// REAL worker chain, offline: controller (default PiExecutor) -> real `pi` 1.4 worker -> our
// extension enrolls -> the (fake, scripted) model calls team tools -> controller records it.
// Then a new message makes the controller relaunch the one-shot worker with resume=true on the
// same Pi session file, and the model sees the earlier history.
//
// No credits, no ~/.pi: PI_CODING_AGENT_DIR is a temp dir whose models.json defines provider
// "fakeoai" -> test/fixtures/fake-openai.ts on 127.0.0.1.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { statePaths } from "../../src/shared/paths.ts";
import { TeamClient, ensureController, readOperatorToken } from "../../src/shared/client.ts";
import type { Envelope, EventView } from "../../src/shared/protocol.ts";
import { probeIdentity, stopIdentity } from "../../src/executor/proc.ts";
import { startFakeOpenAI } from "../fixtures/fake-openai.ts";
import type { FakeOpenAI, FakeReply, FakeRequest } from "../fixtures/fake-openai.ts";

let piBin = "";
try {
	piBin = execFileSync("which", ["pi"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	if (!/^1\.4\./.test(execFileSync(piBin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim())) piBin = "";
} catch {
	piBin = "";
}
const skip = piBin ? false : "pi 1.4.x not on PATH";

const SUMMARY = "integration verified by real pi worker";
const PING = "PING-7731";
const PONG = "PONG-7731 from the resumed worker";
const TOKEN_RE = /\bpt[seo]_[A-Za-z0-9_-]{20,}/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 60_000): Promise<T> {
	const end = Date.now() + ms;
	let last: unknown;
	while (Date.now() < end) {
		try {
			const v = await fn();
			if (v !== undefined && v !== false) return v as T;
		} catch (e) {
			last = e;
		}
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

let rootId = "";
/**
 * Scripted model:
 *  1. no team_complete_task call in history yet -> call it for the task id visible in context;
 *  2. latest user/inbox text contains PING and no team_send_message after it -> answer the root;
 *  3. otherwise plain text.
 */
function respond(req: FakeRequest): FakeReply {
	const msgs = req.messages;
	const calls = (name: string, from = 0) => msgs.slice(from).some((m) => m.tool_calls?.some((t) => t.name === name));
	if (!calls("team_complete_task")) {
		const taskId = msgs.map((m) => m.text).join("\n").match(/task-[0-9a-f]{16}/)?.[0];
		if (!taskId) return { text: "I cannot see a task id." };
		return { tool_calls: [{ name: "team_complete_task", arguments: { task_id: taskId, summary: SUMMARY } }] };
	}
	const pingAt = msgs.findLastIndex((m) => m.role === "user" && m.text.includes(PING));
	if (pingAt >= 0 && !calls("team_send_message", pingAt)) {
		return { tool_calls: [{ name: "team_send_message", arguments: { to: rootId, type: "answer", text: PONG } }] };
	}
	return { text: "Done." };
}

/** When armed, the next model request is held open until `release()` (simulates a slow LLM turn). */
let hold: { arrived: () => void; released: Promise<void> } | null = null;
async function respondMaybeHeld(req: FakeRequest): Promise<FakeReply> {
	const h = hold;
	if (h) {
		hold = null;
		h.arrived();
		await h.released;
	}
	return respond(req);
}

let fake: FakeOpenAI;
let agentDir = "";
let stateDir = "";
let workspace = "";
let opToken = "";
const paths = () => statePaths(stateDir);

function q<T = Record<string, any>>(sql: string, ...args: (string | number)[]): T[] {
	const db = new DatabaseSync(paths().db, { readOnly: true });
	try {
		return db.prepare(sql).all(...args) as T[];
	} finally {
		db.close();
	}
}

before(async () => {
	if (skip) return;
	fake = await startFakeOpenAI(respondMaybeHeld);
	agentDir = realpathSync(mkdtempSync(join(tmpdir(), "pt-rpa-")));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { fakeoai: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "fake-1" }] } } }),
	);
	stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ptr-"))); // short: unix socket path limit
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "pt-rpw-")));
	const git = (...a: string[]) => execFileSync("git", ["-C", workspace, ...a], { stdio: ["ignore", "pipe", "pipe"] });
	git("init", "-q");
	git("config", "user.email", "t@example.invalid");
	git("config", "user.name", "t");
	writeFileSync(join(workspace, "README.md"), "real pi worker e2e\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
});

after(async () => {
	if (skip) return;
	const p = paths();
	try {
		if (opToken) await new TeamClient({ paths: p, noReconnect: true }).shutdown(true, { token: opToken }).catch(() => {});
		await sleep(300);
		if (existsSync(p.db)) for (const s of q<{ pid: number; process_started_at: string }>("SELECT pid, process_started_at FROM sessions WHERE pid IS NOT NULL")) await stopIdentity(s, 1000);
		if (existsSync(p.controllerInfo)) {
			const pid = JSON.parse(readFileSync(p.controllerInfo, "utf8")).pid as number;
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	} finally {
		await fake?.close();
		for (const d of [stateDir, workspace, agentDir]) if (d) rmSync(d, { recursive: true, force: true });
	}
});

test("real pi worker: enroll, tool call recorded, one-shot exit, resume on new message", { skip, timeout: 150_000 }, async () => {
	const p = paths();
	await ensureController(p, {
		env: { PI_TEAM_EXECUTOR: "pi", PI_TEAM_PI_BIN: piBin, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		readyTimeoutMs: 15_000,
	});
	opToken = await readOperatorToken(p);
	let rootToken = "";
	const client = new TeamClient({ paths: p, token: () => rootToken, noReconnect: true });
	const asOp = { token: opToken };

	// --- root + one approved lead worker on the fake provider/model -----------------------
	const run = await client.createRun(
		{
			config: {
				workspace_root: workspace,
				limits: { allow_providers: ["fakeoai"] } as never,
				models: [{ id: "fake", provider: "fakeoai", model: "fake-1", capability_tags: ["general"], tool_support: true, cost_per_m_input_usd: 0, cost_per_m_output_usd: 0, availability: "available" }],
			},
			root: { role: "Root", cwd: workspace, provider: "fakeoai", model: "fake-1" },
		},
		asOp,
	);
	rootToken = run.token;
	rootId = run.root_agent_id;
	const own = await client.delegateTask({ owner_id: rootId, title: "Integration check" });
	const prop = await client.requestExpansion({
		version: 1,
		task_id: own.task_id,
		reason: "need a lead to run the integration check",
		alternatives: "do it myself",
		estimated_cost_usd: 0.1,
		roles: [{ title: "Lead", responsibility: "run the integration check and report", count: 1, capabilities: [], preferred_model_id: "fake", max_cost_usd: 0.1 }],
	});
	const dec = await client.decideExpansion(prop.proposal_id, { decision: "APPROVE", reason: "go" });
	assert.equal(dec.status, "APPROVED");
	const lead = dec.spawned_agent_ids[0];
	const leadTask = q("SELECT id FROM tasks WHERE owner_id = ?", lead)[0].id as string;

	const events = async (): Promise<EventView[]> => (await client.events({ run_id: run.run_id, limit: 1000 }, asOp)).events;
	const leadEvents = async (type: string) => (await events()).filter((e) => e.entity_id === lead && e.type === type);

	// --- first launch: enroll -> team_complete_task -> exit --------------------------------
	await waitUntil("lead enrolled", async () => (await leadEvents("session.enrolled")).length >= 1);
	await waitUntil("lead process exited (one-shot)", async () => (await leadEvents("agent.exited")).length >= 1);
	const enrolled = (await leadEvents("session.enrolled"))[0];
	const exited = (await leadEvents("agent.exited"))[0];
	assert.ok(enrolled.seq < exited.seq, "LIVE (enrolled) before STOPPED (exited)");
	const s1 = q("SELECT * FROM sessions WHERE agent_id = ? ORDER BY generation", lead);
	assert.equal(s1.length, 1);
	assert.ok(s1[0].enrolled_at, "session enrolled");
	assert.equal(s1[0].status, "STOPPED");
	assert.equal(s1[0].pid, enrolled.payload && (enrolled.payload as { pid: number }).pid, "enrolled pid = launched pid");

	const task = q("SELECT status, result_json FROM tasks WHERE id = ?", leadTask)[0];
	assert.equal(task.status, "DONE");
	assert.equal(JSON.parse(task.result_json).summary, SUMMARY);

	const rootInbox: Envelope[] = [];
	const drainRoot = async () => {
		for (const m of (await client.inbox(50)).messages) {
			rootInbox.push(m);
			await client.ack(m.message_id);
		}
	};
	await waitUntil("root got task.completed", async () => {
		await drainRoot();
		return rootInbox.find((m) => m.type === "task.completed" && m.from === lead);
	}, 10_000);
	assert.equal((rootInbox.find((m) => m.type === "task.completed")!.payload as { summary: string }).summary, SUMMARY);

	// The model was offered the team tools and got the tool result back.
	assert.ok(fake.requests[0].tools.includes("team_complete_task"), `tools offered: ${fake.requests[0].tools.join(",")}`);
	assert.ok(fake.requests.some((r) => r.messages.some((m) => m.role === "tool" && /marked DONE/.test(m.text))), "tool result returned to the model");

	// Worker cwd = its own git worktree; Pi ran there.
	const cwd = q("SELECT cwd FROM agents WHERE id = ?", lead)[0].cwd as string;
	assert.equal(cwd, join(workspace, ".team-worktrees", run.run_id, lead));
	assert.equal(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).toString().trim(), cwd);
	const log1 = join(p.workerLogs, `${lead}.1.log`);
	const log1Text = readFileSync(log1, "utf8");
	const header1 = log1Text.split("\n").find((l) => l.startsWith('{"type":"session"'));
	assert.ok(header1, "pi JSON session header in worker log");
	assert.equal(JSON.parse(header1!).cwd, cwd);
	const launch1 = JSON.parse(log1Text.split("\n").find((l) => l.includes('"event":"launch"'))!.replace("[pi-team-executor] ", ""));
	assert.equal(launch1.resume, false);
	const sessionPath = launch1.args[launch1.args.indexOf("--session") + 1] as string;
	assert.ok(existsSync(sessionPath), "pi session file written");
	assert.equal(readdirSync(p.enrollDir).length, 0, "enrollment file consumed");

	// --- resume: a new message relaunches the one-shot worker on the same session -----------
	const nReq = fake.requests.length;
	await client.sendMessage({ to: lead, type: "question", payload: { text: `${PING}: please confirm you still have context` } });
	await waitUntil("lead relaunched and exited again", async () => (await leadEvents("agent.exited")).length >= 2, 60_000);
	const s2 = q("SELECT * FROM sessions WHERE agent_id = ? ORDER BY generation", lead);
	assert.equal(s2.length, 2, "exactly one relaunch");
	assert.equal(s2[1].generation, 2);
	const log2Text = readFileSync(join(p.workerLogs, `${lead}.2.log`), "utf8");
	const launch2 = JSON.parse(log2Text.split("\n").find((l) => l.includes('"event":"launch"'))!.replace("[pi-team-executor] ", ""));
	assert.equal(launch2.resume, true);
	assert.equal(launch2.args[launch2.args.indexOf("--session") + 1], sessionPath, "same pi session file");
	const sid = (t: string) => JSON.parse(t.split("\n").find((l) => l.startsWith('{"type":"session"'))!).id;
	assert.equal(sid(log2Text), sid(log1Text), "same pi session id (transcript resumed)");

	const resumed = fake.requests.slice(nReq);
	assert.ok(resumed.length >= 1);
	const first = resumed[0].messages;
	assert.ok(first.some((m) => m.tool_calls?.some((t) => t.name === "team_complete_task")), "model sees the earlier tool call (history)");
	assert.ok(first.some((m) => m.role === "user" && m.text.includes(PING)), "model sees the new inbox message");
	await waitUntil("root got the answer", async () => {
		await drainRoot();
		return rootInbox.find((m) => m.type === "answer" && m.from === lead);
	}, 10_000);
	assert.equal((rootInbox.find((m) => m.type === "answer")!.payload as { text: string }).text, PONG);
	assert.equal(q("SELECT d.status FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE m.recipient_id = ? AND m.type = 'question'", lead)[0].status, "ACKED");

	// No relaunch loop once the work is done.
	await sleep(3000);
	assert.equal(q("SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?", lead)[0].n, 2, "no further relaunch without pending work");

	// No secrets in worker logs or the Pi transcript.
	for (const f of [log1, join(p.workerLogs, `${lead}.2.log`), sessionPath]) {
		const t = readFileSync(f, "utf8");
		assert.doesNotMatch(t, TOKEN_RE, `token-like secret in ${f}`);
		assert.ok(!t.includes(opToken) && !t.includes(rootToken));
	}
});

test("controller SIGKILLed mid-run: worker reconnects to the restarted controller; no second controller, no default state dir", { skip, timeout: 120_000 }, async () => {
	// Own state dir + a temp HOME / XDG_STATE_HOME, so a stray "default" state dir would be visible here.
	const sdir = realpathSync(mkdtempSync(join(tmpdir(), "ptk-")));
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pt-home-")));
	const xdg = join(home, "xdg-state");
	const defaultDirs = [join(home, "Library", "Application Support", "pi-recursive-team"), join(xdg, "pi-recursive-team"), join(home, ".local", "state", "pi-recursive-team")];
	const p = statePaths(sdir);
	const env = { PI_TEAM_EXECUTOR: "pi", PI_TEAM_PI_BIN: piBin, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", HOME: home, XDG_STATE_HOME: xdg };
	const q2 = <T = Record<string, any>>(sql: string, ...args: (string | number)[]): T[] => {
		const db = new DatabaseSync(p.db, { readOnly: true });
		try {
			return db.prepare(sql).all(...args) as T[];
		} finally {
			db.close();
		}
	};
	const controllerPids: number[] = [];
	let op = "";
	try {
		const h0 = (await ensureController(p, { env, readyTimeoutMs: 15_000 })).health;
		controllerPids.push(h0.pid);
		op = await readOperatorToken(p);
		let rootToken = "";
		const client = new TeamClient({ paths: p, token: () => rootToken, noReconnect: true });
		const run = await client.createRun(
			{
				config: {
					workspace_root: workspace,
					limits: { allow_providers: ["fakeoai"] } as never,
					models: [{ id: "fake", provider: "fakeoai", model: "fake-1", capability_tags: ["general"], tool_support: true, cost_per_m_input_usd: 0, cost_per_m_output_usd: 0, availability: "available" }],
				},
				root: { role: "Root", cwd: workspace, provider: "fakeoai", model: "fake-1" },
			},
			{ token: op },
		);
		rootToken = run.token;
		rootId = run.root_agent_id;

		// Arm the hold BEFORE the worker exists: its first model turn will block mid-run.
		let arrived!: () => void;
		let release!: () => void;
		const arrivedP = new Promise<void>((r) => (arrived = r));
		hold = { arrived, released: new Promise<void>((r) => (release = r)) };

		const own = await client.delegateTask({ owner_id: rootId, title: "Crash-tolerant check" });
		const prop = await client.requestExpansion({
			version: 1,
			task_id: own.task_id,
			reason: "lead for crash test",
			alternatives: "none",
			estimated_cost_usd: 0.1,
			roles: [{ title: "Lead", responsibility: "complete the task across a controller crash", count: 1, capabilities: [], preferred_model_id: "fake", max_cost_usd: 0.1 }],
		});
		const lead = (await client.decideExpansion(prop.proposal_id, { decision: "APPROVE", reason: "go" })).spawned_agent_ids[0];
		const leadTask = q2("SELECT id FROM tasks WHERE owner_id = ?", lead)[0].id as string;

		await waitUntil("worker's model turn in flight", () => arrivedP.then(() => true), 60_000);
		const sess = q2<{ pid: number; process_started_at: string; enrolled_at: string | null }>("SELECT pid, process_started_at, enrolled_at FROM sessions WHERE agent_id = ?", lead);
		assert.equal(sess.length, 1);
		assert.ok(sess[0].enrolled_at, "worker enrolled before the crash");

		// Crash the controller mid-run, then let the model emit its tool call into the dead socket.
		process.kill(h0.pid, "SIGKILL");
		await waitUntil("controller dead", () => {
			try {
				process.kill(h0.pid, 0);
				return false;
			} catch {
				return true;
			}
		}, 5_000);
		release();
		await sleep(1500); // team_complete_task hits ECONNREFUSED and backs off (client reconnect: "retry")
		assert.ok((await probeIdentity(sess[0])) === "alive", "worker survived the controller crash");
		const h1 = (await ensureController(p, { env, readyTimeoutMs: 15_000 })).health;
		controllerPids.push(h1.pid);
		assert.notEqual(h1.pid, h0.pid);
		assert.ok(h1.fencing_epoch > h0.fencing_epoch);

		// The worker's retried tool call lands on the new controller; the worker then exits normally.
		await waitUntil("task DONE via the restarted controller", () => q2("SELECT status FROM tasks WHERE id = ?", leadTask)[0].status === "DONE", 30_000);
		assert.equal(JSON.parse(q2("SELECT result_json FROM tasks WHERE id = ?", leadTask)[0].result_json).summary, SUMMARY);
		await waitUntil("worker exited", async () => (await probeIdentity(sess[0])) === "dead", 30_000);
		const inbox = (await client.inbox(50)).messages;
		assert.ok(inbox.some((m) => m.type === "task.completed" && m.from === lead), "root got task.completed");
		assert.equal(q2("SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?", lead)[0].n, 1, "same worker process/session finished the job (no relaunch)");
		const done = q2("SELECT e.payload_json FROM events e WHERE e.type = 'task.completed' AND e.entity_id = ?", leadTask);
		assert.equal(done.length, 1, "completion recorded exactly once");

		// No second controller and no default state dir: the worker never tried to start one.
		for (const d of defaultDirs) assert.ok(!existsSync(d), `no default state dir created: ${d}`);
		assert.equal(JSON.parse(readFileSync(p.controllerInfo, "utf8")).pid, h1.pid);
		const alive = controllerPids.filter((pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		});
		assert.deepEqual(alive, [h1.pid], "exactly one controller alive");
		const workerLog = readFileSync(join(p.workerLogs, `${lead}.1.log`), "utf8");
		assert.doesNotMatch(workerLog, TOKEN_RE);
	} finally {
		hold = null;
		if (op) await new TeamClient({ paths: p, noReconnect: true }).shutdown(true, { token: op }).catch(() => {});
		await sleep(300);
		if (existsSync(p.db)) for (const s of q2<{ pid: number; process_started_at: string }>("SELECT pid, process_started_at FROM sessions WHERE pid IS NOT NULL")) await stopIdentity(s, 1000);
		for (const pid of controllerPids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		rmSync(sdir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});
