// Resource policy belongs to the human operator, never to an agent session.
import type { Ctx, Principal, ReqScope } from "./context.ts";
import type { Envelope_Limits, RunConfig } from "../shared/protocol.ts";
import { getRun, runConfig, TERMINAL_SQL } from "./queries.ts";
import { obj, onlyKeys, oneOf } from "./validate.ts";
import { type DB, all, get, run, emit, tx } from "./db.ts";
import { fail } from "./errors.ts";
import { recomputeAllocations } from "./budgets.ts";
import { lifecycle } from "./topology.ts";

const usd = (n: number) => `$${n}`;

/** Every limit currently able to block or pause this team, in the operator's words. */
export function activeLimits(db: DB, runId: string): string[] {
	const cfg = runConfig(db, runId), l = cfg.limits, out: string[] = [];
	if (l.max_run_usd != null) out.push(`team spend ≤ ${usd(l.max_run_usd)}`);
	if (l.max_live_agents != null) out.push(`live agents ≤ ${l.max_live_agents}`);
	if (l.max_pending_spawns != null) out.push(`pending launches ≤ ${l.max_pending_spawns}`);
	if (l.emergency_max_depth != null) out.push(`hierarchy depth ≤ ${l.emergency_max_depth}`);
	if (l.max_agent_seconds > 0) out.push(`member session ≤ ${l.max_agent_seconds}s`);
	const members = all(db, `SELECT a.id, a.role, a.metadata_json, al.limits_json FROM agents a JOIN allocations al ON al.agent_id = a.id WHERE a.run_id = ? AND a.status NOT IN ${TERMINAL_SQL} ORDER BY a.created_at`, runId);
	const root = getRun(db, runId).root_agent_id;
	for (const m of members) {
		const e = JSON.parse(m.limits_json) as Envelope_Limits, meta = JSON.parse(m.metadata_json), parts: string[] = [];
		// Children copy their lead's envelope: report it once, at the root.
		if (m.id === root) {
			if (e.max_subtree_usd != null) parts.push(`subtree spend ≤ ${usd(e.max_subtree_usd)}`);
			if (e.max_subtree_slots != null) parts.push(`members ≤ ${e.max_subtree_slots}`);
			if (e.max_grant_usd != null || e.max_grant_slots != null) parts.push(`single grant ≤ ${e.max_grant_slots ?? "∞"} members/${e.max_grant_usd == null ? "$∞" : usd(e.max_grant_usd)}`);
		}
		if (m.id !== root && typeof meta.own_budget_usd === "number" && !meta.budget_inherited) parts.push(`own spend ≤ ${usd(meta.own_budget_usd)}`);
		if (Number(meta.max_runtime_seconds) > 0) parts.push(`runtime ≤ ${meta.max_runtime_seconds}s`);
		if (m.id !== root && e.max_session_seconds > 0) parts.push(`session ≤ ${e.max_session_seconds}s`);
		if (parts.length) out.push(`${m.id === root ? "leader" : m.role} (${m.id}): ${parts.join(", ")}`);
	}
	return out;
}

const UNBOUNDED: Pick<Envelope_Limits, "max_subtree_slots" | "max_subtree_usd" | "max_grant_slots" | "max_grant_usd" | "max_session_seconds"> =
	{ max_subtree_slots: null, max_subtree_usd: null, max_grant_slots: null, max_grant_usd: null, max_session_seconds: 0 };

/** Lift every numeric limit of a run and resume the members those limits had paused. */
function clearLimits(ctx: Ctx, p: Principal, scope: ReqScope, runId: string, cfg: RunConfig): { resumed: string[]; still_paused: string[] } {
	const db = ctx.db, root = getRun(db, runId).root_agent_id as string;
	Object.assign(cfg.limits, { max_live_agents: null, max_pending_spawns: null, emergency_max_depth: null, max_run_usd: null, max_run_seconds: 0, max_agent_seconds: 0 });
	Object.assign(cfg.root_envelope, UNBOUNDED);
	run(db, "UPDATE runs SET config_json=? WHERE id=?", JSON.stringify(cfg), runId);
	for (const a of all(db, "SELECT a.id, a.metadata_json, al.limits_json FROM agents a JOIN allocations al ON al.agent_id=a.id WHERE a.run_id=?", runId)) {
		const meta = JSON.parse(a.metadata_json);
		meta.max_runtime_seconds = null;
		if (a.id === root) delete meta.own_budget_usd;
		// One shared, unbounded pool again: every member inherits from the leader.
		else Object.assign(meta, { own_budget_usd: null, budget_inherited: true, budget_pool_id: root });
		run(db, "UPDATE allocations SET limits_json=? WHERE agent_id=?", JSON.stringify({ ...JSON.parse(a.limits_json), ...UNBOUNDED }), a.id);
		run(db, "UPDATE agents SET metadata_json=? WHERE id=?", JSON.stringify(meta), a.id);
	}
	// Reservations keep their member slots (topology) but no longer hold any money.
	run(db, "UPDATE reservations SET usd=0 WHERE run_id=? AND state='ACTIVE'", runId);
	recomputeAllocations(db, runId);
	const resumed: string[] = [], still_paused: string[] = [];
	for (const a of all(db, `SELECT id FROM agents WHERE run_id=? AND desired_state='PAUSED' AND status NOT IN ${TERMINAL_SQL} ORDER BY created_at`, runId)) {
		// Only pauses a limit caused are undone; a manager's or operator's pause is a decision.
		const cause = get(db, "SELECT type FROM events WHERE run_id=? AND entity_id=? AND type IN ('budget.exhausted','agent.deadline_exceeded','agent.lifecycle') ORDER BY seq DESC LIMIT 1", runId, a.id)?.type;
		if (cause === "budget.exhausted" || cause === "agent.deadline_exceeded") {
			lifecycle(ctx, p, scope, a.id, { action: "resume", reason: "operator cleared the limit that paused this member" });
			resumed.push(a.id);
		} else still_paused.push(a.id);
	}
	return { resumed, still_paused };
}

export function adminPolicy(ctx: Ctx, p: Principal, scope: ReqScope, runId: string, body?: unknown) {
	getRun(ctx.db, runId);
	if (p.kind === "agent" && p.run_id !== runId) fail("FORBIDDEN", "other run");
	const cfg = runConfig(ctx.db, runId);
	let cleared: { resumed: string[]; still_paused: string[] } | undefined;
	if (body !== undefined) {
		if (p.kind !== "operator") fail("FORBIDDEN", "only the human operator can change resource limits");
		const b = obj(body); onlyKeys(b, ["mode"]);
		const mode = oneOf(b, "mode", ["unlimited", "bounded", "clear-deadlines", "clear-limits"] as const);
		tx(ctx.db, () => {
			if (mode === "clear-limits") cleared = clearLimits(ctx, p, scope, runId, cfg);
			else if (mode === "clear-deadlines") {
				// Explicit operator action, not a migration: saved intentional caps stay
				// intact until requested. Do not alter budgets, states, or blocked tasks.
				cfg.limits.max_agent_seconds = 0;
				cfg.limits.max_run_seconds = 0;
				cfg.root_envelope.max_session_seconds = 0;
				for (const a of all(ctx.db, "SELECT a.id, a.metadata_json, al.limits_json FROM agents a JOIN allocations al ON al.agent_id=a.id WHERE a.run_id=?", runId)) {
					const limits = JSON.parse(a.limits_json);
					limits.max_session_seconds = 0;
					const meta = JSON.parse(a.metadata_json);
					meta.max_runtime_seconds = null;
					run(ctx.db, "UPDATE allocations SET limits_json=? WHERE agent_id=?", JSON.stringify(limits), a.id);
					run(ctx.db, "UPDATE agents SET metadata_json=? WHERE id=?", JSON.stringify(meta), a.id);
				}
			} else cfg.operator_unlimited = mode === "unlimited";
			if (mode !== "clear-limits") run(ctx.db, "UPDATE runs SET config_json=? WHERE id=?", JSON.stringify(cfg), runId);
			emit(ctx.db, { run_id: runId, actor_id: p.actor_id, type: "run.resource_policy_changed", entity_id: runId, payload: { unlimited: !!cfg.operator_unlimited, action: mode, ...(cleared ?? {}) } });
		});
		ctx.kick();
	}
	return { run_id: runId, mode: cfg.operator_unlimited ? "unlimited" : "bounded", unlimited: !!cfg.operator_unlimited, limits: activeLimits(ctx.db, runId), ...(cleared ?? {}) };
}
