import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, sql, waitFor } from "./helpers.ts";

async function member(hs: Awaited<ReturnType<typeof harness>>, token: string, name: string): Promise<string> {
	const made = await hs.call("POST", "/members", { token, body: { name, responsibility: `Work as ${name}` } });
	assert.equal(made.status, 200, JSON.stringify(made.body));
	const id = made.body.spawned_agent_ids[0];
	await waitFor(() => hs.ex.tokens.has(id));
	return id;
}

test("stop suspends the whole team resumably; resume restores only members that were running", async () => {
	const hs = await harness();
	try {
		const r = await newRun(hs, { models: [] });
		const worker = await member(hs, r.token, "Worker"), idle = await member(hs, r.token, "Idle");
		await hs.h.reconciler.idle();
		await hs.call("POST", `/agents/${idle}/lifecycle`, { token: r.token, body: { action: "pause", reason: "deliberate" } });
		const other = await newRun(hs);
		assert.equal((await hs.call("POST", `/runs/${r.run_id}/stop`, { token: r.token, body: {} })).status, 403, "agents cannot stop teams");
		const stopped = await hs.call("POST", `/runs/${r.run_id}/stop`, { token: hs.op, body: {} });
		assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
		assert.equal(stopped.body.kind, "stop");
		assert.equal(stopped.body.state, "CLEANING");
		await waitFor(async () => (await hs.call("GET", `/runs/${r.run_id}/lifecycle`, { token: hs.op })).body.state === "STOPPED");
		assert.equal(hs.ex.stopped.length, 2, "owned worker processes are stopped; the operator's Pi is not");
		const stale = await hs.call("GET", "/me", { token: r.token });
		assert.equal(stale.body.error.code, "STALE_SESSION");
		assert.equal(stale.body.error.details.reason, "team_stopped");
		assert.equal((await hs.call("GET", "/me", { token: hs.ex.tokens.get(worker)! })).body.error.details.reason, "team_stopped");
		assert.equal((await hs.call("GET", "/me", { token: other.token })).status, 200, "other teams are unaffected");
		// Nothing is cancelled: identities, tasks and reservations survive.
		assert.ok(sql(hs, "SELECT status FROM agents WHERE run_id=?", r.run_id).every((a) => a.status === "PAUSED"));
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM tasks WHERE run_id=? AND status='CANCELLED'", r.run_id)[0].n, 0);
		const listed = (await hs.call("GET", "/runs", { token: hs.op })).body.runs.find((x: any) => x.run_id === r.run_id);
		assert.equal(listed.stopped, true);
		assert.equal(listed.status, "RUNNING");
		// A stopped team stays stopped across ticks, restarts and repeated stops.
		const launches = hs.ex.launches.length;
		await hs.restart({ crash: true });
		await hs.h.reconciler.tick();
		assert.equal(hs.ex.launches.length, launches);
		const again = await hs.call("POST", `/runs/${r.run_id}/stop`, { token: hs.op, body: {} });
		assert.equal(again.body.operation_id, stopped.body.operation_id);
		assert.equal(again.body.state, "STOPPED");
		const attach = await hs.call("POST", `/runs/${r.run_id}/attach`, { token: hs.op, body: {} });
		assert.equal(attach.status, 409, "attach cannot revive a stopped team without resume");

		const resumed = await hs.call("POST", `/runs/${r.run_id}/resume`, { token: hs.op, body: {} });
		assert.equal(resumed.body.state, "RESUMED");
		assert.equal(resumed.body.operation_id, stopped.body.operation_id);
		assert.deepEqual(sql(hs, "SELECT desired_state FROM agents WHERE id=?", worker)[0].desired_state, "RUNNING");
		assert.deepEqual(sql(hs, "SELECT desired_state FROM agents WHERE id=?", idle)[0].desired_state, "PAUSED", "a deliberate pause is not undone by resume");
		const fresh = await hs.call("POST", `/runs/${r.run_id}/attach`, { token: hs.op, body: {} });
		assert.equal(fresh.status, 200);
		assert.equal((await hs.call("GET", "/me", { token: fresh.body.token })).status, 200);
		assert.equal((await hs.call("GET", "/me", { token: r.token })).body.error.details.reason, "superseded");
		// The worker relaunches on its saved transcript once work is waiting.
		const sent = await hs.call("POST", "/messages", { token: fresh.body.token, body: { to: worker, type: "system.notice", payload: { text: "continue" } } });
		assert.equal(sent.status, 200, JSON.stringify(sent.body));
		await waitFor(() => hs.ex.launchesFor(worker).length === 2);
		assert.equal(hs.ex.launchesFor(worker)[1].spec.resume, true);
		assert.equal(hs.ex.launchesFor(idle).length, 1);
	} finally { await hs.cleanup(); }
});

test("resume of a never-stopped team is a no-op receipt; cleanup errors keep the team CLEANING until retried", async () => {
	const hs = await harness();
	try {
		const r = await newRun(hs, { models: [] });
		await member(hs, r.token, "Worker");
		await hs.h.reconciler.idle();
		assert.equal((await hs.call("GET", `/runs/${r.run_id}/lifecycle`, { token: hs.op })).body, null);
		assert.equal((await hs.call("POST", `/runs/${r.run_id}/resume`, { token: hs.op, body: {} })).body.state, "RESUMED");
		assert.equal((await hs.call("GET", "/me", { token: r.token })).status, 200);
		const stop = hs.ex.stop.bind(hs.ex);
		hs.ex.stop = async () => { throw new Error("signal denied"); };
		await hs.call("POST", `/runs/${r.run_id}/stop`, { token: hs.op, body: {} });
		const failed = await waitFor(async () => { const l = (await hs.call("GET", `/runs/${r.run_id}/lifecycle`, { token: hs.op })).body; return l.error ? l : null; });
		assert.equal(failed.state, "CLEANING");
		assert.match(failed.error, /signal denied/);
		const pending = await hs.call("POST", `/runs/${r.run_id}/resume`, { token: hs.op, body: {} });
		assert.equal(pending.body.state, "CLEANING", "resume never proceeds past unfinished cleanup");
		hs.ex.stop = stop;
		await hs.call("POST", `/runs/${r.run_id}/stop`, { token: hs.op, body: {} });
		await waitFor(async () => (await hs.call("GET", `/runs/${r.run_id}/lifecycle`, { token: hs.op })).body.state === "STOPPED");
		assert.equal((await hs.call("GET", `/runs/${r.run_id}/lifecycle`, { token: hs.op })).body.error, undefined);
		assert.equal((await hs.call("POST", `/runs/${r.run_id}/resume`, { token: hs.op, body: {} })).body.state, "RESUMED");
	} finally { await hs.cleanup(); }
});

test("remove is permanent, confirmed, idempotent and isolated to one team", async () => {
	const hs = await harness();
	try {
		const r = await newRun(hs, { models: [] }), other = await newRun(hs);
		const worker = await member(hs, r.token, "Worker");
		await hs.h.reconciler.idle();
		for (const body of [{}, { confirm_run_id: other.run_id }]) assert.equal((await hs.call("POST", `/runs/${r.run_id}/remove`, { token: hs.op, body })).status, 400);
		assert.equal((await hs.call("POST", `/runs/${r.run_id}/remove`, { token: r.token, body: { confirm_run_id: r.run_id } })).status, 403);
		assert.equal((await hs.call("GET", "/me", { token: r.token })).status, 200, "rejected removals change nothing");
		const removed = await hs.call("POST", `/runs/${r.run_id}/remove`, { token: hs.op, body: { confirm_run_id: r.run_id } });
		assert.equal(removed.status, 200, JSON.stringify(removed.body));
		assert.equal(removed.body.kind, "remove");
		assert.equal(removed.body.state, "REMOVED");
		await waitFor(() => hs.ex.stopped.length === 1);
		assert.ok(sql(hs, "SELECT status FROM agents WHERE run_id=?", r.run_id).every((a) => a.status === "CANCELLED"));
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM auth_tokens WHERE run_id=? AND revoked_at IS NULL", r.run_id)[0].n, 0);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM reservations WHERE run_id=? AND state='ACTIVE'", r.run_id)[0].n, 0);
		assert.notEqual((await hs.call("GET", "/me", { token: hs.ex.tokens.get(worker)! })).status, 200);
		const runs = (await hs.call("GET", "/runs", { token: hs.op })).body.runs.map((x: any) => x.run_id);
		assert.deepEqual(runs, [other.run_id], "removed teams leave every listing");
		for (const action of ["resume", "stop", "attach"]) assert.equal((await hs.call("POST", `/runs/${r.run_id}/${action}`, { token: hs.op, body: {} })).status, 404, action);
		const again = await hs.call("POST", `/runs/${r.run_id}/remove`, { token: hs.op, body: { confirm_run_id: r.run_id } });
		assert.equal(again.body.operation_id, removed.body.operation_id);
		assert.equal((await hs.call("GET", "/me", { token: other.token })).status, 200);
		// A stopped team can be removed without resuming it first.
		await hs.call("POST", `/runs/${other.run_id}/stop`, { token: hs.op, body: {} });
		assert.equal((await hs.call("POST", `/runs/${other.run_id}/remove`, { token: hs.op, body: { confirm_run_id: other.run_id } })).body.state, "REMOVED");
	} finally { await hs.cleanup(); }
});
