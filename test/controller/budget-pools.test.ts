import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, ownTask, recruit, waitFor } from "./helpers.ts";

test("explicit leader pools fund inherited spend once, retain settlement, and enforce totals under unlimited policy", async () => {
	for (const unlimited of [false, true]) {
		const hs = await harness();
		try {
			const { root, token } = await newRun(hs, { operator_unlimited: unlimited, limits: { max_run_usd: 10 } });
			const [lead] = await recruit(hs, token, token, await ownTask(hs, token, root), [{ max_cost_usd: 5 }]);
			const lt = hs.ex.tokens.get(lead)!;
			const task = (await hs.call("GET", "/me", { token: lt })).body.tasks[0].task_id;
			const children = await recruit(hs, lt, token, task, [{ count: 2, max_cost_usd: undefined }]);
			const usage = (id: string, cost: number) => hs.call("POST", "/sessions/usage", { token: hs.ex.tokens.get(id)!, body: { cost_usd: cost } });
			assert.equal((await usage(children[0], 2)).body.budget_exhausted, false);
			if (!unlimited) assert.equal((await hs.call("GET", `/budgets/${root}`, { token })).body.available_usd, 5, "inherited spend uses the reserved leader pool");
			await hs.call("POST", `/agents/${children[0]}/lifecycle`, { token, body: { action: "retire", reason: "done" } });
			if (!unlimited) assert.equal((await hs.call("GET", `/budgets/${root}`, { token })).body.available_usd, 5, "settled inherited spend is not double charged");
			// A fresh inherited member remains possible while the pool has reserved capacity.
			await recruit(hs, lt, token, task, [{ max_cost_usd: undefined }]);
			assert.equal((await usage(children[1], 3)).body.budget_exhausted, true, "aggregate inherited spending exhausts the explicit $5 pool");
			assert.equal((await hs.call("GET", "/me", { token: lt })).body.desired_state, "PAUSED");
		} finally { await hs.cleanup(); }
	}
});

test("turning an inherited ceiling into an explicit reservation requires actual grant authority", async () => {
	const hs = await harness();
	try {
		const { token } = await newRun(hs, { root_envelope: { max_subtree_usd: 100, max_grant_usd: 2 } });
		const made = await hs.call("POST", "/members", { token, body: { responsibility: "inherit budget" } });
		const id = made.body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(id));
		const denied = await hs.call("POST", `/budgets/${id}`, { token, body: { max_cost_usd: 50 } });
		assert.equal(denied.body.error.code, "FORBIDDEN");
		assert.equal((await hs.call("GET", `/budgets/${id}`, { token })).body.own_budget_usd, 100);
	} finally { await hs.cleanup(); }
});
