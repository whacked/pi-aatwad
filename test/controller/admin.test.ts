import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, waitFor, recruit, sql } from "./helpers.ts";

test("only the human operator can remove resource caps; accounting and unlimited mode persist", async () => {
	const hs = await harness();
	try {
		const r = await newRun(hs, { models: [], limits: { max_live_agents: 1, max_pending_spawns: 0, max_run_usd: 0, max_run_seconds: 1, max_agent_seconds: 1, emergency_max_depth: 0 } });
		assert.equal((await hs.call("POST", `/runs/${r.run_id}/admin`, { token: r.token, body: { mode: "unlimited" } })).body.error.code, "FORBIDDEN");
		assert.equal((await hs.call("POST", `/runs/${r.run_id}/admin`, { token: hs.op, body: { mode: "unlimited" } })).status, 200);
		const workers: string[] = [];
		for (const name of ["Alpha", "Beta"]) {
			const result = await hs.call("POST", "/members", { token: r.token, body: { name, responsibility: `Declare hello ${name} and wait` } });
			assert.equal(result.status, 200, JSON.stringify(result.body)); workers.push(result.body.spawned_agent_ids[0]);
		}
		await waitFor(() => workers.every((id) => hs.ex.tokens.has(id)));
		const childToken = hs.ex.tokens.get(workers[0])!;
		const task = (await hs.call("GET", "/me", { token: childToken })).body.tasks[0].task_id;
		await recruit(hs, childToken, r.token, task, [{ title: "Nested", max_cost_usd: 500 }]);
		const usage = await hs.call("POST", "/sessions/usage", { token: childToken, body: { cost_usd: 1000 } });
		assert.equal(usage.body.budget_exhausted, false);
		const budget = (await hs.call("GET", `/budgets/${workers[0]}`, { token: hs.op })).body;
		assert.equal(budget.unlimited, true); assert.equal(budget.available_usd, null); assert.equal(budget.available_slots, null);
		assert.equal(budget.consumed_usd, 1000);
		assert.equal((await hs.call("POST", `/runs/${r.run_id}/admin`, { token: childToken, body: { mode: "unlimited" } })).body.error.code, "FORBIDDEN");
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await hs.h.reconciler.idle();
		assert.equal(sql(hs, "SELECT desired_state FROM agents WHERE id=?", workers[0])[0].desired_state, "PAUSED", "explicit inherited worker deadlines still apply");
		await hs.restart({ crash: true });
		assert.equal((await hs.call("GET", `/runs/${r.run_id}/admin`, { token: hs.op })).body.unlimited, true);
	} finally { await hs.cleanup(); }
});
