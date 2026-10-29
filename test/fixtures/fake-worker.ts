// Fake worker: a no-LLM stand-in for a managed `pi` worker, launched by ScriptExecutor
// (PI_TEAM_EXECUTOR=<path to this file>). It speaks the controller protocol from
// src/shared/protocol.ts over the per-user unix socket, exactly like the real extension would.
//
// Lifecycle
//   1. read PI_TEAM_ENROLL_FILE (0600 JSON EnrollmentFile), delete it, POST /enroll
//   2. background: POST /sessions/heartbeat every PI_TEAM_FAKE_HEARTBEAT_MS (default 1000);
//      when inbox_pending > 0, GET /inbox?limit=PI_TEAM_FAKE_INBOX_LIMIT (default 20) and ack
//      each message (optional PI_TEAM_FAKE_ACK_DELAY_MS between acks). Messages are handled
//      exactly once per message_id (duplicates from redelivery are acked again, logged as
//      "duplicate"); acks that failed (controller down) are retried on the next tick.
//   3. run the scripted ops for this agent's role (see below), then idle (heartbeat + inbox)
//   4. exit 0 on desired_state RETIRED or SIGTERM; exit 3 on 401 / STALE_SESSION (fenced)
//   The worker survives a controller crash: requests that fail to connect are retried with
//   the SAME idempotency keys, so a replayed mutation is deduplicated by the controller.
//
// Script: env PI_TEAM_FAKE_SCRIPT = path to a JSON file keyed by role ("*" = fallback):
//   {
//     "Lead": [
//       {"op": "review", "count": 2, "on_exceeded": "ESCALATE"},
//       {"op": "wait_messages", "type": "task.completed", "count": 3},
//       {"op": "complete_task", "all": true, "summary": "done"}
//     ],
//     "DRC verifier": [
//       {"op": "gate", "name": "step4"},
//       {"op": "request_expansion", "body": {"reason": "...", "alternatives": "...", "estimated_cost_usd": 0.25,
//         "roles": [{"title": "Nested checker", "responsibility": "...", "count": 1, "capabilities": [], "max_cost_usd": 0.25}]}},
//       {"op": "gate", "name": "complete"},
//       {"op": "report_usage", "cost_usd": 0.12},
//       {"op": "complete_task", "artifact": "drc-report.txt"}
//     ]
//   }
// Ops:
//   complete_task  {summary?, status?, all?, artifact?: filename}  waits for an open task of its own;
//                  artifact: writes <cwd>/<filename>, attaches {kind:"report", uri, sha256}
//   request_expansion {body: CreateExpansionRequest (task_id optional -> own open task)}
//   review         {decision?: "APPROVE", reason?, count?: 1, on_exceeded?: "ESCALATE"|"REJECT"}
//                  decides proposals where it is reviewer until `count` were handled. A HARD_CAP
//                  answer (controller rejected it for a global cap) counts as handled. With
//                  on_exceeded, a BUDGET_EXCEEDED / FORBIDDEN answer is followed by that decision.
//   send_message   {to: "parent" | "children" | "child:N" | agent_id, type?: "question", payload?}
//   delegate       {to, title, spec?}
//   wait_children  {count?, status?: string[]}
//   wait_messages  {type?, count?: 1}       until that many distinct messages of type were received
//   report_usage   {cost_usd, input_tokens?, output_tokens?}   POST /sessions/usage
//   gate           {name}                   until file $PI_TEAM_FAKE_GATE_DIR/<name> exists
//   sleep          {ms}
//   exit           {code?: 0}
// Ops only make progress while desired_state is RUNNING (a paused worker waits).
// Waiting ops give up after `timeout_ms` (default PI_TEAM_FAKE_OP_TIMEOUT_MS or 120000) -> exit 4.
// Every stdout line is one JSON log record (stdout goes to the worker log). Tokens are never logged.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { ENV_ENROLL_FILE, HDR_IDEMPOTENCY, HDR_PROTOCOL, PROTOCOL_VERSION } from "../../src/shared/protocol.ts";
import type { EnrollmentFile, EnrollResponse, Envelope, HeartbeatResponse, InboxResponse, OrgContext, ProposalView } from "../../src/shared/protocol.ts";
import { processStartTimeSync } from "../../src/executor/proc.ts";

type Op = { op: string; [k: string]: any };

const HEARTBEAT_MS = Number(process.env.PI_TEAM_FAKE_HEARTBEAT_MS ?? 1000);
const OP_TIMEOUT_MS = Number(process.env.PI_TEAM_FAKE_OP_TIMEOUT_MS ?? 120_000);
const INBOX_LIMIT = Number(process.env.PI_TEAM_FAKE_INBOX_LIMIT ?? 20);
const ACK_DELAY_MS = Number(process.env.PI_TEAM_FAKE_ACK_DELAY_MS ?? 0);
const GATE_DIR = process.env.PI_TEAM_FAKE_GATE_DIR ?? "";

function log(event: string, data: Record<string, unknown> = {}): void {
	process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), fake_worker: process.pid, event, ...data })}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP over unix socket
// ---------------------------------------------------------------------------

/** The controller answered with an error status. */
class ApiFailure extends Error {
	status: number;
	code: string;
	details: any;
	constructor(status: number, code: string, message: string, details?: unknown) {
		super(`${status} ${code}: ${message}`);
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

let socketPath = "";
let bearer = "";

function call<T>(method: "GET" | "POST", path: string, body?: unknown, idemKey?: string): Promise<T> {
	const payload = method === "POST" ? JSON.stringify(body ?? {}) : undefined;
	const headers: Record<string, string> = { [HDR_PROTOCOL]: String(PROTOCOL_VERSION) };
	if (bearer) headers.authorization = `Bearer ${bearer}`;
	if (payload !== undefined) {
		headers[HDR_IDEMPOTENCY] = idemKey ?? `fake-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		headers["content-type"] = "application/json";
		headers["content-length"] = String(Buffer.byteLength(payload));
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
				else reject(new ApiFailure(status, json?.error?.code ?? "HTTP", json?.error?.message ?? data.slice(0, 200), json?.error?.details));
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

const errText = (err: unknown) => String((err as Error)?.message ?? err);

// ---------------------------------------------------------------------------
// Background loop: heartbeat + inbox
// ---------------------------------------------------------------------------

let desired: string = "RUNNING";
const handled = new Map<string, Envelope>(); // message_id -> envelope (handled exactly once)
const unacked = new Set<string>(); // handled but ack not confirmed by the controller

async function ack(id: string): Promise<void> {
	await call("POST", `/messages/${encodeURIComponent(id)}/ack`, {}, `ack:${id}`);
	unacked.delete(id);
	log("acked", { message_id: id });
}

async function tick(): Promise<void> {
	try {
		const hb = await call<HeartbeatResponse>("POST", "/sessions/heartbeat", { busy: true });
		if (hb.desired_state !== desired) log("desired_state", { from: desired, to: hb.desired_state });
		desired = hb.desired_state;
		if (desired === "RETIRED") {
			log("retired");
			process.exit(0);
		}
		for (const id of [...unacked]) await ack(id); // retry acks lost to a controller crash
		if (hb.inbox_pending > 0) {
			const res = await call<InboxResponse>("GET", `/inbox?limit=${INBOX_LIMIT}`);
			// Record the whole claimed batch first, so a crash mid-batch cannot strand a claimed message.
			for (const m of res.messages ?? []) {
				if (handled.has(m.message_id)) {
					log("duplicate", { message_id: m.message_id, type: m.type });
				} else {
					handled.set(m.message_id, m);
					log("message", { message_id: m.message_id, type: m.type, from: m.from });
				}
				unacked.add(m.message_id);
			}
			for (const m of res.messages ?? []) {
				if (ACK_DELAY_MS) await sleep(ACK_DELAY_MS);
				await ack(m.message_id);
			}
		}
	} catch (err) {
		fatalIfFenced(err);
		log("tick_error", { error: errText(err) });
	}
}

function startBackground(): void {
	void (async () => {
		for (;;) {
			await tick();
			await sleep(HEARTBEAT_MS);
		}
	})();
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
				log("op_error", { op: op.op, error: errText(err) });
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

/**
 * Run one op. `key(n)` gives a stable idempotency key for the n-th mutation of this op, so
 * when the whole op is retried after a connection failure the controller replays instead of
 * applying the mutation twice.
 */
async function runOp(op: Op, key: (n: number) => string): Promise<void> {
	switch (op.op) {
		case "complete_task": {
			let n = 0;
			do {
				const taskId = await waitFor("own open task", op, ownOpenTask);
				const body: Record<string, unknown> = { summary: op.summary ?? `completed by fake worker ${process.pid}`, status: op.status ?? "DONE" };
				if (op.artifact) {
					const file = join(process.cwd(), String(op.artifact));
					const content = `${op.artifact}: verified by ${process.env.PI_TEAM_AGENT_ID} (task ${taskId})\n`;
					writeFileSync(file, content);
					body.artifacts = [{ kind: "report", uri: file, sha256: createHash("sha256").update(content).digest("hex") }];
				}
				await call("POST", `/tasks/${encodeURIComponent(taskId)}/complete`, body, key(n++));
				log("task_completed", { task_id: taskId });
			} while (op.all && (await ownOpenTask()) !== undefined);
			return;
		}
		case "request_expansion": {
			const body = { version: 1, ...(op.body ?? {}) };
			if (!body.task_id) body.task_id = await waitFor("own open task", op, ownOpenTask);
			const res = await call<{ proposal_id: string; status: string }>("POST", "/expansions", body, key(0));
			log("expansion_requested", { proposal_id: res.proposal_id, status: res.status });
			return;
		}
		case "review": {
			const want = Number(op.count ?? 1);
			const done = new Set<string>();
			let n = 0;
			await waitFor(`${want} proposal(s) to review`, op, async () => {
				const res = await call<{ proposals: ProposalView[] }>("GET", "/proposals?scope=review");
				for (const p of res.proposals ?? []) {
					if (done.has(p.proposal_id) || !["PENDING", "UNDER_REVIEW", "ESCALATED"].includes(p.status)) continue;
					const decide = (decision: string, reason: string) =>
						call<{ status: string; spawned_agent_ids: string[] }>("POST", `/expansions/${encodeURIComponent(p.proposal_id)}/decision`, { decision, reason }, key(n++));
					try {
						const r = await decide(op.decision ?? "APPROVE", op.reason ?? "fake worker review");
						log("reviewed", { proposal_id: p.proposal_id, decision: op.decision ?? "APPROVE", status: r.status, spawned: r.spawned_agent_ids });
					} catch (err) {
						if (!(err instanceof ApiFailure)) throw err;
						if (err.code === "HARD_CAP") {
							log("reviewed", { proposal_id: p.proposal_id, decision: "APPROVE", status: "REJECTED", hard_cap: err.message });
						} else if (op.on_exceeded && (err.code === "BUDGET_EXCEEDED" || err.code === "FORBIDDEN")) {
							const r = await decide(op.on_exceeded, `cannot grant within my envelope: ${err.message}`);
							log("reviewed", { proposal_id: p.proposal_id, decision: op.on_exceeded, status: r.status, after: err.code });
						} else throw err;
					}
					done.add(p.proposal_id);
				}
				return done.size >= want ? true : undefined;
			});
			return;
		}
		case "send_message": {
			const targets = await waitFor(`recipient ${op.to}`, op, async () => {
				const t = await resolveTargets(String(op.to ?? "parent"));
				return t.length ? t : undefined;
			});
			let n = 0;
			for (const to of targets) await call("POST", "/messages", { to, type: op.type ?? "question", payload: op.payload ?? {} }, key(n++));
			log("message_sent", { to: targets });
			return;
		}
		case "delegate": {
			const targets = await waitFor(`delegate target ${op.to}`, op, async () => {
				const t = await resolveTargets(String(op.to ?? "children"));
				return t.length ? t : undefined;
			});
			const parentTask = await ownOpenTask();
			let n = 0;
			for (const owner_id of targets) {
				const r = await call<{ task_id: string }>("POST", "/tasks", { owner_id, title: op.title ?? "delegated task", spec: op.spec, parent_task_id: parentTask }, key(n++));
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
		case "wait_messages": {
			const count = Number(op.count ?? 1);
			await waitFor(`${count} message(s) of type ${op.type ?? "*"}`, op, async () => {
				const n = [...handled.values()].filter((m) => !op.type || m.type === op.type).length;
				return n >= count ? true : undefined;
			});
			return;
		}
		case "report_usage": {
			const r = await call<{ consumed_usd: number }>("POST", "/sessions/usage", { cost_usd: Number(op.cost_usd ?? 0), input_tokens: op.input_tokens, output_tokens: op.output_tokens }, key(0));
			log("usage_reported", { cost_usd: op.cost_usd, consumed_usd: r.consumed_usd });
			return;
		}
		case "gate": {
			await waitFor(`gate ${op.name}`, op, async () => (existsSync(join(GATE_DIR, String(op.name))) ? true : undefined));
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

/** Retry an op while the controller is unreachable (crash/restart); API errors are final. */
async function runOpWithRetry(op: Op, index: number): Promise<void> {
	const deadline = Date.now() + Number(op.timeout_ms ?? OP_TIMEOUT_MS);
	const key = (n: number) => `fake-${process.env.PI_TEAM_AGENT_ID}-${process.env.PI_TEAM_LAUNCH_TOKEN?.slice(0, 8)}-op${index}-${n}`;
	log("op", { op: op.op, index });
	for (;;) {
		try {
			return await runOp(op, key);
		} catch (err) {
			fatalIfFenced(err);
			if (err instanceof ApiFailure) {
				log("op_failed", { op: op.op, index, code: err.code, error: err.message });
				return;
			}
			if (Date.now() > deadline) {
				log("op_timeout", { op: op.op, error: errText(err) });
				process.exit(4);
			}
			log("op_retry", { op: op.op, index, error: errText(err) });
			await sleep(HEARTBEAT_MS);
		}
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
			launch_token: process.env.PI_TEAM_LAUNCH_TOKEN,
		});
	} catch (err) {
		log("enroll_failed", { error: errText(err) });
		process.exit(3);
	}
	bearer = session.token;
	log("enrolled", { run_id: session.run_id, agent_id: session.agent_id, session_id: session.session_id, task_id: session.task_id });

	startBackground();
	let ctx: OrgContext | undefined;
	while (!ctx) {
		try {
			ctx = await me();
		} catch (err) {
			fatalIfFenced(err);
			await sleep(HEARTBEAT_MS);
		}
	}
	const ops = loadScript(ctx.role);
	log("script", { role: ctx.role, ops: ops.map((o) => o.op) });
	for (let i = 0; i < ops.length; i++) await runOpWithRetry(ops[i], i);
	log("script_done");
	// Idle: background loop keeps heartbeating until RETIRED / fenced / SIGTERM.
}

main().catch((err) => {
	log("crash", { error: String((err as Error)?.stack ?? err) });
	process.exit(1);
});
