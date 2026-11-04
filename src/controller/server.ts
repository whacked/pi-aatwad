import { updateBudget, updateModel, selectedModel } from "./agent-settings.ts";
import { adminPolicy } from "./admin.ts";
import { terminalMode } from "./terminal.ts";
import { registerModel, createMember } from "./members.ts";
// HTTP API over the unix socket: protocol check, auth, idempotency, routing, one BEGIN IMMEDIATE txn per request.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { HDR_IDEMPOTENCY, HDR_PROTOCOL, PROTOCOL_VERSION, type HealthResponse, type ShutdownResponse } from "../shared/protocol.ts";
import { get, run, tx, nowIso, parseJson } from "./db.ts";
import { ApiErr, CommittedError, fail } from "./errors.ts";
import type { Ctx, Principal, ReqScope } from "./context.ts";
import { resolvePrincipal, issueSessionToken } from "./auth.ts";
import { ackMessage, completeTask, delegateTask, readInbox, sendMessage, taskProgress } from "./messaging.ts";
import { createExpansion, decide, listProposals } from "./governance.ts";
import { lifecycle, reparent } from "./topology.ts";
import { attach, budget, createRun, enroll, events, heartbeat, inspect, listRuns, me, models, reportUsage, tree } from "./runs.ts";
import { getRecoveryStatus, isTerminal } from "./queries.ts";
import { assertLeaseHeld } from "./fence.ts";
import { changeReporting, readReporting } from "./reporting.ts";

type Auth = "none" | "any" | "operator" | "agent";
type Handler = (a: { p: Principal; scope: ReqScope; params: string[]; body: unknown; q: URLSearchParams }) => unknown;
interface Route {
	method: "GET" | "POST";
	re: RegExp;
	auth: Auth;
	h: Handler;
	/** Persist response in idempotency table (default true for POST). */
	store?: boolean;
}

export interface ServerDeps {
	operatorToken: string;
	health: () => HealthResponse;
	shutdown: () => void;
	touch: () => void;
}

const ID = "([A-Za-z0-9_.:-]+)";
const OPERATOR: Principal = { kind: "operator", actor_id: "operator" };

function routes(ctx: Ctx, deps: ServerDeps): Route[] {
	const R = (method: Route["method"], path: string, auth: Auth, h: Handler, store?: boolean): Route => ({ method, re: new RegExp(`^${path.replaceAll(":id", ID)}$`), auth, h, store });
	return [
		R("GET", "/health", "none", () => deps.health()),
		R("POST", "/runs", "operator", ({ p, body }) => createRun(ctx, p, body)),
		R("GET", "/runs", "operator", ({ p }) => listRuns(ctx, p)),
		R("GET", "/runs/:id/reporting", "any", ({ p, params, q }) => readReporting(ctx, p, params[0], q.get("history") === "1")),
		R("POST", "/runs/:id/reporting", "any", ({ p, params, body }) => changeReporting(ctx, p, params[0], body)),
		R("POST", "/runs/:id/attach", "operator", ({ p, params, body }) => attach(ctx, p, params[0], body)),
		R("GET", "/runs/:id/admin", "any", ({ p, params }) => adminPolicy(ctx, p, params[0])),
		R("POST", "/runs/:id/admin", "operator", ({ p, params, body }) => adminPolicy(ctx, p, params[0], body ?? {})),
		R("GET", "/runs/:id/terminal", "any", ({ p, params }) => terminalMode(ctx, p, params[0])),
		R("POST", "/runs/:id/terminal", "any", ({ p, params, body }) => terminalMode(ctx, p, params[0], body ?? {})),
		R("GET", "/runs/:id/tree", "any", ({ p, params, q }) => tree(ctx, p, params[0], q.get("active_only") === "1")),
		R("GET", "/runs/:id/recovery", "operator", ({ params }) => getRecoveryStatus(ctx.db, params[0])),
		R("POST", "/enroll", "none", ({ body }) => enroll(ctx, body)),
		R("POST", "/sessions/heartbeat", "agent", ({ p, body }) => heartbeat(ctx, p, body), false),
		R("POST", "/sessions/usage", "agent", ({ p, body }) => reportUsage(ctx, p, body)),
		R("GET", "/me", "agent", ({ p }) => me(ctx, p)),
		R("POST", "/messages", "agent", ({ p, body }) => sendMessage(ctx, p, body)),
		R("GET", "/inbox", "agent", ({ p, q }) => readInbox(ctx, p, q)),
		R("POST", "/messages/:id/ack", "agent", ({ p, params }) => ackMessage(ctx, p, params[0])),
		R("POST", "/tasks", "agent", ({ p, body }) => delegateTask(ctx, p, body)),
		R("POST", "/tasks/:id/progress", "agent", ({ p, params, body }) => taskProgress(ctx, p, params[0], body)),
		R("POST", "/tasks/:id/complete", "agent", ({ p, params, body }) => completeTask(ctx, p, params[0], body)),
		R("POST", "/expansions", "agent", ({ p, body }) => createExpansion(ctx, p, body)),
		R("POST", "/expansions/:id/decision", "any", ({ p, params, body }) => decide(ctx, p, params[0], body)),
		R("GET", "/proposals", "any", ({ p, q }) => listProposals(ctx, p, q)),
		R("POST", "/agents/:id/reparent", "any", ({ p, scope, params, body }) => reparent(ctx, p, scope, params[0], body)),
		R("POST", "/agents/:id/lifecycle", "any", ({ p, scope, params, body }) => lifecycle(ctx, p, scope, params[0], body)),
		R("GET", "/agents/:id", "any", ({ p, params }) => inspect(ctx, p, params[0])),
		R("POST", "/budgets/:id", "any", ({ p, scope, params, body }) => updateBudget(ctx, p, scope, params[0], body)),
		R("POST", "/agents/:id/model", "any", ({ p, params, body }) => updateModel(ctx, p, params[0], body)),
		R("POST", "/sessions/model", "agent", ({ p, body }) => selectedModel(ctx, p, body)),
		R("GET", "/budgets/:id", "any", ({ p, params }) => budget(ctx, p, params[0])),
		R("POST", "/models", "agent", ({ p, body }) => registerModel(ctx, p, body)),
		R("POST", "/members", "agent", ({ p, body }) => createMember(ctx, p, body)),
		R("GET", "/models", "any", ({ p, q }) => models(ctx, p, q)),
		R("GET", "/events", "any", ({ p, q }) => events(ctx, p, q)),
		R(
			"POST",
			"/controller/shutdown",
			"operator",
			({ scope }) => {
				scope.after(() => {
					setTimeout(deps.shutdown, 20);
				});
				const r: ShutdownResponse = { stopping: true };
				return r;
			},
			false,
		),
	];
}

function canonical(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(canonical);
	if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
	return v;
}
function requestHash(path: string, body: unknown): string {
	return createHash("sha256").update(path).update("\n").update(JSON.stringify(canonical(body ?? null))).digest("hex");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) {
		size += (c as Buffer).length;
		if (size > 1_000_000) fail("INVALID", "body too large");
		chunks.push(c as Buffer);
	}
	if (!size) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		fail("INVALID", "body is not valid JSON");
	}
}

function send(res: ServerResponse, status: number, body: unknown): void {
	const s = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
	res.end(s);
}

export function createApiServer(ctx: Ctx, deps: ServerDeps): Server {
	const table = routes(ctx, deps);
	return createServer((req, res) => {
		handle(ctx, deps, table, req, res).catch((e) => {
			ctx.log("error", "unhandled request error", { err: String(e?.stack ?? e) });
			if (!res.headersSent) send(res, 500, new ApiErr("INTERNAL", "internal error").toBody());
		});
	});
}

async function handle(ctx: Ctx, deps: ServerDeps, table: Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
	const started = Date.now();
	const url = new URL(req.url ?? "/", "http://controller");
	const method = req.method ?? "GET";
	let status = 200;
	let actor: string | null = null;
	try {
		if (req.headers[HDR_PROTOCOL] !== String(PROTOCOL_VERSION)) {
			throw new ApiErr("PROTOCOL_MISMATCH", `${HDR_PROTOCOL} must be ${PROTOCOL_VERSION}`, { server_protocol: PROTOCOL_VERSION });
		}
		let route: Route | undefined;
		let params: string[] = [];
		for (const r of table) {
			const m = r.method === method ? r.re.exec(url.pathname) : null;
			if (m) {
				route = r;
				params = m.slice(1).map(decodeURIComponent);
				break;
			}
		}
		if (!route) fail("NOT_FOUND", `no route ${method} ${url.pathname}`);
		if (route.re.source !== "^/health$") deps.touch();
		const body = method === "POST" ? await readBody(req) : undefined;
		const idemKey = (req.headers[HDR_IDEMPOTENCY] as string | undefined) ?? null;
		if (method === "POST" && !idemKey) fail("INVALID", `${HDR_IDEMPOTENCY} header is required on mutations`);
		const afters: (() => void | Promise<void>)[] = [];
		const scope: ReqScope = { after: (fn) => afters.push(fn), idemKey };
		const r = route;
		const result = tx(ctx.db, () => {
			// Fencing: every route except /health may write (GET /inbox claims deliveries), so all of them
			// require that we still hold the DB lease at our epoch.
			if (r.re.source !== "^/health$") {
				try {
					assertLeaseHeld(ctx);
				} catch (e) {
					ctx.log("error", "fenced: lease held by another controller; shutting down", { holder: (e as ApiErr).details });
					setImmediate(deps.shutdown);
					throw e;
				}
			}
			let p: Principal = OPERATOR;
			if (r.auth !== "none") {
				p = resolvePrincipal(ctx.db, deps.operatorToken, req.headers.authorization);
				if (r.auth === "operator" && p.kind !== "operator") fail("FORBIDDEN", "operator token required");
				if (r.auth === "agent" && p.kind !== "agent") fail("FORBIDDEN", "agent session token required");
			}
			actor = r.auth === "none" ? (method === "POST" && body && typeof (body as Record<string, unknown>).agent_id === "string" ? `enroll:${(body as Record<string, string>).agent_id}` : null) : p.actor_id;
			const store = method === "POST" && r.store !== false;
			const op = `${method} ${url.pathname}`;
			const hash = store ? requestHash(url.pathname, body) : "";
			const idActor = actor ?? "anonymous";
			if (store) {
				const prev = get(ctx.db, "SELECT * FROM idempotency WHERE actor_id = ? AND operation = ? AND idem_key = ?", idActor, op, idemKey);
				if (prev) {
					if (prev.request_hash !== hash) fail("IDEMPOTENCY_MISMATCH", "idempotency key reused with a different request");
					const out = parseJson<Record<string, unknown>>(prev.response_json, {});
					if (prev.reissue_session_id) out.token = reissue(ctx, prev.reissue_session_id);
					return { status: prev.status_code as number, body: out, replay: true };
				}
			}
			const out = r.h({ p, scope, params, body, q: url.searchParams });
			let st = 200;
			let resBody: unknown = out;
			if (out instanceof CommittedError) {
				st = out.err.status;
				resBody = out.err.toBody();
			}
			if (store) {
				let stored = resBody as Record<string, unknown>;
				let reissueSession: string | null = null;
				if (stored && typeof stored === "object" && typeof stored.token === "string") {
					// Never persist bearer secrets: redact and re-mint on replay.
					reissueSession = (stored.session_id as string) ?? null;
					const { token: _t, ...rest } = stored;
					stored = rest;
				}
				run(ctx.db, "INSERT INTO idempotency(actor_id, operation, idem_key, request_hash, response_json, status_code, created_at, reissue_session_id) VALUES (?,?,?,?,?,?,?,?)", idActor, op, idemKey, hash, JSON.stringify(stored), st, nowIso(), reissueSession);
			}
			return { status: st, body: resBody, replay: false };
		});
		status = result.status;
		send(res, status, result.body);
		for (const fn of afters) {
			try {
				await fn();
			} catch (e) {
				ctx.log("warn", "after-commit hook failed", { err: String(e) });
			}
		}
	} catch (e) {
		const err = e instanceof ApiErr ? e : new ApiErr("INTERNAL", "internal error");
		if (!(e instanceof ApiErr)) ctx.log("error", "request failed", { path: url.pathname, err: String((e as Error)?.stack ?? e) });
		status = err.status;
		if (!res.headersSent) send(res, status, err.toBody());
	} finally {
		if (url.pathname !== "/health") ctx.log("debug", "request", { method, path: url.pathname, status, actor_id: actor, duration_ms: Date.now() - started });
	}
}

/** Replay of a token-bearing response: mint a fresh token for the same (still current) session. */
function reissue(ctx: Ctx, sessionId: string): string {
	const s = get(ctx.db, "SELECT s.*, a.run_id, a.current_session_id, a.status AS agent_status FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE s.id = ?", sessionId);
	// Only a still-valid session may get a replacement token: agent not terminal, session is the
	// current attempt and still LIVE/STARTING, and the token it handed out has not been revoked
	// (terminate / process exit / deadline / fencing revoke it).
	if (!s || s.current_session_id !== sessionId) fail("STALE_SESSION", "the session from the original request has been superseded");
	if (isTerminal(s.agent_status)) fail("STALE_SESSION", `agent is ${s.agent_status}`);
	if (!["LIVE", "STARTING"].includes(s.status)) fail("STALE_SESSION", `session is ${s.status}`);
	if (!get(ctx.db, "SELECT 1 FROM auth_tokens WHERE session_id = ? AND revoked_at IS NULL", sessionId)) fail("STALE_SESSION", "session token has been revoked");
	run(ctx.db, "UPDATE auth_tokens SET revoked_at = ?, revoke_reason = 'reissued' WHERE session_id = ? AND revoked_at IS NULL", nowIso(), sessionId);
	return issueSessionToken(ctx.db, { run_id: s.run_id, agent_id: s.agent_id, session_id: sessionId, generation: s.generation });
}
