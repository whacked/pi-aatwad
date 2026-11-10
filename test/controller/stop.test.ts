import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, ownTask, recruit, sql, waitFor } from "./helpers.ts";

test("cancelled runs remain in history with accurate status and stop is idempotent", async () => {
	const hs = await harness();
	try {
		const r = await newRun(hs);
		const body = { action: "cancel", reason: "operator stop", children_policy: "cascade" };
		const stopped = await hs.call("POST", `/agents/${r.root}/lifecycle`, { token: hs.op, body });
		assert.equal(stopped.status, 200);
		const stale = await hs.call("GET", "/me", { token: r.token });
		assert.equal(stale.body.error.details.reason, "agent_terminal");
		assert.equal(stale.body.error.details.agent_status, "CANCELLED");
		const again = await hs.call("POST", `/agents/${r.root}/lifecycle`, { token: hs.op, body });
		assert.equal(again.status, 200);
		assert.deepEqual(again.body.affected_agent_ids, []);
		assert.equal(sql(hs, "SELECT status FROM runs WHERE id=?", r.run_id)[0].status, "CANCELLED");
		const runs = await hs.call("GET", "/runs", { token: hs.op });
		assert.equal(runs.body.runs[0].status, "CANCELLED");
		assert.equal(runs.body.runs[0].root_status, "CANCELLED");
	} finally { await hs.cleanup(); }
});

test("genuine supersession is still distinguished from cancellation", async () => {
	const hs = await harness();
	try {
		const r = await newRun(hs);
		await hs.call("POST", `/runs/${r.run_id}/attach`, { token: hs.op, body: {} });
		const stale = await hs.call("GET", "/me", { token: r.token });
		assert.equal(stale.body.error.code, "STALE_SESSION");
		assert.equal(stale.body.error.details.reason, "superseded");
	} finally { await hs.cleanup(); }
});

test("cascade cancellation settles workers once and preserves replay across restart", async () => {
	const hs = await harness();
	try {
		const r = await newRun(hs);
		const task = await ownTask(hs, r.token, r.root);
		const [worker] = await recruit(hs, r.token, hs.op, task, [{}]);
		await hs.h.reconciler.stop();
		hs.h.db.prepare("UPDATE allocations SET consumed_usd = 0.25 WHERE agent_id = ?").run(worker);
		const body = { action: "cancel", reason: "stop", children_policy: "cascade" };
		const first = await hs.call("POST", `/agents/${r.root}/lifecycle`, { token: hs.op, body, key: "first-stop" });
		assert.equal(first.status, 200);
		assert.deepEqual(new Set(first.body.affected_agent_ids), new Set([worker, r.root]));
		await waitFor(() => hs.ex.stopped.length === 1);
		assert.equal(sql(hs, "SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL")[0].n, 0);
		assert.ok(sql(hs, "SELECT status FROM spawn_intents").every(a => a.status === "CANCELLED"));
		assert.ok(sql(hs, "SELECT status FROM tasks").every(a => a.status === "CANCELLED"));
		assert.equal(sql(hs, "SELECT COUNT(*) AS n FROM reservations WHERE state = 'ACTIVE'")[0].n, 0);
		assert.equal(sql(hs, "SELECT SUM(usd) AS n FROM reservations WHERE state = 'CONSUMED'")[0].n, 0.25);
		const snapshot = () => ({ sessions: sql(hs, "SELECT * FROM sessions"), reservations: sql(hs, "SELECT * FROM reservations"), events: sql(hs, "SELECT * FROM events") });
		const before = snapshot();
		const replay = await hs.call("POST", `/agents/${r.root}/lifecycle`, { token: hs.op, body, key: "first-stop" });
		assert.deepEqual(replay, first);
		const again = await hs.call("POST", `/agents/${r.root}/lifecycle`, { token: hs.op, body, key: "second-stop" });
		assert.equal(again.status, 200);
		assert.deepEqual(again.body.affected_agent_ids, []);
		assert.deepEqual(snapshot(), before);
		assert.equal(hs.ex.stopped.length, 1);
		assert.equal(sql(hs, "SELECT COUNT(*) AS n FROM events WHERE type = 'run.status_changed'")[0].n, 1);
		await hs.restart();
		const restarted = await hs.call("POST", `/agents/${r.root}/lifecycle`, { token: hs.op, body });
		assert.equal(restarted.status, 200);
		assert.deepEqual(restarted.body.affected_agent_ids, []);
		assert.deepEqual(snapshot(), before);
		assert.equal(hs.ex.stopped.length, 1);
	} finally { await hs.cleanup(); }
});

test("cancelled roots still clean up surviving descendants and stopped sessions with live processes", async () => {
	const hs = await harness();
	try {
		const r = await newRun(hs);
		const task = await ownTask(hs, r.token, r.root);
		const [worker] = await recruit(hs, r.token, hs.op, task, [{}]);
		await hs.h.reconciler.stop();
		// Simulate an older/interrupted cancellation that only changed the root.
		hs.h.db.prepare("UPDATE agents SET status = 'CANCELLED' WHERE id = ?").run(r.root);
		const body = { action: "cancel", reason: "recover stop", children_policy: "cascade" };
		const stopped = await hs.call("POST", `/agents/${r.root}/lifecycle`, { token: hs.op, body });
		assert.equal(stopped.status, 200);
		assert.deepEqual(stopped.body.affected_agent_ids, [worker]);
		await waitFor(() => hs.ex.stopped.length === 1);
		assert.ok(sql(hs, "SELECT status, desired_state, observed_state FROM agents").every(a => a.status === "CANCELLED" && a.desired_state === "RETIRED" && a.observed_state === "STOPPED"));
		assert.equal(sql(hs, "SELECT status FROM runs")[0].status, "CANCELLED");
		assert.equal(sql(hs, "SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL")[0].n, 0);
		assert.equal(sql(hs, "SELECT COUNT(*) AS n FROM reservations WHERE state = 'ACTIVE'")[0].n, 0);
		// A failed post-commit process stop must be retried even though the session is STOPPED.
		const pid = hs.ex.launchesFor(worker)[0].id.pid;
		hs.ex.alive.add(pid);
		hs.h.db.prepare("UPDATE sessions SET ended_at = NULL WHERE agent_id = ?").run(r.root);
		hs.h.db.prepare("UPDATE spawn_intents SET status = 'PENDING' WHERE agent_id = ?").run(worker);
		hs.h.db.prepare("UPDATE tasks SET status = 'ASSIGNED' WHERE owner_id = ?").run(worker);
		hs.h.db.prepare("UPDATE reservations SET state = 'ACTIVE', released_at = NULL WHERE beneficiary_id = ?").run(worker);
		const ended = sql(hs, "SELECT ended_at FROM sessions WHERE agent_id = ?", worker);
		const again = await hs.call("POST", `/agents/${r.root}/lifecycle`, { token: hs.op, body });
		assert.equal(again.status, 200);
		await waitFor(() => hs.ex.stopped.length === 2);
		assert.equal(hs.ex.alive.has(pid), false);
		assert.equal(sql(hs, "SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL")[0].n, 0);
		assert.ok(sql(hs, "SELECT status FROM spawn_intents").every(a => a.status === "CANCELLED"));
		assert.ok(sql(hs, "SELECT status FROM tasks").every(a => a.status === "CANCELLED"));
		assert.equal(sql(hs, "SELECT COUNT(*) AS n FROM reservations WHERE state = 'ACTIVE'")[0].n, 0);
		assert.deepEqual(sql(hs, "SELECT ended_at FROM sessions WHERE agent_id = ?", worker), ended);
	} finally { await hs.cleanup(); }
});

test("startup reconciles historical terminal roots and cancellation remains authorized and fenced", async () => {
	const hs = await harness();
	try {
		const r = await newRun(hs);
		const other = await newRun(hs);
		const body = { action: "cancel", reason: "stop", children_policy: "cascade" };
		await hs.call("POST", `/agents/${r.root}/lifecycle`, { token: hs.op, body });
		hs.h.db.prepare("UPDATE runs SET status = 'RUNNING' WHERE id = ?").run(r.run_id);
		await hs.restart();
		assert.equal(sql(hs, "SELECT status FROM runs WHERE id = ?", r.run_id)[0].status, "CANCELLED");
		const listing = await hs.call("GET", "/runs", { token: hs.op });
		assert.equal(listing.body.runs.find((x: any) => x.run_id === r.run_id).status, "CANCELLED");
		const denied = await hs.call("POST", `/agents/${r.root}/lifecycle`, { token: other.token, body });
		assert.equal(denied.status, 403);
		const unauth = await hs.call("POST", `/agents/${r.root}/lifecycle`, { body });
		assert.equal(unauth.status, 401);
		const resume = await hs.call("POST", `/agents/${r.root}/lifecycle`, { token: hs.op, body: { action: "resume", reason: "invalid" } });
		assert.equal(resume.status, 409);
		const attach = await hs.call("POST", `/runs/${r.run_id}/attach`, { token: hs.op, body: {} });
		assert.equal(attach.status, 409);
	} finally { await hs.cleanup(); }
});

test("non-root cancellation leaves the run running", async () => {
	const hs = await harness();
	try {
		const r = await newRun(hs);
		const task = await ownTask(hs, r.token, r.root);
		const [worker] = await recruit(hs, r.token, hs.op, task, [{}]);
		const stopped = await hs.call("POST", `/agents/${worker}/lifecycle`, { token: hs.op, body: { action: "cancel", reason: "worker only", children_policy: "cascade" } });
		assert.equal(stopped.status, 200);
		assert.equal(sql(hs, "SELECT status FROM runs")[0].status, "RUNNING");
		assert.equal(sql(hs, "SELECT COUNT(*) AS n FROM events WHERE type = 'run.status_changed'")[0].n, 0);
	} finally { await hs.cleanup(); }
});
