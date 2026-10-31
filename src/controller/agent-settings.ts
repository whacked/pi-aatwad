import { lifecycle } from "./topology.ts";
// Live member configuration. Mutations run in the server's idempotent transaction.
import type { Ctx, Principal, ReqScope } from "./context.ts";
import { emit, newId, parseJson, run } from "./db.ts";
import { fail } from "./errors.ts";
import { obj, onlyKeys, str } from "./validate.ts";
import { getAgent, getAllocation, getAncestry, getRun, isAncestor, isTerminal, runConfig } from "./queries.ts";
import { assertWithinEnvelopes, budgetView, ownBudgetUsd, recomputeAllocations, setLimits } from "./budgets.ts";
import { runSpendUsd } from "./governance.ts";
import { modelIneligibility } from "./config.ts";
import { registerRunModel } from "./members.ts";
import { requireAgent } from "./messaging.ts";

function managed(ctx: Ctx, p: Principal, id: string) {
	const a = getAgent(ctx.db, id);
	if (p.kind !== "operator" && (p.run_id !== a.run_id || !isAncestor(ctx.db, p.actor_id, id))) fail("FORBIDDEN", "you do not manage this agent");
	if (isTerminal(a.status)) fail("CONFLICT", "agent is closed");
	return a;
}

export function updateBudget(ctx: Ctx, p: Principal, scope: ReqScope, id: string, body: unknown) {
	const a = managed(ctx, p, id), b = obj(body);
	onlyKeys(b, ["max_cost_usd", "resume"]);
	if (b.resume !== undefined && typeof b.resume !== "boolean") fail("INVALID", "resume must be boolean");
	const usd = b.max_cost_usd;
	if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) fail("INVALID", "max_cost_usd must be a nonnegative finite total ceiling");
	const db = ctx.db, cfg = runConfig(db, a.run_id), allocation = getAllocation(db, id);
	if (usd < allocation.consumed_usd) fail("BUDGET_EXCEEDED", "cannot set a budget below spend already consumed");
	const before = ownBudgetUsd(db, id);
	const delta = usd - (before ?? allocation.limits.max_subtree_usd);
	if (!cfg.operator_unlimited && p.kind === "agent" && delta > getAllocation(db, p.actor_id).limits.max_grant_usd) fail("FORBIDDEN", "increase exceeds your single-decision grant; ask your manager");
	if (before !== null) run(db, "UPDATE reservations SET usd=? WHERE beneficiary_id=? AND state='ACTIVE'", usd, id);
	if (before === null) setLimits(db, id, { ...allocation.limits, max_subtree_usd: usd });
	recomputeAllocations(db, a.run_id);
	assertWithinEnvelopes(db, [id, ...getAncestry(db, id)]);
	const r = getRun(db, a.run_id);
	if (!cfg.operator_unlimited && runSpendUsd(db, a.run_id, r.root_agent_id) > cfg.limits.max_run_usd + 1e-9) fail("HARD_CAP", "increase exceeds the run's total budget");
	emit(db, { run_id: a.run_id, actor_id: p.actor_id, type: "budget.updated", entity_id: id, payload: { before, max_cost_usd: usd } });
	if (b.resume) {
		if (!cfg.operator_unlimited && usd <= allocation.consumed_usd) fail("BUDGET_EXCEEDED", "resume requires unspent budget");
		lifecycle(ctx, p, scope, id, { action: "resume", reason: "resume requested with budget update" });
	}
	ctx.kick();
	return { ...budgetView(db, id), own_budget_usd: before === null ? null : usd };
}

export function updateModel(ctx: Ctx, p: Principal, id: string, body: unknown) {
	const a = managed(ctx, p, id), b = obj(body), db = ctx.db;
	onlyKeys(b, ["model", "model_id"]);
	if (b.model !== undefined && b.model_id !== undefined) fail("INVALID", "specify model or model_id, not both");
	const entry = b.model === undefined ? runConfig(db, a.run_id).models.find((m) => m.id === str(b, "model_id")) : registerRunModel(ctx, p, a.run_id, b.model);
	if (!entry) fail("NOT_FOUND", "model is not in the run catalog");
	const cfg = runConfig(db, a.run_id);
	const why = modelIneligibility(entry, cfg, [id, ...getAncestry(db, id)].map((x) => getAllocation(db, x).limits.allowed_providers));
	if (why) fail("FORBIDDEN", why);
	const meta = parseJson<Record<string, any>>(a.metadata_json, {});
	if (Array.isArray(meta.capabilities) && meta.capabilities.some((c: string) => !entry.capability_tags.includes(c))) fail("FORBIDDEN", "model lacks required member capabilities");
	const change = { request_id: newId("modelchange"), provider: entry.provider, model: entry.model };
	meta.actual_model ??= { provider: a.provider, model: a.model };
	meta.model_change = change;
	// Persist launch settings now, so a worker which is offline also gets the new model.
	run(db, "UPDATE agents SET provider=?, model=?, model_id=?, metadata_json=? WHERE id=?", entry.provider, entry.model, entry.id, JSON.stringify(meta), id);
	emit(db, { run_id: a.run_id, actor_id: p.actor_id, type: "agent.model_requested", entity_id: id, payload: change });
	ctx.kick();
	return { agent_id: id, ...change, status: "PENDING", note: "Applied in the same Pi process when idle; inspect metadata.model_change for pending state" };
}

/** Report Pi's actual selection, including direct /model changes; never send a leader inbox message. */
export function selectedModel(ctx: Ctx, p: Principal, body: unknown) {
	const principal = requireAgent(p), b = obj(body), db = ctx.db;
	onlyKeys(b, ["provider", "model", "request_id"]);
	const provider = str(b, "provider"), model = str(b, "model"), requestId = str(b, "request_id", { optional: true });
	const a = getAgent(db, principal.actor_id), meta = parseJson<Record<string, any>>(a.metadata_json, {});
	if (requestId && meta.model_change?.request_id !== requestId) return { applied: false, superseded: true };
	delete meta.model_change;
	meta.actual_model = { provider, model };
	const entry = runConfig(db, a.run_id).models.find((m) => m.provider === provider && m.model === model);
	run(db, "UPDATE agents SET provider=?, model=?, model_id=?, metadata_json=? WHERE id=?", provider, model, entry?.id ?? null, JSON.stringify(meta), a.id);
	run(db, "UPDATE sessions SET provider=?, model=? WHERE id=?", provider, model, principal.session_id);
	emit(db, { run_id: a.run_id, actor_id: a.id, type: "agent.model_selected", entity_id: a.id, payload: { provider, model } });
	return { applied: true, provider, model };
}
