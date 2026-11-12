import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { TeamRuntime, __resetProcessStateForTests } from "../../src/extension/runtime.ts";
import type { Identity } from "../../src/extension/runtime.ts";
import { makeState, startMock } from "./helpers.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}
const respond = (res: ServerResponse, body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
const replacement = (): Identity => ({ run_id: "replacement", agent_id: "replacement", session_id: "replacement", token: "replacement", managed: false, pi_session_id: "pi" });

async function fixture() {
	__resetProcessStateForTests();
	const { paths, cleanup } = makeState();
	const server = await startMock(paths);
	const entries: { customType: string; data: any }[] = [];
	const notes: string[] = [];
	const rt = new TeamRuntime({
		appendEntry: (customType, data) => { entries.push({ customType, data }); },
		sendMessage: () => {},
	}, { paths, env: {}, heartbeatMs: 60_000 });
	await rt.start({
		hasUI: true, mode: "rpc", cwd: "/w",
		ui: { notify: (text: string) => notes.push(text), setStatus: () => {} },
		isIdle: () => true, hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => "pi", getSessionFile: () => undefined, getEntries: () => [] },
	} as any);
	const ensure = mock.method(rt, "ensure", async () => ({} as any));
	mock.method(rt, "operatorToken", async () => "operator");
	mock.method(rt, "heartbeat", async () => {});
	server.route("GET", "/me", () => ({ body: { role: "root", parent: null } }));
	return {
		rt, server, entries, notes, ensure,
		close: async () => { rt.stop(); await server.close(); cleanup(); __resetProcessStateForTests(); },
	};
}

for (const sameAgent of [true, false]) {
	test(`overlapping attaches serialize controller requests (${sameAgent ? "same agent" : "different teams"})`, async () => {
		const f = await fixture();
		const firstSeen = deferred<ServerResponse>();
		const secondSeen = deferred<void>();
		let attaches = 0;
		let currentToken = "";
		const responses = [
			{ run_id: "run-A", agent_id: "A", session_id: "session-1", token: "token-1" },
			{ run_id: sameAgent ? "run-A" : "run-B", agent_id: sameAgent ? "A" : "B", session_id: "session-2", token: "token-2" },
		];
		f.server.route("POST", /^\/runs\/[^/]+\/attach$/, (_req, res) => {
			const response = responses[attaches++];
			currentToken = response.token;
			if (attaches === 1) { firstSeen.resolve(res); return; }
			secondSeen.resolve();
			return { body: response };
		});
		f.server.route("GET", "/me", (req) => req.headers.authorization === `Bearer ${currentToken}`
			? { body: { role: "root", parent: null } }
			: { status: 401, body: { error: { code: "STALE_SESSION", message: "superseded", details: { reason: "superseded" } } } });
		try {
			const first = f.rt.attach("run-A", "A");
			const res = await firstSeen.promise;
			const second = f.rt.attach(responses[1].run_id, responses[1].agent_id);
			// Let all ready work run: the second attach must still be queued locally,
			// not merely waiting for its response after invalidating token-1.
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(f.ensure.mock.callCount(), 1);
			assert.equal(attaches, 1);
			respond(res, responses[0]);
			assert.equal((await first).token, "token-1");
			await secondSeen.promise;
			const latest = await second;
			assert.equal(latest.token, "token-2");
			assert.equal(f.rt.identity, latest);
			assert.ok(await f.rt.refreshRole(), "the final credential is accepted by the controller");
			assert.equal(f.rt.fenced, false);
			assert.deepEqual(f.entries.map((entry) => entry.data.agent_id), responses.map((response) => response.agent_id));
		} finally { await f.close(); }
	});
}

for (const transition of ["stop", "release", "adopt", "init"] as const) {
	test(`${transition} invalidates pending and queued attaches without persisting their responses`, async () => {
		const f = await fixture();
		const firstSeen = deferred<ServerResponse>();
		f.server.route("POST", /^\/runs\/[^/]+\/attach$/, (_req, res) => { firstSeen.resolve(res); });
		try {
			const first = f.rt.attach("run-old", "old");
			const res = await firstSeen.promise;
			const queued = f.rt.attach("run-queued", "queued");
			const failures = [first, queued].map((work) => assert.rejects(work, /team identity changed while attach was pending/));
			const id = replacement();
			if (transition === "stop") f.rt.stop();
			else if (transition === "release") f.rt.releaseStoppedIdentity("CANCELLED");
			else if (transition === "adopt") f.rt.adopt(id);
			else f.rt.adoptNew(id);
			const count = f.entries.length;
			respond(res, { run_id: "run-old", agent_id: "old", session_id: "old", token: "old" });
			await Promise.all(failures);
			assert.equal(f.rt.identity, transition === "adopt" || transition === "init" ? id : undefined);
			assert.equal(f.entries.length, count);
			assert.equal(f.server.requests.filter((request) => request.method === "POST").length, 1);
			assert.equal(f.rt.fenced, false);
			assert.deepEqual(f.notes, []);
		} finally { await f.close(); }
	});
}

test("a replacement during attach role refresh is not overwritten or announced as attached", async () => {
	const f = await fixture();
	const roleSeen = deferred<ServerResponse>();
	f.server.route("POST", "/runs/run-old/attach", () => ({ body: { run_id: "run-old", agent_id: "old", session_id: "old", token: "old" } }));
	f.server.route("GET", "/me", (_req, res) => { roleSeen.resolve(res); });
	try {
		const work = f.rt.attach("run-old", "old");
		const res = await roleSeen.promise;
		const failed = assert.rejects(work, /team identity changed while attach was pending/);
		const id = replacement();
		f.rt.adoptNew(id);
		respond(res, { role: "obsolete", parent: { agent_id: "obsolete" } });
		await failed;
		assert.equal(f.rt.identity, id);
		assert.equal(id.role, undefined);
		assert.deepEqual(f.notes, []);
	} finally { await f.close(); }
});

for (const phase of ["ensure", "operator"] as const) {
	test(`stop during attach ${phase} preparation prevents the controller request`, async () => {
		const f = await fixture();
		const started = deferred<void>();
		const pending = deferred<any>();
		const gate = phase === "ensure"
			? mock.method(f.rt, "ensure", () => { started.resolve(); return pending.promise; })
			: mock.method(f.rt, "operatorToken", () => { started.resolve(); return pending.promise; });
		try {
			const work = f.rt.attach("run-old", "old");
			await started.promise;
			const failed = assert.rejects(work, /team identity changed while attach was pending/);
			f.rt.stop();
			pending.resolve(phase === "ensure" ? {} : "operator");
			await failed;
			assert.equal(f.server.requests.length, 0);
			assert.equal(f.entries.length, 0);
		} finally { gate.mock.restore(); await f.close(); }
	});
}

test("a rejected attach releases the queue for the next request", async () => {
	const f = await fixture();
	const firstSeen = deferred<ServerResponse>();
	f.server.route("POST", "/runs/run-old/attach", (_req, res) => { firstSeen.resolve(res); });
	f.server.route("POST", "/runs/run-new/attach", () => ({ body: { run_id: "run-new", agent_id: "new", session_id: "new", token: "new" } }));
	try {
		const first = f.rt.attach("run-old", "old");
		const res = await firstSeen.promise;
		const failed = assert.rejects(first, /no such run/);
		const second = f.rt.attach("run-new", "new");
		res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such run" } }));
		await failed;
		assert.equal((await second).token, "new");
		assert.equal(f.rt.identity?.agent_id, "new");
	} finally { await f.close(); }
});
