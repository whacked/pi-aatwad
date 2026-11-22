// Operator driver for the Qwen secretary experiment (see README.md). Runs inside the container.
// Plays the human: drives four Pi leader sessions over RPC mode, verifies each step against the
// controller database, and records everything under /results.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { MISSIONS, SECRETARY_BRIEF } from "./missions.ts";

const RESULTS = process.env.RESULTS_DIR ?? "/results";
const STATE = process.env.PI_TEAM_STATE_DIR ?? "/state";
const WORK = "/work";
const EXTENSION = "/pkg/src/extension/index.ts";
const MODELS = {
	lead: process.env.MODEL_LEAD ?? "mac-studio-1-mtplx/mtplx-qwen38-27b-optimized-speed",
	a: process.env.MODEL_A ?? "anthropic/claude-opus-5-5",
	b: process.env.MODEL_B ?? "openai/gpt-5.6-sol",
	c: process.env.MODEL_C ?? "openrouter/openrouter/free",
};
const CHECKIN = process.env.CHECKIN ?? "5m";
const HARD_STOP_MS = Number(process.env.HARD_STOP_MIN ?? 45) * 60_000;
const t0 = Date.now();
mkdirSync(RESULTS, { recursive: true });

const stamp = () => `+${((Date.now() - t0) / 60_000).toFixed(1).padStart(4)}m`;
function log(line: string): void {
	const text = `${new Date().toISOString().slice(11, 19)} ${stamp()} ${line}`;
	console.log(text);
	appendFileSync(join(RESULTS, "transcript.md"), `${text}\n`);
}
function section(title: string): void { log(`\n## ${title}`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | Promise<T>, timeoutMs: number, stepMs = 2000): Promise<T | undefined> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const v = await fn();
		if (v) return v;
		await sleep(stepMs);
	}
	log(`(timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what})`);
	return undefined;
}

// ---------------------------------------------------------------------------------------------
class Session {
	readonly name: string;
	readonly proc: ChildProcess;
	busy = false;
	runs = 0;
	notes: string[] = [];
	runId?: string;
	agentId?: string;
	private buf = "";
	private nextId = 1;
	private waiting = new Map<string, (r: any) => void>();
	private settledWaiters: (() => void)[] = [];

	constructor(name: string, model: string, cwd: string) {
		this.name = name;
		const env = { ...process.env, PI_CODING_AGENT_SESSION_DIR: join(STATE, "pi-sessions", name) };
		this.proc = spawn("pi", ["--mode", "rpc", "--model", model, "-e", EXTENSION], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.proc.stdout!.on("data", (chunk: Buffer) => this.read(chunk));
		this.proc.stderr!.on("data", (chunk: Buffer) => appendFileSync(join(RESULTS, `${name}.stderr.log`), chunk));
		this.proc.on("exit", (code, signal) => log(`[${name}] process exited (${code ?? signal})`));
	}
	private read(chunk: Buffer): void {
		this.buf += chunk.toString("utf8");
		let i: number;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i).replace(/\r$/, "");
			this.buf = this.buf.slice(i + 1);
			if (!line.trim()) continue;
			appendFileSync(join(RESULTS, `${this.name}.events.jsonl`), `${JSON.stringify({ t: Date.now() - t0, ...safeParse(line) })}\n`);
			this.handle(safeParse(line));
		}
	}
	private handle(r: any): void {
		if (r.type === "response" && r.id && this.waiting.has(r.id)) { this.waiting.get(r.id)!(r); this.waiting.delete(r.id); return; }
		if (r.type === "extension_ui_request") {
			if (r.method === "notify") { this.notes.push(String(r.message ?? "")); log(`[${this.name}] » ${oneLine(String(r.message ?? ""), 400)}`); }
			else if (r.method === "confirm") this.send({ type: "extension_ui_response", id: r.id, confirmed: true });
			else if (r.method === "select") this.send({ type: "extension_ui_response", id: r.id, value: r.options?.[0] });
			else if (["input", "editor"].includes(r.method)) this.send({ type: "extension_ui_response", id: r.id, cancelled: true });
			return;
		}
		if (r.type === "agent_start") this.busy = true;
		if (r.type === "message_end" && r.message?.role === "custom" && r.message?.customType) {
			const text = typeof r.message.content === "string" ? r.message.content : JSON.stringify(r.message.content);
			log(`[${this.name}] ⇠ ${r.message.customType}: ${oneLine(text, 300)}`);
		}
		if (r.type === "tool_execution_start") log(`[${this.name}]   tool ${r.toolName}${r.args ? ` ${oneLine(JSON.stringify(r.args), 220)}` : ""}`);
		if (r.type === "agent_settled") {
			this.busy = false;
			this.runs++;
			void this.lastText().then((t) => t && log(`[${this.name}] ⇢ ${oneLine(t, 1200)}`));
			for (const w of this.settledWaiters.splice(0)) w();
		}
	}
	send(cmd: Record<string, unknown>): void { this.proc.stdin!.write(`${JSON.stringify(cmd)}\n`); }
	request(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
		const id = `${this.name}-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`${this.name}: ${cmd.type} timed out`)); }, timeoutMs);
			this.waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
			this.send({ ...cmd, id });
		});
	}
	async lastText(): Promise<string> {
		try { return (await this.request({ type: "get_last_assistant_text" }, 10_000)).data?.text ?? ""; } catch { return ""; }
	}
	/** A /team command: returns the notifications it produced. */
	async command(text: string): Promise<string> {
		log(`[operator → ${this.name}] ${text}`);
		const before = this.notes.length;
		const r = await this.request({ type: "prompt", message: text }, 180_000);
		if (!r.success) log(`[${this.name}] command failed: ${r.error}`);
		await sleep(500);
		return this.notes.slice(before).join("\n");
	}
	/** An operator message. Waits for the run it starts to settle unless wait=false. */
	async say(text: string, { wait = true, timeoutMs = 600_000 } = {}): Promise<void> {
		log(`[operator → ${this.name}] ${oneLine(text, 600)}`);
		const settled = this.nextSettled();
		const r = await this.request({ type: "prompt", message: text, ...(this.busy ? { streamingBehavior: "followUp" } : {}) }, 60_000);
		if (!r.success) { log(`[${this.name}] prompt rejected: ${r.error}`); return; }
		if (wait) await Promise.race([settled, sleep(timeoutMs)]);
	}
	nextSettled(): Promise<void> { return new Promise((r) => this.settledWaiters.push(r)); }
	/** Idle with no automatic turn for quietMs. */
	async quiet(quietMs: number, timeoutMs: number): Promise<boolean> {
		const end = Date.now() + timeoutMs;
		let since = Date.now(), runs = this.runs;
		while (Date.now() < end) {
			if (this.busy || this.runs !== runs) { since = Date.now(); runs = this.runs; }
			else if (Date.now() - since >= quietMs) return true;
			await sleep(1000);
		}
		return false;
	}
	close(): void { this.proc.stdin!.end(); }
}

function safeParse(line: string): any { try { return JSON.parse(line); } catch { return { unparsed: line }; } }
function oneLine(s: string, max: number): string { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max)}…` : t; }

// ---------------------------------------------------------------------------------------------
let dbHandle: DatabaseSync | undefined;
function db(): DatabaseSync { return (dbHandle ??= new DatabaseSync(join(STATE, "org.sqlite"), { readOnly: true })); }
function q<T = any>(sql: string, ...args: any[]): T[] { return db().prepare(sql).all(...args) as T[]; }
function teamState(runId: string): string {
	const cfg = JSON.parse(q("SELECT config_json FROM runs WHERE id = ?", runId)[0]?.config_json ?? "{}");
	return cfg.team_lifecycle?.state ?? "RUNNING";
}
function link(runId: string): any { return q("SELECT parent_id, terminatable FROM reporting_edges WHERE run_id = ? AND parent_run_id IS NOT NULL AND valid_to IS NULL", runId)[0]; }
function members(runId: string, rootId: string): any[] { return q("SELECT id, role, status, observed_state, desired_state FROM agents WHERE run_id = ? AND id <> ?", runId, rootId); }
function check(label: string, ok: boolean, detail = ""): boolean { log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`); results.push({ label, ok, detail }); return ok; }
const results: { label: string; ok: boolean; detail: string }[] = [];
function spend(): number { return Number(q("SELECT COALESCE(SUM(consumed_usd), 0) AS s FROM allocations")[0].s); }
function piProcesses(): string[] {
	try { return execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).split("\n").filter((l) => /\bpi\b|pi-coding-agent|cli\.js/.test(l) && !/ps -eo/.test(l)); } catch { return []; }
}

let lastJournal = "";
function snapshotJournal(): void {
	const path = join(WORK, "lead", "journal.md");
	if (!existsSync(path)) return;
	const text = readFileSync(path, "utf8");
	if (text === lastJournal) return;
	lastJournal = text;
	const n = readdirCount(join(RESULTS, "journal-snapshots"));
	mkdirSync(join(RESULTS, "journal-snapshots"), { recursive: true });
	writeFileSync(join(RESULTS, "journal-snapshots", `${String(n + 1).padStart(2, "0")}${stamp().replace(/[+ ]/g, "_")}.md`), text);
	log(`(journal changed: ${text.length} bytes, snapshot ${n + 1})`);
}
function readdirCount(dir: string): number { try { return readdirSync(dir).length; } catch { return 0; } }

function idsFrom(notes: string): { runId?: string; agentId?: string } {
	const m = /team run (run-[\w-]+) created[^;]*; you are root agent ([\w-]+)/.exec(notes);
	return m ? { runId: m[1], agentId: m[2] } : {};
}

// ---------------------------------------------------------------------------------------------
function setupWorkspace(): void {
	for (const dir of ["lead", "ledger", "sortbench", "booknotes"]) {
		const p = join(WORK, dir);
		mkdirSync(p, { recursive: true });
		writeFileSync(join(p, "README.md"), `# ${dir}\n`);
		if (dir === "booknotes") copyFileSync("/seed/book.txt", join(p, "book.txt"));
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p });
		execFileSync("git", ["add", "."], { cwd: p });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: p });
	}
}

async function main(): Promise<void> {
	const hardStop = setTimeout(() => { log("HARD STOP reached; shutting down"); process.exit(2); }, HARD_STOP_MS);
	hardStop.unref();
	writeFileSync(join(RESULTS, "transcript.md"), `# Qwen secretary experiment transcript\n\nModels: ${JSON.stringify(MODELS)}\nCheck-in interval: ${CHECKIN}\n`);
	setupWorkspace();
	const journalTimer = setInterval(snapshotJournal, 5000);

	section("1. Two independent leaders start their own missions (B: Sol, C: free model)");
	const B = new Session("B-sortbench", MODELS.b, join(WORK, "sortbench"));
	const C = new Session("C-booknotes", MODELS.c, join(WORK, "booknotes"));
	for (const s of [B, C]) Object.assign(s, idsFrom(await s.command("/team init")));
	check("B and C created their own teams", !!B.runId && !!C.runId, `${B.runId}, ${C.runId}`);
	await B.say(MISSIONS.b, { wait: false });
	await C.say(MISSIONS.c, { wait: false });

	section("2. The top-level leader (Qwen 27B) starts, with sub-leader A (Opus) joined under it");
	const T = new Session("T-secretary", MODELS.lead, join(WORK, "lead"));
	Object.assign(T, idsFrom(await T.command("/team init")));
	const A = new Session("A-ledger", MODELS.a, join(WORK, "ledger"));
	Object.assign(A, idsFrom(await A.command("/team init")));
	check("T and A created their teams", !!T.runId && !!A.runId, `${T.runId}, ${A.runId}`);
	await T.say(SECRETARY_BRIEF); // interaction 1
	await A.command(`/team join ${T.runId} --yes`);
	check("A is linked under T (joined, not terminatable)", link(A.runId!)?.parent_id === T.agentId && link(A.runId!)?.terminatable === 0);
	await T.command(`/team attention checkin ${CHECKIN}`);
	await T.say(`A new sub-leader has joined you: agent ${A.agentId} (team ${A.runId}). Assign it this mission with team_delegate_task, record the project in journal.md, and return control.\n\nMission for ${A.agentId}:\n${MISSIONS.a}`); // interaction 2
	const taskA = await until("T to assign A its mission", () => q("SELECT id, title FROM tasks WHERE owner_id = ? AND run_id = ?", A.agentId, T.runId)[0], 120_000);
	check("T assigned A its mission as a task in T's team", !!taskA, taskA?.title ?? "");
	await until("A to start working", () => A.busy || A.runs > 0, 180_000);

	section("3. After A starts, the two independent leaders join T");
	await sleep(60_000);
	await B.command(`/team join ${T.runId} --yes`);
	await C.command(`/team join ${T.runId} --yes`);
	check("B and C are linked under T", link(B.runId!)?.parent_id === T.agentId && link(C.runId!)?.parent_id === T.agentId);
	await T.say(`Two teams that were already running now report to you as well: ${B.agentId} (team ${B.runId}, the SORTBENCH project) and ${C.agentId} (team ${C.runId}, the BOOKNOTES project). Add both to journal.md. Then do a status round: ask all three sub-leaders for their status, and when the answers arrive update the journal and give me a short summary.`); // interaction 3: milestone update 1
	await T.quiet(60_000, 8 * 60_000);
	snapshotJournal();

	section("4. The operator talks directly to a sub-leader");
	await C.say("Operator here, directly: please also add a one-line theme for each chapter in summaries.md.", { wait: false });

	section("5. More operator interactions with the secretary");
	await T.say("Based only on journal.md and what you already know (do not contact anyone): which project is furthest along, and which is most at risk?"); // interaction 4
	await T.say(`Add a note to journal.md that SORTBENCH's report must also mention the memory characteristics of each algorithm, and pass that request on to ${B.agentId}.`); // interaction 5
	await T.quiet(30_000, 4 * 60_000);

	section("6. Scheduled check-ins (every " + CHECKIN + ") are handled by the secretary on its own");
	const checkins = () => q("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'attention.wake' AND json_extract(payload_json, '$.reason') = 'checkin'", T.runId)[0]?.n ?? 0;
	const fromEvents = () => readFileSync(join(RESULTS, `${T.name}.events.jsonl`), "utf8").split("\n").filter((l) => /Team check-in/.test(l) && /"message_end"/.test(l)).length;
	await until("two scheduled check-ins", () => Math.max(checkins(), fromEvents()) >= 2, 14 * 60_000, 5000);
	check("the secretary ran two scheduled check-ins", Math.max(checkins(), fromEvents()) >= 2, `${Math.max(checkins(), fromEvents())} seen`);
	await T.quiet(45_000, 5 * 60_000);

	section("7. Milestone status update after six interactions");
	await T.say("Status round please: ask each sub-leader for its current status and deliverables, update journal.md when the answers are in, and give me a concise summary of all three projects."); // interaction 6
	await T.quiet(60_000, 8 * 60_000);
	snapshotJournal();

	section("8. Four leaders idle and awaiting instructions");
	for (const s of [A, B, C]) await s.quiet(20_000, 6 * 60_000);
	await T.quiet(20_000, 4 * 60_000);
	await sleep(15_000);
	const live = [T, A, B, C].map((s) => ({ s, row: q("SELECT observed_state, status FROM agents WHERE id = ?", s.agentId)[0] }));
	check("four leaders are connected and idle", live.every(({ s, row }) => !s.busy && row?.observed_state === "LIVE" && row?.status === "RUNNING"), live.map(({ s, row }) => `${s.name}: ${row?.observed_state}/${row?.status}${s.busy ? "/busy" : "/idle"}`).join(", "));
	for (const [s, label] of [[A, "A"], [B, "B"], [C, "C"]] as const) log(`${label} members: ${JSON.stringify(members(s.runId!, s.agentId!).map((m) => `${m.role}:${m.status}/${m.observed_state}`))}`);

	section("9. Deallocate sub-leader A (made terminatable by the operator, closed by the secretary)");
	await T.command(`/team link ${A.agentId} terminatable on`);
	await T.say(`Project LEDGER is finished. Close sub-leader ${A.agentId}'s team now with team_close_member, record that in journal.md, and confirm.`); // interaction 7
	await until("A's team to stop", () => ["STOPPED", "CLEANING"].includes(teamState(A.runId!)), 120_000);
	check("A's team was stopped (resumable) and its link closed", ["STOPPED", "CLEANING"].includes(teamState(A.runId!)) && !link(A.runId!), `state ${teamState(A.runId!)}`);
	check("A's members are paused, not deleted", members(A.runId!, A.agentId!).every((m) => m.status !== "CANCELLED"), JSON.stringify(members(A.runId!, A.agentId!).map((m) => m.status)));

	section("10. Sub-leader B leaves the secretary (disconnect)");
	await B.command("/team join none --yes");
	check("B is detached and still running on its own", !link(B.runId!) && teamState(B.runId!) === "RUNNING");

	section("11. Sub-leader C deallocates its own team through itself");
	await C.say("Operator here: your project is complete. Close every member of your team now with team_close_member, then stop and wait for further instructions.");
	await C.quiet(20_000, 5 * 60_000);
	const cMembers = members(C.runId!, C.agentId!);
	check("C closed its own members and is idle", cMembers.length > 0 && cMembers.every((m) => ["CANCELLED", "RETIRED", "COMPLETED"].includes(m.status)) && !C.busy, JSON.stringify(cMembers.map((m) => `${m.role}:${m.status}`)));

	section("12. Close the secretary and everything around it");
	await T.command(`/team link ${C.agentId} terminatable on`);
	await T.command("/team stop --yes");
	await B.command("/team stop --yes");
	await until("teams to stop", () => [T, B, C].every((s) => teamState(s.runId!) === "STOPPED") && teamState(A.runId!) === "STOPPED", 120_000);
	check("all four teams are stopped (resumable)", [T, A, B, C].every((s) => teamState(s.runId!) === "STOPPED"), [T, A, B, C].map((s) => `${s.name}: ${teamState(s.runId!)}`).join(", "));
	clearInterval(journalTimer);
	snapshotJournal();
	for (const s of [T, A, B, C]) s.close();
	await sleep(8000);
	const leftover = piProcesses();
	check("no Pi processes remain", leftover.length === 0, leftover.join(" | "));
	check("agents remain in the database (memory kept)", q("SELECT COUNT(*) AS n FROM agents")[0].n >= 4);

	log(`Nominal spend recorded by the controller: $${spend().toFixed(4)} (subscription and free models; see report)`);
	if (existsSync(join(WORK, "lead", "journal.md"))) copyFileSync(join(WORK, "lead", "journal.md"), join(RESULTS, "journal.md"));
	for (const [dir, file] of [["ledger", ""], ["sortbench", "report.md"], ["booknotes", "summaries.md"]] as const) {
		try { execFileSync("tar", ["czf", join(RESULTS, `${dir}.tgz`), "--exclude=.git", "--exclude=.team-worktrees", "-C", WORK, dir]); } catch {}
		if (file && existsSync(join(WORK, dir, file))) copyFileSync(join(WORK, dir, file), join(RESULTS, `${dir}-${file}`));
	}
	writeFileSync(join(RESULTS, "checks.json"), JSON.stringify({ models: MODELS, minutes: (Date.now() - t0) / 60_000, spend_usd: spend(), results }, null, 2));
	log(`Done in ${((Date.now() - t0) / 60_000).toFixed(1)} minutes: ${results.filter((r) => r.ok).length}/${results.length} checks passed.`);
	process.exit(0);
}

main().catch((e) => { log(`DRIVER ERROR: ${(e as Error).stack ?? e}`); process.exit(1); });
