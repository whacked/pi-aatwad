import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, sql } from "./helpers.ts";

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
