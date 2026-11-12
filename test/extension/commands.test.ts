import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { TmuxWatch } from "../../src/watch/tmux.ts";
import { registerTeamCommand } from "../../src/extension/commands.ts";
import { TeamRuntime, __resetProcessStateForTests } from "../../src/extension/runtime.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { harness, newRun } from "../controller/helpers.ts";

test("stop own run, stop another, repeat stop, and refresh completion without false fencing", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const entries: any[] = [], notes: string[] = [];
	let command: any;
	const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: () => {}, getAllTools: () => [], registerCommand: (_name: string, definition: unknown) => { command = definition; } };
	const ctx = { hasUI: true, mode: "rpc", cwd: hs.dir, isIdle: () => true, hasPendingMessages: () => false,
		ui: { notify: (text: string) => notes.push(text), confirm: async () => true, setStatus: () => {} },
		sessionManager: { getSessionId: () => "stop-session", getSessionFile: () => undefined, getEntries: () => entries } } as any;
	const rt = new TeamRuntime(pi as any, { paths: statePaths(hs.dir), env: {}, heartbeatMs: 60000 });
	try {
		const own = await newRun(hs), other = await newRun(hs), legacy = await newRun(hs);
		await hs.call("POST", `/agents/${legacy.root}/lifecycle`, { token: hs.op, body: { action: "cancel", reason: "old stopped run", children_policy: "cascade" } });
		hs.h.db.prepare("UPDATE runs SET status='RUNNING' WHERE id=?").run(legacy.run_id); // old controller's stale status
		await rt.start(ctx);
		const me = (await hs.call("GET", "/me", { token: own.token })).body;
		rt.adoptNew({ run_id: own.run_id, agent_id: own.root, session_id: me.session_id, token: own.token, managed: false, pi_session_id: "stop-session" });
		registerTeamCommand(pi as any, rt);
		const suggestions = async (sub: string) => (await command.getArgumentCompletions(`${sub} `) ?? []).map((c: any) => c.label);
		assert.deepEqual(new Set(await suggestions("stop")), new Set([own.run_id, other.run_id]));
		await command.handler("stop", ctx);
		assert.equal(rt.identity, undefined);
		assert.equal(rt.fenced, false);
		assert.match(rt.notice!, /CANCELLED/);
		await rt.heartbeat();
		assert.deepEqual(await suggestions("stop"), [other.run_id]);
		assert.ok(!(await suggestions("resume")).includes(own.run_id));
		assert.ok((await suggestions("events")).includes(own.run_id), "history remains accessible");
		await command.handler(`stop ${other.run_id}`, ctx);
		await command.handler(`stop ${other.run_id}`, ctx);
		assert.deepEqual(await suggestions("stop"), []);
		assert.ok(notes.some((n) => n.includes("already stopped")));
		assert.ok(!notes.some((n) => /FENCED|CONFLICT/.test(n)), notes.join("\n"));
		const rtReload = new TeamRuntime(pi as any, { paths: statePaths(hs.dir), env: {} });
		await rtReload.start(ctx);
		assert.equal(rtReload.identity, undefined);
		assert.match(rtReload.notice!, /CANCELLED/);
		rtReload.stop();
	} finally { rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

function commandSession(hs: Awaited<ReturnType<typeof harness>>, id: string, selectedRun: string) {
	const entries: any[] = [], notes: string[] = [], choices: string[][] = [];
	let command: any;
	const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }), sendMessage: () => {}, getAllTools: () => [],
		registerCommand: (_name: string, definition: unknown) => { command = definition; } };
	const ctx = { hasUI: true, mode: "rpc", cwd: hs.dir, isIdle: () => true, hasPendingMessages: () => false,
		ui: { notify: (text: string) => notes.push(text), confirm: async () => true, setStatus: () => {},
			select: async (_title: string, options: string[]) => { choices.push(options); return selectedRun ? options.find((s) => s.startsWith(selectedRun)) : undefined; } },
		sessionManager: { getSessionId: () => id, getSessionFile: () => undefined, getEntries: () => entries } } as any;
	const rt = new TeamRuntime(pi as any, { paths: statePaths(hs.dir), env: {}, heartbeatMs: 60000 });
	registerTeamCommand(pi as any, rt);
	return { rt, ctx, notes, choices, command };
}

test("fresh session init then watch reclaims stale leader tags after terminal metadata was cleared", { skip: spawnSync("tmux", ["-V"]).status !== 0 }, async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const env = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
	const old = commandSession(hs, "old-pane-session", ""), fresh = commandSession(hs, "new-pane-session", "");
	const view = new TmuxWatch({ stateDir: hs.dir, runId: "setup", socket: join(hs.dir, "tmux.sock") });
	try {
		const pane = await view.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "human", "/bin/sh");
		process.env.TMUX = `${view.opts.socket},0,0`; process.env.TMUX_PANE = pane;
		const pid = await view.tmux("display-message", "-p", "-t", pane, "#{pane_pid}");
		await old.rt.start(old.ctx);
		await old.command.handler("init", old.ctx);
		const oldRun = old.rt.identity!.run_id;
		await old.command.handler("watch", old.ctx);
		await old.command.handler("watch off", old.ctx); // leaves pane tags but deletes terminal config
		old.rt.stop();
		await fresh.rt.start(fresh.ctx);
		assert.equal(fresh.rt.identity, undefined);
		await fresh.command.handler("init", fresh.ctx);
		await fresh.command.handler("watch", fresh.ctx);
		assert.ok(fresh.notes.some((s) => s.includes("Team panes opened")), fresh.notes.join("\n"));
		assert.ok(!fresh.notes.some((s) => s.includes("Error:")), fresh.notes.join("\n"));
		assert.equal(await view.tmux("show-options", "-p", "-qv", "-t", pane, "@pi_team_owner"), new TmuxWatch({ stateDir: hs.dir, runId: fresh.rt.identity!.run_id }).owner);
		assert.equal(await view.tmux("display-message", "-p", "-t", pane, "#{pane_pid}"), pid);
		assert.equal((await hs.call("GET", "/runs", { token: hs.op })).body.runs.find((r: any) => r.run_id === oldRun).status, "RUNNING", "old team is not cancelled by reclaiming pane tags");
	} finally {
		old.rt.stop(); fresh.rt.stop();
		for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		try { await view.tmux("kill-server"); } catch {}
		await hs.cleanup(); __resetProcessStateForTests();
	}
});

test("resume auto-attaches the sole valid team; multiple teams show a picker and init cleanup remains safe", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	let fresh: ReturnType<typeof commandSession> | undefined, initialized: ReturnType<typeof commandSession> | undefined;
	try {
		const existing = await newRun(hs, { models: [] });
		for (const name of ["Alpha", "Beta"]) {
			const made = await hs.call("POST", "/members", { token: existing.token, body: { name, responsibility: `Say hello ${name}` } });
			assert.equal(made.status, 200, JSON.stringify(made.body));
		}
		const cancelled = await newRun(hs);
		await hs.call("POST", `/agents/${cancelled.root}/lifecycle`, { token: hs.op, body: { action: "cancel", reason: "old team", children_policy: "cascade" } });
		fresh = commandSession(hs, "fresh-resume", existing.run_id);
		await fresh.rt.start(fresh.ctx);
		assert.equal(fresh.rt.identity, undefined);
		await fresh.command.handler("resume", fresh.ctx);
		assert.equal((fresh.rt as TeamRuntime).identity?.run_id, existing.run_id, fresh.notes.join("\n"));
		assert.equal(fresh.choices.length, 0, "sole valid team resumes without a picker, excluding cancelled teams");
		assert.ok(fresh.notes.some((text) => text.includes("/team watch")));
		fresh.rt.stop();

		initialized = commandSession(hs, "init-then-resume", existing.run_id);
		await initialized.rt.start(initialized.ctx);
		await initialized.command.handler("init", initialized.ctx);
		const emptyId = initialized.rt.identity!.run_id;
		assert.notEqual(emptyId, existing.run_id);
		await initialized.command.handler("status", initialized.ctx);
		assert.ok(initialized.notes.some((s) => s.includes("no active members")));
		await initialized.command.handler("resume", initialized.ctx);
		assert.equal(initialized.choices.length, 1, "multiple valid teams require selection");
		assert.ok(initialized.choices[0].some((label) => label.includes("2 active members")));
		assert.ok(!initialized.choices[0].some((label) => label.includes(cancelled.run_id)));
		assert.equal(initialized.rt.identity!.run_id, existing.run_id);
		await initialized.rt.heartbeat();
		assert.equal(initialized.rt.fenced, false);
		const list = (await hs.call("GET", "/runs", { token: hs.op })).body.runs;
		assert.equal(list.find((r: any) => r.run_id === emptyId).status, "CANCELLED");
		assert.equal(list.find((r: any) => r.run_id === existing.run_id).active_members, 2);
		const resumedId = initialized.rt.identity!.agent_id;
		await initialized.command.handler(`resume ${cancelled.run_id}`, initialized.ctx);
		assert.equal(initialized.rt.identity!.agent_id, resumedId, "failed resume preserves current association");
		assert.ok(initialized.notes.some((s) => s.includes("cannot be resumed")));
	} finally { fresh?.rt.stop(); initialized?.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("resume handles a single team without UI and preserves association when already attached", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const session = commandSession(hs, "headless-resume", "");
	try {
		const existing = await newRun(hs);
		session.ctx.hasUI = false;
		await session.rt.start(session.ctx);
		await session.command.handler("resume", session.ctx);
		assert.equal(session.rt.identity?.run_id, existing.run_id, session.notes.join("\n"));
		assert.equal(session.choices.length, 0);
		const identity = session.rt.identity;
		session.ctx.hasUI = true;
		await session.command.handler("resume", session.ctx);
		assert.equal(session.rt.identity, identity, "already attached must not create a new controller session");
		assert.equal(session.choices.length, 0);
		assert.ok(session.notes.some((text) => text.includes("Already attached")));
	} finally { session.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("resume without UI lists multiple candidates rather than silently choosing one", async (t) => {
	__resetProcessStateForTests();
	const hs = await harness();
	const session = commandSession(hs, "headless-multiple", "");
	try {
		const first = await newRun(hs), second = await newRun(hs);
		session.ctx.hasUI = false;
		await session.rt.start(session.ctx);
		const output: string[] = [];
		const write = t.mock.method(process.stderr, "write", (chunk: any) => { output.push(String(chunk)); return true; });
		await session.command.handler("resume", session.ctx);
		write.mock.restore();
		assert.equal(session.rt.identity, undefined);
		assert.equal(session.choices.length, 0);
		assert.ok(output.some((text) => text.includes(first.run_id) && text.includes(second.run_id)));
		session.ctx.hasUI = true;
		await session.command.handler("resume", session.ctx); // selector returns undefined (cancel)
		assert.equal(session.choices.length, 1);
		assert.equal(session.rt.identity, undefined, "cancelling the selector leaves the session unattached");
	} finally { session.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("human init --unlimited and admin policy commands remove and restore bounded defaults", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const s = commandSession(hs, "admin-session", "");
	try {
		await s.rt.start(s.ctx);
		await s.command.handler("init --unlimited", s.ctx);
		assert.ok(s.rt.identity);
		assert.equal((await s.rt.client.budget(s.rt.identity!.agent_id)).unlimited, true);
		assert.ok(s.notes.some((n) => n.includes("policy: UNLIMITED")));
		await s.command.handler("admin bounded", s.ctx);
		assert.equal((await s.rt.client.budget(s.rt.identity!.agent_id)).unlimited, false);
		await s.command.handler("admin clear-deadlines", s.ctx);
		assert.ok(s.notes.some((n) => n.includes("deadlines cleared") && n.includes("budgets unchanged")));
		assert.equal((await s.rt.client.budget(s.rt.identity!.agent_id)).unlimited, false);
		await s.command.handler("admin unlimited", s.ctx);
		assert.equal((await s.rt.client.budget(s.rt.identity!.agent_id)).available_usd, null);
		await s.command.handler("stop", s.ctx);
		assert.equal(s.rt.identity, undefined);
		assert.equal(s.rt.fenced, false);
	} finally { s.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("commands accept quoted member names, suggest names, and change budget/model without config files", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const s = commandSession(hs, "named-commands", "");
	s.ctx.modelRegistry = { getAvailable: () => [{ provider: "openai", id: "test-model", name: "Test Model", cost: { input: 1, output: 2 } }] };
	try {
		await s.rt.start(s.ctx);
		await s.command.handler("init", s.ctx);
		const token = s.rt.identity!.token;
		const made = await hs.call("POST", "/members", { token, body: { name: "Senior Reviewer", responsibility: "Review" } });
		const id = made.body.spawned_agent_ids[0];
		await s.command.handler('budget "Senior Reviewer" 4', s.ctx);
		assert.equal((await s.rt.client.budget(id)).own_budget_usd, 4);
		const words = id.slice("agent-".length).replaceAll("-", " ");
		await s.command.handler(`budget "${words}" 3`, s.ctx);
		assert.equal((await s.rt.client.budget(id)).own_budget_usd, 3, "quoted multi-word IDs route to the selected member");
		await s.command.handler(`budget "agent ${words}" 4`, s.ctx);
		assert.equal((await s.rt.client.budget(id)).own_budget_usd, 4, "optional agent prefix is accepted inside quoted command argument");
		await s.command.handler('inspect "senior reviewer"', s.ctx);
		assert.ok(s.notes.some((n) => n.includes("Senior Reviewer")));
		await s.command.handler('send "Senior Reviewer" Check carefully', s.ctx);
		assert.ok(s.notes.some((n) => n.includes("sent to Senior Reviewer")));
		const suggestions = await s.command.getArgumentCompletions("budget Senior");
		assert.equal(suggestions[0].value, 'budget "Senior Reviewer"');
		await s.command.handler('model "Senior Reviewer" openai/test-model', s.ctx);
		const inspect = await s.rt.client.inspect(id);
		assert.equal(inspect.agent.pending_model, "openai/test-model");
		assert.ok(s.notes.some((n) => n.includes("PENDING")));
		await s.command.handler('stop "Senior Reviewer"', s.ctx);
		assert.equal((await s.rt.client.inspect(id)).agent.status, "CANCELLED");
		assert.deepEqual(await s.command.getArgumentCompletions("budget Senior"), []);
	} finally { s.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("reporting commands connect, disconnect, transfer, show history and dismiss without taking over project sessions", async () => {
 __resetProcessStateForTests();
 const hs = await harness();
 const parent = commandSession(hs, "parent-session", "");
 const project = commandSession(hs, "project-session", "");
 const replacement = commandSession(hs, "replacement-session", "");
 try {
  for (const session of [parent, project, replacement]) {
   await session.rt.start(session.ctx);
   await session.command.handler("init", session.ctx);
   assert.ok(session.rt.identity, session.notes.join("\n"));
  }
  const sId = parent.rt.identity!.run_id, pId = project.rt.identity!.run_id, rId = replacement.rt.identity!.run_id;
  const original = { ...project.rt.identity! };
  await project.command.handler(`report-to ${sId}`, project.ctx);
  await project.command.handler("reporting", project.ctx);
  assert.ok(project.notes.some((n) => n.includes(sId) && n.includes("parent_agent_id")));
  assert.deepEqual(project.rt.identity, original);
  await parent.command.handler("reporting wake on", parent.ctx);
  assert.equal((await parent.rt.client.reporting(sId)).wake_on_message, true);
  await project.command.handler("reporting wake on", project.ctx);
  assert.equal((await project.rt.client.reporting(pId)).wake_on_message, true);
  await project.command.handler("report-to none", project.ctx);
  await project.command.handler(`report-to ${sId}`, project.ctx);
  await parent.command.handler(`reporting transfer ${rId}`, parent.ctx);
  assert.equal((await project.rt.client.reporting(pId)).links[0].parent_run_id, rId);
  await project.command.handler("reporting --all", project.ctx);
  assert.equal((await project.rt.client.reporting(pId, true)).links.length, 3);
  await replacement.command.handler("reporting dismiss", replacement.ctx);
  assert.equal(replacement.rt.identity!.run_id, rId);
  assert.equal((await project.rt.client.reporting(pId)).links.length, 0);
  assert.equal((await project.rt.client.me()).agent_id, original.agent_id);
  assert.ok(![...parent.notes, ...project.notes, ...replacement.notes].some((n) => /FORBIDDEN|CONFLICT|FENCED/.test(n)));
 } finally {
  for (const session of [parent, project, replacement]) session.rt.stop();
  await hs.cleanup(); __resetProcessStateForTests();
 }
});

test("watch off and status work without tmux and persist the automatic-pane opt-out", async () => {
 __resetProcessStateForTests();
 const hs = await harness();
 const session = commandSession(hs, "headless-commands", "");
 const previousPath = process.env.PATH;
 try {
  await session.rt.start(session.ctx);
  await session.command.handler("init", session.ctx);
  process.env.PATH = hs.dir; // no tmux (or any other executable) is discoverable here
  await session.command.handler("watch off", session.ctx);
  await session.command.handler("watch status", session.ctx);
  const cfg = await session.rt.client.get<{ enabled: boolean; auto_open: boolean }>(`/runs/${session.rt.identity!.run_id}/terminal`);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.auto_open, false);
  assert.ok(session.notes.some((n) => n.includes("Detached workers")));
  assert.ok(!session.notes.some((n) => n.includes("/team watch:")), session.notes.join("\n"));
 } finally {
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  session.rt.stop(); await hs.cleanup(); __resetProcessStateForTests();
 }
});
