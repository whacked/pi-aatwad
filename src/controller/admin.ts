// Resource policy belongs to the human operator, never to an agent session.
import type { Ctx, Principal } from "./context.ts";
import { getRun, runConfig } from "./queries.ts";
import { obj, onlyKeys, oneOf } from "./validate.ts";
import { run, emit } from "./db.ts";
import { fail } from "./errors.ts";
export function adminPolicy(ctx: Ctx, p: Principal, runId: string, body?: unknown) {
	getRun(ctx.db, runId);
	if (p.kind === "agent" && p.run_id !== runId) fail("FORBIDDEN", "other run");
	const cfg = runConfig(ctx.db, runId);
	if (body !== undefined) {
		if (p.kind !== "operator") fail("FORBIDDEN", "only the human operator can change resource limits");
		const b = obj(body); onlyKeys(b, ["mode"]);
		cfg.operator_unlimited = oneOf(b, "mode", ["unlimited", "bounded"] as const) === "unlimited";
		run(ctx.db, "UPDATE runs SET config_json=? WHERE id=?", JSON.stringify(cfg), runId);
		emit(ctx.db, { run_id: runId, actor_id: p.actor_id, type: "run.resource_policy_changed", entity_id: runId, payload: { unlimited: cfg.operator_unlimited } });
		ctx.kick();
	}
	return { run_id: runId, mode: cfg.operator_unlimited ? "unlimited" : "bounded", unlimited: !!cfg.operator_unlimited };
}
