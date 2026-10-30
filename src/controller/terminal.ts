import type { Ctx, Principal } from "./context.ts";
import { getRun, runConfig } from "./queries.ts";
import { obj, onlyKeys, str } from "./validate.ts";
import { fail } from "./errors.ts";
import { run, emit } from "./db.ts";

export function terminalMode(ctx: Ctx, p: Principal, id: string, body?: unknown) {
	const row = getRun(ctx.db, id);
	if (p.kind === "agent" && p.run_id !== id) fail("FORBIDDEN", "other run");
	const cfg = runConfig(ctx.db, id);
	if (body !== undefined) {
		if (p.kind !== "operator" && p.actor_id !== row.root_agent_id) fail("FORBIDDEN", "only the root may enable interactive terminals");
		const b = obj(body);
		onlyKeys(b, ["socket"]);
		const socket = str(b, "socket", { optional: true });
		cfg.terminal = socket ? { socket } : {};
		run(ctx.db, "UPDATE runs SET config_json = ? WHERE id = ?", JSON.stringify(cfg), id);
		emit(ctx.db, { run_id: id, actor_id: p.actor_id, type: "run.terminal_enabled", entity_id: id, payload: {} });
		ctx.kick();
	}
	return { enabled: cfg.terminal !== undefined, ...cfg.terminal };
}
