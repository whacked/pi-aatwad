import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, sql, waitFor } from "./helpers.ts";

const notices = (hs: Awaited<ReturnType<typeof harness>>, root: string, kind: string) =>
	sql(hs, "SELECT payload_json FROM messages WHERE recipient_id=? AND type='system.notice' AND json_extract(payload_json,'$.kind')=?", root, kind).map((r) => JSON.parse(r.payload_json));

test("default members have no lifetime timer; completion preserves membership and communication", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const created = await hs.call("POST", "/members", { token, body: { responsibility: "do a task then wait" } });
		assert.equal(created.status, 200, JSON.stringify(created.body));
		const id = created.body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(id));
		const worker = hs.ex.tokens.get(id)!;
		const task = sql(hs, "SELECT id FROM tasks WHERE owner_id=?", id)[0].id;
		assert.equal(JSON.parse(sql(hs, "SELECT metadata_json FROM agents WHERE id=?", id)[0].metadata_json).max_runtime_seconds, null);
		assert.equal(JSON.parse(sql(hs, "SELECT limits_json FROM allocations WHERE agent_id=?", id)[0].limits_json).max_session_seconds, 0);
		assert.equal((await hs.call("POST", `/tasks/${task}/complete`, { token: worker, body: { summary: "done" } })).status, 200);
		// Older than both the old 600s convenience default and the 3600s global cap.
		hs.h.db.prepare("UPDATE sessions SET started_at=? WHERE agent_id=?").run(new Date(Date.now() - 7200_000).toISOString(), id);
		await hs.h.reconciler.enforceDeadlines();
		assert.equal(sql(hs, "SELECT desired_state FROM agents WHERE id=?", id)[0].desired_state, "RUNNING");
		assert.equal(hs.ex.stopped.length, 0);
		assert.equal((await hs.call("POST", `/agents/${id}/lifecycle`, { token: worker, body: { action: "retire", reason: "finished" } })).body.error.code, "FORBIDDEN");
		assert.equal((await hs.call("POST", "/messages", { token, body: { to: id, type: "question", payload: { text: "next job" } } })).status, 200);
		const inbox = await hs.call("GET", "/inbox", { token: worker });
		assert.ok(inbox.body.messages.some((m: any) => m.payload.text === "next job"));
		assert.equal((await hs.call("GET", "/me", { token: worker })).status, 200);
		assert.equal(notices(hs, root, "deadline_exceeded").length, 0);
	} finally { await hs.cleanup(); }
});

test("terminal worker death, restart scheduling and lease loss notify the manager once", async () => {
	const hs = await harness({ tunables: { tickMs: 60_000 } });
	try {
		const { root, token, run_id } = await newRun(hs);
		await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: {} });
		const created = await hs.call("POST", "/members", { token, body: { responsibility: "remain available" } });
		const id = created.body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(id));
		await hs.h.reconciler.idle();
		const old = hs.ex.launchesFor(id)[0];
		hs.ex.alive.delete(old.id.pid);
		await hs.h.reconciler.observeExits();
		await hs.h.reconciler.observeExits();
		assert.equal(notices(hs, root, "worker_exited").length, 1);
		assert.equal(sql(hs, "SELECT observed_state FROM agents WHERE id=?", id)[0].observed_state, "STOPPED");
		await hs.h.reconciler.scheduleRestarts();
		assert.equal(notices(hs, root, "worker_restart_scheduled").length, 1);
		await hs.h.reconciler.tick();
		await waitFor(() => hs.ex.launchesFor(id).length === 2);
		await waitFor(() => sql(hs, "SELECT observed_state FROM agents WHERE id=?", id)[0].observed_state === "LIVE");
		assert.equal(hs.ex.launchesFor(id)[1].spec.resume, true);
		hs.h.db.prepare("UPDATE agents SET lease_until=? WHERE id=?").run(new Date(0).toISOString(), id);
		hs.h.reconciler.expireLeases();
		hs.h.reconciler.expireLeases();
		assert.equal(notices(hs, root, "worker_lost").length, 1);
		// A process discovered missing at controller startup uses a separate path.
		hs.h.db.prepare("UPDATE agents SET observed_state=\'LIVE\', desired_state=\'PAUSED\' WHERE id=?").run(id);
		hs.ex.alive.delete(hs.ex.launchesFor(id)[1].id.pid);
		await hs.h.reconciler.recoverLiveSessions();
		await hs.h.reconciler.recoverLiveSessions();
		assert.equal(notices(hs, root, "worker_lost").length, 2, "startup loss notified once, including paused workers");
		assert.match(notices(hs, root, "worker_lost")[1].reason, /controller startup/);
	} finally { await hs.cleanup(); }
});

test("budget exhaustion tells the manager without killing the worker", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const created = await hs.call("POST", "/members", { token, body: { responsibility: "work", max_cost_usd: 1 } });
		const id = created.body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(id));
		const worker = hs.ex.tokens.get(id)!;
		for (const cost of [1, 0]) assert.equal((await hs.call("POST", "/sessions/usage", { token: worker, body: { cost_usd: cost } })).status, 200);
		assert.equal(notices(hs, root, "budget_paused").length, 1);
		assert.equal(hs.ex.stopped.length, 0);
	} finally { await hs.cleanup(); }
});
