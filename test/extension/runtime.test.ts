// TeamRuntime against a mock controller, with a fake Pi API/context (no Pi process needed).
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TeamRuntime, __resetProcessStateForTests, IDENTITY_ENTRY, INBOX_MESSAGE, NOT_ENROLLED, MAX_SETTLE_CONTINUATIONS, MANAGED_NO_STATE_DIR } from "../../src/extension/runtime.ts";
import { ENV_ENROLL_FILE } from "../../src/shared/protocol.ts";
import type { EnrollmentFile, Envelope, OrgContext } from "../../src/shared/protocol.ts";
import { formatOrgContext, MAX_CONTEXT_CHARS } from "../../src/extension/format.ts";
import { makeState, startMock, waitFor, sleep } from "./helpers.ts";
import { TeamApiError, spawnCount } from "../../src/shared/client.ts";
import { readdirSync } from "node:fs";

beforeEach(() => __resetProcessStateForTests());

let counter = 0;
function fakePi() {
	const entries: any[] = [];
	const sent: { message: any; options: any }[] = [];
	return {
		entries,
		sent,
		appendEntry(customType: string, data?: unknown) {
			entries.push({ type: "custom", id: `e${++counter}`, customType, data });
		},
		sendMessage(message: any, options?: any) {
			sent.push({ message, options });
			entries.push({ type: "custom_message", id: `e${++counter}`, customType: message.customType, details: message.details, content: message.content });
		},
	};
}
function fakeCtx(pi: ReturnType<typeof fakePi>, sessionId: string, opts: { idle?: boolean } = {}) {
	const notes: { text: string; level?: string }[] = [];
	const status = new Map<string, string | undefined>();
	return {
		notes,
		status,
		hasUI: true,
		mode: "rpc",
		cwd: "/w",
		ui: { notify: (text: string, level?: string) => notes.push({ text, level }), setStatus: (k: string, v: string | undefined) => status.set(k, v) },
		isIdle: () => opts.idle ?? true,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/s/${sessionId}.jsonl`, getEntries: () => pi.entries },
	} as any;
}

function me(over: Partial<OrgContext> = {}): OrgContext {
	return {
		run_id: "run1",
		agent_id: "ag-child",
		session_id: "ses2",
		role: "tester",
		is_root: false,
		parent: { agent_id: "ag-root", role: "root" },
		children: [],
		tasks: [{ task_id: "t1", title: "write tests", status: "IN_PROGRESS", parent_task_id: null }],
		envelope: {} as any,
		budget: { agent_id: "ag-child", limits: { max_subtree_usd: 5 } as any, reserved_slots: 0, reserved_usd: 0, consumed_usd: 1, subtree_live_agents: 0, available_slots: 2, available_usd: 4 },
		pending_proposals_to_review: 0,
		inbox_pending: 0,
		desired_state: "RUNNING",
		topology_version: 3,
		...over,
	};
}
const env1 = (id: string): Envelope => ({ version: 1, message_id: id, run_id: "run1", type: "task.assigned", from: "ag-root", to: "ag-child", payload: { text: `do ${id}` } });

describe("TeamRuntime identity", () => {
	test("managed child: reads+deletes enrollment file, enrolls with pid and pi session, injects+acks inbox once", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		let inboxCalls = 0;
		m.route("POST", "/enroll", () => ({ body: { run_id: "run1", agent_id: "ag-child", session_id: "ses2", token: "child-tok", parent_id: "ag-root", task_id: "t1" } }));
		m.route("GET", "/me", () => ({ body: me() }));
		m.route("POST", "/sessions/heartbeat", () => ({ body: { lease_until: "x", inbox_pending: 1, desired_state: "RUNNING" } }));
		m.route("GET", "/inbox", () => {
			inboxCalls++;
			return { body: { messages: [env1("msg-1")] } }; // redelivered every time (ack "lost")
		});
		m.route("POST", /^\/messages\/[^/]+\/ack$/, () => ({ body: { acked: true } }));
		const file = join(paths.enrollDir, "e.json");
		const ef: EnrollmentFile = { version: 1, socket_path: paths.socket, run_id: "run1", agent_id: "ag-child", spawn_intent_id: "si1", token: "one-time-secret", expires_at: new Date(Date.now() + 60_000).toISOString() };
		writeFileSync(file, JSON.stringify(ef), { mode: 0o600 });
		const env: NodeJS.ProcessEnv = { [ENV_ENROLL_FILE]: file };
		const pi = fakePi();
		const ctx = fakeCtx(pi, "pis-child");
		const rt = new TeamRuntime(pi as any, { paths, env, heartbeatMs: 60_000 });
		try {
			await rt.start(ctx);
			assert.ok(!existsSync(file), "enrollment file deleted");
			assert.equal(env[ENV_ENROLL_FILE], undefined, "env var scrubbed");
			const enroll = m.requests.find((r) => r.path === "/enroll")!;
			assert.equal(enroll.headers.authorization, undefined, "no bearer on /enroll");
			assert.equal(enroll.body.token, "one-time-secret");
			assert.equal(enroll.body.pid, process.pid);
			assert.equal(enroll.body.pi_session_id, "pis-child");
			assert.equal(rt.identity?.agent_id, "ag-child");
			assert.equal(rt.identity?.managed, true);
			assert.equal(rt.identity?.role, "tester");
			const persisted = pi.entries.find((e) => e.customType === IDENTITY_ENTRY);
			assert.equal(persisted.data.pi_session_id, "pis-child");
			assert.ok(!JSON.stringify(persisted.data).includes("tok"), "no token persisted in transcript");
			// heartbeat authenticates with the session token; a managed one-shot worker does NOT inject from it
			await waitFor(() => m.requests.some((r) => r.path === "/sessions/heartbeat"), 3_000, "heartbeat");
			const hb = m.requests.find((r) => r.path === "/sessions/heartbeat")!;
			assert.equal(hb.headers.authorization, "Bearer child-tok");
			assert.equal(pi.sent.length, 0);
			assert.equal(inboxCalls, 0);
			// guards: no claim when the run was aborted or errored
			assert.equal(await rt.onBeforeSettle({ outcome: "aborted", context: { canContinue: false } }), undefined);
			assert.equal(await rt.onBeforeSettle({ outcome: "error", context: { canContinue: false } }), undefined);
			assert.equal(inboxCalls, 0);
			// before settling: new message -> one custom_message entry + one continuation
			const r1 = await rt.onBeforeSettle({ outcome: "completed", context: { canContinue: false } });
			assert.ok(r1);
			assert.equal(r1.continue, true);
			assert.equal(r1.entries.length, 1);
			assert.equal(r1.entries[0].type, "custom_message");
			assert.equal(r1.entries[0].customType, INBOX_MESSAGE);
			assert.match(r1.entries[0].content, /do msg-1/);
			await waitFor(() => m.requests.some((r) => r.path === "/messages/msg-1/ack"), 3_000, "ack after injection");
			// redelivery of the same message id is acked but not injected again -> Pi may settle and exit
			const r2 = await rt.onBeforeSettle({ outcome: "completed", context: { canContinue: false } });
			assert.equal(r2, undefined);
			assert.equal(inboxCalls, 2);
			await waitFor(() => m.requests.filter((r) => r.path === "/messages/msg-1/ack").length === 2, 3_000, "dup ack");
			assert.match(ctx.status.get("team") ?? "", /ag-child.*run1.*managed/);
		} finally {
			rt.stop();
			await m.close();
			cleanup();
		}
	});

	test("fork/clone: persisted identity from another pi session id is NOT adopted", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths, { operatorToken: "op" });
		const pi = fakePi();
		pi.appendEntry(IDENTITY_ENTRY, { version: 1, run_id: "run1", agent_id: "ag-root", pi_session_id: "original", managed: false });
		const ctx = fakeCtx(pi, "forked-copy");
		const rt = new TeamRuntime(pi as any, { paths, env: {} });
		try {
			await rt.start(ctx);
			assert.equal(rt.identity, undefined);
			assert.equal(m.requests.length, 0, "no controller traffic at all");
			assert.match(rt.notice ?? "", /forked\/cloned.*\/team resume run1 ag-root/);
			assert.equal(ctx.notes[0].level, "warning");
			await assert.rejects(rt.requireIdentity(10), new RegExp(NOT_ENROLLED.slice(0, 20)));
		} finally {
			rt.stop();
			await m.close();
			cleanup();
		}
	});

	test("same pi session restarted: re-attaches with the operator token (new session attempt)", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths, { operatorToken: "op-secret" });
		m.route("POST", "/runs/run1/attach", () => ({ body: { run_id: "run1", agent_id: "ag-root", session_id: "ses9", token: "root-tok" } }));
		m.route("GET", "/me", () => ({ body: me({ agent_id: "ag-root", role: "root", is_root: true, parent: null }) }));
		m.route("POST", "/sessions/heartbeat", () => ({ body: { lease_until: "x", inbox_pending: 0, desired_state: "RUNNING" } }));
		const pi = fakePi();
		pi.appendEntry(IDENTITY_ENTRY, { version: 1, run_id: "run1", agent_id: "ag-root", pi_session_id: "pis-root", managed: false });
		const rt = new TeamRuntime(pi as any, { paths, env: {}, heartbeatMs: 60_000 });
		try {
			await rt.start(fakeCtx(pi, "pis-root"));
			const at = m.requests.find((r) => r.path === "/runs/run1/attach")!;
			assert.equal(at.headers.authorization, "Bearer op-secret");
			assert.deepEqual({ a: at.body.agent_id, s: at.body.pi_session_id, mode: at.body.mode }, { a: "ag-root", s: "pis-root", mode: "attach" });
			assert.equal(rt.identity?.token, "root-tok");
			assert.equal(rt.identity?.role, "root");
			// /reload in the same process: new runtime reuses the in-memory credential, no second attach
			rt.stop();
			const rt2 = new TeamRuntime(pi as any, { paths, env: {}, heartbeatMs: 60_000 });
			await rt2.start(fakeCtx(pi, "pis-root"));
			assert.equal(rt2.identity?.token, "root-tok");
			assert.equal(m.requests.filter((r) => r.path === "/runs/run1/attach").length, 1);
			rt2.stop();
		} finally {
			rt.stop();
			await m.close();
			cleanup();
		}
	});

	test("unenrolled standalone Pi creates nothing and talks to no controller", async () => {
		const { paths, cleanup } = makeState();
		const pi = fakePi();
		const rt = new TeamRuntime(pi as any, { paths, env: {} });
		try {
			await rt.start(fakeCtx(pi, "plain"));
			assert.equal(rt.identity, undefined);
			assert.equal(rt.notice, undefined);
			assert.ok(!existsSync(paths.socket));
			assert.equal(pi.entries.length, 0);
			await assert.rejects(rt.agentCall(async () => 1), /not enrolled/);
		} finally {
			rt.stop();
			cleanup();
		}
	});

	test("STALE_SESSION fences the session: identity dropped, tools refuse, user told", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		m.route("POST", "/enroll", () => ({ body: { run_id: "run1", agent_id: "ag-child", session_id: "ses2", token: "old-tok", parent_id: "ag-root", task_id: null } }));
		m.route("GET", "/me", () => ({ body: me() }));
		m.route("POST", "/sessions/heartbeat", () => ({ status: 409, body: { error: { code: "STALE_SESSION", message: "session generation fenced" } } }));
		const file = join(paths.enrollDir, "e2.json");
		writeFileSync(file, JSON.stringify({ version: 1, socket_path: paths.socket, run_id: "run1", agent_id: "ag-child", spawn_intent_id: "si", token: "x", expires_at: "" }));
		const pi = fakePi();
		const ctx = fakeCtx(pi, "pis-x");
		const rt = new TeamRuntime(pi as any, { paths, env: { [ENV_ENROLL_FILE]: file }, heartbeatMs: 60_000 });
		try {
			await rt.start(ctx);
			await waitFor(() => rt.fenced, 3_000, "fencing");
			assert.equal(rt.identity, undefined);
			assert.ok(ctx.notes.some((n: any) => n.level === "error" && /FENCED/.test(n.text)));
			await assert.rejects(rt.agentCall(async () => 1), /fenced/);
			assert.match(ctx.status.get("team") ?? "", /fenced/);
		} finally {
			rt.stop();
			await m.close();
			cleanup();
		}
	});
});

describe("TeamRuntime inbox + enrollment guards", () => {
	test("continuations are capped per process; interactive delivery queues for next turn", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths, { operatorToken: "op" });
		let n = 0;
		m.route("POST", "/enroll", () => ({ body: { run_id: "run1", agent_id: "ag-loop", session_id: "s", token: "t", parent_id: null, task_id: null } }));
		m.route("GET", "/me", () => ({ body: me({ agent_id: "ag-loop" }) }));
		m.route("POST", "/sessions/heartbeat", () => ({ body: { lease_until: "x", inbox_pending: 0, desired_state: "RUNNING" } }));
		m.route("GET", "/inbox", () => ({ body: { messages: [env1(`loop-${++n}`)] } })); // always "new" work
		m.route("POST", /ack$/, () => ({ body: { acked: true } }));
		const file = join(paths.enrollDir, "l.json");
		writeFileSync(file, JSON.stringify({ version: 1, socket_path: paths.socket, run_id: "run1", agent_id: "ag-loop", spawn_intent_id: "si", token: "x", expires_at: "" }));
		const pi = fakePi();
		const rt = new TeamRuntime(pi as any, { paths, env: { [ENV_ENROLL_FILE]: file, PI_TEAM_LAUNCH_TOKEN: "launch-123", PI_TEAM_AGENT_ID: "ag-loop", PI_TEAM_RUN_ID: "run1" }, heartbeatMs: 60_000 });
		try {
			await rt.start(fakeCtx(pi, "pis-loop"));
			assert.equal(m.requests.find((r) => r.path === "/enroll")!.body.launch_token, "launch-123");
			let conts = 0;
			for (let i = 0; i < MAX_SETTLE_CONTINUATIONS + 5; i++) if (await rt.onBeforeSettle({ outcome: "completed", context: { canContinue: false } })) conts++;
			assert.equal(conts, MAX_SETTLE_CONTINUATIONS);
		} finally {
			rt.stop();
			await m.close();
			cleanup();
		}
	});

	test("interactive root: deliverInbox injects with deliverAs nextTurn (no surprise model turn)", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths, { operatorToken: "op" });
		m.route("POST", "/runs/run1/attach", () => ({ body: { run_id: "run1", agent_id: "ag-r", session_id: "s", token: "rt" } }));
		m.route("GET", "/me", () => ({ body: me({ agent_id: "ag-r", role: "root" }) }));
		m.route("POST", "/sessions/heartbeat", () => ({ body: { lease_until: "x", inbox_pending: 1, desired_state: "RUNNING" } }));
		m.route("GET", "/inbox", () => ({ body: { messages: [env1("q-1")] } }));
		m.route("POST", /ack$/, () => ({ body: { acked: true } }));
		const pi = fakePi();
		pi.appendEntry(IDENTITY_ENTRY, { version: 1, run_id: "run1", agent_id: "ag-r", pi_session_id: "pis-r", managed: false });
		const rt = new TeamRuntime(pi as any, { paths, env: {}, heartbeatMs: 60_000 });
		try {
			await rt.start(fakeCtx(pi, "pis-r"));
			await waitFor(() => pi.sent.length === 1, 3_000, "interactive injection from heartbeat");
			assert.deepEqual(pi.sent[0].options, { deliverAs: "nextTurn" });
			// a later Pi process on the same transcript re-seeds dedupe from the persisted custom_message
			rt.stop();
			const rt2 = new TeamRuntime(pi as any, { paths, env: {}, heartbeatMs: 60_000 });
			(globalThis as any)[Symbol.for("pi-recursive-team.seenMessages")].clear();
			await rt2.start(fakeCtx(pi, "pis-r"));
			assert.deepEqual(await rt2.deliverInbox(), []);
			assert.equal(pi.sent.length, 1);
			rt2.stop();
		} finally {
			rt.stop();
			await m.close();
			cleanup();
		}
	});

	test("enrollment file / worker env mismatch is refused", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		const file = join(paths.enrollDir, "mm.json");
		writeFileSync(file, JSON.stringify({ version: 1, socket_path: paths.socket, run_id: "run1", agent_id: "ag-a", spawn_intent_id: "si", token: "x", expires_at: "" }));
		const pi = fakePi();
		const ctx = fakeCtx(pi, "pis-mm");
		const rt = new TeamRuntime(pi as any, { paths, env: { [ENV_ENROLL_FILE]: file, PI_TEAM_AGENT_ID: "ag-OTHER" } });
		try {
			await rt.start(ctx);
			assert.equal(rt.identity, undefined);
			assert.ok(!m.requests.some((r) => r.path === "/enroll"));
			assert.ok(!existsSync(file), "credential still consumed");
			assert.ok(ctx.notes.some((n: any) => /refusing to enroll/.test(n.text)));
		} finally {
			rt.stop();
			await m.close();
			cleanup();
		}
	});
});

describe("managed worker never touches the state dir (review finding 7)", () => {
	test("socket only from the enrollment file; no statePaths/operator.token/ensureController; outages retried with backoff", async () => {
		// Decoy interactive state dir: has an operator token and its own (live) controller socket.
		const decoy = makeState();
		const decoyMock = await startMock(decoy.paths, { operatorToken: "OPERATOR-SECRET" });
		// The controller that launched the worker lives elsewhere; only the enrollment file says where.
		const real = makeState();
		let m = await startMock(real.paths);
		const routes = (mm: typeof m) => {
			mm.route("POST", "/enroll", () => ({ body: { run_id: "run1", agent_id: "ag-w", session_id: "s", token: "w-tok", parent_id: "ag-root", task_id: null } }));
			mm.route("GET", "/me", () => ({ body: me({ agent_id: "ag-w" }) }));
			mm.route("POST", "/sessions/heartbeat", () => ({ body: { lease_until: "x", inbox_pending: 0, desired_state: "RUNNING" } }));
		};
		routes(m);
		const file = join(real.paths.enrollDir, "w.json");
		writeFileSync(file, JSON.stringify({ version: 1, socket_path: real.paths.socket, run_id: "run1", agent_id: "ag-w", spawn_intent_id: "si", token: "x", expires_at: "" }));
		const pi = fakePi();
		const rt = new TeamRuntime(pi as any, {
			paths: decoy.paths, // must be IGNORED in managed mode
			env: { [ENV_ENROLL_FILE]: file },
			heartbeatMs: 60_000,
			retryDelaysMs: [30, 30, 30, 30, 30, 30],
			ensure: { entry: "/nonexistent/should-never-spawn.ts" },
		});
		const spawnsBefore = spawnCount();
		try {
			assert.throws(() => rt.paths, new RegExp(MANAGED_NO_STATE_DIR.slice(0, 30)), "no paths before enrollment");
			await rt.start(fakeCtx(pi, "pis-w"));
			assert.equal(rt.identity?.agent_id, "ag-w");
			assert.equal(rt.paths.socket, real.paths.socket);
			for (const k of ["dir", "db", "lock", "operatorToken", "log", "enrollDir", "workerLogs", "controllerInfo"] as const) assert.equal(rt.paths[k], "", k);
			await assert.rejects(rt.ensure(), /never use the team state dir/);
			await assert.rejects(rt.operatorToken(), /never use the team state dir/);
			assert.equal(await rt.commandToken(), "w-tok", "commands use the agent token, never the operator token");
			await assert.rejects(rt.attach("run1", "ag-root"), /managed workers cannot attach/);

			// Controller outage: no ensureController/spawn; backoff retries reach it once it is back.
			await m.close();
			const call = rt.agentCall((o) => rt.client.me(o));
			await sleep(70);
			m = await startMock(real.paths);
			routes(m);
			assert.equal((await call).agent_id, "ag-w");
			// Outage that outlasts the backoff: clear error, still no spawn.
			await m.close();
			await assert.rejects(rt.agentCall((o) => rt.client.me(o)), /controller unreachable/);

			assert.equal(spawnCount(), spawnsBefore, "a managed worker never spawns a controller");
			assert.equal(decoyMock.requests.length, 0, "decoy state-dir controller never contacted");
			assert.deepEqual(readdirSync(decoy.paths.dir).sort(), ["c.sock", "enroll", "operator.token", "workers"], "decoy state dir unchanged");
		} finally {
			rt.stop();
			await m.close().catch(() => {});
			await decoyMock.close();
			decoy.cleanup();
			real.cleanup();
		}
	});

	test("enrollment file without an absolute socket_path is refused (never falls back to the state dir)", async () => {
		const st = makeState();
		const file = join(st.paths.enrollDir, "nosock.json");
		writeFileSync(file, JSON.stringify({ version: 1, run_id: "run1", agent_id: "ag-x", spawn_intent_id: "si", token: "x", expires_at: "" }));
		const pi = fakePi();
		const ctx = fakeCtx(pi, "pis-nosock");
		const rt = new TeamRuntime(pi as any, { paths: st.paths, env: { [ENV_ENROLL_FILE]: file } });
		try {
			await rt.start(ctx);
			assert.equal(rt.identity, undefined);
			assert.ok(ctx.notes.some((n: any) => /no absolute socket_path/.test(n.text)));
			assert.throws(() => rt.paths, /never use the team state dir/);
		} finally {
			rt.stop();
			st.cleanup();
		}
	});
});

describe("org context", () => {
	test("is bounded and contains role, manager, tasks, budget, review hint", () => {
		const big = me({
			children: Array.from({ length: 200 }, (_, i) => ({ agent_id: `c${i}`, role: "worker ".repeat(20), status: "RUNNING" as const, observed_state: "LIVE" as const })),
			pending_proposals_to_review: 2,
		});
		const t = formatOrgContext(big);
		assert.ok(t.length <= MAX_CONTEXT_CHARS);
		const small = formatOrgContext(me({ pending_proposals_to_review: 1 }));
		assert.match(small, /role: tester/);
		assert.match(small, /Manager: root \[ag-root\]/);
		assert.match(small, /t1 IN_PROGRESS: write tests/);
		assert.match(small, /\$4\.00 available/);
		assert.match(small, /team_review_expansion/);
		assert.match(small, /not guarantees/);
	});
});


test("legacy cancellation errors leave the team without claiming another session took over", async () => {
	const pi = fakePi();
	const ctx = fakeCtx(pi, "stopped-pi");
	const rt = new TeamRuntime(pi as any);
	rt.ctx = ctx;
	rt.identity = { run_id: "run-stopped", agent_id: "agent-stopped", session_id: "ses-stopped", token: "old", managed: false, pi_session_id: "stopped-pi" };
	assert.equal(rt.handleAgentError(new TeamApiError("STALE_SESSION", "session token revoked (cancelled)", 409)), true);
	assert.equal(rt.fenced, false);
	assert.equal(rt.identity, undefined);
	assert.ok(ctx.notes.some((n: any) => /CANCELLED/.test(n.text)));
	assert.ok(!ctx.notes.some((n: any) => /FENCED|newer session/.test(n.text)));
	rt.stop();
});

test("model requests wait while busy; direct selections supersede stale heartbeat responses and retry persistence", async () => {
	const { paths, cleanup } = makeState();
	let busy = true;
	const selected: string[] = [], reports: any[] = [];
	const pi = { ...fakePi(), setModel: async (m: any) => { selected.push(m.id); return true; } };
	const ctx = fakeCtx(pi, "model-session");
	ctx.isIdle = () => !busy;
	ctx.modelRegistry = { find: (provider: string, id: string) => ({ provider, id }) };
	const rt = new TeamRuntime(pi as any, { paths, env: {} });
	rt.ctx = ctx;
	rt.identity = { run_id: "run1", agent_id: "ag-child", session_id: "ses2", token: "t", managed: false, pi_session_id: "model-session" };
	const pending = { lease_until: "x", inbox_pending: 0, desired_state: "RUNNING" as const, model_change: { request_id: "request1", provider: "test", model: "leader-choice" } };
	rt.client.heartbeat = async () => pending;
	rt.client.post = async (_path: string, body: any) => { reports.push(body); return { applied: true } as any; };
	try {
		await rt.heartbeat();
		assert.deepEqual(selected, []);
		busy = false;
		await rt.heartbeat();
		assert.deepEqual(selected, ["leader-choice"]);
		assert.equal(reports[0].request_id, "request1");

		let reply!: (r: typeof pending) => void;
		rt.client.heartbeat = () => new Promise((resolve) => { reply = resolve; });
		const staleHeartbeat = rt.heartbeat();
		await rt.reportModel("test", "human-choice");
		reply(pending);
		await staleHeartbeat;
		assert.deepEqual(selected, ["leader-choice"], "stale request cannot undo a direct selection");

		let offline = true;
		rt.client.post = async (_path: string, body: any) => { if (offline) throw new Error("offline"); reports.push(body); return {} as any; };
		await rt.reportModel("test", "offline-choice");
		offline = false;
		rt.client.heartbeat = async () => pending;
		await rt.heartbeat();
		assert.equal(reports.at(-1).model, "offline-choice");
		assert.deepEqual(selected, ["leader-choice"]);
	} finally { rt.stop(); cleanup(); }
});

test("root inbox turns require explicit wake setting and a RUNNING desired state", async () => {
 for (const desired of ["RUNNING", "PAUSED"]) {
  __resetProcessStateForTests();
  const { paths, cleanup } = makeState();
  const m = await startMock(paths, { operatorToken: "op" });
  m.route("POST", "/runs/run1/attach", () => ({ body: { run_id: "run1", agent_id: "ag-r", session_id: "s", token: "rt" } }));
  m.route("GET", "/me", () => ({ body: me({ agent_id: "ag-r", role: "root" }) }));
  m.route("POST", "/sessions/heartbeat", () => ({ body: { lease_until: "x", inbox_pending: 1, desired_state: desired, reporting_wake: true } }));
  m.route("GET", "/inbox", () => ({ body: { messages: [env1(`wake-${desired}`)] } }));
  m.route("POST", /ack$/, () => ({ body: { acked: true } }));
  const pi = fakePi();
  pi.appendEntry(IDENTITY_ENTRY, { version: 1, run_id: "run1", agent_id: "ag-r", pi_session_id: "pis-wake", managed: false });
  const rt = new TeamRuntime(pi as any, { paths, env: {}, heartbeatMs: 60_000 });
  try {
   await rt.start(fakeCtx(pi, "pis-wake"));
   await waitFor(() => pi.sent.length === 1, 3_000, "root inbox delivery");
   assert.deepEqual(pi.sent[0].options, desired === "RUNNING" ? { triggerTurn: true } : { deliverAs: "nextTurn" });
   await rt.heartbeat();
   assert.equal(pi.sent.length, 1, "message dedupe survives subsequent heartbeats");
  } finally { rt.stop(); await m.close(); cleanup(); }
 }
});
