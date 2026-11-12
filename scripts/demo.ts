#!/usr/bin/env node
// End-to-end demo (recursive-agent-org-v1.2/examples/demo-scenario.md), fully offline:
//   * the REAL controller process (`node src/controller/main.ts`, started via ensureController
//     exactly like the extension does) on a fresh temp state dir;
//   * workers = test/fixtures/fake-worker.ts via PI_TEAM_EXECUTOR (no LLM, no credentials);
//   * root agent A = this script, driving the controller through src/shared/client.ts.
// Every step is an assertion. Writes tree.json, events.jsonl, budget.json and test-report.txt.
//
//   node scripts/demo.ts [--out demo-output] [--keep]
//
// Exit code 0 iff all steps passed. No processes are left behind (also on failure).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { statePaths } from "../src/shared/paths.ts";
import type { StatePaths } from "../src/shared/paths.ts";
import { TeamClient, ensureController, readOperatorToken, TeamApiError } from "../src/shared/client.ts";
import type { BudgetView, CreateExpansionRequest, EventView, ExpansionRole, TreeNode, TreeResponse } from "../src/shared/protocol.ts";
import { probeIdentity, stopIdentity } from "../src/executor/proc.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_WORKER = join(ROOT, "test", "fixtures", "fake-worker.ts");

export interface DemoOptions {
	outDir?: string;
	keep?: boolean; // keep temp state dir + workspace for inspection
	log?: (line: string) => void;
}

export interface StepResult {
	n: number;
	name: string;
	ok: boolean;
	ms: number;
	details: string[];
	error?: string;
}

export interface DemoResult {
	ok: boolean;
	steps: StepResult[];
	outDir: string;
	stateDir: string;
	strayPids: number[];
}

// ---------------------------------------------------------------------------
// Scenario script for the fake workers (keyed by role title)
// ---------------------------------------------------------------------------

const role = (title: string, responsibility: string, max_cost_usd: number, extra: Partial<ExpansionRole> = {}): ExpansionRole => ({
	title,
	responsibility,
	count: 1,
	capabilities: [],
	max_cost_usd,
	...extra,
});

const HUNDRED_ROLES: ExpansionRole[] = [...Array(7)].map((_, i) => ({
	...role(`Bulk checker ${i}`, "brute-force corner sweep", 0.1),
	count: i < 6 ? 16 : 4, // 6*16 + 4 = 100 (schema caps count per role at 16)
}));

const WORKER_SCRIPT = {
	"Lead B": [
		{
			op: "request_expansion",
			body: {
				reason: "split verification into DRC and LVS",
				alternatives: "run both checks myself sequentially (slower)",
				estimated_cost_usd: 1,
				roles: [
					role("DRC verifier", "design-rule check of the tapeout", 0.5, { preferred_model_id: "economy" }),
					role("LVS verifier", "layout-vs-schematic check", 0.5, { preferred_model_id: "economy" }),
				],
			},
		},
		{ op: "review", count: 2, on_exceeded: "ESCALATE" },
		{ op: "wait_messages", type: "task.completed", count: 3 },
		{ op: "complete_task", all: true, summary: "DRC + LVS + nested check verified" },
	],
	"DRC verifier": [
		{ op: "gate", name: "step4" },
		{
			op: "request_expansion",
			body: {
				reason: "nested antenna-rule check needs its own worker",
				alternatives: "skip antenna rules",
				estimated_cost_usd: 0.25,
				roles: [role("Nested checker", "antenna-rule check", 0.25, { preferred_model_id: "economy" })],
			},
		},
		{ op: "gate", name: "complete" },
		{ op: "report_usage", cost_usd: 0.12, input_tokens: 1200, output_tokens: 300 },
		{ op: "complete_task", artifact: "drc-report.txt", summary: "DRC clean" },
	],
	"LVS verifier": [
		{ op: "gate", name: "step5" },
		{
			op: "request_expansion",
			body: { reason: "exhaustive sweep", alternatives: "sampled sweep", estimated_cost_usd: 10, roles: HUNDRED_ROLES },
		},
		{ op: "gate", name: "complete" },
		{ op: "report_usage", cost_usd: 0.07, input_tokens: 800, output_tokens: 200 },
		{ op: "complete_task", artifact: "lvs-report.txt", summary: "LVS matched" },
	],
	"Nested checker": [
		{ op: "gate", name: "complete" },
		{ op: "report_usage", cost_usd: 0.03, input_tokens: 300, output_tokens: 90 },
		{ op: "complete_task", artifact: "antenna-report.txt", summary: "antenna rules clean" },
	],
};

const USAGE: Record<string, number> = { "DRC verifier": 0.12, "LVS verifier": 0.07, "Nested checker": 0.03 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 30_000, stepMs = 100): Promise<T> {
	const end = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < end) {
		try {
			const v = await fn();
			if (v !== undefined && v !== false) return v as T;
		} catch (e) {
			lastErr = e;
		}
		await sleep(stepMs);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}${lastErr ? ` (last error: ${(lastErr as Error).message})` : ""}`);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Read-only SQLite query against the controller DB (verification only; never written). */
function q<T = Record<string, any>>(paths: StatePaths, sql: string, ...args: (string | number | null)[]): T[] {
	const db = new DatabaseSync(paths.db, { readOnly: true });
	try {
		return db.prepare(sql).all(...args) as T[];
	} finally {
		db.close();
	}
}

/** Seed an explicit delegated envelope for this bounded-policy demo (not a production default). */
function demoSlots(paths: StatePaths, agent: string, slots: number): void {
	const db = new DatabaseSync(paths.db);
	try {
		db.exec("PRAGMA busy_timeout=5000");
		db.prepare("UPDATE allocations SET limits_json=json_set(limits_json,'$.max_subtree_slots',?) WHERE agent_id=?").run(slots, agent);
	} finally { db.close(); }
}

interface LogRec {
	event: string;
	[k: string]: any;
}

function workerLogs(paths: StatePaths, agentId: string): string[] {
	if (!existsSync(paths.workerLogs)) return [];
	return readdirSync(paths.workerLogs)
		.filter((f) => f.startsWith(`${agentId}.`) && f.endsWith(".log"))
		.map((f) => join(paths.workerLogs, f));
}

function workerEvents(paths: StatePaths, agentId: string): LogRec[] {
	const out: LogRec[] = [];
	for (const f of workerLogs(paths, agentId)) {
		for (const line of readFileSync(f, "utf8").split("\n")) {
			if (!line.startsWith("{")) continue;
			try {
				out.push(JSON.parse(line));
			} catch {
				/* partial line */
			}
		}
	}
	return out;
}

function flatten(n: TreeNode, acc: TreeNode[] = []): TreeNode[] {
	acc.push(n);
	for (const c of n.children) flatten(c, acc);
	return acc;
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
	const say = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
	const outDir = resolve(opts.outDir ?? join(ROOT, "demo-output"));
	// Short state dir: macOS limits unix socket paths to 104 bytes.
	const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ptd-")));
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ptw-")));
	const gateDir = join(stateDir, "gates");
	mkdirSync(gateDir, { recursive: true });
	const scriptFile = join(stateDir, "fake-script.json");
	writeFileSync(scriptFile, JSON.stringify(WORKER_SCRIPT, null, 2));
	const paths = statePaths(stateDir);
	const gate = (name: string) => writeFileSync(join(gateDir, name), "");

	// Workspace = a git repo, so workers get isolated worktrees.
	const git = (...a: string[]) => execFileSync("git", ["-C", workspace, ...a], { stdio: ["ignore", "pipe", "pipe"] });
	git("init", "-q");
	git("config", "user.email", "demo@example.invalid");
	git("config", "user.name", "demo");
	writeFileSync(join(workspace, "README.md"), "tapeout under verification\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");

	const controllerEnv: Record<string, string> = {
		PI_TEAM_EXECUTOR: FAKE_WORKER,
		PI_TEAM_FAKE_SCRIPT: scriptFile,
		PI_TEAM_FAKE_GATE_DIR: gateDir,
		PI_TEAM_FAKE_HEARTBEAT_MS: "200",
		PI_TEAM_FAKE_INBOX_LIMIT: "3",
		PI_TEAM_FAKE_ACK_DELAY_MS: "40",
		PI_TEAM_FAKE_OP_TIMEOUT_MS: "90000",
	};
	const startController = async () => (await ensureController(paths, { env: controllerEnv, readyTimeoutMs: 15_000 })).health;

	const steps: StepResult[] = [];
	const controllerPids = new Set<number>();
	let rootToken = "";
	let opToken = "";
	let runId = "";
	const client = new TeamClient({ paths, token: () => rootToken, noReconnect: true });
	const asOp = () => ({ token: opToken });
	const ids: Record<string, string> = {}; // A, B, C, D, E
	let stopRootLoop = false;
	let rootLoop: Promise<void> | null = null;

	async function step(name: string, fn: (d: string[]) => Promise<void>): Promise<void> {
		const n = steps.length + 1;
		const t0 = Date.now();
		const details: string[] = [];
		say(`\n[${n}] ${name}`);
		try {
			await fn(details);
			steps.push({ n, name, ok: true, ms: Date.now() - t0, details });
			for (const d of details) say(`    - ${d}`);
			say(`    PASS (${Date.now() - t0} ms)`);
		} catch (e) {
			const error = String((e as Error)?.stack ?? e);
			steps.push({ n, name, ok: false, ms: Date.now() - t0, details, error });
			for (const d of details) say(`    - ${d}`);
			say(`    FAIL: ${(e as Error)?.message ?? e}`);
			throw e;
		}
	}

	const tree = () => client.tree(runId, asOp());
	const nodeOf = async (agentId: string) => flatten((await tree()).root).find((n) => n.agent_id === agentId);
	const budget = (agentId: string) => client.budget(agentId, asOp());
	const agentByRole = async (title: string) => flatten((await tree()).root).find((n) => n.role === title)?.agent_id;
	const allEvents = async (): Promise<EventView[]> => {
		const evs: EventView[] = [];
		let after = 0;
		for (;;) {
			const r = (await client.events({ run_id: runId, after, limit: 1000 }, asOp())) as { events: EventView[]; next_after?: number };
			evs.push(...r.events);
			if (r.events.length < 1000) return evs;
			after = r.events[r.events.length - 1].seq;
		}
	};
	const live = async (agentId: string) => {
		const n = await nodeOf(agentId);
		return n && n.observed_state === "LIVE" && ["RUNNING", "PAUSED"].includes(n.status) ? n : undefined;
	};
	const reviewQueue = async () => (await client.proposals("review")).proposals;
	const sessionPids = () => q<{ agent_id: string; pid: number; process_started_at: string }>(paths, "SELECT s.agent_id, s.pid, s.process_started_at FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE a.run_id = ? AND s.pid IS NOT NULL", runId);

	/** Root A behaves like the root Pi extension: heartbeat + drain/ack inbox. */
	const startRootLoop = () => {
		rootLoop = (async () => {
			while (!stopRootLoop) {
				try {
					const hb = await client.heartbeat({ busy: true });
					if (hb.inbox_pending > 0) for (const m of (await client.inbox(50)).messages) await client.ack(m.message_id);
				} catch {
					/* controller may be down (step 7) */
				}
				await sleep(500);
			}
		})();
	};

	let failure: unknown = null;
	try {
		// 1 ------------------------------------------------------------------
		await step("Initialize SQLite, register two models, launch root A", async (d) => {
			const h = await startController();
			controllerPids.add(h.pid);
			assert.equal(h.ok, true);
			assert.ok(existsSync(paths.db), "SQLite DB created");
			d.push(`controller pid ${h.pid}, epoch ${h.fencing_epoch}, state dir ${stateDir}`);
			opToken = await readOperatorToken(paths);
			const run = await client.createRun(
				{
					config: {
						workspace_root: workspace,
						limits: { max_live_agents: 12, max_pending_spawns: 8, max_run_usd: 25, emergency_max_depth: 12, max_run_seconds: 0, max_agent_seconds: 0, allow_providers: ["anthropic", "openrouter", "local"] },
						models: [
							{ id: "economy", provider: "local", model: "fake-small-1", capability_tags: ["general"], tool_support: true, cost_per_m_input_usd: 0.1, cost_per_m_output_usd: 0.4, availability: "available" },
							{ id: "strong", provider: "openrouter", model: "fake-large-2", capability_tags: ["general", "reasoning"], tool_support: true, cost_per_m_input_usd: 3, cost_per_m_output_usd: 15, availability: "available" },
						],
					},
					root: { role: "Root A", cwd: workspace, provider: "anthropic", model: "fake-root-0" },
				},
				asOp(),
			);
			runId = run.run_id;
			rootToken = run.token;
			ids.A = run.root_agent_id;
			startRootLoop();
			const models = (await client.models()).models;
			const byId = Object.fromEntries(models.map((m) => [m.id, m]));
			assert.ok(byId.economy?.eligible && byId.strong?.eligible, "both catalog models eligible");
			assert.notEqual(byId.economy.provider, byId.strong.provider);
			assert.notEqual(byId.economy.model, byId.strong.model);
			const tables = q(paths, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
			for (const t of ["agents", "sessions", "spawn_intents", "reservations", "events"]) assert.ok(tables.includes(t), `table ${t}`);
			d.push(`run ${runId}, root A = ${ids.A} (anthropic/fake-root-0)`);
			d.push(`catalog: ${models.map((m) => `${m.id}=${m.provider}/${m.model}`).join(", ")}`);
		});

		// 2 ------------------------------------------------------------------
		await step("Root delegates verification to Lead B on a different model", async (d) => {
			const own = await client.delegateTask({ owner_id: ids.A, title: "Tapeout verification" });
			const req: CreateExpansionRequest = {
				version: 1,
				task_id: own.task_id,
				reason: "need a verification lead",
				alternatives: "verify myself",
				estimated_cost_usd: 3,
				roles: [role("Lead B", "own tapeout verification", 3, { preferred_model_id: "strong" })],
			};
			const prop = await client.requestExpansion(req);
			assert.equal(prop.reviewer_id, ids.A, "root reviews its own proposal");
			const dec = await client.decideExpansion(prop.proposal_id, { decision: "APPROVE", reason: "root approves its lead" });
			assert.equal(dec.status, "APPROVED");
			assert.equal(dec.spawned_agent_ids.length, 1);
			ids.B = dec.spawned_agent_ids[0];
			demoSlots(paths, ids.B, 2);
			const b = await waitUntil("Lead B enrolled (LIVE)", () => live(ids.B));
			const del = await client.delegateTask({ owner_id: ids.B, title: "Verify DRC + LVS", parent_task_id: own.task_id, spec: { scope: "full chip" } });
			const t = await tree();
			assert.equal(t.root.agent_id, ids.A);
			assert.deepEqual(t.root.children.map((c) => c.agent_id), [ids.B]);
			assert.equal(b.model, "openrouter/fake-large-2");
			const rootNode = t.root;
			assert.notEqual(b.model, rootNode.model, "Lead B runs on a different model than root");
			const insp = await client.inspect(ids.B, asOp());
			assert.equal(insp.sessions.length, 1);
			assert.equal(insp.sessions[0].status, "LIVE");
			assert.ok(insp.sessions[0].pid && pidAlive(insp.sessions[0].pid), "B process alive");
			assert.ok(insp.tasks.some((x) => x.task_id === del.task_id), "delegated task persisted for B");
			const ws = q(paths, "SELECT cwd FROM agents WHERE id = ?", ids.B)[0].cwd as string;
			assert.ok(ws.startsWith(join(workspace, ".team-worktrees")), "B works in an isolated worktree");
			d.push(`B = ${ids.B} model ${b.model} (root ${rootNode.model}), pid ${insp.sessions[0].pid}, cwd ${ws}`);
			d.push(`task ${del.task_id} delegated A -> B`);
		});

		// 3 ------------------------------------------------------------------
		await step("B proposes 2 workers; A approves within envelope; C and D spawned", async (d) => {
			const prop = await waitUntil("B's proposal in A's review queue", async () => (await reviewQueue()).find((p) => p.requester_id === ids.B));
			assert.equal(prop.request.roles.length, 2);
			const before = await budget(ids.A);
			const dec = await client.decideExpansion(prop.proposal_id, { decision: "APPROVE", reason: "within B's delegated envelope" });
			assert.equal(dec.status, "APPROVED");
			assert.equal(dec.spawned_agent_ids.length, 2);
			ids.C = (await agentByRole("DRC verifier"))!;
			ids.D = (await agentByRole("LVS verifier"))!;
			assert.ok(ids.C && ids.D);
			demoSlots(paths, ids.C, 0);
			await waitUntil("C and D LIVE", async () => (await live(ids.C)) && (await live(ids.D)));
			const bB = await budget(ids.B);
			const bA = await budget(ids.A);
			assert.equal(bB.limits.max_subtree_slots, 2, "B's envelope raised by the grant");
			assert.equal(bB.reserved_slots, 2);
			assert.equal(bA.reserved_slots, before.reserved_slots + 2);
			assert.equal(q(paths, "SELECT COUNT(*) AS n FROM spawn_intents WHERE proposal_id = ?", prop.proposal_id)[0].n, 2);
			const cNode = (await nodeOf(ids.C))!;
			assert.equal(cNode.parent_id, ids.B);
			assert.equal(cNode.model, "local/fake-small-1");
			d.push(`C = ${ids.C}, D = ${ids.D} (local/fake-small-1)`);
			d.push(`reservations: A ${bA.reserved_slots} slots/$${bA.reserved_usd}, B ${bB.reserved_slots}/${bB.limits.max_subtree_slots} slots/$${bB.reserved_usd}`);
		});

		// 4 ------------------------------------------------------------------
		await step("C proposes nested E beyond envelope; B escalates; A approves bounded grant; E spawned", async (d) => {
			gate("step4");
			const prop = await waitUntil("C's proposal escalated to A", async () => (await reviewQueue()).find((p) => p.requester_id === ids.C && p.status === "ESCALATED"));
			const esc = prop.decisions.find((x) => x.decision === "ESCALATE");
			assert.ok(esc && esc.reviewer_id === ids.B, "B escalated");
			assert.match(esc.reason, /BUDGET_EXCEEDED|envelope/);
			const bBbefore = await budget(ids.B);
			assert.equal(bBbefore.available_slots, 0, "B had no free slot for E");
			const dec = await client.decideExpansion(prop.proposal_id, { decision: "APPROVE", reason: "approved increased bounded grant for nested check" });
			assert.equal(dec.status, "APPROVED");
			ids.E = dec.spawned_agent_ids[0];
			await waitUntil("E LIVE", () => live(ids.E));
			assert.equal((await nodeOf(ids.E))!.parent_id, ids.C);
			const [bB, bC] = [await budget(ids.B), await budget(ids.C)];
			assert.equal(bB.limits.max_subtree_slots, 3, "B envelope raised by A's grant");
			assert.equal(bC.limits.max_subtree_slots, 1, "C envelope raised by A's grant");
			assert.equal(bC.reserved_slots, 1);
			const evs = await allEvents();
			assert.ok(evs.some((e) => e.type === "proposal.escalated" && e.entity_id === prop.proposal_id));
			d.push(`proposal ${prop.proposal_id}: B ESCALATE ("${esc.reason.slice(0, 70)}...") -> A APPROVE`);
			d.push(`E = ${ids.E} under C; envelopes B ${bB.limits.max_subtree_slots} slots, C ${bC.limits.max_subtree_slots} slot`);
		});

		// 5 ------------------------------------------------------------------
		await step("D proposes 100 workers: rejected by global hard cap, audited, nothing spawned", async (d) => {
			const agentsBefore = q(paths, "SELECT COUNT(*) AS n FROM agents WHERE run_id = ?", runId)[0].n;
			const intentsBefore = q(paths, "SELECT COUNT(*) AS n FROM spawn_intents")[0].n;
			gate("step5");
			const prop = await waitUntil("D's proposal decided", () => {
				const r = q(paths, "SELECT * FROM proposals WHERE requester_id = ? AND status = 'REJECTED'", ids.D)[0];
				return r;
			});
			const req = JSON.parse(prop.request_json as string);
			assert.equal(req.roles.reduce((s: number, r: ExpansionRole) => s + r.count, 0), 100);
			const evs = await allEvents();
			const audit = evs.find((e) => e.type === "governance.hard_cap_denied" && e.entity_id === prop.id);
			assert.ok(audit, "hard-cap audit event recorded");
			assert.ok(((audit.payload as { violations: string[] }).violations ?? []).some((v) => v.includes("max_live_agents")));
			assert.equal(q(paths, "SELECT COUNT(*) AS n FROM agents WHERE run_id = ?", runId)[0].n, agentsBefore, "no agents created");
			assert.equal(q(paths, "SELECT COUNT(*) AS n FROM spawn_intents")[0].n, intentsBefore, "no spawn intents");
			const dec = q(paths, "SELECT * FROM proposal_decisions WHERE proposal_id = ?", prop.id as string);
			assert.ok(dec.some((x) => x.decision === "REJECT" && String(x.reason).startsWith("HARD_CAP")));
			d.push(`proposal ${prop.id} REJECTED: ${(audit.payload as { violations: string[] }).violations.join("; ")}`);
		});

		// 6 ------------------------------------------------------------------
		await step("Reparent E from C to B: no cycles, reservations transferred, history kept", async (d) => {
			const t0 = await tree();
			// Cycle guard: B cannot report to E (E is in B's subtree).
			await assert.rejects(
				client.post(`/agents/${ids.B}/reparent`, { new_parent_id: ids.E, expected_topology_version: t0.topology_version, reason: "cycle attempt", pending_work_policy: "retain" }),
				(e: unknown) => e instanceof TeamApiError && e.code === "CONFLICT" && /cycle/.test(e.message),
			);
			const r = (await client.post(`/agents/${ids.E}/reparent`, { new_parent_id: ids.B, expected_topology_version: t0.topology_version, reason: "E's antenna check belongs to the lead", pending_work_policy: "retain" })) as { topology_version: number; old_parent_id: string };
			assert.equal(r.old_parent_id, ids.C);
			const t1 = await tree();
			assert.equal(t1.topology_version, r.topology_version);
			assert.equal(flatten(t1.root).find((n) => n.agent_id === ids.E)!.parent_id, ids.B);
			const hist = t1.history.filter((h) => h.child_id === ids.E);
			assert.ok(hist.some((h) => h.parent_id === ids.C && h.valid_to !== null), "historical C->E edge kept (closed)");
			assert.ok(hist.some((h) => h.parent_id === ids.B && h.valid_to === null), "current B->E edge");
			const [bC, bB, bA] = [await budget(ids.C), await budget(ids.B), await budget(ids.A)];
			assert.equal(bC.reserved_slots, 0, "C no longer carries E's reservation");
			assert.equal(bB.reserved_slots, 3);
			assert.equal(bA.reserved_slots, 4);
			const moved = q(paths, "SELECT state FROM reservations WHERE beneficiary_id = ? AND ancestor_id = ?", ids.E, ids.C);
			assert.deepEqual(moved.map((m) => m.state), ["MOVED"]);
			d.push(`E now reports to B (topology v${r.topology_version}); history: ${hist.map((h) => `${h.parent_id.slice(-6)}->E ${h.valid_to ? "closed" : "open"}`).join(", ")}`);
			d.push(`reserved slots A=${bA.reserved_slots} B=${bB.reserved_slots} C=${bC.reserved_slots}`);
		});

		// 7 ------------------------------------------------------------------
		await step("SIGKILL controller mid-delivery; restart; no duplicates, no lost messages", async (d) => {
			const agentsBefore = q(paths, "SELECT id, status FROM agents WHERE run_id = ? ORDER BY id", runId);
			const sessionsBefore = q(paths, "SELECT id, agent_id, pid FROM sessions WHERE agent_id IN (SELECT id FROM agents WHERE run_id = ?) ORDER BY id", runId);
			const intentsBefore = q(paths, "SELECT id FROM spawn_intents ORDER BY id");
			const workers = [ids.B, ids.C, ids.D, ids.E];
			const pidsBefore = Object.fromEntries(workers.map((a) => [a, q(paths, "SELECT s.pid FROM agents a JOIN sessions s ON s.id = a.current_session_id WHERE a.id = ?", a)[0].pid as number]));
			const BURST = 30;
			const sent: string[] = [];
			for (let i = 0; i < BURST; i++) sent.push((await client.sendMessage({ to: ids.B, type: "question", payload: { seq: i, text: `status check ${i}` } })).message_id);
			const ackedIds = () => new Set(workerEvents(paths, ids.B).filter((e) => e.event === "acked").map((e) => e.message_id));
			await waitUntil("B part-way through the burst", () => [...sent].filter((m) => ackedIds().has(m)).length >= 3, 15_000, 10);
			const h0 = await client.health();
			process.kill(h0.pid, "SIGKILL");
			await waitUntil("controller dead", () => !pidAlive(h0.pid), 5000, 20);
			const ackedAtKill = sent.filter((m) => ackedIds().has(m)).length;
			assert.ok(ackedAtKill < BURST, `killed mid-delivery (acked ${ackedAtKill}/${BURST})`);
			for (const a of workers) assert.ok(pidAlive(pidsBefore[a]), `worker ${a} survived controller death`);
			await sleep(600); // workers hit a dead socket for a few heartbeats
			const h1 = await startController();
			controllerPids.add(h1.pid);
			assert.notEqual(h1.pid, h0.pid);
			assert.ok(h1.fencing_epoch > h0.fencing_epoch, "new fencing epoch");
			await waitUntil("every burst message handled by B", () => sent.every((m) => ackedIds().has(m)), 30_000, 100);
			await waitUntil("all burst deliveries ACKED in DB", () => q(paths, `SELECT COUNT(*) AS n FROM deliveries WHERE message_id IN (${sent.map(() => "?").join(",")}) AND status = 'ACKED'`, ...sent)[0].n === BURST, 15_000);
			const handledOnce = workerEvents(paths, ids.B).filter((e) => e.event === "message" && sent.includes(e.message_id));
			assert.equal(handledOnce.length, BURST, "each message handled exactly once");
			assert.equal(new Set(handledOnce.map((e) => e.message_id)).size, BURST);
			const dups = workerEvents(paths, ids.B).filter((e) => e.event === "duplicate" && sent.includes(e.message_id)).length;
			// No duplicate agents / sessions / spawn intents / processes.
			assert.deepEqual(q(paths, "SELECT id, status FROM agents WHERE run_id = ? ORDER BY id", runId), agentsBefore);
			assert.deepEqual(q(paths, "SELECT id, agent_id, pid FROM sessions WHERE agent_id IN (SELECT id FROM agents WHERE run_id = ?) ORDER BY id", runId), sessionsBefore);
			assert.deepEqual(q(paths, "SELECT id FROM spawn_intents ORDER BY id"), intentsBefore);
			for (const a of workers) {
				assert.equal(workerLogs(paths, a).length, 1, `exactly one worker process ever launched for ${a}`);
				assert.equal(workerEvents(paths, a).filter((e) => e.event === "enrolled").length, 1);
				assert.ok(pidAlive(pidsBefore[a]));
			}
			await waitUntil("all workers LIVE again under the new controller", async () => {
				for (const a of workers) if (!(await live(a))) return false;
				return true;
			});
			const rec = await client.recovery(runId, asOp());
			assert.equal(rec.pending_spawn_intents.length, 0);
			d.push(`burst of ${BURST} messages A->B; SIGKILL controller pid ${h0.pid} after ${ackedAtKill} acks`);
			d.push(`restarted controller pid ${h1.pid}, epoch ${h0.fencing_epoch} -> ${h1.fencing_epoch}`);
			d.push(`all ${BURST} delivered + ACKED, handled once each (${dups} redelivered duplicates suppressed); agents/sessions/intents/processes unchanged`);
		});

		// 8 ------------------------------------------------------------------
		await step("Pause/resume D; complete work; retire subtree; reservations released, cost kept", async (d) => {
			const pr = await client.lifecycle(ids.D, { action: "pause", reason: "operator pause for review" });
			assert.equal(pr.desired_state, "PAUSED");
			await waitUntil("D observes PAUSED", () => workerEvents(paths, ids.D).some((e) => e.event === "desired_state" && e.to === "PAUSED"));
			gate("complete");
			const taskStatus = (agent: string) => q(paths, "SELECT status FROM tasks WHERE owner_id = ?", agent).map((r) => r.status as string);
			await waitUntil("C and E tasks DONE", () => taskStatus(ids.C).every((s) => s === "DONE") && taskStatus(ids.E).every((s) => s === "DONE"));
			await sleep(1500);
			assert.ok(taskStatus(ids.D).every((s) => s !== "DONE"), "paused D did not complete its task");
			const rr = await client.lifecycle(ids.D, { action: "resume", reason: "review done" });
			assert.equal(rr.desired_state, "RUNNING");
			await waitUntil("D task DONE after resume", () => taskStatus(ids.D).every((s) => s === "DONE"));
			await waitUntil("B tasks DONE", () => taskStatus(ids.B).length === 2 && taskStatus(ids.B).every((s) => s === "DONE"));
			// Task artifacts: recorded with sha256 matching the file each worker wrote in its worktree.
			const arts = q(paths, "SELECT agent_id, kind, uri, sha256 FROM artifacts WHERE agent_id IN (?,?,?)", ids.C, ids.D, ids.E);
			assert.equal(arts.length, 3);
			for (const a of arts) {
				assert.equal(createHash("sha256").update(readFileSync(a.uri)).digest("hex"), a.sha256, `artifact ${a.uri} checksum`);
				assert.ok(String(a.uri).startsWith(join(workspace, ".team-worktrees")), "artifact inside the worker's worktree");
			}
			const consumedBefore = Object.fromEntries(await Promise.all([ids.C, ids.D, ids.E].map(async (a) => [a, (await budget(a)).consumed_usd])));
			const ret = await client.lifecycle(ids.B, { action: "retire", reason: "verification complete", children_policy: "cascade" });
			assert.equal(ret.status, "RETIRED");
			assert.deepEqual([...ret.affected_agent_ids].sort(), [ids.B, ids.C, ids.D, ids.E].sort());
			const procs = sessionPids().filter((s) => s.agent_id !== ids.A);
			await waitUntil("all worker processes exited", async () => {
				for (const s of procs) if ((await probeIdentity(s)) === "alive") return false;
				return true;
			}, 15_000);
			for (const a of [ids.B, ids.C, ids.D, ids.E]) assert.equal((await nodeOf(a))!.status, "RETIRED");
			const bA = await budget(ids.A);
			assert.equal(bA.reserved_slots, 0, "root reservations released");
			assert.equal(bA.reserved_usd, 0);
			assert.equal(q(paths, "SELECT COUNT(*) AS n FROM reservations WHERE run_id = ? AND state = 'ACTIVE'", runId)[0].n, 0);
			const roleOf: Record<string, string> = { [ids.C]: "DRC verifier", [ids.D]: "LVS verifier", [ids.E]: "Nested checker" };
			for (const a of [ids.C, ids.D, ids.E]) {
				const c = (await budget(a)).consumed_usd;
				assert.ok(Math.abs(c - USAGE[roleOf[a]]) < 1e-9, `consumed cost of ${roleOf[a]} preserved`);
				assert.equal(c, consumedBefore[a]);
			}
			// Retire revokes the session token AND SIGTERMs the process group: whichever the worker notices first ends it.
			const stopBy = (a: string) => workerEvents(paths, a).find((e) => ["sigterm", "retired", "fenced"].includes(e.event))?.event;
			for (const a of [ids.B, ids.C, ids.D, ids.E]) assert.ok(stopBy(a), `${a} stopped by retire`);
			d.push(`D paused while C/E finished; resumed -> done. ${arts.length} artifacts with verified sha256`);
			d.push(`workers stopped via: ${[ids.B, ids.C, ids.D, ids.E].map(stopBy).join(", ")}`);
			d.push(`retired ${ret.affected_agent_ids.length} agents (cascade); active reservations 0; consumed kept: ${[ids.C, ids.D, ids.E].map((a) => `${roleOf[a]} $${consumedBefore[a]}`).join(", ")}`);
		});

		// 9 ------------------------------------------------------------------
		await step("Write tree.json, events.jsonl, budget.json, test-report.txt", async (d) => {
			mkdirSync(outDir, { recursive: true });
			const t: TreeResponse = await tree();
			writeFileSync(join(outDir, "tree.json"), JSON.stringify(t, null, 2));
			const evs = await allEvents();
			writeFileSync(join(outDir, "events.jsonl"), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
			const budgets: Record<string, BudgetView & { role: string }> = {};
			for (const n of flatten(t.root)) budgets[n.agent_id] = { role: n.role, ...(await budget(n.agent_id)) };
			writeFileSync(join(outDir, "budget.json"), JSON.stringify({ run_id: runId, budgets }, null, 2));
			const types = new Set(evs.map((e) => e.type));
			for (const ty of ["run.created", "proposal.approved", "proposal.escalated", "governance.hard_cap_denied", "agent.reparented", "agent.lifecycle", "agent.terminated", "usage.reported", "task.completed"]) {
				assert.ok(types.has(ty), `events.jsonl contains ${ty}`);
			}
			for (const f of ["tree.json", "events.jsonl", "budget.json"]) assert.ok(readFileSync(join(outDir, f), "utf8").length > 10);
			d.push(`${outDir}: tree.json (${flatten(t.root).length} agents, ${t.history.length} edges), events.jsonl (${evs.length} events), budget.json`);
		});
	} catch (e) {
		failure = e;
	}

	// ---- teardown: stop everything, then prove no stray processes ----------
	stopRootLoop = true;
	await rootLoop;
	let pids: { agent_id: string; pid: number; process_started_at: string }[] = [];
	try {
		pids = runId ? sessionPids() : [];
	} catch {
		/* db missing */
	}
	try {
		if (opToken) await client.shutdown(true, asOp()).catch(() => {});
		await waitUntil("controller exited", () => [...controllerPids].every((p) => !pidAlive(p)), 10_000).catch(() => {});
	} finally {
		for (const p of controllerPids) if (pidAlive(p)) process.kill(p, "SIGKILL");
		for (const s of pids) await stopIdentity(s, 1000).catch(() => {});
	}
	const strayPids = [...pids.map((s) => s.pid), ...controllerPids].filter((p) => pidAlive(p));

	// ---- report ------------------------------------------------------------
	const ok = !failure && steps.length === 9 && steps.every((s) => s.ok) && strayPids.length === 0;
	const report = [
		`pi-recursive-team demo — ${new Date().toISOString()}`,
		`result: ${ok ? "PASS" : "FAIL"}  (${steps.filter((s) => s.ok).length}/9 steps passed, stray processes: ${strayPids.length ? strayPids.join(",") : "none"})`,
		`run: ${runId}  state dir: ${stateDir}${opts.keep ? " (kept)" : " (removed)"}`,
		`agents: ${Object.entries(ids).map(([k, v]) => `${k}=${v}`).join(" ")}`,
		"",
		...steps.flatMap((s) => [`[${s.ok ? "PASS" : "FAIL"}] ${s.n}. ${s.name} (${s.ms} ms)`, ...s.details.map((x) => `       ${x}`), ...(s.error ? [`       ERROR: ${s.error.split("\n").slice(0, 3).join(" | ")}`] : [])]),
		"",
	].join("\n");
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "test-report.txt"), report);
	say(`\n${report}`);
	say(`outputs: ${outDir}`);

	if (!opts.keep) {
		rmSync(stateDir, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
	}
	return { ok, steps, outDir, stateDir, strayPids };
}

// ---- CLI -------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const outIdx = args.indexOf("--out");
	runDemo({ outDir: outIdx >= 0 ? args[outIdx + 1] : undefined, keep: args.includes("--keep") }).then(
		(r) => process.exit(r.ok ? 0 : 1),
		(e) => {
			process.stderr.write(`demo crashed: ${String((e as Error)?.stack ?? e)}\n`);
			process.exit(2);
		},
	);
}
