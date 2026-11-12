import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, ownTask, recruit, sql, waitFor } from "./helpers.ts";
import { formatOrgContext } from "../../src/extension/format.ts";

test("default runs and delegated authority are unbounded; omitted member limits inherit", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const task = await ownTask(hs, token, root);
		// Exceeds both the former 12-agent default and former 16-member batch bound.
		const members = await recruit(hs, token, token, task, [{ count: 17, max_cost_usd: undefined }]);
		assert.equal(members.length, 17);
		const member = members[0];
		const mt = hs.ex.tokens.get(member)!;
		const me = (await hs.call("GET", "/me", { token: mt })).body;
		assert.equal(me.budget.own_budget_usd, null);
		assert.equal(me.budget.available_slots, null);
		assert.equal(me.budget.available_usd, null);
		assert.equal(me.budget.limits.max_grant_usd, null);
		assert.equal(me.budget.limits.max_grant_slots, null);
		assert.equal(me.budget.limits.max_session_seconds, 0);
		assert.match(formatOrgContext(me), /Authority: manage descendants/);
		assert.match(formatOrgContext(me), /approval by your manager/);
		assert.match(formatOrgContext(me), /Omitted member limits inherit yours/);
		const [nested] = await recruit(hs, mt, token, me.tasks[0].task_id, [{ max_cost_usd: undefined }]);
		assert.equal((await hs.call("GET", `/budgets/${nested}`, { token })).body.own_budget_usd, null);
		assert.equal((await hs.call("POST", "/sessions/usage", { token: mt, body: { cost_usd: 100 } })).body.budget_exhausted, false);
	} finally { await hs.cleanup(); }
});

test("inherited finite budgets share accounting rather than reserving the entire pool for each sibling", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs, { limits: { max_run_usd: 10 } });
		const task = await ownTask(hs, token, root);
		const members = await recruit(hs, token, token, task, [{ count: 2, max_cost_usd: undefined }]);
		for (const id of members) assert.equal((await hs.call("GET", `/budgets/${id}`, { token })).body.own_budget_usd, 10);
		assert.equal((await hs.call("GET", `/budgets/${root}`, { token })).body.reserved_usd, 0);
		await hs.call("POST", "/sessions/usage", { token: hs.ex.tokens.get(members[0])!, body: { cost_usd: 6 } });
		assert.equal((await hs.call("GET", `/budgets/${root}`, { token })).body.available_usd, 4);
		const usage = await hs.call("POST", "/sessions/usage", { token: hs.ex.tokens.get(members[1])!, body: { cost_usd: 4 } });
		assert.equal(usage.body.budget_exhausted, true);
		for (const id of [root, ...members]) assert.equal(sql(hs, "SELECT desired_state FROM agents WHERE id=?", id)[0].desired_state, "PAUSED");
	} finally { await hs.cleanup(); }
});

test("leaders can choose explicit member budgets and runtime even with unlimited run policy", async () => {
	const hs = await harness();
	try {
		const { token } = await newRun(hs, { operator_unlimited: true });
		const made = await hs.call("POST", "/members", { token, body: { responsibility: "bounded work", max_cost_usd: 2, max_runtime_seconds: 60 } });
		const id = made.body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(id));
		const mt = hs.ex.tokens.get(id)!;
		const me = (await hs.call("GET", "/me", { token: mt })).body;
		const [child] = await recruit(hs, mt, token, me.tasks[0].task_id, [{ max_cost_usd: undefined }]);
		assert.equal((await hs.call("GET", `/budgets/${child}`, { token })).body.own_budget_usd, 2);
		assert.equal(JSON.parse(sql(hs, "SELECT metadata_json FROM agents WHERE id=?", child)[0].metadata_json).max_runtime_seconds, 60);
		assert.equal((await hs.call("POST", "/sessions/usage", { token: mt, body: { cost_usd: 2 } })).body.budget_exhausted, true);
		assert.equal(sql(hs, "SELECT desired_state FROM agents WHERE id=?", id)[0].desired_state, "PAUSED");
		const short = await hs.call("POST", "/members", { token, body: { responsibility: "short work", max_runtime_seconds: 1 } });
		const shortId = short.body.spawned_agent_ids[0];
		await waitFor(() => sql(hs, "SELECT COUNT(*) n FROM events WHERE entity_id=? AND type='agent.deadline_exceeded'", shortId)[0].n > 0, "explicit worker deadline", 5000);
	} finally { await hs.cleanup(); }
});
