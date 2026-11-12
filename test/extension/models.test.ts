import { test } from "node:test";
import assert from "node:assert/strict";
import { availableModels, resolveAvailableModel } from "../../src/extension/models.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const ctx = { modelRegistry: { getAvailable: () => [
	{ provider: "anthropic", id: "claude-test", name: "Claude Test", reasoning: true, cost: { input: 1, output: 2 } },
	{ provider: "openrouter", id: "anthropic/claude-test", name: "Claude Test", cost: { input: 3, output: 4 } },
] } } as unknown as ExtensionContext;

test("Pi discovery resolves qualified IDs and rejects ambiguous or unknown model names", () => {
	assert.equal(availableModels(ctx).length, 2);
	assert.equal(resolveAvailableModel(ctx, "claude-test").provider, "anthropic");
	assert.equal(resolveAvailableModel(ctx, "openrouter/anthropic/claude-test").provider, "openrouter");
	assert.throws(() => resolveAvailableModel(ctx, "Claude Test"), /Ambiguous/);
	assert.throws(() => resolveAvailableModel(ctx, "claude"), /not an exact/);
	assert.throws(() => resolveAvailableModel(ctx, "unknown"), /configure\/authenticate/);
	assert.equal(resolveAvailableModel(ctx, "anthropic/claude-test").cost_per_m_input_usd, 1);
	assert.equal(JSON.stringify(availableModels(ctx)).includes("apiKey"), false);
});


test("member tool discovers a Pi model and provisions through the real controller", async () => {
	const { registerTools } = await import("../../src/extension/tools.ts");
	const { TeamClient } = await import("../../src/shared/client.ts");
	const { statePaths } = await import("../../src/shared/paths.ts");
	const { harness, newRun } = await import("../controller/helpers.ts");
	const hs = await harness();
	try {
		const { token, run_id } = await newRun(hs, { models: [] });
		const tools = new Map<string, any>();
		const pi = { registerTool: (tool: any) => tools.set(tool.name, tool) };
		const rt = { identity: { agent_id: "root", run_id }, client: new TeamClient({ paths: statePaths(hs.dir), token: () => token, noReconnect: true }),
			agentCall: (fn: () => unknown) => fn(), commandToken: () => token, attached: () => false };
		registerTools(pi as any, rt as any);
		const discovered = await tools.get("team_get_models").execute("discover", { source: "available" }, undefined, undefined, ctx);
		assert.equal(discovered.details.models.length, 2);
		const created = await tools.get("team_create_member").execute("create", { name: "Adjudicator", responsibility: "Independently review the proposed patch", model: "openrouter/anthropic/claude-test" }, undefined, undefined, ctx);
		assert.equal(created.details.spawned_agent_ids.length, 1);
		const replay = await tools.get("team_create_member").execute("create", { name: "Adjudicator", responsibility: "Independently review the proposed patch", model: "openrouter/anthropic/claude-test" }, undefined, undefined, ctx);
		assert.deepEqual(replay.details, created.details);
		const invoke = (name: string, params: any) => tools.get(name).execute(name, params, undefined, undefined, ctx);
		await invoke("team_set_budget", { agent_id: "Adjudicator", max_cost_usd: 3 });
		assert.equal((await invoke("team_get_budget", { agent_id: "Adjudicator" })).details.own_budget_usd, 3);
		await invoke("team_send_message", { to: "Adjudicator", type: "question", text: "Status?" });
		await invoke("team_delegate_task", { owner_id: "Adjudicator", title: "Check names" });
		assert.equal((await invoke("team_set_model", { agent_id: "Adjudicator", model: "anthropic/claude-test" })).details.status, "PENDING");
		const catalog = await rt.client.models();
		assert.ok(catalog.models.some((m) => m.id === "openrouter/anthropic/claude-test"));
	} finally { await hs.cleanup(); }
});
