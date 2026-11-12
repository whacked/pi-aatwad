import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { TeamRuntime, __resetProcessStateForTests } from "../../src/extension/runtime.ts";
import type { Identity } from "../../src/extension/runtime.ts";
import { TeamApiError, TeamClient } from "../../src/shared/client.ts";
import { HDR_IDEMPOTENCY } from "../../src/shared/protocol.ts";
import type { Envelope } from "../../src/shared/protocol.ts";
import { makeState, startMock } from "./helpers.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

const terminal = () => new TeamApiError("STALE_SESSION", "agent is CANCELLED", 409, { reason: "agent_terminal", agent_status: "CANCELLED" });
const superseded = () => new TeamApiError("STALE_SESSION", "session superseded", 409, { reason: "superseded" });
const envelope = (message_id: string): Envelope => ({ version: 1, message_id, run_id: "run-A", type: "question", from: "sender", to: "A", payload: { text: "hello" } });

async function fixture() {
	__resetProcessStateForTests();
	const { paths, cleanup } = makeState();
	const entries: { customType: string; data: any }[] = [];
	const notes: string[] = [];
	const sent: unknown[] = [];
	let aborts = 0;
	const pi = {
		appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); },
		sendMessage: (message: unknown) => { sent.push(message); },
	};
	const rt = new TeamRuntime(pi as any, { paths, env: {}, heartbeatMs: 60_000 });
	await rt.start({
		hasUI: true, mode: "rpc", cwd: "/w",
		ui: { notify: (text: string) => notes.push(text), setStatus: () => {} },
		isIdle: () => true, hasPendingMessages: () => false,
		abort: () => { aborts++; },
		sessionManager: { getSessionId: () => "pi-session", getSessionFile: () => undefined, getEntries: () => [] },
	} as any);
	// Keep adoption's automatic heartbeat out of these explicitly controlled races.
	const heartbeat = rt.heartbeat.bind(rt);
	mock.method(rt, "heartbeat", async () => {});
	const identity = (agent: string): Identity => ({ run_id: `run-${agent}`, agent_id: agent, session_id: `session-${agent}`, token: `token-${agent}`, managed: false, pi_session_id: "pi-session" });
	const a = identity("A");
	const b = identity("B");
	rt.adopt(a);
	return {
		rt, a, b, entries, notes, sent, heartbeat, aborts: () => aborts,
		transition: () => { rt.releaseStoppedIdentity("CANCELLED"); rt.adopt(b); },
		close: () => { rt.stop(); cleanup(); __resetProcessStateForTests(); },
	};
}

for (const error of [terminal, superseded]) {
	for (const operation of ["usage", "model", "role", "inbox", "ack", "settle", "runStart"] as const) {
		test(`late ${error.name} error from ${operation} cannot release or fence replacement identity`, async () => {
			const f = await fixture();
			const pending = deferred<any>();
			try {
				let work: Promise<unknown>;
				switch (operation) {
					case "usage":
						mock.method(f.rt.client, "post", () => pending.promise);
						work = f.rt.reportUsage(0.25, "old-message"); break;
					case "model":
						mock.method(f.rt.client, "post", () => pending.promise);
						work = f.rt.reportModel("provider", "old-model"); break;
					case "role":
						mock.method(f.rt.client, "me", () => pending.promise);
						work = f.rt.refreshRole(); break;
					case "ack":
						mock.method(f.rt.client, "ack", () => pending.promise);
						work = f.rt.ack([envelope("one"), envelope("two")]); break;
					default:
						mock.method(f.rt.client, "inbox", () => pending.promise);
						if (operation !== "inbox") f.a.managed = true;
						work = operation === "settle" ? f.rt.onBeforeSettle({ outcome: "completed" }) : operation === "runStart" ? f.rt.inboxForRunStart() : f.rt.deliverInbox();
				}
				f.transition();
				const entries = f.entries.length;
				pending.reject(error());
				await work;
				assert.equal(f.rt.identity, f.b);
				assert.equal(f.rt.fenced, false);
				assert.equal(f.entries.length, entries);
				assert.deepEqual(f.notes, []);
				assert.deepEqual(f.sent, []);
			} finally { f.close(); }
		});
	}
}

for (const operation of ["usage", "role", "inbox", "settle", "runStart"] as const) {
	test(`late successful ${operation} response is ignored after stop and reattach`, async () => {
		const f = await fixture();
		const pending = deferred<any>();
		try {
			let work: Promise<unknown>;
			if (operation === "usage") {
				mock.method(f.rt.client, "post", () => pending.promise);
				work = f.rt.reportUsage(0.25, "old-message");
			} else if (operation === "role") {
				mock.method(f.rt.client, "me", () => pending.promise);
				work = f.rt.refreshRole();
			} else {
				mock.method(f.rt.client, "inbox", () => pending.promise);
				if (operation !== "inbox") f.a.managed = true;
				work = operation === "settle" ? f.rt.onBeforeSettle({ outcome: "completed" }) : operation === "runStart" ? f.rt.inboxForRunStart() : f.rt.deliverInbox();
			}
			f.transition();
			f.rt.lastInboxPending = 7;
			const entries = f.entries.length;
			pending.resolve({ budget_exhausted: true, role: "old-role", parent: { agent_id: "old-parent" }, messages: [envelope("old")] });
			await work;
			assert.equal(f.rt.identity, f.b);
			assert.equal(f.b.role, undefined);
			assert.equal(f.b.parent_id, undefined);
			assert.equal(f.aborts(), 0);
			assert.equal(f.entries.length, entries);
			assert.equal(f.rt.lastInboxPending, 7);
			assert.equal(f.rt.settleContinuations, 0);
			assert.deepEqual(f.sent, []);
		} finally { f.close(); }
	});
}

test("ack stops its batch after an identity transition", async () => {
	const f = await fixture();
	const pending = deferred<any>();
	try {
		const ack = mock.method(f.rt.client, "ack", () => pending.promise);
		const work = f.rt.ack([envelope("one"), envelope("two")]);
		f.transition();
		pending.resolve({ acked: true });
		await work;
		assert.equal(ack.mock.callCount(), 1);
	} finally { f.close(); }
});

test("deferred managed inbox acknowledgement retains its originating identity", async () => {
	const f = await fixture();
	try {
		mock.method(f.rt.client, "inbox", async () => ({ messages: [envelope("old")] }));
		const ack = mock.method(f.rt.client, "ack", async () => ({ acked: true as const }));
		f.a.managed = true;
		assert.ok(await f.rt.inboxForRunStart());
		f.transition();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(ack.mock.callCount(), 0);
	} finally { f.close(); }
});

test("heartbeat does not apply old desired state after waiting for usage", async () => {
	const f = await fixture();
	const pending = deferred<any>();
	try {
		mock.method(f.rt.client, "post", () => pending.promise);
		const usage = f.rt.reportUsage(0.25, "old-message");
		const received = deferred<void>();
		mock.method(f.rt.client, "heartbeat", async () => {
			received.resolve();
			return { lease_until: "later", inbox_pending: 10, desired_state: "PAUSED" as const };
		});
		const work = f.heartbeat();
		await received.promise;
		f.transition();
		pending.resolve({ budget_exhausted: true });
		await Promise.all([usage, work]);
		assert.equal(f.aborts(), 0);
		assert.equal(f.rt.lastInboxPending, 0);
	} finally { f.close(); }
});

test("a model switch completing after replacement cannot acknowledge A's request as B", async () => {
	const f = await fixture();
	const selected = deferred<boolean>();
	const switching = deferred<void>();
	try {
		f.rt.ctx!.modelRegistry = { find: () => ({ provider: "provider", id: "model" }) } as any;
		f.rt.pi.setModel = async () => { switching.resolve(); return selected.promise; };
		const post = mock.method(f.rt.client, "post", async () => ({}));
		mock.method(f.rt.client, "heartbeat", async () => ({
			lease_until: "later", inbox_pending: 10, desired_state: "PAUSED" as const,
			model_change: { provider: "provider", model: "model", request_id: "request-A" },
		}));
		const work = f.heartbeat();
		await switching.promise;
		f.transition();
		selected.resolve(true);
		await work;
		assert.equal(post.mock.callCount(), 0);
		assert.equal(f.aborts(), 0);
		assert.equal(f.rt.lastInboxPending, 0);
		assert.deepEqual(f.notes, []);
	} finally { f.close(); }
});

test("agentCall rejects a stale result and retains its captured bearer", async () => {
	const f = await fixture();
	const pending = deferred<string>();
	const started = deferred<void>();
	try {
		const work = f.rt.agentCall(async (options) => {
			assert.equal(options.token, f.a.token);
			started.resolve();
			return pending.promise;
		});
		await started.promise;
		f.transition();
		pending.resolve("old result");
		await assert.rejects(work, /team identity changed while request was pending/);
		assert.equal(f.rt.identity, f.b);
		assert.equal(f.rt.fenced, false);
	} finally { f.close(); }
});

test("current identity still releases on cancellation and fences on supersession", async () => {
	for (const error of [terminal, superseded]) {
		const f = await fixture();
		try {
			assert.equal(f.rt.handleAgentError(error(), f.a), true);
			assert.equal(f.rt.identity, undefined);
			assert.equal(f.rt.fenced, error === superseded);
		} finally { f.close(); }
	}
});

for (const initialToken of ["token-A", undefined]) {
	test(`reconnect retry preserves original bearer (${initialToken ?? "absent"}) and idempotency key`, async () => {
		const { paths, cleanup } = makeState();
		const server = await startMock(paths);
		let token = initialToken;
		let reads = 0;
		server.route("POST", "/sessions/usage", (_req, res) => {
			if (server.requests.length === 1) {
				token = "token-B";
				res.destroy();
				return;
			}
			return { body: { budget_exhausted: false } };
		});
		try {
			const client = new TeamClient({ paths, token: () => { reads++; return token; }, reconnect: "retry", retryDelaysMs: [0] });
			await client.post("/sessions/usage", { cost_usd: 0.25 });
			assert.equal(server.requests.length, 2);
			assert.equal(reads, 1);
			for (const request of server.requests) assert.equal(request.headers.authorization, initialToken ? `Bearer ${initialToken}` : undefined);
			assert.ok(server.requests[0].headers[HDR_IDEMPOTENCY]);
			assert.equal(server.requests[0].headers[HDR_IDEMPOTENCY], server.requests[1].headers[HDR_IDEMPOTENCY]);
		} finally { await server.close(); cleanup(); }
	});
}
