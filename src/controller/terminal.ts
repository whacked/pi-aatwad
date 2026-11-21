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
		onlyKeys(b, ["enabled", "backend", "socket", "location", "debug"]);
		if (b.enabled !== undefined && typeof b.enabled !== "boolean") fail("INVALID", "enabled must be boolean");
		if (b.enabled === false) {
			if (b.backend !== undefined || b.socket !== undefined || b.location !== undefined || b.debug !== undefined) fail("INVALID", "enabled=false cannot include terminal options");
			delete cfg.terminal;
			cfg.terminal_disabled = true;
			run(ctx.db, "UPDATE runs SET config_json = ? WHERE id = ?", JSON.stringify(cfg), id);
			emit(ctx.db, { run_id: id, actor_id: p.actor_id, type: "run.terminal_disabled", entity_id: id, payload: {} });
			ctx.kick();
			return { enabled: false, auto_open: false };
		}
		if (b.debug !== undefined && typeof b.debug !== "boolean") fail("INVALID", "debug must be boolean");
		if (b.backend !== undefined && b.backend !== "tmux" && b.backend !== "rex") fail("INVALID", "backend must be tmux or rex");
		const backend = b.backend === "rex" ? "rex" as const : undefined;
		if (backend && b.debug) fail("INVALID", "the debug control pane is tmux-only");
		const socket = str(b, "socket", { optional: true });
		let location: { window: string; leader: string } | undefined;
		if (b.location !== undefined) {
			const l = obj(b.location); onlyKeys(l, ["window", "leader"]);
			const window = str(l, "window"), leader = str(l, "leader");
			if (backend === "rex" ? !/^window:[0-9a-f-]+$/i.test(window) || !/^block:[0-9a-f-]+$/i.test(leader) : !/^@\d+$/.test(window) || !/^%\d+$/.test(leader))
				fail("INVALID", `location must use ${backend === "rex" ? "Rex window/block" : "tmux window/pane"} IDs`);
			location = { window, leader };
		}
		cfg.terminal = { ...(backend ? { backend } : {}), ...(socket ? { socket } : {}), ...(location ? { location } : {}), ...(b.debug ? { debug: true } : {}) };
		delete cfg.terminal_disabled;
		run(ctx.db, "UPDATE runs SET config_json = ? WHERE id = ?", JSON.stringify(cfg), id);
		emit(ctx.db, { run_id: id, actor_id: p.actor_id, type: "run.terminal_enabled", entity_id: id, payload: {} });
		ctx.kick();
	}
	return { enabled: cfg.terminal !== undefined, auto_open: !cfg.terminal_disabled, ...cfg.terminal };
}
