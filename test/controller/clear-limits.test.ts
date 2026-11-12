import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, ownTask, recruit, sql, type Harness } from "./helpers.ts";

const LEGACY = {
	limits: { max_live_agents: 12, max_pending_spawns: 8, emergency_max_depth: 12, max_run_usd: 25, max_run_seconds: 14400, max_agent_seconds: 3600 },
	root_envelope: { max_subtree_slots: 11, max_subtree_usd: 20, max_session_seconds: 3600, max_grant_slots: 11, max_grant_usd: 20 },
};
const budget = async (hs: Harness, id: string) => (await hs.call("GET", `/budgets/${id}`, { token: hs.op })).body;
const admin = async (hs: Harness, run: string, mode?: string) => (await hs.call(mode ? "POST" : "GET", `/runs/${run}/admin`, { token: hs.op, ...(mode ? { body: { mode } } : {}) })).body;

test("a team saved with the old default caps is blocked, told the remedy, and fully freed by clear-limits", async () => {
	const hs = await harness();
	try {
		const { root, token, run_id } = await newRun(hs, LEGACY);
		const task = await ownTask(hs, token, root);
		const members = [
			...await recruit(hs, token, token, task, [{ count: 5, max_cost_usd: 2, max_runtime_seconds: 600 }]),
			...await recruit(hs, token, token, task, [{ count: 4, max_cost_usd: 2, max_runtime_seconds: 600 }]),
		];
		// $18 of the $20 envelope is reserved by ceilings nobody chose: the next $4 member is refused.
		assert.equal((await budget(hs, root)).available_usd, 2);
		const blocked = await hs.call("POST", "/members", { token, body: { name: "rechecker", responsibility: "Recheck", max_cost_usd: 4 } });
		assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
		assert.match(blocked.body.error.message, /\/team admin clear-limits/);
		assert.match(blocked.body.error.message, /Agents cannot lift this limit/);
		const listed = (await admin(hs, run_id)).limits as string[];
		assert.ok(listed.some((l) => l === "team spend ≤ $25"));
		assert.ok(listed.some((l) => l.startsWith("leader") && l.includes("subtree spend ≤ $20")));
		assert.equal(listed.filter((l) => l.includes("own spend ≤ $2") && l.includes("runtime ≤ 600s")).length, 9);
		// One member exhausts its $2 and is paused by the limit; another is paused deliberately.
		await hs.call("POST", "/sessions/usage", { token: hs.ex.tokens.get(members[0])!, body: { cost_usd: 2 } });
		await hs.call("POST", `/agents/${members[1]}/lifecycle`, { token, body: { action: "pause", reason: "leader decision" } });
		assert.equal(sql(hs, "SELECT desired_state FROM agents WHERE id=?", members[0])[0].desired_state, "PAUSED");
		assert.equal((await hs.call("POST", `/runs/${run_id}/admin`, { token, body: { mode: "clear-limits" } })).status, 403, "agents never clear limits");

		const cleared = await admin(hs, run_id, "clear-limits");
		assert.deepEqual(cleared.limits, []);
		assert.deepEqual(cleared.resumed, [members[0]], "only the limit-caused pause is undone");
		assert.deepEqual(cleared.still_paused, [members[1]]);
		assert.equal(sql(hs, "SELECT desired_state FROM agents WHERE id=?", members[0])[0].desired_state, "RUNNING");
		for (const id of [root, ...members]) {
			const b = await budget(hs, id);
			assert.equal(b.own_budget_usd, null);
			assert.equal(b.available_usd, null);
			assert.equal(b.available_slots, null);
			assert.equal(b.limits.max_session_seconds, 0);
			assert.equal(b.reserved_usd, 0);
		}
		assert.ok(sql(hs, "SELECT metadata_json FROM agents WHERE run_id=?", run_id).every((a) => !JSON.parse(a.metadata_json).max_runtime_seconds));
		// Recruitment and spend are unconstrained again, with no ceiling or timer on the new member.
		const made = await hs.call("POST", "/members", { token, body: { name: "rechecker", responsibility: "Recheck" } });
		assert.equal(made.status, 200, JSON.stringify(made.body));
		assert.equal((await budget(hs, made.body.spawned_agent_ids[0])).own_budget_usd, null);
		const usage = await hs.call("POST", "/sessions/usage", { token: hs.ex.tokens.get(members[2])!, body: { cost_usd: 500 } });
		assert.equal(usage.body.budget_exhausted, false);
		// Limits remain available on request.
		const set = await hs.call("POST", `/budgets/${members[3]}`, { token, body: { max_cost_usd: 7 } });
		assert.equal(set.status, 200, JSON.stringify(set.body));
		assert.deepEqual((await admin(hs, run_id)).limits.length, 1);
	} finally { await hs.cleanup(); }
});

test("a member ceiling can be removed: the member and its inheritors rejoin the lead's pool", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const [lead] = await recruit(hs, token, token, await ownTask(hs, token, root), [{ max_cost_usd: 5 }]);
		const leadToken = hs.ex.tokens.get(lead)!;
		const leadTask = (await hs.call("GET", "/me", { token: leadToken })).body.tasks[0].task_id;
		const [child] = await recruit(hs, leadToken, token, leadTask, [{ max_cost_usd: undefined }]);
		assert.equal((await budget(hs, child)).own_budget_usd, 5);
		await hs.call("POST", "/sessions/usage", { token: hs.ex.tokens.get(child)!, body: { cost_usd: 5 } });
		assert.equal(sql(hs, "SELECT desired_state FROM agents WHERE id=?", child)[0].desired_state, "PAUSED");
		assert.equal((await hs.call("POST", `/budgets/${lead}`, { token, body: { max_cost_usd: "none" } })).status, 400);
		const removed = await hs.call("POST", `/budgets/${lead}`, { token, body: { max_cost_usd: null } });
		assert.equal(removed.status, 200, JSON.stringify(removed.body));
		for (const id of [lead, child]) {
			assert.equal((await budget(hs, id)).own_budget_usd, null);
			assert.equal((await budget(hs, id)).budget_pool_id, root);
		}
		assert.equal((await budget(hs, root)).reserved_usd, 0);
		const resumed = await hs.call("POST", `/budgets/${child}`, { token, body: { max_cost_usd: null, resume: true } });
		assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
		assert.equal(sql(hs, "SELECT desired_state FROM agents WHERE id=?", child)[0].desired_state, "RUNNING");
		assert.equal((await hs.call("POST", "/sessions/usage", { token: hs.ex.tokens.get(child)!, body: { cost_usd: 50 } })).body.budget_exhausted, false);
	} finally { await hs.cleanup(); }
});
