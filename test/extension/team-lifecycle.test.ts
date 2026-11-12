import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { registerTeamCommand } from "../../src/extension/commands.ts";
import { TeamRuntime, __resetProcessStateForTests } from "../../src/extension/runtime.ts";
import { TeamApiError } from "../../src/shared/client.ts";
import { makeState, startMock } from "./helpers.ts";

async function fixture() {
	__resetProcessStateForTests();
	const state = makeState(), server = await startMock(state.paths, { operatorToken: "operator" });
	const entries: any[] = [], notes: string[] = [], confirmations: string[] = [], choices: string[][] = [];
	let command: any;
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: () => {}, getAllTools: () => [], registerCommand: (_: string, def: unknown) => { command = def; },
	};
	const ctx = {
		hasUI: true, mode: "rpc", cwd: "/w", isIdle: () => true, hasPendingMessages: () => false,
		ui: { notify: (text: string) => notes.push(text), setStatus: () => {},
			confirm: async (_: string, detail: string) => { confirmations.push(detail); return true; },
			select: async (_: string, rows: string[]) => { choices.push(rows); return rows[1]; } },
		sessionManager: { getSessionId: () => "pi", getSessionFile: () => "/saved/transcript.jsonl", getEntries: () => entries },
	} as any;
	const rt = new TeamRuntime(pi as any, { paths: state.paths, env: {}, heartbeatMs: 60_000 });
	await rt.start(ctx);
	mock.method(rt, "ensure", async () => ({} as any));
	mock.method(rt, "heartbeat", async () => {});
	registerTeamCommand(pi as any, rt);
	const runs = ["one", "two"].map((run_id) => ({ run_id, root_agent_id: `${run_id}-root`, root_status: "RUNNING", status: "RUNNING", agents: 1, created_at: "2026-01-01" }));
	server.route("GET", "/runs", () => ({ body: { runs } }));
	server.route("GET", "/me", () => ({ body: { role: "root", parent: null } }));
	for (const run of runs) {
		for (const [action, kind, status] of [["stop", "stop", "CLEANING"], ["resume", "stop", "RESUMED"], ["remove", "remove", "REMOVED"]]) {
			server.route("POST", `/runs/${run.run_id}/${action}`, () => ({ body: { operation_id: "op", run_id: run.run_id, kind, state: status } }));
		}
		server.route("POST", `/runs/${run.run_id}/attach`, () => ({ body: { run_id: run.run_id, agent_id: run.root_agent_id, session_id: "fresh", token: "fresh-token" } }));
	}
	const adopt = (run = "one") => rt.adoptNew({ run_id: run, agent_id: `${run}-root`, session_id: "old", token: "old", managed: false, pi_session_id: "pi" });
	return { rt, ctx, command, server, entries, notes, confirmations, choices, runs, adopt,
		close: async () => { rt.stop(); await server.close(); state.cleanup(); __resetProcessStateForTests(); } };
}

test("whole-team stop uses operator endpoint, retains resumable identity, and reports cleanup", async () => {
	const f = await fixture();
	try {
		f.adopt();
		await f.command.handler("stop one", f.ctx);
		assert.equal(f.rt.identity, undefined);
		assert.equal(f.rt.fenced, false);
		assert.equal(f.entries.at(-1).data.suspended, true);
		assert.equal(f.entries.at(-1).data.ended, undefined);
		assert.match(f.rt.notice!, /resume one/);
		assert.ok(f.notes.some((n) => n.includes("CLEANING") && n.includes("operation op")));
		const posts = f.server.requests.filter((r) => r.method === "POST");
		assert.deepEqual(posts.map((r) => r.path), ["/runs/one/stop"]);
		assert.deepEqual(posts[0].body, {});
		assert.equal(posts[0].headers.authorization, "Bearer operator");
		await f.rt.start(f.ctx);
		assert.equal(f.rt.identity, undefined, "reload does not silently resume a stopped team");
		assert.match(f.rt.notice!, /resume one/);
	} finally { await f.close(); }
});

test("same attached leader resumes server-side before fresh attach with saved transcript", async () => {
	const f = await fixture();
	try {
		f.adopt();
		(f.runs[0] as any).stopped = true; // stopped from another operator session
		await f.command.handler("resume one", f.ctx);
		assert.equal(f.rt.identity?.token, "fresh-token");
		const posts = f.server.requests.filter((r) => r.method === "POST");
		assert.deepEqual(posts.map((r) => r.path), ["/runs/one/resume", "/runs/one/attach"]);
		assert.deepEqual(posts[0].body, {});
		assert.equal(posts[1].body.pi_session_path, "/saved/transcript.jsonl");
		assert.ok(posts.every((r) => r.headers.authorization === "Bearer operator"));
	} finally { await f.close(); }
});

test("pending resume cleanup does not attach or replace the current identity", async () => {
	const f = await fixture();
	try {
		f.adopt(); const identity = f.rt.identity;
		(f.runs[0] as any).stopped = true;
		f.server.route("POST", "/runs/one/resume", () => ({ body: { operation_id: "op", run_id: "one", kind: "stop", state: "CLEANING" } }));
		await f.command.handler("resume one", f.ctx);
		assert.equal(f.rt.identity, identity);
		assert.equal(f.server.requests.some((r) => r.path.endsWith("/attach")), false);
		assert.ok(f.notes.some((n) => n.includes("cleanup is still pending")));
	} finally { await f.close(); }
});

test("team_stopped revocation is resumable, not permanent or superseded", async () => {
	const f = await fixture();
	try {
		f.adopt();
		f.rt.handleAgentError(new TeamApiError("STALE_SESSION", "team stopped", 409, { reason: "team_stopped" }));
		assert.equal(f.rt.identity, undefined);
		assert.equal(f.rt.fenced, false);
		assert.equal(f.entries.at(-1).data.ended, undefined);
		assert.match(f.rt.notice!, /stopped, not removed/);
		await f.command.handler("resume one", f.ctx);
		assert.equal((f.rt as TeamRuntime).identity?.token, "fresh-token");
	} finally { await f.close(); }
});

test("remove confirms destructive target, isolates other teams, clears suspended mapping", async () => {
	const f = await fixture();
	try {
		f.adopt();
		await f.command.handler("remove two", f.ctx);
		assert.equal(f.rt.identity?.run_id, "one");
		assert.match(f.confirmations[0], /Permanently remove whole team two/);
		assert.deepEqual(f.server.requests.find((r) => r.path === "/runs/two/remove")?.body, { confirm_run_id: "two" });
		f.rt.suspendTeamIdentity("one");
		await f.command.handler("remove one", f.ctx);
		assert.equal(f.entries.at(-1).data.ended, "REMOVED");
		assert.equal(f.entries.at(-1).data.suspended, false);
		assert.ok(f.notes.some((n) => n.includes("Pi and worktrees are preserved")));
	} finally { await f.close(); }
});

test("remove cancellation and headless confirmation are inert; --yes authorizes exact target", async (t) => {
	const f = await fixture();
	try {
		f.ctx.ui.confirm = async () => false;
		await f.command.handler("remove one", f.ctx);
		assert.equal(f.server.requests.filter((r) => r.method === "POST").length, 0);
		f.ctx.hasUI = false;
		const output: string[] = [];
		t.mock.method(process.stderr, "write", (s: any) => { output.push(String(s)); return true; });
		await f.command.handler("remove one", f.ctx);
		assert.equal(f.server.requests.filter((r) => r.method === "POST").length, 0);
		assert.ok(output.some((s) => s.includes("Confirmation required")));
		await f.command.handler("remove one --yes", f.ctx);
		assert.equal(f.server.requests.filter((r) => r.path === "/runs/one/remove").length, 1);
	} finally { await f.close(); }
});

test("whole-team omitted selection picks among multiple, auto-selects sole; managed workers denied", async () => {
	const f = await fixture();
	try {
		await f.command.handler("stop", f.ctx);
		assert.equal(f.choices[0].length, 2);
		assert.ok(f.server.requests.some((r) => r.path === "/runs/two/stop"));
		f.runs.pop();
		await f.command.handler("remove", f.ctx);
		assert.equal(f.choices.length, 1);
		assert.ok(f.server.requests.some((r) => r.path === "/runs/one/remove"));
		f.rt.adoptNew({ run_id: "one", agent_id: "worker", session_id: "s", token: "worker", managed: true, pi_session_id: "pi", socket_path: f.rt.paths.socket });
		const before = f.server.requests.length;
		for (const command of ["stop one --yes", "remove one --yes", "resume one --yes"]) await f.command.handler(command, f.ctx);
		assert.equal(f.server.requests.length, before);
	} finally { await f.close(); }
});

test("client lifecycle query handles null and operation receipts", async () => {
	const f = await fixture();
	try {
		f.server.route("GET", "/runs/one/lifecycle", () => ({ body: null }));
		assert.equal(await f.rt.client.teamLifecycle("one", { token: "operator" }), null);
		const receipt = { operation_id: "op", run_id: "one", kind: "stop", state: "STOPPED" };
		f.server.route("GET", "/runs/one/lifecycle", () => ({ body: receipt }));
		assert.deepEqual(await f.rt.client.teamLifecycle("one", { token: "operator" }), receipt);
	} finally { await f.close(); }
});
