import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openTerminals } from "../../src/extension/terminals.ts";
import { TeamClient } from "../../src/shared/client.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { TmuxWatch } from "../../src/watch/tmux.ts";
import { harness, newRun } from "../controller/helpers.ts";
const haveTmux = spawnSync("tmux", ["-V"]).status === 0;

test("stopped pane ownership is released for a new team; active teams remain protected", { skip: !haveTmux }, async () => {
	const hs = await harness();
	const socket = join(hs.dir, "tmux.sock");
	const oldEnv = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
	let view: TmuxWatch | undefined;
	try {
		const old = await newRun(hs), current = await newRun(hs), next = await newRun(hs);
		view = new TmuxWatch({ stateDir: hs.dir, runId: old.run_id, socket });
		const pane = await view.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "user-session", "-x", "180", "-y", "50", "/bin/sh");
		await view.open(pane);
		const pid = await view.tmux("display-message", "-p", "-t", pane, "#{pane_pid}");
		await hs.call("POST", `/runs/${old.run_id}/terminal`, { token: hs.op, body: { socket, location: view.opts.location } });
		await hs.call("POST", `/agents/${old.root}/lifecycle`, { token: hs.op, body: { action: "cancel", reason: "old team stopped", children_policy: "cascade" } });
		process.env.TMUX = `${socket},0,0`; process.env.TMUX_PANE = pane;
		const rt = { paths: statePaths(hs.dir), commandToken: async () => hs.op, client: new TeamClient({ paths: statePaths(hs.dir), noReconnect: true }) } as any;
		const fresh = await openTerminals(rt, current.run_id);
		assert.equal(await fresh.tmux("show-options", "-p", "-qv", "-t", pane, "@pi_team_owner"), fresh.owner);
		assert.equal(await fresh.tmux("display-message", "-p", "-t", pane, "#{pane_pid}"), pid);
		assert.equal((await fresh.tmux("list-sessions", "-F", "#{session_name}")).trim(), "user-session");
		await hs.call("POST", "/members", { token: current.token, body: { name: "Active", responsibility: "Wait for new tasks" } });
		await assert.rejects(openTerminals(rt, next.run_id), /active members.*team resume/);
		assert.equal(await fresh.tmux("show-options", "-p", "-qv", "-t", pane, "@pi_team_owner"), fresh.owner);
	} finally {
		for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		try { await view?.tmux("kill-server"); } catch {}
		await hs.cleanup();
	}
});
