import { test } from "node:test";
import assert from "node:assert/strict";
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
			select: async (_title: string, options: string[]) => { choices.push(options); return options.find((s) => s.startsWith(selectedRun)); } },
		sessionManager: { getSessionId: () => id, getSessionFile: () => undefined, getEntries: () => entries } } as any;
	const rt = new TeamRuntime(pi as any, { paths: statePaths(hs.dir), env: {}, heartbeatMs: 60000 });
	registerTeamCommand(pi as any, rt);
	return { rt, ctx, notes, choices, command };
}

test("fresh resume picker restores the existing multi-member team; init then resume discards only the new empty team", async () => {
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
		assert.ok(fresh.choices[0].some((label) => label.includes("2 active members")));
		assert.ok(!fresh.choices[0].some((label) => label.includes(cancelled.run_id)));
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
		await s.command.handler("admin unlimited", s.ctx);
		assert.equal((await s.rt.client.budget(s.rt.identity!.agent_id)).available_usd, null);
		await s.command.handler("stop", s.ctx);
		assert.equal(s.rt.identity, undefined);
		assert.equal(s.rt.fenced, false);
	} finally { s.rt.stop(); await hs.cleanup(); __resetProcessStateForTests(); }
});
