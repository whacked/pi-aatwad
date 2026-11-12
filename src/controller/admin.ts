// Resource policy belongs to the human operator, never to an agent session.
import type { Ctx, Principal } from "./context.ts";
import { getRun, runConfig } from "./queries.ts";
import { obj, onlyKeys, oneOf } from "./validate.ts";
import { all, run, emit, tx } from "./db.ts";
import { fail } from "./errors.ts";
export function adminPolicy(ctx: Ctx, p: Principal, runId: string, body?: unknown) {
	getRun(ctx.db, runId);
	if (p.kind === "agent" && p.run_id !== runId) fail("FORBIDDEN", "other run");
	const cfg = runConfig(ctx.db, runId);
	if (body !== undefined) {
		if (p.kind !== "operator") fail("FORBIDDEN", "only the human operator can change resource limits");
		const b = obj(body); onlyKeys(b, ["mode"]);
		const mode = oneOf(b, "mode", ["unlimited", "bounded", "clear-deadlines"] as const);
		tx(ctx.db, () => {
			if (mode === "clear-deadlines") {
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
			run(ctx.db, "UPDATE runs SET config_json=? WHERE id=?", JSON.stringify(cfg), runId);
			emit(ctx.db, { run_id: runId, actor_id: p.actor_id, type: "run.resource_policy_changed", entity_id: runId, payload: { unlimited: !!cfg.operator_unlimited, action: mode } });
		});
		ctx.kick();
	}
	return { run_id: runId, mode: cfg.operator_unlimited ? "unlimited" : "bounded", unlimited: !!cfg.operator_unlimited };
}
