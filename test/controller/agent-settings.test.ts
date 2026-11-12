import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, sql, waitFor } from "./helpers.ts";
import { TeamClient } from "../../src/shared/client.ts";
import { statePaths } from "../../src/shared/paths.ts";

test("friendly defaults, scoped names, ambiguity, and active replacements", async () => {
	const hs = await harness();
	try {
		const { token, run_id } = await newRun(hs);
		const client = new TeamClient({ paths: statePaths(hs.dir), token: () => token, noReconnect: true });
		const alpha = (await client.post<any>("/members", { responsibility: "Check alpha" })).spawned_agent_ids[0];
		const beta = (await client.post<any>("/members", { responsibility: "Check beta" })).spawned_agent_ids[0];
		assert.equal(await client.resolveAgent("alpha", run_id), alpha);
		assert.equal(await client.resolveAgent("Beta", run_id), beta);
		assert.equal(await client.resolveAgent(beta), beta);
		await assert.rejects(client.resolveAgent("missing", run_id), /No agent/);
		await assert.rejects(client.resolveAgent("Alpha"), /attached team/);
		assert.equal(await client.resolveAgent("agent-0123456789abcdef"), "agent-0123456789abcdef", "legacy IDs need no attached team");
		const other = await newRun(hs);
		assert.equal(await client.resolveAgent(other.root), other.root, "word IDs need no attached team");
		assert.equal(await client.resolveAgent(other.root, run_id), other.root, "foreign exact IDs bypass local-name lookup");
		await hs.call("POST", "/members", { token: other.token, body: { name: "Alpha", responsibility: "Another run" } });
		assert.equal(await client.resolveAgent("Alpha", run_id), alpha);
		const duplicate = (await client.post<any>("/members", { name: "Alpha", responsibility: "Duplicate" })).spawned_agent_ids[0];
		await assert.rejects(client.resolveAgent("Alpha", run_id), /Ambiguous.*agent-/);
		await client.lifecycle(alpha, { action: "cancel", reason: "replace", children_policy: "cascade" });
		assert.equal(await client.resolveAgent("Alpha", run_id), duplicate);
	} finally { await hs.cleanup(); }
});

test("budget changes reserve ancestor funds, enforce spend and authority, and roll back invalid increases", async () => {
	const hs = await harness();
	try {
		const { token, root } = await newRun(hs, { limits: { max_run_usd: 25 }, root_envelope: { max_subtree_usd: 20, max_grant_usd: 20 } });
		const made = await hs.call("POST", "/members", { token, body: { responsibility: "work" } });
		const id = made.body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(id));
		const memberToken = hs.ex.tokens.get(id)!;
		const change = (usd: number, bearer = token) => hs.call("POST", `/budgets/${id}`, { token: bearer, body: { max_cost_usd: usd } });
		assert.equal((await change(5)).body.own_budget_usd, 5);
		assert.equal((await hs.call("GET", `/budgets/${root}`, { token })).body.reserved_usd, 5);
		assert.equal((await change(26)).body.error.code, "FORBIDDEN"); // exceeds root's grant
		assert.equal((await change(25, hs.op)).body.error.code, "BUDGET_EXCEEDED");
		assert.equal((await hs.call("GET", `/budgets/${id}`, { token })).body.own_budget_usd, 5);
		assert.equal((await change(6, memberToken)).body.error.code, "FORBIDDEN");
		await hs.call("POST", "/sessions/usage", { token: memberToken, body: { cost_usd: 1 } });
		assert.equal((await change(0.5)).body.error.code, "BUDGET_EXCEEDED");
		assert.equal((await change(1)).body.own_budget_usd, 1);
		assert.equal((await hs.call("GET", `/budgets/${root}`, { token })).body.reserved_usd, 1);
		assert.equal((await change(-1)).body.error.code, "INVALID");
		await hs.call("POST", `/agents/${id}/lifecycle`, { token, body: { action: "pause", reason: "test" } });
		const resumed = await hs.call("POST", `/budgets/${id}`, { token, body: { max_cost_usd: 3, resume: true } });
		assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
		assert.equal(sql(hs, "SELECT desired_state FROM agents WHERE id=?", id)[0].desired_state, "RUNNING");
	} finally { await hs.cleanup(); }
});

test("model requests survive restart; acknowledgments fence stale requests; local selections persist without leader messages", async () => {
	const hs = await harness();
	try {
		const { token } = await newRun(hs);
		const made = await hs.call("POST", "/members", { token, body: { responsibility: "work" } });
		const id = made.body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(id));
		const memberToken = hs.ex.tokens.get(id)!;
		const model = { id: "openai/new", provider: "openai", model: "new", capability_tags: ["tools"] };
		const first = await hs.call("POST", `/agents/${id}/model`, { token, body: { model } });
		assert.equal(first.body.status, "PENDING", JSON.stringify(first.body));
		assert.equal((await hs.call("POST", `/agents/${id}/model`, { token: memberToken, body: { model_id: model.id } })).body.error.code, "FORBIDDEN");
		await hs.restart({ crash: true });
		const hb = await hs.call("POST", "/sessions/heartbeat", { token: memberToken, body: {} });
		assert.equal(hb.body.model_change.request_id, first.body.request_id);
		const second = await hs.call("POST", `/agents/${id}/model`, { token, body: { model_id: "leader" } });
		const selected = (body: any) => hs.call("POST", "/sessions/model", { token: memberToken, body });
		assert.equal((await selected({ provider: "openai", model: "new", request_id: first.body.request_id })).body.superseded, true);
		assert.equal((await selected({ provider: second.body.provider, model: second.body.model, request_id: second.body.request_id })).body.applied, true);
		const messagesBefore = sql(hs, "SELECT COUNT(*) n FROM messages")[0].n;
		await selected({ provider: "openrouter", model: "user-chosen" });
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM messages")[0].n, messagesBefore);
		assert.equal(sql(hs, "SELECT model FROM agents WHERE id=?", id)[0].model, "user-chosen");
		assert.equal((await hs.call("POST", "/sessions/heartbeat", { token: memberToken, body: {} })).body.model_change, undefined);
		await hs.restart({ crash: true });
		assert.equal(sql(hs, "SELECT model FROM agents WHERE id=?", id)[0].model, "user-chosen");
	} finally { await hs.cleanup(); }
});
