import { EventEmitter } from "node:events";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync } from "node:fs";
import {
	TeamClient,
	TeamApiError,
	ControllerUnavailableError,
	ControllerIncompatibleError,
	ensureController,
	readOperatorToken,
	rawRequest,
	spawnCount,
} from "../../src/shared/client.ts";
import { HDR_IDEMPOTENCY, HDR_PROTOCOL, PROTOCOL_VERSION, SCHEMA_VERSION } from "../../src/shared/protocol.ts";
import { makeState, startMock, health, sleep } from "./helpers.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-controller.ts");

describe("TeamClient transport", () => {
	test("standalone URL error recovers missing-socket errno but preserves errors for live sockets", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		const original = http.request;
		const runtimeError = new Error("Was there a typo in the url or port?");
		const mocked = mock.method(http, "request", () => { throw runtimeError; });
		syncBuiltinESMExports();
		try {
			await assert.rejects(rawRequest(join(paths.dir, "missing", "controller.sock"), "GET", "/health"),
				(e: unknown) => e instanceof ControllerUnavailableError && e.errno === "ENOENT");
			await assert.rejects(rawRequest(paths.socket, "GET", "/health"), (e: unknown) => e === runtimeError);
			// Restore the HTTP binding after simulating the runtime failure.
			mocked.mock.restore();
			syncBuiltinESMExports();
			assert.equal(http.request, original);
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
			await m.close();
			cleanup();
		}
	});

	test("classifies synchronous Bun FailedToOpenSocket independently of message text", async () => {
		const error = Object.assign(new Error("Unable to connect"), { code: "FailedToOpenSocket" });
		const mocked = mock.method(http, "request", () => { throw error; });
		syncBuiltinESMExports();
		try {
			await assert.rejects(rawRequest("/unused/controller.sock", "GET", "/health"),
				(e: unknown) => e instanceof ControllerUnavailableError && e.errno === "FailedToOpenSocket");
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
		}
	});

	test("sends protocol header, bearer and an auto idempotency key on POST only", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		try {
			m.route("POST", "/messages", () => ({ body: { message_id: "m1" } }));
			m.route("GET", "/me", () => ({ body: { agent_id: "a1" } }));
			const c = new TeamClient({ paths, token: () => "tok-123", noReconnect: true });
			const r = await c.sendMessage({ to: "a2", type: "question", payload: { text: "hi" } });
			assert.equal(r.message_id, "m1");
			await c.me();
			const [post, get] = m.requests.filter((x) => x.path !== "/health");
			assert.equal(post.headers[HDR_PROTOCOL], String(PROTOCOL_VERSION));
			assert.equal(post.headers.authorization, "Bearer tok-123");
			assert.match(String(post.headers[HDR_IDEMPOTENCY]), /^[0-9a-f-]{36}$/);
			assert.equal(post.headers["content-type"], "application/json");
			assert.deepEqual(post.body, { to: "a2", type: "question", payload: { text: "hi" } });
			assert.equal(get.headers[HDR_PROTOCOL], String(PROTOCOL_VERSION));
			assert.equal(get.headers[HDR_IDEMPOTENCY], undefined);
			assert.equal(get.headers.authorization, "Bearer tok-123");
		} finally {
			await m.close();
			cleanup();
		}
	});

	test("caller-supplied idempotency key is sent verbatim and distinct calls get distinct keys", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		try {
			m.route("POST", "/tasks", () => ({ body: { task_id: "t", message_id: "m" } }));
			const c = new TeamClient({ paths, token: () => "t", noReconnect: true });
			await c.delegateTask({ owner_id: "x", title: "a" }, { idempotencyKey: "tool:a1:team_delegate_task:call-7" });
			await c.delegateTask({ owner_id: "x", title: "a" }, { idempotencyKey: "tool:a1:team_delegate_task:call-7" });
			await c.delegateTask({ owner_id: "x", title: "a" });
			await c.delegateTask({ owner_id: "x", title: "a" });
			const keys = m.requests.filter((r) => r.path === "/tasks").map((r) => r.headers[HDR_IDEMPOTENCY]);
			assert.equal(keys[0], "tool:a1:team_delegate_task:call-7");
			assert.equal(keys[1], keys[0]);
			assert.notEqual(keys[2], keys[3]);
		} finally {
			await m.close();
			cleanup();
		}
	});

	test("retry after a dropped connection reuses the same idempotency key", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		try {
			let n = 0;
			m.route("POST", "/messages", (_req, res) => {
				n++;
				if (n === 1) {
					res.socket?.destroy(); // -> ECONNRESET on the client
					return;
				}
				return { body: { message_id: "m-ok" } };
			});
			const before = spawnCount();
			const c = new TeamClient({ paths, token: () => "t" });
			const r = await c.sendMessage({ to: "a", type: "answer", payload: {} });
			assert.equal(r.message_id, "m-ok");
			const posts = m.requests.filter((x) => x.path === "/messages");
			assert.equal(posts.length, 2);
			assert.equal(posts[0].headers[HDR_IDEMPOTENCY], posts[1].headers[HDR_IDEMPOTENCY]);
			assert.equal(spawnCount(), before, "healthy controller must not be respawned");
		} finally {
			await m.close();
			cleanup();
		}
	});

	test("maps ApiError bodies, bare HTTP errors and missing sockets to typed errors", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		try {
			m.route("POST", "/expansions", () => ({ status: 409, body: { error: { code: "BUDGET_EXCEEDED", message: "too expensive", details: { need: 5 } } } }));
			m.route("GET", "/me", () => ({ status: 409, body: { error: { code: "STALE_SESSION", message: "fenced" } } }));
			m.route("GET", "/models", (_r, res) => {
				res.writeHead(502).end("bad gateway");
			});
			const c = new TeamClient({ paths, token: () => "t", noReconnect: true });
			await assert.rejects(
				c.requestExpansion({ version: 1, task_id: "t", reason: "r", alternatives: "a", estimated_cost_usd: 1, roles: [] }),
				(e: unknown) => e instanceof TeamApiError && e.code === "BUDGET_EXCEEDED" && e.status === 409 && (e.details as any).need === 5,
			);
			await assert.rejects(c.me(), (e: unknown) => e instanceof TeamApiError && e.code === "STALE_SESSION");
			await assert.rejects(c.models(), (e: unknown) => e instanceof TeamApiError && e.code === "INTERNAL" && e.status === 502);
			await assert.rejects(rawRequest(join(paths.dir, "nope.sock"), "GET", "/health"), (e: unknown) => e instanceof ControllerUnavailableError && e.errno === "ENOENT");
		} finally {
			await m.close();
			cleanup();
		}
	});
});

describe("ensureController", () => {
	test("only pings when a compatible controller is healthy (no spawn)", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		try {
			const before = spawnCount();
			const r = await ensureController(paths, { entry: FAKE });
			assert.equal(r.spawned, false);
			assert.equal(r.health.controller_id, "mock");
			const again = await ensureController(paths, { entry: FAKE }); // e.g. /reload
			assert.equal(again.spawned, false);
			assert.equal(spawnCount(), before);
			assert.equal(m.requests.filter((x) => x.path === "/health").length, 2);
			assert.ok(!existsSync(join(paths.dir, "fake-starts.log")));
		} finally {
			await m.close();
			cleanup();
		}
	});

	test("rejects a controller with a different schema/protocol and does not replace it", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		try {
			m.route("GET", "/health", () => ({ body: health({ schema: SCHEMA_VERSION + 1 }) }));
			const before = spawnCount();
			await assert.rejects(ensureController(paths, { entry: FAKE }), (e: unknown) => e instanceof ControllerIncompatibleError && /schema/.test((e as Error).message));
			m.route("GET", "/health", () => ({ status: 426, body: { error: { code: "PROTOCOL_MISMATCH", message: "need protocol 9" } } }));
			await assert.rejects(ensureController(paths, { entry: FAKE }), (e: unknown) => e instanceof ControllerIncompatibleError);
			assert.equal(spawnCount(), before);
		} finally {
			await m.close();
			cleanup();
		}
	});

	test("spawns a detached controller when none answers; concurrent callers share one spawn", async () => {
		const { paths, cleanup } = makeState();
		let pid: number | undefined;
		try {
			const before = spawnCount();
			const results = await Promise.all(Array.from({ length: 6 }, () => ensureController(paths, { entry: FAKE, env: { FAKE_CONTROLLER_DELAY_MS: "400" } })));
			assert.equal(spawnCount() - before, 1, "exactly one spawn for concurrent callers");
			assert.ok(results.every((r) => r.spawned));
			pid = results[0].health.pid;
			assert.ok(results.every((r) => r.health.pid === pid));
			assert.notEqual(pid, process.pid);
			assert.equal(results[0].health.state_dir, paths.dir, "PI_TEAM_STATE_DIR passed to controller");
			assert.equal(await readOperatorToken(paths), "op-token-fake");
			// Settled: next call pings the running instance instead of spawning again.
			const again = await ensureController(paths, { entry: FAKE });
			assert.equal(again.spawned, false);
			assert.equal(spawnCount() - before, 1);
			const starts = readFileSync(join(paths.dir, "fake-starts.log"), "utf8").trim().split("\n");
			assert.equal(starts.filter((l) => l.startsWith("owner")).length, 1);
		} finally {
			if (pid) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {}
				await sleep(100);
			}
			cleanup();
		}
	});

	test("standalone async FailedToOpenSocket bootstraps from an absent state directory", async () => {
		const { paths, cleanup } = makeState();
		rmSync(paths.dir, { recursive: true });
		const original = http.request;
		const mocked = mock.method(http, "request", (...args: any[]) => {
			if (existsSync(paths.socket)) return (original as any)(...args);
			const req = new EventEmitter() as any;
			req.setTimeout = () => req;
			req.end = () => queueMicrotask(() => req.emit("error", Object.assign(new Error("Unable to connect"), { code: "FailedToOpenSocket" })));
			return req;
		});
		syncBuiltinESMExports();
		let pid: number | undefined;
		try {
			const before = spawnCount();
			const result = await ensureController(paths, { entry: FAKE });
			pid = result.health.pid;
			assert.equal(result.spawned, true);
			assert.equal(spawnCount() - before, 1);
			assert.equal(await readOperatorToken(paths), "op-token-fake");
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
			if (pid) {
				process.kill(pid, "SIGTERM");
				await sleep(100);
			}
			cleanup();
		}
	});

	test("controller restart: a call after the controller died re-spawns it and succeeds", async () => {
		const { paths, cleanup } = makeState();
		let pid: number | undefined;
		try {
			const first = await ensureController(paths, { entry: FAKE, env: { FAKE_CONTROLLER_DELAY_MS: "50" } });
			process.kill(first.health.pid, "SIGTERM");
			await sleep(200);
			const c = new TeamClient({ paths, ensure: { entry: FAKE, env: { FAKE_CONTROLLER_DELAY_MS: "50" } } });
			let reconnected = false;
			c.opts.onReconnect = () => (reconnected = true);
			const h = await c.health().catch((e) => e);
			// /health itself answers after reconnect
			assert.ok(reconnected, "client re-ran ensureController");
			assert.equal((h as any).ok, true);
			pid = (h as any).pid;
			assert.notEqual(pid, first.health.pid);
		} finally {
			if (pid) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {}
				await sleep(100);
			}
			cleanup();
		}
	});

	test("reports a clear error when the controller never becomes ready", async () => {
		const { paths, cleanup } = makeState();
		try {
			await assert.rejects(
				ensureController(paths, { entry: join(paths.dir, "does-not-exist.ts"), readyTimeoutMs: 800 }),
				(e: unknown) => e instanceof ControllerUnavailableError && /failed to start/.test((e as Error).message) && /exited \(code 1/.test((e as Error).message),
			);
		} finally {
			cleanup();
		}
	});
});
