import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, proposal, sql, waitFor } from "./helpers.ts";

test("only an explicit operator action clears saved deadlines, preserving budgets, states and other runs", async () => {
	const hs = await harness();
	try {
		const r = await newRun(hs, { limits: { max_agent_seconds: 3600, max_run_usd: 25 }, root_envelope: { max_session_seconds: 3600, max_subtree_usd: 20 } });
		const other = await newRun(hs, { limits: { max_agent_seconds: 7200 } });
		const made = await hs.call("POST", "/members", { token: r.token, body: { name: "Timed", responsibility: "Wait", max_cost_usd: 3, max_runtime_seconds: 1200 } });
		assert.equal(made.status, 200, JSON.stringify(made.body));
		const id = made.body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(id));
		const childToken = hs.ex.tokens.get(id)!;
		const taskId = (await hs.call("GET", "/me", { token: childToken })).body.tasks[0].task_id;
		const pending = await hs.call("POST", "/expansions", { token: childToken, body: proposal(taskId, [{ title: "PendingTimed", max_runtime_seconds: 1800 }]) });
		assert.equal(pending.status, 200, JSON.stringify(pending.body));
		const requestBefore = sql(hs, "SELECT request_json FROM proposals WHERE id=?", pending.body.proposal_id)[0].request_json;
		const path = `/runs/${r.run_id}/admin`;
		for (const token of [r.token, hs.ex.tokens.get(id)!]) {
			assert.equal((await hs.call("POST", path, { token, body: { mode: "clear-deadlines" } })).body.error.code, "FORBIDDEN");
		}
		hs.h.db.prepare("UPDATE agents SET desired_state='PAUSED', status='PAUSED' WHERE id=?").run(id);
		const before = sql(hs, "SELECT agent_id, limits_json FROM allocations WHERE agent_id IN (?,?) ORDER BY agent_id", r.root, id);
		const reservations = sql(hs, "SELECT * FROM reservations ORDER BY id");
		assert.equal((await hs.call("POST", path, { token: hs.op, body: { mode: "clear-deadlines" } })).body.mode, "bounded");
		for (const row of before) {
			const limits = JSON.parse(sql(hs, "SELECT limits_json FROM allocations WHERE agent_id=?", row.agent_id)[0].limits_json);
			assert.deepEqual(limits, { ...JSON.parse(row.limits_json), max_session_seconds: 0 });
		}
		assert.equal(JSON.parse(sql(hs, "SELECT metadata_json FROM agents WHERE id=?", id)[0].metadata_json).max_runtime_seconds, null);
		assert.deepEqual(sql(hs, "SELECT * FROM reservations ORDER BY id"), reservations);
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id=?", id)[0].status, "PAUSED", "clearing policy must not resume work");
		assert.equal(JSON.parse(sql(hs, "SELECT limits_json FROM allocations WHERE agent_id=?", other.root)[0].limits_json).max_session_seconds, 7200);
		const cfg = JSON.parse(sql(hs, "SELECT config_json FROM runs WHERE id=?", r.run_id)[0].config_json);
		assert.equal(cfg.limits.max_agent_seconds, 0);
		assert.equal(cfg.root_envelope.max_session_seconds, 0);
		assert.equal(cfg.limits.max_run_usd, 25);
		assert.equal(cfg.root_envelope.max_subtree_usd, 20);
		assert.equal((await hs.call("POST", path, { token: hs.op, body: { mode: "clear-deadlines" } })).status, 200, "idempotent");
		const next = await hs.call("POST", "/members", { token: r.token, body: { name: "Untimed", responsibility: "Wait" } });
		assert.equal(next.status, 200, JSON.stringify(next.body));
		const nextId = next.body.spawned_agent_ids[0];
		assert.equal(JSON.parse(sql(hs, "SELECT limits_json FROM allocations WHERE agent_id=?", nextId)[0].limits_json).max_session_seconds, 0);
		assert.equal(JSON.parse(sql(hs, "SELECT metadata_json FROM agents WHERE id=?", nextId)[0].metadata_json).max_runtime_seconds, null);
		const explicit = await hs.call("POST", "/members", { token: r.token, body: { name: "ExplicitlyTimed", responsibility: "Wait", max_runtime_seconds: 1200 } });
		assert.equal(explicit.status, 200, JSON.stringify(explicit.body));
		const explicitId = explicit.body.spawned_agent_ids[0];
		assert.equal(JSON.parse(sql(hs, "SELECT limits_json FROM allocations WHERE agent_id=?", explicitId)[0].limits_json).max_session_seconds, 1200, "new explicit worker caps still apply");
		assert.equal(sql(hs, "SELECT request_json FROM proposals WHERE id=?", pending.body.proposal_id)[0].request_json, requestBefore, "pending explicit requests are not silently rewritten");
		const approved = await hs.call("POST", `/expansions/${pending.body.proposal_id}/decision`, { token: r.token, body: { decision: "APPROVE", reason: "explicit timer remains requested" } });
		assert.equal(approved.status, 200, JSON.stringify(approved.body));
		const pendingId = approved.body.spawned_agent_ids[0];
		assert.equal(JSON.parse(sql(hs, "SELECT limits_json FROM allocations WHERE agent_id=?", pendingId)[0].limits_json).max_session_seconds, 1800);
		await hs.restart({ crash: true });
		assert.equal(JSON.parse(sql(hs, "SELECT limits_json FROM allocations WHERE agent_id=?", id)[0].limits_json).max_session_seconds, 0);
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id=?", id)[0].status, "PAUSED");
		assert.ok(sql(hs, "SELECT payload_json FROM events WHERE run_id=? AND type='run.resource_policy_changed'", r.run_id).some((e) => JSON.parse(e.payload_json).action === "clear-deadlines"));
	} finally { await hs.cleanup(); }
});
