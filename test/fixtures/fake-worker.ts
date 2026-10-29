// Fake worker: a no-LLM stand-in for a managed `pi` worker, launched by ScriptExecutor
// (PI_TEAM_EXECUTOR=<path to this file>). It speaks the controller protocol from
// src/shared/protocol.ts over the per-user unix socket, exactly like the real extension would.
//
// Lifecycle
//   1. read PI_TEAM_ENROLL_FILE (0600 JSON EnrollmentFile), delete it, POST /enroll
//   2. background: POST /sessions/heartbeat every PI_TEAM_FAKE_HEARTBEAT_MS (default 1000)
//      and drain GET /inbox, acking every message (POST /messages/:id/ack)
//   3. run the scripted ops for this agent's role (see below), then idle (heartbeat + inbox)
//   4. exit 0 on desired_state RETIRED or SIGTERM; exit 3 on 401 / STALE_SESSION (fenced)
//
// Script: env PI_TEAM_FAKE_SCRIPT = path to a JSON file keyed by role ("*" = fallback):
//   {
//     "Lead": [
//       {"op": "request_expansion", "body": {"reason": "...", "alternatives": "...",
//         "estimated_cost_usd": 0.1, "roles": [{"title": "DRC verifier", "responsibility": "...",
//         "count": 1, "capabilities": [], "max_cost_usd": 0.1}]}},     // task_id defaults to own task
//       {"op": "wait_children", "count": 1},                             // until >= count children exist
//       {"op": "delegate", "to": "children", "title": "check DRC"},      // "children" | "child:<i>" | agent id
//       {"op": "wait_children", "status": ["COMPLETED"]},                // until every child is in status
//       {"op": "complete_task", "summary": "done"}
//     ],
//     "DRC verifier": [{"op": "complete_task"}],
//     "Root": [{"op": "review", "decision": "APPROVE", "count": 1}]
//   }
// Ops:
//   complete_task  {summary?, status?: "DONE"|"FAILED"|"BLOCKED"}  waits for an open task of its own
//   request_expansion {body: CreateExpansionRequest (task_id optional)}
//   review         {decision?: "APPROVE", reason?, count?: 1}  waits until `count` proposals decided
//   send_message   {to: "parent" | agent_id, type?: "question", payload?}
//   delegate       {to, title, spec?}
//   wait_children  {count?, status?: string[]}
//   sleep          {ms}
//   exit           {code?: 0}
// Waiting ops poll every heartbeat interval and give up after `timeout_ms` (default 120000,
// env PI_TEAM_FAKE_OP_TIMEOUT_MS) -> exit 4.
// Every line written to stdout is one JSON log record (stdout goes to the worker log). Tokens are never logged.

import { readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import {
	ENV_ENROLL_FILE,
	HDR_IDEMPOTENCY,
	HDR_PROTOCOL,
	PROTOCOL_VERSION,
} from "../../src/shared/protocol.ts";
import type {
	EnrollmentFile,
	EnrollResponse,
	HeartbeatResponse,
	InboxResponse,
	OrgContext,
	ProposalView,
} from "../../src/shared/protocol.ts";
import { processStartTimeSync } from "../../src/executor/proc.ts";

type Op = { op: string; [k: string]: any };

const HEARTBEAT_MS = Number(process.env.PI_TEAM_FAKE_HEARTBEAT_MS ?? 1000);
const OP_TIMEOUT_MS = Number(process.env.PI_TEAM_FAKE_OP_TIMEOUT_MS ?? 120_000);

function log(event: string, data: Record<string, unknown> = {}): void {
	process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), fake_worker: process.pid, event, ...data })}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

// ---------------------------------------------------------------------------
// HTTP over unix socket
// ---------------------------------------------------------------------------

class ApiFailure extends Error {
	status: number;
	code: string;
	constructor(status: number, code: string, message: string) {
		super(`${status} ${code}: ${message}`);
		this.status = status;
		this.code = code;
	}
}

let socketPath = "";
let bearer = "";

function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
	const payload = body === undefined ? undefined : JSON.stringify(body);
	const headers: Record<string, string> = { [HDR_PROTOCOL]: String(PROTOCOL_VERSION) };
	if (bearer) headers.authorization = `Bearer ${bearer}`;
	if (method === "POST") {
		headers[HDR_IDEMPOTENCY] = `fake-${process.pid}-${Date.now()}-${++seq}`;
		headers["content-type"] = "application/json";
		headers["content-length"] = String(Buffer.byteLength(payload ?? ""));
	}
	return new Promise((resolve, reject) => {
		const req = request({ socketPath, method, path, headers, timeout: 10_000 }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (data += c));
			res.on("end", () => {
				let json: any = {};
				try {
					json = data ? JSON.parse(data) : {};
				} catch {
					/* non-JSON */
				}
				const status = res.statusCode ?? 0;
				if (status >= 200 && status < 300) resolve(json as T);
				else reject(new ApiFailure(status, json?.error?.code ?? "HTTP", json?.error?.message ?? data.slice(0, 200)));
			});
		});
		req.on("timeout", () => req.destroy(new Error("request timeout")));
		req.on("error", reject);
		req.end(payload);
	});
}

/** 401 or STALE_SESSION means this session was fenced/revoked: stop immediately. */
function fatalIfFenced(err: unknown): void {
	if (err instanceof ApiFailure && (err.status === 401 || err.code === "STALE_SESSION" || err.code === "UNAUTHENTICATED")) {
		log("fenced", { error: err.message });
		process.exit(3);
	}
}

// ---------------------------------------------------------------------------
// Background loop: heartbeat + inbox
// ---------------------------------------------------------------------------

let desired: string = "RUNNING";
const inbox: any[] = [];

async function tick(): Promise<void> {
	try {
		const hb = await call<HeartbeatResponse>("POST", "/sessions/heartbeat", { busy: true });
		desired = hb.desired_state;
		if (desired === "RETIRED") {
			log("retired");
			process.exit(0);
		}
		if (hb.inbox_pending > 0) {
			const res = await call<InboxResponse>("GET", "/inbox?limit=20");
			for (const m of res.messages ?? []) {
				inbox.push(m);
				log("message", { message_id: m.message_id, type: m.type, from: m.from });
				await call("POST", `/messages/${encodeURIComponent(m.message_id)}/ack`, {});
			}
		}
	} catch (err) {
		fatalIfFenced(err);
		log("tick_error", { error: String((err as Error).message ?? err) });
	}
}

function startBackground(): void {
	const loop = async () => {
		for (;;) {
			await tick();
			await sleep(HEARTBEAT_MS);
		}
	};
	void loop();
}

// ---------------------------------------------------------------------------
// Scripted ops
// ---------------------------------------------------------------------------

const me = () => call<OrgContext>("GET", "/me");

/** Poll `check` every heartbeat interval until it returns a value (not undefined). */
async function waitFor<T>(what: string, op: Op, check: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + Number(op.timeout_ms ?? OP_TIMEOUT_MS);
	for (;;) {
		if (desired === "RUNNING") {
			try {
				const v = await check();
				if (v !== undefined) return v;
			} catch (err) {
				fatalIfFenced(err);
				log("op_error", { op: op.op, error: String((err as Error).message ?? err) });
			}
		}
		if (Date.now() > deadline) {
			log("op_timeout", { op: op.op, waiting_for: what });
			process.exit(4);
		}
		await sleep(HEARTBEAT_MS);
	}
}

const OPEN_TASK = new Set(["OPEN", "ASSIGNED", "IN_PROGRESS"]);

async function ownOpenTask(): Promise<string | undefined> {
	const ctx = await me();
	return ctx.tasks.find((t) => OPEN_TASK.has(t.status))?.task_id;
}

async function resolveTargets(to: string): Promise<string[]> {
	const ctx = await me();
	if (to === "parent") return ctx.parent ? [ctx.parent.agent_id] : [];
	if (to === "children") return ctx.children.map((c) => c.agent_id);
	const m = /^child:(\d+)$/.exec(to);
	if (m) {
		const c = ctx.children[Number(m[1])];
		return c ? [c.agent_id] : [];
	}
	return [to];
}

async function runOp(op: Op): Promise<void> {
	log("op", { op: op.op });
	switch (op.op) {
		case "complete_task": {
			const taskId = await waitFor("own open task", op, ownOpenTask);
			await call("POST", `/tasks/${encodeURIComponent(taskId)}/complete`, {
				summary: op.summary ?? `completed by fake worker ${process.pid}`,
				status: op.status ?? "DONE",
			});
			log("task_completed", { task_id: taskId });
			return;
		}
		case "request_expansion": {
			const body = { version: 1, ...(op.body ?? {}) };
			if (!body.task_id) body.task_id = await waitFor("own open task", op, ownOpenTask);
			const res = await call<{ proposal_id: string; status: string }>("POST", "/expansions", body);
			log("expansion_requested", { proposal_id: res.proposal_id, status: res.status });
			return;
		}
		case "review": {
			const want = Number(op.count ?? 1);
			let decided = 0;
			await waitFor(`${want} proposal(s) to review`, op, async () => {
				const res = await call<{ proposals: ProposalView[] } | ProposalView[]>("GET", "/proposals?scope=review");
				const list = Array.isArray(res) ? res : (res.proposals ?? []);
				for (const p of list) {
					if (p.status !== "PENDING" && p.status !== "UNDER_REVIEW") continue;
					const r = await call<{ status: string; spawned_agent_ids: string[] }>(
						"POST",
						`/expansions/${encodeURIComponent(p.proposal_id)}/decision`,
						{ decision: op.decision ?? "APPROVE", reason: op.reason ?? "fake worker review" },
					);
					log("reviewed", { proposal_id: p.proposal_id, status: r.status, spawned: r.spawned_agent_ids });
					decided++;
				}
				return decided >= want ? true : undefined;
			});
			return;
		}
		case "send_message": {
			const targets = await waitFor(`recipient ${op.to}`, op, async () => {
				const t = await resolveTargets(String(op.to ?? "parent"));
				return t.length ? t : undefined;
			});
			for (const to of targets) {
				await call("POST", "/messages", { to, type: op.type ?? "question", payload: op.payload ?? {} });
			}
			log("message_sent", { to: targets });
			return;
		}
		case "delegate": {
			const targets = await waitFor(`delegate target ${op.to}`, op, async () => {
				const t = await resolveTargets(String(op.to ?? "children"));
				return t.length ? t : undefined;
			});
			const parentTask = (await ownOpenTask()) ?? undefined;
			for (const owner_id of targets) {
				const r = await call<{ task_id: string }>("POST", "/tasks", {
					owner_id,
					title: op.title ?? "delegated task",
					spec: op.spec,
					parent_task_id: parentTask,
				});
				log("delegated", { owner_id, task_id: r.task_id });
			}
			return;
		}
		case "wait_children": {
			const count = Number(op.count ?? 1);
			const statuses: string[] | undefined = op.status;
			await waitFor("children", op, async () => {
				const ctx = await me();
				if (ctx.children.length < count) return undefined;
				if (statuses && !ctx.children.every((c) => statuses.includes(c.status))) return undefined;
				return true;
			});
			return;
		}
		case "sleep":
			await sleep(Number(op.ms ?? 1000));
			return;
		case "exit":
			log("exit", { code: op.code ?? 0 });
			process.exit(Number(op.code ?? 0));
		default:
			log("unknown_op", { op: op.op });
	}
}

function loadScript(role: string): Op[] {
	const file = process.env.PI_TEAM_FAKE_SCRIPT;
	if (!file) return [];
	const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, Op[]>;
	return all[role] ?? all["*"] ?? [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	process.on("SIGTERM", () => {
		log("sigterm");
		process.exit(0);
	});

	const enrollPath = process.env[ENV_ENROLL_FILE];
	if (!enrollPath) {
		log("no_enroll_file");
		process.exit(2);
	}
	const enroll = JSON.parse(readFileSync(enrollPath, "utf8")) as EnrollmentFile;
	rmSync(enrollPath, { force: true }); // single-use secret: remove before using it
	socketPath = enroll.socket_path;

	let session: EnrollResponse;
	try {
		session = await call<EnrollResponse>("POST", "/enroll", {
			token: enroll.token,
			agent_id: enroll.agent_id,
			spawn_intent_id: enroll.spawn_intent_id,
			pid: process.pid,
			process_started_at: processStartTimeSync(process.pid) ?? undefined,
			pi_session_path: process.env.PI_TEAM_PI_SESSION_PATH,
		});
	} catch (err) {
		log("enroll_failed", { error: String((err as Error).message ?? err) });
		process.exit(3);
	}
	bearer = session.token;
	log("enrolled", { run_id: session.run_id, agent_id: session.agent_id, session_id: session.session_id, task_id: session.task_id });

	startBackground();
	const ctx = await me();
	const ops = loadScript(ctx.role);
	log("script", { role: ctx.role, ops: ops.map((o) => o.op) });
	for (const op of ops) await runOp(op);
	log("script_done");
	// Idle: background loop keeps heartbeating until RETIRED / fenced / SIGTERM.
}

main().catch((err) => {
	log("crash", { error: String((err as Error)?.stack ?? err) });
	process.exit(1);
});
