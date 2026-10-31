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
		onlyKeys(b, ["socket", "location", "debug"]);
		if (b.debug !== undefined && typeof b.debug !== "boolean") fail("INVALID", "debug must be boolean");
		const socket = str(b, "socket", { optional: true });
		let location: { window: string; leader: string } | undefined;
		if (b.location !== undefined) {
			const l = obj(b.location); onlyKeys(l, ["window", "leader"]);
			const window = str(l, "window"), leader = str(l, "leader");
			if (!/^@\d+$/.test(window) || !/^%\d+$/.test(leader)) fail("INVALID", "location must use tmux window/pane IDs");
			location = { window, leader };
		}
		cfg.terminal = { ...(socket ? { socket } : {}), ...(location ? { location } : {}), ...(b.debug ? { debug: true } : {}) };
		run(ctx.db, "UPDATE runs SET config_json = ? WHERE id = ?", JSON.stringify(cfg), id);
		emit(ctx.db, { run_id: id, actor_id: p.actor_id, type: "run.terminal_enabled", entity_id: id, payload: {} });
		ctx.kick();
	}
	return { enabled: cfg.terminal !== undefined, ...cfg.terminal };
}
