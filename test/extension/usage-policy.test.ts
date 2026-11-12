import { test } from "node:test";
import assert from "node:assert/strict";
import { TeamRuntime } from "../../src/extension/runtime.ts";
import { makeState } from "./helpers.ts";

test("usage survives controller outages and runtime reload; retries retain keys and exhaustion aborts", async () => {
	const { paths, cleanup } = makeState();
	const entries: any[] = [];
	const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }), sendMessage: () => {} };
	let aborts = 0;
	const ctx = { abort: () => { aborts++; }, isIdle: () => false, hasPendingMessages: () => false, hasUI: false,
		ui: { setStatus: () => {} }, sessionManager: { getEntries: () => entries, getSessionId: () => "pi1", getSessionFile: () => "/pi1.jsonl" } };
	const identity = { run_id: "run1", agent_id: "agent1", session_id: "session1", token: "t", managed: false, pi_session_id: "pi1" };
	const first = new TeamRuntime(pi as any, { paths });
	const second = new TeamRuntime(pi as any, { paths });
	try {
		first.ctx = ctx as any;
		first.identity = identity;
		let originalKey: unknown;
		first.client.post = async (_path, _body, options) => { originalKey = options?.idempotencyKey; throw new Error("controller offline"); };
		await first.reportUsage(1.25, "assistant:1");
		assert.equal(entries.filter((e) => e.data.cost === 1.25).length, 1);
		second.ctx = ctx as any;
		second.identity = { ...identity, session_id: "resumed-session" };
		let requests = 0;
		second.client.post = async (path, body, options) => {
			assert.equal(path, "/sessions/usage");
			assert.equal(options?.idempotencyKey, originalKey);
			assert.deepEqual(body, { cost_usd: 1.25 });
			requests++;
			return { budget_exhausted: true } as any;
		};
		second.client.heartbeat = async () => ({ lease_until: "x", inbox_pending: 0, desired_state: "RUNNING" });
		await second.heartbeat();
		assert.equal(aborts, 1);
		assert.equal(requests, 1);
		await second.heartbeat();
		assert.equal(requests, 1, "acknowledged usage is not resent");
		second.client.heartbeat = async () => ({ lease_until: "x", inbox_pending: 0, desired_state: "PAUSED" });
		await second.heartbeat();
		assert.equal(aborts, 2, "controller pause aborts an active worker");
	} finally { first.stop(); second.stop(); cleanup(); }
});
