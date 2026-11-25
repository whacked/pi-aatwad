import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { LOADED_SOURCE, LOADED_VERSION } from "../../src/shared/version.ts";
import { TmuxWatch } from "../../src/terminal/tmux.ts";
import { registerTeamCommand } from "../../src/extension/commands.ts";
import { TeamRuntime, __resetProcessStateForTests } from "../../src/extension/runtime.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { harness, newRun, sql, waitFor } from "../controller/helpers.ts";

// These tests drive tmux/Rex panes from outside them, so host detection trusts the markers.
process.env.PI_TEAM_HOST_VERIFY = "markers";
// tmux tests: a richer host (Rex or bb) around the test run would otherwise be chosen first.
for (const k of ["REX_SERVER", "REX_BLOCK", "REX_SESSION", "BB_THREAD_ID"]) delete process.env[k];
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
		assert.match(rt.notice!, /stopped, not removed/);
		await rt.heartbeat();
		assert.equal((await hs.call("GET", `/agents/${own.root}`, { token: hs.op })).body.agent.status, "PAUSED", "stop suspends; it never cancels");
		assert.deepEqual(await suggestions("stop"), [other.run_id]);
		assert.ok((await suggestions("resume")).includes(own.run_id), "stopped teams stay resumable");
		assert.ok((await suggestions("events")).includes(own.run_id), "history remains accessible");
		await command.handler(`stop ${other.run_id}`, ctx);
		await command.handler(`stop ${other.run_id}`, ctx);
		assert.deepEqual(await suggestions("stop"), []);
		assert.equal(notes.filter((n) => n.includes(`Team ${other.run_id}: STOPPED`)).length, 2, "repeat stop is idempotent");
		assert.ok(!notes.some((n) => /FENCED|CONFLICT/.test(n)), notes.join("\n"));
		const rtReload = new TeamRuntime(pi as any, { paths: statePaths(hs.dir), env: {} });
		await rtReload.start(ctx);
		assert.equal(rtReload.identity, undefined);
		assert.match(rtReload.notice!, new RegExp(`resume ${own.run_id}`));
		rtReload.stop();
		await command.handler(`resume ${own.run_id}`, ctx);
		assert.equal((rt as TeamRuntime).identity?.run_id, own.run_id, notes.join("\n"));
		assert.equal((await hs.call("GET", `/agents/${own.root}`, { token: hs.op })).body.agent.status, "RUNNING");
		await command.handler(`remove ${own.run_id}`, ctx);
		assert.equal(rt.identity, undefined);
		assert.ok(!(await suggestions("resume")).includes(own.run_id), "removed teams cannot be resumed");
		assert.ok(!(await suggestions("events")).includes(own.run_id));
	} finally { rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

function commandSession(hs: Awaited<ReturnType<typeof harness>>, id: string, selectedRun: string, paths = statePaths(hs.dir)) {
	const entries: any[] = [], notes: string[] = [], choices: string[][] = [], confirmations: string[] = [];
	let command: any;
	const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }), sendMessage: () => {}, getAllTools: () => [],
		registerCommand: (_name: string, definition: unknown) => { command = definition; } };
	const ctx = { hasUI: true, mode: "rpc", cwd: hs.dir, isIdle: () => true, hasPendingMessages: () => false,
		ui: { notify: (text: string) => notes.push(text), confirm: async (_title: string, detail: string) => { confirmations.push(detail); return true; }, setStatus: () => {},
			select: async (_title: string, options: string[]) => { choices.push(options); return selectedRun ? options.find((s) => s.includes(selectedRun)) : undefined; } },
		sessionManager: { getSessionId: () => id, getSessionFile: () => undefined, getEntries: () => entries } } as any;
	const rt = new TeamRuntime(pi as any, { paths, env: {}, heartbeatMs: 60000 });
	registerTeamCommand(pi as any, rt);
	return { rt, ctx, notes, choices, confirmations, command };
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
		assert.ok(fresh.notes.some((s) => s.includes("Member panes open beside Pi")), fresh.notes.join("\n"));
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
		assert.ok(initialized.choices[0].some((label) => label.includes("/2 live")), "picker labels show live/total members");
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

test("resume handles a single team without UI and preserves association when already attached", async (t) => {
	__resetProcessStateForTests();
	const hs = await harness();
	const session = commandSession(hs, "headless-resume", "");
	try {
		const existing = await newRun(hs);
		session.ctx.hasUI = false;
		await session.rt.start(session.ctx);
		const output: string[] = [];
		const write = t.mock.method(process.stderr, "write", (chunk: any) => { output.push(String(chunk)); return true; });
		await session.command.handler("resume", session.ctx);
		assert.ok(output.some((text) => text.includes("Confirmation required")));
		assert.equal(session.rt.identity, undefined);
		assert.equal((await hs.call("GET", "/me", { token: existing.token })).status, 200, "denied root takeover preserves the old credential");
		await session.command.handler("resume --yes", session.ctx);
		write.mock.restore();
		assert.equal((session.rt as TeamRuntime).identity?.run_id, existing.run_id, session.notes.join("\n"));
		assert.equal(session.choices.length, 0);
		const identity = session.rt.identity;
		session.ctx.hasUI = true;
		await session.command.handler("resume", session.ctx);
		assert.equal(session.rt.identity, identity, "already attached must not create a new controller session");
		assert.equal(session.choices.length, 0);
		assert.equal(session.confirmations.length, 0, "already attached does not prompt for takeover");
		assert.ok(session.notes.some((text) => text.includes("Already attached")));
	} finally { session.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("declining root resume confirmation never attaches or revokes the old credential", async (t) => {
	__resetProcessStateForTests();
	const hs = await harness(), session = commandSession(hs, "declined-root-resume", "");
	try {
		const existing = await newRun(hs);
		await session.rt.start(session.ctx);
		const attach = t.mock.method(session.rt, "attach");
		session.ctx.ui.confirm = async (_title: string, detail: string) => { session.confirmations.push(detail); return false; };
		await session.command.handler("resume", session.ctx);
		assert.equal(session.confirmations.length, 1);
		assert.ok(session.confirmations[0].includes(existing.run_id));
		assert.equal(attach.mock.callCount(), 0);
		assert.equal(session.rt.identity, undefined);
		assert.equal((await hs.call("GET", "/me", { token: existing.token })).status, 200);
		assert.ok(session.notes.some((text) => text.includes("Operation cancelled")));
	} finally { session.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("version reports loaded extension/controller versions and paths without enrollment or controller startup", async (t) => {
	__resetProcessStateForTests();
	const hs = await harness(), session = commandSession(hs, "version-unenrolled", "");
	const offline = commandSession(hs, "version-offline", "", statePaths(join(hs.dir, "offline")));
	try {
		for (const s of [session, offline]) {
			t.mock.method(s.rt, "ensure", async () => { throw new Error("version must not start the controller"); });
			await s.command.handler("version", s.ctx);
			assert.equal(s.rt.identity, undefined);
			assert.ok(s.notes.some((text) => text.includes(`extension: v${LOADED_VERSION} · source ${LOADED_SOURCE}`)), s.notes.join("\n"));
		}
		assert.ok(session.notes.some((text) => text.includes(`controller: v${LOADED_VERSION}`) && text.includes(`source ${LOADED_SOURCE}`) && text.includes(`state ${hs.dir}`)), session.notes.join("\n"));
		assert.ok(offline.notes.some((text) => text.includes(`controller: not running · state ${offline.rt.paths.dir}`)));
		assert.equal(existsSync(offline.rt.paths.dir), false, "version does not create controller state");
	} finally { session.rt.stop(); offline.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
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
		const words = id.split("-").slice(-5).join(" ");
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
		assert.ok(s.notes.some((n) => n.startsWith("/team stop:")), "stop targets whole teams, never a member name");
		assert.notEqual((await s.rt.client.inspect(id)).agent.status, "CANCELLED");
		await s.rt.client.lifecycle(id, { action: "cancel", reason: "closed", children_policy: "cascade" });
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
  const joinCompletions = await project.command.getArgumentCompletions(`join ${sId.slice(0, 6)}`);
  assert.ok(joinCompletions?.some((c: { value: string }) => c.value === `join ${sId}`), "join completes run ids like report-to");
  await project.command.handler(`join ${sId}`, project.ctx); // alias for report-to
  assert.equal((await project.rt.client.reporting(pId)).links[0].parent_run_id, sId);
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

test("unattached commands infer the sole viable team and stopped teams never become resume candidates", async () => {
	__resetProcessStateForTests();
	const hs = await harness(), s = commandSession(hs, "sole-target", "");
	try {
		const r = await newRun(hs);
		await s.rt.start(s.ctx);
		for (const command of ["tree", "events", "admin status", "budget", "inspect", "watch status"]) await s.command.handler(command, s.ctx);
		assert.equal(s.choices.length, 0);
		assert.equal(s.rt.identity, undefined, "read-only target inference does not attach or create a team");
		assert.ok(!s.notes.some((n) => n.startsWith("/team")), s.notes.join("\n"));
		await s.command.handler("stop", s.ctx);
		assert.equal(s.confirmations.length, 1);
		assert.ok(s.confirmations[0].includes(r.run_id));
		assert.equal((await hs.call("GET", `/agents/${r.root}`, { token: hs.op })).body.agent.status, "PAUSED");
		await s.command.handler(`stop ${r.run_id}`, s.ctx);
		assert.equal(s.notes.filter((n) => n.includes(`Team ${r.run_id}: STOPPED`)).length, 2);
		assert.ok(!s.notes.some((n) => /FENCED|CONFLICT/.test(n)), s.notes.join("\n"));
		await s.command.handler(`remove ${r.run_id}`, s.ctx);
		await s.command.handler("resume", s.ctx);
		assert.ok(s.notes.some((n) => n.includes("No resumable teams")));
		assert.equal(s.choices.length, 0);
		assert.equal(await s.command.getArgumentCompletions("resume "), null);
	} finally { s.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("multiple team candidates require selection; invalid explicit targets never fall back; cancellation is inert", async () => {
	__resetProcessStateForTests();
	const hs = await harness(), s = commandSession(hs, "multiple-targets", "");
	try {
		const first = await newRun(hs), second = await newRun(hs);
		await s.rt.start(s.ctx);
		await s.command.handler("stop", s.ctx); // selector cancelled
		assert.equal(s.choices[0].length, 2);
		assert.equal(s.confirmations.length, 0);
		assert.equal((await hs.call("GET", `/agents/${first.root}`, { token: hs.op })).body.agent.status, "RUNNING");
		s.ctx.ui.select = async (_title: string, options: string[]) => options.find((o) => o.startsWith(second.run_id));
		s.ctx.ui.confirm = async () => false;
		await s.command.handler("stop", s.ctx);
		assert.equal((await hs.call("GET", `/agents/${second.root}`, { token: hs.op })).body.agent.status, "RUNNING");
		await s.command.handler("stop run-not-a-team", s.ctx);
		assert.ok(s.notes.some((n) => n.startsWith("/team stop:")), s.notes.join("\n"));
		assert.equal(s.choices.length, 1, "invalid explicit target never opens another selector");
		assert.equal((await hs.call("GET", `/agents/${first.root}`, { token: hs.op })).body.agent.status, "RUNNING");
	} finally { s.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("member commands infer sole active member, retain self budget reads, and require selection for multiple members", async () => {
	__resetProcessStateForTests();
	const hs = await harness(), s = commandSession(hs, "member-targets", "");
	s.ctx.modelRegistry = { getAvailable: () => [{ provider: "openai", id: "test-model", name: "Test Model" }] };
	try {
		await s.rt.start(s.ctx);
		await s.command.handler("init", s.ctx);
		const made = await hs.call("POST", "/members", { token: s.rt.identity!.token, body: { name: "OnlyMember", responsibility: "Review" } });
		const id = made.body.spawned_agent_ids[0];
		await s.command.handler("inspect", s.ctx);
		assert.ok(s.notes.some((n) => n.includes("OnlyMember")));
		await s.command.handler("model openai/test-model", s.ctx);
		assert.equal((await s.rt.client.inspect(id)).agent.pending_model, "openai/test-model");
		await s.command.handler('send "Please review"', s.ctx);
		await s.command.handler("send -- Please review carefully", s.ctx);
		assert.equal(s.notes.filter((n) => n.includes(`sent to ${id}`)).length, 2);
		await s.command.handler("budget 3", s.ctx);
		assert.equal((await s.rt.client.budget(id)).own_budget_usd, 3);
		assert.equal(s.choices.length, 0);
		await hs.call("POST", "/members", { token: s.rt.identity!.token, body: { name: "Another", responsibility: "Review" } });
		await s.command.handler("inspect", s.ctx);
		assert.equal(s.choices.at(-1)!.length, 2);
		const selections = s.choices.length;
		await s.command.handler("inspect misspelled", s.ctx);
		assert.equal(s.choices.length, selections, "explicit invalid names do not trigger default selection");
		s.ctx.ui.confirm = async () => false;
		await s.command.handler(`budget ${id} 1`, s.ctx);
		assert.equal((await s.rt.client.budget(id)).own_budget_usd, 3);
		await s.command.handler("admin unlimited", s.ctx);
		assert.equal((await s.rt.client.budget(id)).unlimited, false);
		await s.command.handler("reporting dismiss", s.ctx);
		assert.ok(s.notes.some((n) => n.includes("Operation cancelled")));
	} finally { s.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("headless destructive actions require explicit --yes even for a sole target", async (t) => {
	__resetProcessStateForTests();
	const hs = await harness(), s = commandSession(hs, "headless-confirm", "");
	try {
		const r = await newRun(hs);
		await s.rt.start(s.ctx);
		s.ctx.hasUI = false;
		const output: string[] = [];
		const write = t.mock.method(process.stderr, "write", (chunk: any) => { output.push(String(chunk)); return true; });
		await s.command.handler("stop", s.ctx);
		assert.ok(output.some((n) => n.includes("Confirmation required")));
		assert.equal((await hs.call("GET", `/agents/${r.root}`, { token: hs.op })).body.agent.status, "RUNNING");
		await s.command.handler("stop --yes", s.ctx);
		assert.equal((await hs.call("GET", `/agents/${r.root}`, { token: hs.op })).body.agent.status, "PAUSED");
		assert.equal((await hs.call("GET", `/runs/${r.run_id}/lifecycle`, { token: hs.op })).body.state, "STOPPED");
		write.mock.restore();
	} finally { s.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("operator lists and clears saved limits, and removes one member's ceiling by command", async () => {
	__resetProcessStateForTests();
	const hs = await harness(), s = commandSession(hs, "limits-session", "");
	try {
		const legacy = await newRun(hs, { models: [], limits: { max_run_usd: 25, max_live_agents: 12 }, root_envelope: { max_subtree_usd: 20, max_subtree_slots: 11, max_grant_usd: 20, max_grant_slots: 11 } });
		const made = await hs.call("POST", "/members", { token: legacy.token, body: { name: "Checker", responsibility: "Check", max_cost_usd: 2, max_runtime_seconds: 600 } });
		const id = made.body.spawned_agent_ids[0];
		await s.rt.start(s.ctx);
		await s.command.handler("resume", s.ctx);
		assert.ok(s.notes.some((n) => /saved limit\(s\).*\/team admin clear-limits/s.test(n)), s.notes.join("\n"));
		await s.command.handler("admin limits", s.ctx);
		const listing = s.notes.at(-1)!;
		for (const expected of ["team spend ≤ $25", "live agents ≤ 12", "subtree spend ≤ $20", "Checker", "own spend ≤ $2", "runtime ≤ 600s"]) assert.ok(listing.includes(expected), `${expected}\n${listing}`);
		await s.command.handler("budget Checker none", s.ctx);
		assert.equal((await s.rt.client.budget(id)).own_budget_usd, 20, "without its own ceiling the member shares its lead's");
		await s.command.handler("budget Checker 3", s.ctx);
		assert.equal((await s.rt.client.budget(id)).own_budget_usd, 3);
		await s.command.handler("budget Checker lots", s.ctx);
		assert.ok(s.notes.at(-1)!.includes("usage: /team budget"));
		await s.command.handler("admin clear-limits", s.ctx);
		assert.ok(s.confirmations.at(-1)!.includes("Remove every spend, member-count, depth and time limit"));
		assert.ok(s.notes.at(-1)!.includes("No limits in force"), s.notes.at(-1));
		const budget = await s.rt.client.budget(id);
		assert.equal(budget.own_budget_usd, null);
		assert.equal(budget.available_usd, null);
		await s.command.handler("admin status", s.ctx);
		assert.ok(s.notes.at(-1)!.includes("No limits in force"));
	} finally { s.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});

test("/team join links a team under another leader or agent, /team dismiss detaches or stops it, /team link toggles terminatable", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const lead = commandSession(hs, "lead-session", ""), sub = commandSession(hs, "sub-session", "");
	try {
		await lead.rt.start(lead.ctx); await sub.rt.start(sub.ctx);
		await lead.command.handler("init", lead.ctx);
		await sub.command.handler("init", sub.ctx);
		const leadRun = lead.rt.identity!.run_id, subRun = sub.rt.identity!.run_id, subRoot = sub.rt.identity!.agent_id;
		const edge = () => sql(hs, "SELECT parent_id, terminatable FROM reporting_edges WHERE run_id = ? AND parent_run_id IS NOT NULL AND valid_to IS NULL", subRun)[0];

		await sub.command.handler(`join ${leadRun}`, sub.ctx);
		assert.deepEqual({ ...edge() }, { parent_id: lead.rt.identity!.agent_id, terminatable: 0 });
		await lead.command.handler(`link ${subRoot} terminatable on`, lead.ctx);
		assert.equal(edge().terminatable, 1);
		await lead.command.handler(`link ${subRoot} terminatable off`, lead.ctx);
		await lead.command.handler(`dismiss ${subRoot} wrapping up`, lead.ctx);
		assert.equal(edge(), undefined);
		assert.ok(lead.notes.some((n) => /detached; its team keeps running/.test(n)), lead.notes.join("\n"));

		// Join under a specific agent of the lead's team, terminatable from the start.
		const member = (await hs.call("POST", "/members", { token: (lead.rt.identity as any).token, body: { name: "Coordinator", responsibility: "Coordinate" } })).body.spawned_agent_ids[0];
		await sub.command.handler(`join ${member} --terminatable`, sub.ctx);
		assert.deepEqual({ ...edge() }, { parent_id: member, terminatable: 1 });
		await sub.command.handler("join none", sub.ctx);
		assert.equal(edge(), undefined);
		await sub.command.handler(`report-to ${leadRun}`, sub.ctx);
		assert.equal(edge().parent_id, lead.rt.identity!.agent_id, "report-to is an alias of join");

		await lead.command.handler("admin member-default 7", lead.ctx);
		assert.equal(JSON.parse(sql(hs, "SELECT config_json FROM runs WHERE id = ?", leadRun)[0].config_json).member_default_usd, 7);
		await lead.command.handler(`dismiss ${subRoot} --stop`, lead.ctx);
		assert.ok(lead.notes.some((n) => new RegExp(`stopped ${subRun}`).test(n)), lead.notes.join("\n"));
	} finally { lead.rt.stop(); sub.rt.stop(); await hs.cleanup(); }
});

test("a session working as a member moves to another team: /team join leaves its team, leads its own, and links under the target", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const lead = commandSession(hs, "lead-session", ""), worker = commandSession(hs, "worker-session", ""), other = commandSession(hs, "other-session", "");
	try {
		for (const s of [lead, worker, other]) await s.rt.start(s.ctx);
		await lead.command.handler("init", lead.ctx);
		await other.command.handler("init", other.ctx);
		const leadRun = lead.rt.identity!.run_id, otherRun = other.rt.identity!.run_id;
		const member = (await hs.call("POST", "/members", { token: (lead.rt.identity as any).token, body: { name: "Builder", responsibility: "Build" } })).body.spawned_agent_ids[0];
		await worker.command.handler(`resume ${leadRun} ${member}`, worker.ctx);
		assert.equal(worker.rt.identity!.agent_id, member);

		await worker.command.handler(`join ${otherRun}`, worker.ctx);
		const moved = worker.rt.identity!;
		assert.notEqual(moved.agent_id, member);
		assert.notEqual(moved.run_id, leadRun);
		assert.ok(worker.notes.some((n) => /Left team .* you now lead team/.test(n)), worker.notes.join("\n"));
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id = ?", member)[0].status, "RETIRED");
		assert.equal(sql(hs, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND parent_run_id IS NOT NULL AND valid_to IS NULL", moved.agent_id)[0].parent_id, other.rt.identity!.agent_id);
		assert.equal((await worker.rt.client.me()).parent?.agent_id, other.rt.identity!.agent_id, "the session now works under its new lead");
		// Leaving alone also works: a fresh member detaches without joining anything.
		const second = (await hs.call("POST", "/members", { token: (lead.rt.identity as any).token, body: { name: "Tester", responsibility: "Test" } })).body.spawned_agent_ids[0];
		const solo = commandSession(hs, "solo-session", "");
		await solo.rt.start(solo.ctx);
		await solo.command.handler(`resume ${leadRun} ${second}`, solo.ctx);
		await solo.command.handler("leave", solo.ctx); // alias of join none
		assert.equal((await solo.rt.client.me()).is_root, true);
		assert.equal(sql(hs, "SELECT COUNT(*) AS n FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", solo.rt.identity!.agent_id)[0].n, 0, "an independent leader");
		solo.rt.stop();
	} finally { for (const s of [lead, worker, other]) s.rt.stop(); await hs.cleanup(); }
});

test("quitting Pi stops the team by default (resumable), keeps it running when the policy says so, and the guard sees working members", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const a = commandSession(hs, "quit-a", ""), b = commandSession(hs, "quit-b", ""), c = commandSession(hs, "quit-c", "");
	try {
		for (const s of [a, b]) { await s.rt.start(s.ctx); await s.command.handler("init --name Alpha", s.ctx); }
		const state = (run: string) => JSON.parse(sql(hs, "SELECT config_json FROM runs WHERE id = ?", run)[0].config_json).team_lifecycle?.state ?? "RUNNING";
		assert.equal(JSON.parse(sql(hs, "SELECT config_json FROM runs WHERE id = ?", a.rt.identity!.run_id)[0].config_json).name, "Alpha");
		assert.equal(await a.rt.exitCheck().then((c) => c?.busy), 0, "no members: nothing to guard");
		const out: string[] = [];
		await a.rt.onQuit((t) => out.push(t));
		assert.equal(out.length, 0, "a team with no members is left alone");

		const member = (await hs.call("POST", "/members", { token: (a.rt.identity as any).token, body: { name: "Builder", responsibility: "Build" } })).body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(member));
		await hs.call("POST", "/sessions/heartbeat", { token: hs.ex.tokens.get(member)!, body: { busy: true } });
		const check = await a.rt.exitCheck();
		assert.equal(check?.busy, 1);
		assert.match(check!.detail, /Builder[\s\S]*stops the team now \(resumable\)/);
		await a.rt.onQuit((t) => out.push(t));
		assert.match(out.join(""), new RegExp(`Team ${a.rt.identity!.run_id} stopped \\(resumable\\): 1 member\\(s\\) paused, 1 mid-task\\. /team resume`));
		assert.equal(state(a.rt.identity!.run_id), "STOPPED");

		await b.command.handler("exit-policy keep", b.ctx);
		const other = (await hs.call("POST", "/members", { token: (b.rt.identity as any).token, body: { name: "Writer", responsibility: "Write" } })).body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(other));
		const kept: string[] = [];
		await b.rt.onQuit((t) => kept.push(t));
		assert.match(kept.join(""), /keeps running in the background/);
		assert.equal(state(b.rt.identity!.run_id), "RUNNING");

		// bb owns the thread: its Pi process exiting (bb restart, idle eviction) is not the human leaving.
		await c.rt.start(c.ctx); await c.command.handler("init --name Gamma", c.ctx);
		c.rt.env.BB_THREAD_ID = "thr_leader";
		const third = (await hs.call("POST", "/members", { token: (c.rt.identity as any).token, body: { name: "Reader", responsibility: "Read" } })).body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(third));
		const bbOut: string[] = [];
		await c.rt.onQuit((t) => bbOut.push(t));
		assert.deepEqual(bbOut, []);
		assert.equal(state(c.rt.identity!.run_id), "RUNNING", "a bb leader's team survives its Pi process");
	} finally { a.rt.stop(); b.rt.stop(); c.rt.stop(); await hs.cleanup(); }
});

test("/team init in a project whose team is led by another open session warns, with commands for each option", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const first = commandSession(hs, "first-session", ""), second = commandSession(hs, "second-session", "");
	try {
		await first.rt.start(first.ctx); await first.command.handler("init", first.ctx);
		const theirs = first.rt.identity!.run_id;
		await second.rt.start(second.ctx); await second.command.handler("init", second.ctx);
		const mine = second.rt.identity!.run_id;
		const warning = second.notes.find((n) => n.includes("still led by another open session"));
		assert.ok(warning, second.notes.join("\n"));
		assert.match(warning!, new RegExp(`/team resume ${theirs}`));
		assert.match(warning!, new RegExp(`/team join ${theirs}`));
		assert.match(warning!, new RegExp(`in the other session, /team join ${mine}`));
	} finally { first.rt.stop(); second.rt.stop(); await hs.cleanup(); }
});

test("a session that comes back to a team stopped while it was away says how to resume it", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const s = commandSession(hs, "comes-back", "");
	let again: TeamRuntime | undefined;
	try {
		await s.rt.start(s.ctx); await s.command.handler("init", s.ctx);
		const { run_id, agent_id } = s.rt.identity!;
		s.rt.stop(); // the Pi process died without applying its exit policy
		assert.equal((await hs.call("POST", `/runs/${run_id}/stop`, { token: hs.op, body: {} })).status, 200);
		__resetProcessStateForTests(); // a new process: no in-memory credential
		const notes: string[] = [];
		again = new TeamRuntime({ appendEntry: () => {}, sendMessage: () => {} } as any, { paths: statePaths(hs.dir), env: {}, heartbeatMs: 60000 });
		await again.start({ ...s.ctx, ui: { ...s.ctx.ui, notify: (t: string) => notes.push(t) } });
		assert.equal(again.identity, undefined);
		const expected = `/team resume ${run_id} ${agent_id}`;
		assert.ok(notes.some((n) => n.includes(expected)), notes.join("\n"));
		await assert.rejects(again.requireIdentity(100), (e: Error) => e.message.includes(expected) && e.message.includes("was stopped while this session was away"));
	} finally { again?.stop(); await hs.cleanup(); }
});

test("a stopped team's leader session attaches again by itself when the team is resumed, unless another session took over", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const s = commandSession(hs, "away-leader", ""), t = commandSession(hs, "other-leader", "");
	const runtimes: TeamRuntime[] = [];
	const comeBack = async (session: typeof s) => {
		__resetProcessStateForTests();
		const rt = new TeamRuntime({ appendEntry: () => {}, sendMessage: () => {} } as any, { paths: statePaths(hs.dir), env: {}, heartbeatMs: 100 });
		runtimes.push(rt);
		await rt.start(session.ctx);
		return rt;
	};
	try {
		await s.rt.start(s.ctx); await s.command.handler("init", s.ctx);
		const { run_id, agent_id } = s.rt.identity!;
		s.rt.stop();
		assert.equal((await hs.call("POST", `/runs/${run_id}/stop`, { token: hs.op, body: {} })).status, 200);
		const back = await comeBack(s);
		assert.equal(back.identity, undefined);
		assert.equal((await hs.call("POST", `/runs/${run_id}/resume`, { token: hs.op, body: {} })).status, 200); // as its lead would
		await waitFor(() => back.identity?.agent_id === agent_id, "re-attached after the resume", 3000);

		// Stopped again, and this time another session takes the agent over before the resume.
		back.stop();
		assert.equal((await hs.call("POST", `/runs/${run_id}/stop`, { token: hs.op, body: {} })).status, 200);
		const again = await comeBack(s);
		await t.rt.start(t.ctx); await t.command.handler(`resume ${run_id} ${agent_id}`, t.ctx);
		assert.equal(t.rt.identity?.agent_id, agent_id);
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(again.identity, undefined, "never takes the agent back from the session that resumed it");
		assert.match(again.notice ?? "", /led from another session/);
	} finally { for (const rt of runtimes) rt.stop(); s.rt.stop(); t.rt.stop(); await hs.cleanup(); }
});

test("/team prune closes only idle members with no open tasks, after confirmation", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const s = commandSession(hs, "prune-session", "");
	try {
		await s.rt.start(s.ctx);
		await s.command.handler("init", s.ctx);
		const token = (s.rt.identity as any).token;
		const made = (await hs.call("POST", "/members", { token, body: { name: "Done", responsibility: "Finish fast" } })).body.spawned_agent_ids[0];
		const busy = (await hs.call("POST", "/members", { token, body: { name: "Busy", responsibility: "Keep going" } })).body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(made) && hs.ex.tokens.has(busy));
		const task = sql(hs, "SELECT id FROM tasks WHERE owner_id = ?", made)[0].id;
		await hs.call("POST", `/tasks/${task}/complete`, { token: hs.ex.tokens.get(made)!, body: { summary: "done" } });
		await s.command.handler("prune", s.ctx);
		assert.ok(s.confirmations.some((c) => /Close 1 idle member\(s\) with no open tasks: Done\?/.test(c)), s.confirmations.join("\n"));
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id = ?", made)[0].status, "CANCELLED");
		assert.notEqual(sql(hs, "SELECT status FROM agents WHERE id = ?", busy)[0].status, "CANCELLED", "a member with open work stays");
		await s.command.handler("prune", s.ctx);
		assert.ok(s.notes.some((n) => /Nothing to prune/.test(n)));
	} finally { s.rt.stop(); await hs.cleanup(); }
});

test("the leader detects its host at startup, reports it, re-detects on request, and /team host explains it", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	const s = commandSession(hs, "host-session", "");
	try {
		await s.rt.start(s.ctx);
		await s.command.handler("init", s.ctx);
		const root = (s.rt.identity as any).agent_id;
		const read = async () => (await hs.call("GET", `/agents/${root}/host`, { token: hs.op })).body;
		await waitFor(async () => (await read()).host !== null, "startup detection reported", 10000);
		const first = await read();
		assert.equal(first.host.verified, true);
		assert.deepEqual(first.host.candidates.map((c: any) => c.host), ["bb", "rex", "tmux", "native", "detached"]);
		await hs.call("POST", `/agents/${root}/host/refresh`, { token: hs.op, body: {} });
		await s.rt.heartbeat();
		await waitFor(async () => { const now = await read(); return !now.refresh_requested && now.reported_at !== first.reported_at; }, "refresh picked up on the heartbeat", 10000);
		await s.command.handler("host", s.ctx);
		assert.match(s.notes.at(-1)!, /^Host: [\s\S]*bb: not detected[\s\S]*detached workers/);
		await s.command.handler("host refresh", s.ctx);
		assert.doesNotMatch(s.notes.at(-1)!, /not yet verified/);
		await s.command.handler("host sideways", s.ctx);
		assert.match(s.notes.at(-1)!, /usage: \/team host \[refresh\]/);
	} finally { s.rt.stop(); await hs.cleanup(); }
});
