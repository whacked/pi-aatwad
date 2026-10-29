import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { StubExecutor, harness, newRun, ownTask, proposal, recruit, sql, waitFor, type Harness } from "./helpers.ts";

async function approveOne(hs: Harness, rootTok: string, root: string, count = 1): Promise<string[]> {
	const t = await ownTask(hs, rootTok, root);
	const p = await hs.call("POST", "/expansions", { token: rootTok, body: proposal(t, [{ count }]) });
	const d = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: rootTok, body: { decision: "APPROVE", reason: "go" } });
	assert.equal(d.status, 200, JSON.stringify(d.body));
	return d.body.spawned_agent_ids;
}
const intent = (hs: Harness, agent: string) => sql(hs, "SELECT * FROM spawn_intents WHERE agent_id = ?", agent)[0];

test("restart preserves state and bumps the fencing epoch", async () => {
	const hs = await harness();
	try {
		const { run_id, root, token } = await newRun(hs);
		const [a] = await recruit(hs, token, token, await ownTask(hs, token, root), [{}]);
		const e1 = hs.h.epoch;
		const tree1 = (await hs.call("GET", `/runs/${run_id}/tree`, { token: hs.op })).body;
		await hs.restart();
		assert.equal(hs.h.epoch, e1 + 1);
		assert.equal((await hs.call("GET", "/health")).body.fencing_epoch, e1 + 1);
		const tree2 = (await hs.call("GET", `/runs/${run_id}/tree`, { token: hs.op })).body;
		assert.deepEqual(tree2, tree1);
		// Tokens survive a controller restart (sessions are not tied to the controller process).
		assert.equal((await hs.call("GET", "/me", { token: hs.ex.tokens.get(a)! })).status, 200);
		await hs.h.reconciler.idle();
		assert.equal(hs.ex.launchesFor(a).length, 1, "live worker is not relaunched");
	} finally {
		await hs.cleanup();
	}
});

test("crash between durable spawn intent and launch recovers without duplicates", async () => {
	const ex = new StubExecutor();
	ex.mode = "hang"; // launch() never returns: the controller 'crashes' while the launch outcome is unknown
	const hs = await harness({ executor: ex });
	try {
		const { root, token } = await newRun(hs);
		const [a] = await approveOne(hs, token, root);
		await waitFor(() => intent(hs, a).status === "LAUNCHING", "LAUNCHING");
		const oldCredFile = sql(hs, "SELECT enroll_file FROM enrollment_credentials WHERE agent_id = ?", a)[0].enroll_file;
		const oldCred = JSON.parse(readFileSync(oldCredFile, "utf8"));
		await hs.restart({ crash: true, ex: Object.assign(new StubExecutor(), { mode: "enroll" }) });
		await waitFor(() => hs.ex.tokens.has(a), "re-enrollment after recovery");
		await hs.h.reconciler.idle();
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM agents")[0].n, 2, "same agent identity, no duplicate agent");
		assert.equal(hs.ex.launches.length, 1, "exactly one relaunch");
		const sessions = sql(hs, "SELECT status, generation FROM sessions WHERE agent_id = ? ORDER BY generation", a);
		assert.deepEqual(sessions.map((s) => s.status), ["FAILED", "LIVE"]);
		assert.equal(intent(hs, a).status, "LIVE");
		// A late process holding the old credential is fenced.
		const late = await hs.call("POST", "/enroll", { body: { token: oldCred.token, agent_id: a, spawn_intent_id: oldCred.spawn_intent_id, pid: 1 } });
		assert.equal(late.body.error.code, "STALE_SESSION");
		assert.ok(sql(hs, "SELECT COUNT(*) n FROM events WHERE type = 'spawn.recovered' AND entity_id = ?", a)[0].n === 1);
	} finally {
		await hs.cleanup();
	}
});

test("crash after process start: live launched worker is probed and kept (no relaunch); dead one is relaunched", async () => {
	const ex = new StubExecutor();
	ex.mode = "silent"; // started, identity recorded, but not yet enrolled
	const hs = await harness({ executor: ex });
	try {
		const { root, token } = await newRun(hs);
		const [a, b] = await approveOne(hs, token, root, 2);
		await waitFor(() => intent(hs, a).status === "LAUNCHED" && intent(hs, b).status === "LAUNCHED", "LAUNCHED");
		const [la, lb] = [ex.launchesFor(a)[0], ex.launchesFor(b)[0]];
		ex.alive.delete(lb.id.pid); // b died while the controller was down
		await hs.restart({ crash: true });
		await hs.h.reconciler.idle();
		await waitFor(() => ex.launchesFor(b).length === 2, "relaunch of dead b");
		assert.equal(ex.launchesFor(a).length, 1, "alive a not relaunched");
		assert.equal(intent(hs, a).status, "LAUNCHED");
		// a now finishes starting and enrolls with its original credential.
		const f = JSON.parse(readFileSync(la.spec.enroll_file, "utf8"));
		const r = await hs.call("POST", "/enroll", { body: { token: f.token, agent_id: a, spawn_intent_id: f.spawn_intent_id, pid: la.id.pid } });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(sql(hs, "SELECT observed_state FROM agents WHERE id = ?", a)[0].observed_state, "LIVE");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM sessions WHERE agent_id = ?", b)[0].n, 2);
	} finally {
		await hs.cleanup();
	}
});

test("crash after enroll file consumed but before identity commit: waits for enrollment instead of relaunching", async () => {
	const ex = new StubExecutor();
	ex.mode = "hang";
	const hs = await harness({ executor: ex, tunables: { launchGraceMs: 60_000 } });
	try {
		const { root, token } = await newRun(hs);
		const [a] = await approveOne(hs, token, root);
		await waitFor(() => intent(hs, a).status === "LAUNCHING");
		const file = sql(hs, "SELECT enroll_file FROM enrollment_credentials WHERE agent_id = ?", a)[0].enroll_file;
		const cred = JSON.parse(readFileSync(file, "utf8"));
		unlinkSync(file); // the (real) worker consumed it
		const ex2 = new StubExecutor();
		await hs.restart({ crash: true, ex: ex2 });
		await hs.h.reconciler.idle();
		assert.equal(ex2.launches.length, 0, "no blind relaunch while launch outcome is uncertain");
		const r = await hs.call("POST", "/enroll", { body: { token: cred.token, agent_id: a, spawn_intent_id: cred.spawn_intent_id, pid: 4242, process_started_at: "t0" } });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		const s = sql(hs, "SELECT pid, process_started_at, status FROM sessions WHERE agent_id = ?", a);
		assert.deepEqual({ ...s[0] }, { pid: 4242, process_started_at: "t0", status: "LIVE" }, "identity learned from enrollment");
	} finally {
		await hs.cleanup();
	}
});

test("enrollment credential: mismatched, single-use, expired are rejected; file is 0600", async () => {
	const ex = new StubExecutor();
	ex.mode = "silent";
	const hs = await harness({ executor: ex, tunables: { enrollTtlMs: 400 } });
	try {
		const { root, token } = await newRun(hs);
		const [a, b] = await approveOne(hs, token, root, 2);
		await waitFor(() => ex.launches.length === 2);
		const fa = ex.launchesFor(a)[0].spec.enroll_file;
		const { statSync } = await import("node:fs");
		assert.equal(statSync(fa).mode & 0o777, 0o600);
		const ca = JSON.parse(readFileSync(fa, "utf8"));
		assert.equal((await hs.call("POST", "/enroll", { body: { token: ca.token, agent_id: b, spawn_intent_id: ca.spawn_intent_id, pid: 1 } })).body.error.code, "UNAUTHENTICATED");
		assert.equal((await hs.call("POST", "/enroll", { body: { token: "pte_bogus", agent_id: a, spawn_intent_id: ca.spawn_intent_id, pid: 1 } })).body.error.code, "UNAUTHENTICATED");
		assert.equal((await hs.call("POST", "/enroll", { body: { token: ca.token, agent_id: a, spawn_intent_id: ca.spawn_intent_id, pid: 1, launch_token: "wrong" } })).body.error.code, "UNAUTHENTICATED");
		const ok = await hs.call("POST", "/enroll", { body: { token: ca.token, agent_id: a, spawn_intent_id: ca.spawn_intent_id, pid: 1, launch_token: ex.launchesFor(a)[0].id.launch_token } });
		assert.equal(ok.status, 200);
		const again = await hs.call("POST", "/enroll", { body: { token: ca.token, agent_id: a, spawn_intent_id: ca.spawn_intent_id, pid: 1 } });
		assert.equal(again.body.error.code, "UNAUTHENTICATED");
		assert.match(again.body.error.message, /already used/);
		const cb = JSON.parse(readFileSync(ex.launchesFor(b)[0].spec.enroll_file, "utf8"));
		await new Promise((r) => setTimeout(r, 450));
		const exp = await hs.call("POST", "/enroll", { body: { token: cb.token, agent_id: b, spawn_intent_id: cb.spawn_intent_id, pid: 1 } });
		assert.equal(exp.body.error.code, "UNAUTHENTICATED");
		assert.match(exp.body.error.message, /expired/);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM enrollment_credentials WHERE token_hash LIKE 'pte_%'")[0].n, 0, "only hashes stored");
		// Secrets never in the log.
		const log = readFileSync(`${hs.dir}/controller.log`, "utf8");
		assert.ok(!log.includes(ca.token) && !log.includes(token) && !log.includes(hs.op));
	} finally {
		await hs.cleanup();
	}
});

test("stale heartbeat with live process → LOST → (after hung grace) stopped and restarted as a new session; old token fenced", async () => {
	const hs = await harness({ tunables: { leaseMs: 150, hungMs: 100 } });
	try {
		const { run_id, root, token } = await newRun(hs);
		const [a] = await recruit(hs, token, token, await ownTask(hs, token, root), [{}]);
		const oldTok = hs.ex.tokens.get(a)!;
		const pid1 = hs.ex.launchesFor(a)[0].id.pid;
		// Process stays alive but stops heartbeating.
		await waitFor(() => sql(hs, "SELECT COUNT(*) n FROM events WHERE type = 'agent.lost' AND entity_id = ?", a)[0].n === 1, "LOST");
		await waitFor(() => hs.ex.launchesFor(a).length === 2 && hs.ex.tokens.get(a) !== oldTok, "restart", 5000);
		assert.ok(hs.ex.stopped.includes(pid1), "hung process stopped before relaunch (no duplicate)");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM agents")[0].n, 2);
		const l2 = hs.ex.launchesFor(a)[1].spec;
		assert.equal(l2.resume, true);
		assert.ok(l2.resume_prompt);
		assert.equal(l2.pi_session_path, hs.ex.launchesFor(a)[0].spec.pi_session_path);
		assert.equal((await hs.call("GET", "/me", { token: oldTok })).body.error.code, "STALE_SESSION");
		assert.equal((await hs.call("POST", "/sessions/heartbeat", { token: hs.ex.tokens.get(a)!, body: {} })).status, 200);
		assert.ok(sql(hs, "SELECT COUNT(*) n FROM events WHERE type = 'agent.restart_scheduled' AND entity_id = ?", a)[0].n >= 1);
		assert.deepEqual(sql(hs, "SELECT generation FROM sessions WHERE agent_id = ? ORDER BY generation", a).map((r) => r.generation).slice(0, 2), [1, 2]);
		// Root is never auto-restarted; it becomes LOST and comes back via explicit attach.
		await waitFor(() => sql(hs, "SELECT observed_state s FROM agents WHERE id = ?", root)[0].s === "LOST", "root LOST");
		const at = await hs.call("POST", `/runs/${run_id}/attach`, { token: hs.op, body: {} });
		assert.equal(at.body.agent_id, root);
		assert.equal((await hs.call("GET", "/me", { token })).body.error.code, "STALE_SESSION");
		assert.equal((await hs.call("GET", "/me", { token: at.body.token })).status, 200);
	} finally {
		await hs.cleanup();
	}
});

test("one-shot worker exit is STOPPED (not LOST); relaunched with resume only when work is pending", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const [a] = await recruit(hs, token, token, await ownTask(hs, token, root), [{}]);
		const tokA = hs.ex.tokens.get(a)!;
		// Worker drains its inbox and completes its task, then its process exits.
		for (const m of (await hs.call("GET", "/inbox", { token: tokA })).body.messages) await hs.call("POST", `/messages/${m.message_id}/ack`, { token: tokA });
		const task = (await hs.call("GET", "/me", { token: tokA })).body.tasks[0].task_id;
		assert.equal((await hs.call("POST", `/tasks/${task}/complete`, { token: tokA, body: { summary: "done" } })).status, 200);
		hs.ex.alive.delete(hs.ex.launchesFor(a)[0].id.pid);
		await waitFor(() => sql(hs, "SELECT observed_state s FROM agents WHERE id = ?", a)[0].s === "STOPPED", "STOPPED");
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id = ?", a)[0].status, "RUNNING", "agent keeps its position");
		assert.equal(sql(hs, "SELECT status FROM sessions WHERE agent_id = ?", a)[0].status, "STOPPED");
		await new Promise((r) => setTimeout(r, 200));
		await hs.h.reconciler.idle();
		assert.equal(hs.ex.launchesFor(a).length, 1, "no pending work → no relaunch");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM events WHERE type = 'agent.lost' AND entity_id = ?", a)[0].n, 0);
		// New work arrives → relaunched as same agent, new session, resume=true; old token fenced.
		await hs.call("POST", "/tasks", { token, body: { owner_id: a, title: "follow-up" } });
		await waitFor(() => hs.ex.launchesFor(a).length === 2 && hs.ex.tokens.get(a) !== tokA, "relaunch on new work");
		const l2 = hs.ex.launchesFor(a)[1].spec;
		assert.equal(l2.resume, true);
		assert.equal(l2.agent_id, a);
		assert.equal(l2.cwd, hs.ex.launchesFor(a)[0].spec.cwd);
		assert.equal((await hs.call("GET", "/me", { token: tokA })).body.error.code, "STALE_SESSION");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM agents")[0].n, 2);
	} finally {
		await hs.cleanup();
	}
});

test("launch failures retry then fail the agent and release its reservations", async () => {
	const ex = new StubExecutor();
	ex.mode = "fail";
	const hs = await harness({ executor: ex, tunables: { maxLaunchAttempts: 2 } });
	try {
		const { root, token } = await newRun(hs);
		const [a] = await approveOne(hs, token, root);
		await waitFor(() => intent(hs, a).status === "FAILED", "FAILED intent");
		assert.equal(intent(hs, a).attempts, 2);
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id = ?", a)[0].status, "FAILED");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM reservations WHERE beneficiary_id = ? AND state = 'ACTIVE'", a)[0].n, 0);
		assert.equal(sql(hs, "SELECT reserved_slots n FROM allocations WHERE agent_id = ?", root)[0].n, 0);
		assert.ok(!existsSync(sql(hs, "SELECT enroll_file f FROM enrollment_credentials WHERE agent_id = ? LIMIT 1", a)[0].f));
		const rec = (await hs.call("GET", `/runs/${sql(hs, "SELECT run_id FROM agents WHERE id = ?", a)[0].run_id}/recovery`, { token: hs.op })).body;
		assert.equal(rec.pending_spawn_intents.length, 0);
	} finally {
		await hs.cleanup();
	}
});
