// Drives test/fixtures/fake-worker.ts (via ScriptExecutor) against a minimal in-test
// controller stub on a unix socket, checking it speaks the protocol from protocol.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptExecutor, probeIdentity } from "../../src/executor/index.ts";
import { HDR_IDEMPOTENCY, HDR_PROTOCOL, PROTOCOL_VERSION } from "../../src/shared/protocol.ts";
import { FIXTURES, makeSpec, tmp, until } from "./helpers.ts";

const FAKE = join(FIXTURES, "fake-worker.ts");

interface Call { method: string; path: string; body: any; auth?: string; idem?: string; proto?: string }

function stubController(sock: string, opts: { role: string; rejectHeartbeat?: boolean }) {
	const calls: Call[] = [];
	const state = { desired: "RUNNING", taskStatus: "ASSIGNED", inbox: [{ message_id: "m1", type: "task.assigned", from: "root", to: "a1", payload: {} }] as any[] };
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const body = raw ? JSON.parse(raw) : undefined;
			const path = req.url ?? "";
			calls.push({ method: req.method!, path, body, auth: req.headers.authorization, idem: req.headers[HDR_IDEMPOTENCY] as string, proto: req.headers[HDR_PROTOCOL] as string });
			const send = (code: number, obj: unknown) => {
				res.writeHead(code, { "content-type": "application/json" });
				res.end(JSON.stringify(obj));
			};
			if (path === "/enroll") return send(200, { run_id: "r1", agent_id: "a1", session_id: "s1", token: "SESSION-TOKEN", parent_id: "root", task_id: "t1" });
			if (req.headers.authorization !== "Bearer SESSION-TOKEN") return send(401, { error: { code: "UNAUTHENTICATED", message: "no" } });
			if (path === "/sessions/heartbeat") {
				if (opts.rejectHeartbeat) return send(409, { error: { code: "STALE_SESSION", message: "fenced" } });
				return send(200, { lease_until: new Date().toISOString(), inbox_pending: state.inbox.length, desired_state: state.desired });
			}
			if (path === "/me") return send(200, { run_id: "r1", agent_id: "a1", session_id: "s1", role: opts.role, is_root: false, parent: { agent_id: "root", role: "Root" }, children: [], tasks: [{ task_id: "t1", title: "x", status: state.taskStatus, parent_task_id: null }], desired_state: state.desired });
			if (path.startsWith("/inbox")) {
				const messages = state.inbox;
				state.inbox = [];
				return send(200, { messages });
			}
			if (/^\/messages\/[^/]+\/ack$/.test(path)) return send(200, { acked: true });
			if (path === "/expansions") return send(200, { proposal_id: "p1", status: "PENDING", reviewer_id: "root" });
			if (path === "/tasks/t1/complete") {
				state.taskStatus = "DONE";
				state.desired = "RETIRED"; // controller retires the worker once its task is done
				return send(200, { ok: true });
			}
			return send(404, { error: { code: "NOT_FOUND", message: path } });
		});
	});
	return { calls, state, server, listen: () => new Promise<void>((r) => server.listen(sock, r)) };
}

async function runWorker(role: string, script: object, opts: { rejectHeartbeat?: boolean } = {}) {
	const dir = tmp("pt-fw-");
	const sock = join(dir, "c.sock");
	const ctl = stubController(sock, { role, ...opts });
	await ctl.listen();
	const spec = makeSpec(dir, { role });
	writeFileSync(spec.enroll_file, JSON.stringify({ version: 1, socket_path: sock, run_id: "r1", agent_id: "a1", spawn_intent_id: "i1", token: "ENROLL-TOKEN", expires_at: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
	const scriptFile = join(dir, "script.json");
	writeFileSync(scriptFile, JSON.stringify(script));
	const saved = { ...process.env };
	process.env.PI_TEAM_FAKE_SCRIPT = scriptFile;
	process.env.PI_TEAM_FAKE_HEARTBEAT_MS = "100";
	let id;
	try {
		id = await new ScriptExecutor(FAKE).launch(spec);
	} finally {
		process.env = saved;
	}
	await until(async () => (await probeIdentity(id)) === "dead", 20_000, 50);
	ctl.server.close();
	return { ctl, spec };
}

test("fake worker: enroll, heartbeat, inbox ack, scripted ops, exit on RETIRED", async () => {
	const { ctl, spec } = await runWorker("Lead", {
		Lead: [
			{ op: "request_expansion", body: { reason: "need help", alternatives: "none", estimated_cost_usd: 0.1, roles: [{ title: "DRC verifier", responsibility: "verify", count: 1, capabilities: [], max_cost_usd: 0.1 }] } },
			{ op: "complete_task", summary: "all done" },
		],
	});
	assert.ok(!existsSync(spec.enroll_file), "enroll file deleted");
	const enroll = ctl.calls.find((c) => c.path === "/enroll")!;
	assert.equal(enroll.body.token, "ENROLL-TOKEN");
	assert.equal(enroll.body.agent_id, "a1");
	assert.equal(enroll.body.spawn_intent_id, "i1");
	assert.ok(enroll.body.pid > 0);
	assert.match(enroll.body.process_started_at, /Z$/);
	for (const c of ctl.calls) {
		assert.equal(c.proto, String(PROTOCOL_VERSION));
		if (c.method === "POST") assert.ok(c.idem, `idempotency-key on ${c.path}`);
	}
	const paths = ctl.calls.map((c) => `${c.method} ${c.path}`);
	assert.ok(paths.includes("POST /sessions/heartbeat"));
	assert.ok(paths.includes("POST /messages/m1/ack"));
	const exp = ctl.calls.find((c) => c.path === "/expansions")!;
	assert.equal(exp.body.task_id, "t1");
	assert.equal(exp.body.roles[0].title, "DRC verifier");
	assert.equal(ctl.calls.find((c) => c.path === "/tasks/t1/complete")!.body.summary, "all done");
	const log = (await import("node:fs")).readFileSync(spec.log_path, "utf8");
	assert.match(log, /"event":"retired"/);
	assert.ok(!log.includes("ENROLL-TOKEN") && !log.includes("SESSION-TOKEN"), "tokens never logged");
});

test("fake worker exits on STALE_SESSION", async () => {
	const { spec } = await runWorker("X", { "*": [{ op: "sleep", ms: 60_000 }] }, { rejectHeartbeat: true });
	assert.match((await import("node:fs")).readFileSync(spec.log_path, "utf8"), /"event":"fenced"/);
});
