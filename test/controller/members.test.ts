import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, sql, waitFor } from "./helpers.ts";

const model = { id: "openai/new-model", provider: "openai", model: "new-model", capability_tags: ["coding", "tools"], cost_per_m_input_usd: 1, cost_per_m_output_usd: 2 };

test("conversational recruitment: leader default, runtime model, retry, permissions and persistence", async () => {
	const hs = await harness();
	try {
		const { token, run_id } = await newRun(hs, { models: [] });
		const request = { name: "Adjudicator", responsibility: "Review the patch and report concrete defects", model };
		const first = await hs.call("POST", "/members", { token, key: "member-1", body: request });
		assert.equal(first.status, 200, JSON.stringify(first.body));
		const [id] = first.body.spawned_agent_ids;
		const replay = await hs.call("POST", "/members", { token, key: "member-1", body: request });
		assert.deepEqual(replay.body, first.body);
		await waitFor(() => hs.ex.tokens.has(id));
		const launch = hs.ex.launchesFor(id)[0];
		assert.equal(launch.spec.provider, "openai");
		assert.equal(launch.spec.model, "new-model");
		assert.equal(sql(hs, "SELECT role FROM agents WHERE id = ?", id)[0].role, "Adjudicator");
		const tasks = (await hs.call("GET", "/me", { token: hs.ex.tokens.get(id)! })).body.tasks;
		assert.equal(tasks.length, 1);
		assert.match(sql(hs, "SELECT spec_json FROM tasks WHERE id = ?", tasks[0].task_id)[0].spec_json, /Review the patch/);
		assert.equal((await hs.call("POST", "/models", { token: hs.ex.tokens.get(id)!, body: model })).body.error.code, "FORBIDDEN");
		assert.equal((await hs.call("POST", "/members", { token: hs.ex.tokens.get(id)!, body: { name: "Other", responsibility: "test" } })).body.error.code, "FORBIDDEN");
		assert.equal((await hs.call("POST", "/models", { token, body: { ...model, model: "different" } })).body.error.code, "CONFLICT");
		const same = await hs.call("POST", "/members", { token, body: { name: "Coder", responsibility: "Implement the feature" } });
		assert.equal(same.status, 200, JSON.stringify(same.body));
		assert.equal(sql(hs, "SELECT model_id FROM agents WHERE id = ?", same.body.spawned_agent_ids[0])[0].model_id, "leader");
		const cfg = JSON.parse(sql(hs, "SELECT config_json FROM runs WHERE id = ?", run_id)[0].config_json);
		assert.ok(cfg.limits.allow_providers.includes("openai"));
		assert.ok(cfg.models.some((m: any) => m.id === model.id));
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM events WHERE type = 'model.registered'")[0].n, 1);
		await hs.restart();
		const catalog = await hs.call("GET", `/models?run_id=${run_id}`, { token: hs.op });
		assert.ok(catalog.body.models.some((m: any) => m.id === model.id && m.eligible));
	} finally { await hs.cleanup(); }
});

test("failed direct recruitment rolls back model, policy, tasks and proposal; invalid metadata rejected", async () => {
	const hs = await harness();
	try {
		const { token, run_id } = await newRun(hs, { limits: { max_live_agents: 1 } });
		const before = sql(hs, "SELECT config_json FROM runs WHERE id = ?", run_id)[0].config_json;
		const result = await hs.call("POST", "/members", { token, body: { name: "Adjudicator", responsibility: "review", model } });
		assert.equal(result.body.error.code, "HARD_CAP");
		assert.equal(sql(hs, "SELECT config_json FROM runs WHERE id = ?", run_id)[0].config_json, before);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM tasks")[0].n, 0);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM proposals")[0].n, 0);
		assert.equal((await hs.call("POST", "/models", { token, body: { ...model, cost_per_m_input_usd: -1 } })).body.error.code, "INVALID");
		assert.equal((await hs.call("POST", "/models", { token, body: { ...model, id: "leader" } })).body.error.code, "INVALID");
	} finally { await hs.cleanup(); }
});
