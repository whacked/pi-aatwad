import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, ownTask, recruit, sql, waitFor } from "./helpers.ts";

test("runtime deadline (policy BLOCKED): process stopped, task BLOCKED, agent paused, manager notified; resume relaunches", { timeout: 20_000 }, async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const [a] = await recruit(hs, token, token, await ownTask(hs, token, root), [{ max_runtime_seconds: 1 }]);
		const tokA = hs.ex.tokens.get(a)!;
		const pid = hs.ex.launchesFor(a)[0].id.pid;
		const ev = await waitFor(() => sql(hs, "SELECT payload_json FROM events WHERE type = 'agent.deadline_exceeded' AND entity_id = ?", a)[0], "deadline event", 5000);
		const payload = JSON.parse(ev.payload_json);
		assert.equal(payload.kind, "runtime");
		assert.equal(payload.policy, "BLOCKED");
		await waitFor(() => hs.ex.stopped.includes(pid), "executor.stop");
		const ag = sql(hs, "SELECT status, desired_state, observed_state FROM agents WHERE id = ?", a)[0];
		assert.deepEqual({ ...ag }, { status: "PAUSED", desired_state: "PAUSED", observed_state: "STOPPED" });
		assert.equal(sql(hs, "SELECT status FROM tasks WHERE owner_id = ?", a)[0].status, "BLOCKED");
		const notice = sql(hs, "SELECT payload_json FROM messages WHERE recipient_id = ? AND type = 'system.notice'", root).map((m) => JSON.parse(m.payload_json));
		assert.ok(notice.some((n) => n.kind === "deadline_exceeded" && n.agent_id === a));
		assert.equal((await hs.call("GET", "/me", { token: tokA })).body.error.code, "STALE_SESSION");
		// Reservations are kept while paused (agent keeps its position and budget).
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM reservations WHERE beneficiary_id = ? AND state = 'ACTIVE'", a)[0].n, 1);
		await hs.h.reconciler.idle();
		assert.equal(hs.ex.launchesFor(a).length, 1, "paused agent is not relaunched");
		// Resume restarts the runtime clock, unblocks the task and relaunches as a new session.
		const rs = await hs.call("POST", `/agents/${a}/lifecycle`, { token, body: { action: "resume", reason: "more time" } });
		assert.equal(rs.status, 200, JSON.stringify(rs.body));
		await waitFor(() => hs.ex.launchesFor(a).length === 2 && hs.ex.tokens.get(a) !== tokA, "relaunch after resume");
		assert.equal(hs.ex.launchesFor(a)[1].spec.resume, true);
		assert.equal(sql(hs, "SELECT status FROM tasks WHERE owner_id = ?", a)[0].status, "ASSIGNED");
	} finally {
		await hs.cleanup();
	}
});

test("session deadline (policy FAILED): process stopped, task FAILED, agent FAILED, reservations released", { timeout: 20_000 }, async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs, { deadline_policy: "FAILED", limits: { max_agent_seconds: 1 } });
		const [a] = await recruit(hs, token, token, await ownTask(hs, token, root), [{}]);
		const pid = hs.ex.launchesFor(a)[0].id.pid;
		await waitFor(() => sql(hs, "SELECT status FROM agents WHERE id = ?", a)[0].status === "FAILED", "agent FAILED", 5000);
		const ev = JSON.parse(sql(hs, "SELECT payload_json FROM events WHERE type = 'agent.deadline_exceeded' AND entity_id = ?", a)[0].payload_json);
		assert.equal(ev.kind, "session");
		assert.equal(ev.policy, "FAILED");
		await waitFor(() => hs.ex.stopped.includes(pid), "executor.stop");
		assert.equal(sql(hs, "SELECT status FROM tasks WHERE owner_id = ?", a)[0].status, "FAILED");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM reservations WHERE beneficiary_id = ? AND state = 'ACTIVE'", a)[0].n, 0);
		assert.equal(sql(hs, "SELECT reserved_slots n FROM allocations WHERE agent_id = ?", root)[0].n, 0);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM messages WHERE recipient_id = ? AND type = 'system.notice' AND payload_json LIKE '%deadline_exceeded%'", root)[0].n, 1);
		// Root (no managed process) is never subject to the worker deadline.
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id = ?", root)[0].status, "RUNNING");
	} finally {
		await hs.cleanup();
	}
});
