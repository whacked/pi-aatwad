// Conversational root operations. Called inside the server's idempotent transaction.
import type { Ctx, Principal } from "./context.ts";
import type { ModelCatalogEntry } from "../shared/protocol.ts";
import { obj, str, onlyKeys } from "./validate.ts";
import { fail, CommittedError } from "./errors.ts";
import { requireAgent, createTask } from "./messaging.ts";
import { getRun, runConfig } from "./queries.ts";
import { run, emit } from "./db.ts";
import { createExpansion, decide } from "./governance.ts";

function requireRoot(ctx: Ctx, p: Principal) {
	const a = requireAgent(p);
	const r = getRun(ctx.db, a.run_id);
	if (r.root_agent_id !== a.actor_id) fail("FORBIDDEN", "only the run root may configure models or directly create members; use expansion requests");
	if (r.status !== "RUNNING") fail("CONFLICT", "run is not running");
	return a;
}

export function registerModel(ctx: Ctx, p: Principal, body: unknown) {
	const a = requireRoot(ctx, p);
	const b = obj(body);
	onlyKeys(b, ["id", "provider", "model", "capability_tags", "tool_support", "cost_per_m_input_usd", "cost_per_m_output_usd"]);
	const id = str(b, "id"), provider = str(b, "provider"), model = str(b, "model");
	if (id === "leader") fail("INVALID", "leader is reserved for the initial root model");
	if (!Array.isArray(b.capability_tags) || !b.capability_tags.every((x) => typeof x === "string")) fail("INVALID", "capability_tags must be strings");
	if (b.tool_support !== undefined && typeof b.tool_support !== "boolean") fail("INVALID", "tool_support must be boolean");
	for (const key of ["cost_per_m_input_usd", "cost_per_m_output_usd"]) {
		const v = b[key];
		if (v != null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) fail("INVALID", `${key} must be a non-negative finite number or null`);
	}
	const cfg = runConfig(ctx.db, a.run_id);
	const previous = cfg.models.find((m) => m.id === id);
	if (previous) {
		if (previous.provider !== provider || previous.model !== model) fail("CONFLICT", "catalog ID already refers to a different model; choose another ID");
		return previous;
	}
	const entry: ModelCatalogEntry = {
		id, provider, model,
		capability_tags: b.capability_tags as string[],
		tool_support: (b.tool_support as boolean | undefined) ?? true,
		cost_per_m_input_usd: (b.cost_per_m_input_usd as number | null | undefined) ?? null,
		cost_per_m_output_usd: (b.cost_per_m_output_usd as number | null | undefined) ?? null,
		availability: "available",
	};
	cfg.models.push(entry);
	if (!cfg.limits.allow_providers.includes(provider)) cfg.limits.allow_providers.push(provider);
	run(ctx.db, "UPDATE runs SET config_json = ? WHERE id = ?", JSON.stringify(cfg), a.run_id);
	emit(ctx.db, { run_id: a.run_id, actor_id: a.actor_id, type: "model.registered", entity_id: id, payload: { model: entry } });
	return entry;
}

export function createMember(ctx: Ctx, p: Principal, body: unknown) {
	const a = requireRoot(ctx, p);
	const b = obj(body);
	onlyKeys(b, ["name", "responsibility", "preferred_model_id", "model", "max_cost_usd", "max_runtime_seconds"]);
	const name = str(b, "name"), responsibility = str(b, "responsibility");
	const registered = b.model === undefined ? undefined : registerModel(ctx, p, b.model);
	if (registered && b.preferred_model_id !== undefined) fail("INVALID", "specify model or preferred_model_id, not both");
	const modelId = registered?.id ?? str(b, "preferred_model_id", { optional: true }) ?? "leader";
	const cost = b.max_cost_usd ?? 2;
	const runtime = b.max_runtime_seconds ?? 600;
	const task = createTask(ctx.db, { run_id: a.run_id, owner_id: a.actor_id, title: `Recruit ${name}`, spec: { responsibility }, parent_task_id: null, assigned_by: a.actor_id });
	const proposal = createExpansion(ctx, p, { version: 1, task_id: task, reason: `Recruit member: ${responsibility}`, alternatives: "Leader performs the work alone", estimated_cost_usd: cost,
		roles: [{ title: name, responsibility, count: 1, capabilities: [], preferred_model_id: modelId, max_cost_usd: cost, max_runtime_seconds: runtime }] });
	const result = decide(ctx, p, proposal.proposal_id, { decision: "APPROVE", reason: "Root requested direct member creation" });
	// Roll back this convenience operation fully on failure, including model/task registration.
	if (result instanceof CommittedError) throw result.err;
	run(ctx.db, "UPDATE tasks SET status = 'DONE' WHERE id = ?", task);
	return result;
}
