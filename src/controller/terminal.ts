import type { Ctx, Principal } from "./context.ts";
import { getRun, runConfig } from "./queries.ts";
import { obj, onlyKeys, str } from "./validate.ts";
import { fail } from "./errors.ts";
import { run, emit } from "./db.ts";
import { backendFacts, BACKENDS, isBackend } from "../terminal/backends.ts";

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
		if (b.backend !== undefined && !isBackend(b.backend)) fail("INVALID", `backend must be one of ${Object.keys(BACKENDS).join(", ")}`);
		const facts = backendFacts(b.backend as Parameters<typeof backendFacts>[0]);
		// The default backend is recorded by omission, as older configurations were.
		const backend = facts.id === backendFacts(undefined).id ? undefined : facts.id;
		if (b.debug && !facts.debugPane) fail("INVALID", `the debug control pane is only available on ${Object.values(BACKENDS).filter((x) => x.debugPane).map((x) => x.label).join(", ")}`);
		const socket = str(b, "socket", { optional: true });
		let location: { window: string; leader: string } | undefined;
		if (b.location !== undefined) {
			const l = obj(b.location); onlyKeys(l, ["window", "leader"]);
			const window = str(l, "window"), leader = str(l, "leader");
			if (!facts.validLocation({ window, leader })) fail("INVALID", `location must use ${facts.locationFormat}`);
			location = { window, leader };
		}
		// Backends without an on-screen place (the built-in host) have one fixed location.
		if (facts.fixedLocation) location = { ...facts.fixedLocation };
		cfg.terminal = { ...(backend ? { backend } : {}), ...(socket ? { socket } : {}), ...(location ? { location } : {}), ...(b.debug ? { debug: true } : {}) };
		delete cfg.terminal_disabled;
		run(ctx.db, "UPDATE runs SET config_json = ? WHERE id = ?", JSON.stringify(cfg), id);
		emit(ctx.db, { run_id: id, actor_id: p.actor_id, type: "run.terminal_enabled", entity_id: id, payload: {} });
		ctx.kick();
	}
	return { enabled: cfg.terminal !== undefined, auto_open: !cfg.terminal_disabled, ...cfg.terminal };
}
