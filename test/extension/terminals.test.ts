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

for (const savedLocation of ["saved", "missing", "disabled", "moved"]) test(`pane ownership is released for a new team (location: ${savedLocation}); active teams remain protected`, { skip: !haveTmux }, async () => {
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
		let elsewhere: string | undefined;
		if (savedLocation === "saved") {
			await hs.call("POST", `/runs/${old.run_id}/terminal`, { token: hs.op, body: { socket, location: view.opts.location } });
			await hs.call("POST", `/agents/${old.root}/lifecycle`, { token: hs.op, body: { action: "cancel", reason: "old team stopped", children_policy: "cascade" } });
		}
		if (savedLocation === "disabled") {
			await hs.call("POST", `/runs/${old.run_id}/terminal`, { token: hs.op, body: { socket, location: view.opts.location } });
			await hs.call("POST", `/runs/${old.run_id}/terminal`, { token: hs.op, body: { enabled: false } });
		}
		if (savedLocation === "moved") {
			elsewhere = await view.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "user-session", "/bin/sh");
			const moved = new TmuxWatch({ stateDir: hs.dir, runId: old.run_id, socket });
			await moved.open(elsewhere);
			await hs.call("POST", `/runs/${old.run_id}/terminal`, { token: hs.op, body: { socket, location: moved.opts.location } });
		}
		// Without a saved location the old root-only team is still RUNNING, as
		// after /new; its tmux tags outlive the Pi session that installed them.
		process.env.TMUX = `${socket},0,0`; process.env.TMUX_PANE = pane;
		const rt = { paths: statePaths(hs.dir), commandToken: async () => hs.op, client: new TeamClient({ paths: statePaths(hs.dir), noReconnect: true }) } as any;
		const foreign = new TmuxWatch({ stateDir: join(hs.dir, "another-controller"), runId: old.run_id, socket });
		await foreign.tag(pane, "leader");
		await assert.rejects(openTerminals(rt, current.run_id), /another controller state directory/);
		assert.equal(await foreign.tmux("show-options", "-p", "-qv", "-t", pane, "@pi_team_owner"), foreign.owner);
		await view.tag(pane, "old-member");
		await assert.rejects(openTerminals(rt, current.run_id), /not its leader/);
		assert.equal(await view.tmux("display-message", "-p", "-t", pane, "#{pane_pid}"), pid, "old member pane is not killed");
		await view.tag(pane, "leader");
		const fresh = await openTerminals(rt, current.run_id);
		assert.equal(await fresh.tmux("show-options", "-p", "-qv", "-t", pane, "@pi_team_owner"), fresh.owner);
		assert.equal(await fresh.tmux("display-message", "-p", "-t", pane, "#{pane_pid}"), pid);
		assert.equal((await fresh.tmux("list-sessions", "-F", "#{session_name}")).trim(), "user-session");
		if (elsewhere) assert.equal(await view.tmux("show-options", "-p", "-qv", "-t", elsewhere, "@pi_team_owner"), view.owner, "a different saved layout is not released");
		assert.equal((await hs.call("GET", "/runs", { token: hs.op })).body.runs.find((r: any) => r.run_id === old.run_id).status, savedLocation === "saved" ? "CANCELLED" : "RUNNING");
		await hs.call("POST", "/members", { token: current.token, body: { name: "Active", responsibility: "Wait for new tasks" } });
		await assert.rejects(openTerminals(rt, next.run_id), /active members.*team resume/);
		assert.equal(await fresh.tmux("show-options", "-p", "-qv", "-t", pane, "@pi_team_owner"), fresh.owner);
	} finally {
		for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		try { await view?.tmux("kill-server"); } catch {}
		await hs.cleanup();
	}
});

test("recruitment works with missing tmux, stale markers, Herdr and an explicit headless preference", async () => {
 const { registerTools } = await import("../../src/extension/tools.ts");
 const hs = await harness();
 const previous = { PATH: process.env.PATH, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, HERDR_ENV: process.env.HERDR_ENV };
 try {
  const team = await newRun(hs, { models: [] });
  const client = new TeamClient({ paths: statePaths(hs.dir), token: () => team.token, noReconnect: true });
  const tools = new Map<string, any>();
  const rt = { identity: { run_id: team.run_id, agent_id: team.root }, paths: statePaths(hs.dir), client, managed: false,
   commandToken: async () => hs.op, agentCall: (fn: () => unknown) => fn() };
  registerTools({ registerTool: (t: any) => tools.set(t.name, t) } as any, rt as any);
  // No executable can be found on this PATH, including tmux. Stub workers need none.
  process.env.PATH = hs.dir;
  delete process.env.TMUX; delete process.env.TMUX_PANE; delete process.env.HERDR_ENV;
  const create = (name: string) => tools.get("team_create_member").execute(name, { name, responsibility: "Wait" }, undefined, undefined, {});
  assert.equal((await create("PlainSSH")).details.spawned_agent_ids.length, 1);
  process.env.TMUX = "/missing/server,1,0"; process.env.TMUX_PANE = "%987654";
  const stale = await create("StaleTmux");
  assert.equal(stale.details.spawned_agent_ids.length, 1);
  assert.match(stale.details.terminal_warning, /tmux is not installed/);
  process.env.HERDR_ENV = "1";
  const herdr = await create("Herdr");
  assert.equal(herdr.details.spawned_agent_ids.length, 1);
  assert.equal(herdr.details.terminal_warning, undefined, "Herdr ignores inherited outer tmux markers");
  delete process.env.HERDR_ENV;
  await client.post(`/runs/${team.run_id}/terminal`, { enabled: false });
  const disabled = await create("ExplicitHeadless");
  assert.equal(disabled.details.spawned_agent_ids.length, 1);
  assert.equal(disabled.details.terminal_warning, undefined, "manual headless preference avoids invoking tmux");
  const status = await tools.get("team_watch").execute("status", { action: "status" }, undefined, undefined, {});
  assert.equal(status.details.mode, "headless");
 } finally {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await hs.cleanup();
 }
});
