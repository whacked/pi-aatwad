import { lifecycle } from "./topology.ts";
// Live member configuration. Mutations run in the server's idempotent transaction.
import type { Ctx, Principal, ReqScope } from "./context.ts";
import { emit, newId, parseJson, run } from "./db.ts";
import { fail } from "./errors.ts";
import { obj, onlyKeys, str } from "./validate.ts";
import { getAgent, getAllocation, getAncestry, getRun, getSubtree, isAncestor, isTerminal, runConfig } from "./queries.ts";
import { assertWithinEnvelopes, budgetPool, budgetView, ownBudgetUsd, recomputeAllocations } from "./budgets.ts";
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
	if (usd === null) return removeBudget(ctx, p, scope, a, b.resume === true);
	if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) fail("INVALID", "max_cost_usd must be a nonnegative finite total ceiling, or null to remove the ceiling");
	const db = ctx.db, cfg = runConfig(db, a.run_id), allocation = getAllocation(db, id);
	if (usd < allocation.consumed_usd) fail("BUDGET_EXCEEDED", "cannot set a budget below spend already consumed");
	const before = ownBudgetUsd(db, id);
	const pool = budgetPool(db, id);
	const oldReservation = ctx.db.prepare("SELECT usd FROM reservations WHERE beneficiary_id=? AND state='ACTIVE' LIMIT 1").get(id) as { usd: number } | undefined;
	const delta = usd - (oldReservation?.usd ?? 0);
	if (pool.id === id && usd < pool.consumed) fail("BUDGET_EXCEEDED", "cannot set a pool budget below spend already consumed");
	const grant = p.kind === "agent" ? getAllocation(db, p.actor_id).limits.max_grant_usd : null;
	if (!cfg.operator_unlimited && grant !== null && delta > grant) fail("FORBIDDEN", "increase exceeds your single-decision grant; ask your manager");
	run(db, "UPDATE reservations SET usd=? WHERE beneficiary_id=? AND state='ACTIVE'", usd, id);
	const meta = parseJson<Record<string, unknown>>(a.metadata_json, {});
	// A new explicit ceiling separates this inherited branch into its own pool.
	for (const descendant of getSubtree(db, id)) {
		const childMeta = parseJson<Record<string, unknown>>(getAgent(db, descendant).metadata_json, {});
		if ((childMeta.budget_pool_id ?? descendant) !== pool.id) continue;
		childMeta.budget_pool_id = id;
		run(db, "UPDATE agents SET metadata_json=? WHERE id=?", JSON.stringify(childMeta), descendant);
	}
	meta.own_budget_usd = usd;
	meta.budget_inherited = false;
	meta.budget_pool_id = id;
	run(db, "UPDATE agents SET metadata_json=? WHERE id=?", JSON.stringify(meta), id);
	recomputeAllocations(db, a.run_id);
	assertWithinEnvelopes(db, [id, ...getAncestry(db, id)]);
	const r = getRun(db, a.run_id);
	if (!cfg.operator_unlimited && cfg.limits.max_run_usd !== null && runSpendUsd(db, a.run_id, r.root_agent_id) > cfg.limits.max_run_usd + 1e-9) fail("HARD_CAP", "increase exceeds the run's total budget");
	emit(db, { run_id: a.run_id, actor_id: p.actor_id, type: "budget.updated", entity_id: id, payload: { before, max_cost_usd: usd } });
	if (b.resume) {
		if (usd <= allocation.consumed_usd) fail("BUDGET_EXCEEDED", "resume requires unspent budget");
		lifecycle(ctx, p, scope, id, { action: "resume", reason: "resume requested with budget update" });
	}
	ctx.kick();
	return budgetView(db, id);
}

/** Drop a member's own ceiling: it rejoins its lead's pool (unbounded when the lead is). */
function removeBudget(ctx: Ctx, p: Principal, scope: ReqScope, a: ReturnType<typeof getAgent>, resume: boolean) {
	const db = ctx.db, id = a.id as string, before = ownBudgetUsd(db, id);
	const lead = getAncestry(db, id)[0];
	const meta = parseJson<Record<string, unknown>>(a.metadata_json, {});
	if (lead) {
		const target = budgetPool(db, lead).id;
		// Members that inherited this member's pool follow it into the lead's pool.
		for (const descendant of getSubtree(db, id).slice(1)) {
			const childMeta = parseJson<Record<string, unknown>>(getAgent(db, descendant).metadata_json, {});
			if (childMeta.budget_pool_id !== id) continue;
			childMeta.budget_pool_id = target;
			run(db, "UPDATE agents SET metadata_json=? WHERE id=?", JSON.stringify(childMeta), descendant);
		}
		meta.own_budget_usd = null;
		meta.budget_inherited = true;
		meta.budget_pool_id = target;
	} else {
		delete meta.own_budget_usd;
		delete meta.budget_inherited;
		delete meta.budget_pool_id;
	}
	run(db, "UPDATE agents SET metadata_json=? WHERE id=?", JSON.stringify(meta), id);
	run(db, "UPDATE reservations SET usd=0 WHERE beneficiary_id=? AND state='ACTIVE'", id);
	recomputeAllocations(db, a.run_id);
	emit(db, { run_id: a.run_id, actor_id: p.actor_id, type: "budget.updated", entity_id: id, payload: { before, max_cost_usd: null } });
	if (resume) lifecycle(ctx, p, scope, id, { action: "resume", reason: "resume requested with budget removal" });
	ctx.kick();
	return budgetView(db, id);
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
