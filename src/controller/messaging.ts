// Durable messages + deliveries (at-least-once, lease-based claims) and tasks.
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DB, type Row, all, get, run, newId, nowIso, isoPlus, emit, parseJson } from "./db.ts";
import { fail } from "./errors.ts";
import type { Ctx, Principal } from "./context.ts";
import type { AckResponse, Envelope, MessageType, SendMessageResponse, InboxResponse, DelegateTaskResponse, TaskCompleteResponse, TaskProgressResponse } from "../shared/protocol.ts";
import { assertSchema, obj, str, oneOf, onlyKeys } from "./validate.ts";
import { getAgent, getCurrentManager, getSubtree, isTerminal, runConfig } from "./queries.ts";

export interface PostMessage {
	run_id: string;
	from: string;
	to: string;
	type: MessageType;
	payload: Record<string, unknown>;
	correlation_id?: string | null;
	causation_id?: string | null;
	deadline?: string | null;
	message_id?: string;
}

/** Inserts a message + PENDING delivery. Caller is inside a transaction. */
export function postMessage(db: DB, m: PostMessage): string {
	const id = m.message_id ?? newId("msg");
	run(
		db,
		"INSERT INTO messages(id, run_id, sender_id, recipient_id, type, payload_json, correlation_id, causation_id, deadline, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
		id,
		m.run_id,
		m.from,
		m.to,
		m.type,
		JSON.stringify(m.payload),
		m.correlation_id ?? null,
		m.causation_id ?? null,
		m.deadline ?? null,
		nowIso(),
	);
	run(db, "INSERT INTO deliveries(message_id, recipient_id, status) VALUES (?,?, 'PENDING')", id, m.to);
	return id;
}

export function requireAgent(p: Principal): Extract<Principal, { kind: "agent" }> {
	if (p.kind !== "agent") fail("FORBIDDEN", "this operation requires an agent session token");
	return p;
}

export function sendMessage(ctx: Ctx, p: Principal, body: unknown): SendMessageResponse {
	const a = requireAgent(p);
	const b = obj(body);
	// Server-assigned fields win; `from`/`run_id`/`version`/`message_id` from the body are ignored (actor comes from the token).
	const { from: _f, run_id: _r, version: _v, message_id: _m, ...rest } = b;
	const env: Record<string, unknown> = { ...rest, version: 1, message_id: newId("msg"), run_id: a.run_id, from: a.actor_id };
	assertSchema("envelope", env);
	const to = getAgent(ctx.db, env.to as string);
	if (to.run_id !== a.run_id) fail("FORBIDDEN", "recipient is in a different run");
	const allowed = to.id === a.actor_id || getCurrentManager(ctx.db, a.actor_id) === to.id || getSubtree(ctx.db, a.actor_id).includes(to.id);
	if (!allowed) fail("FORBIDDEN", "recipient must be your manager or within your subtree");
	const id = postMessage(ctx.db, {
		run_id: a.run_id,
		from: a.actor_id,
		to: to.id,
		type: env.type as MessageType,
		payload: env.payload as Record<string, unknown>,
		correlation_id: env.correlation_id as string | undefined,
		causation_id: env.causation_id as string | undefined,
		deadline: env.deadline as string | undefined,
		message_id: env.message_id as string,
	});
	emit(ctx.db, { run_id: a.run_id, actor_id: a.actor_id, type: "message.sent", entity_id: id, payload: { to: to.id, type: env.type } });
	return { message_id: id };
}

function toEnvelope(r: Row): Envelope {
	const e: Envelope = { version: 1, message_id: r.id, run_id: r.run_id, type: r.type, from: r.sender_id, to: r.recipient_id, payload: parseJson(r.payload_json, {}) };
	if (r.correlation_id) e.correlation_id = r.correlation_id;
	if (r.causation_id) e.causation_id = r.causation_id;
	if (r.deadline) e.deadline = r.deadline;
	return e;
}

export function releaseExpiredClaims(db: DB, recipient?: string): number {
	if (recipient) return run(db, "UPDATE deliveries SET status = 'PENDING', lease_until = NULL WHERE recipient_id = ? AND status = 'CLAIMED' AND lease_until < ?", recipient, nowIso());
	return run(db, "UPDATE deliveries SET status = 'PENDING', lease_until = NULL WHERE status = 'CLAIMED' AND lease_until < ?", nowIso());
}

export function readInbox(ctx: Ctx, p: Principal, query: URLSearchParams): InboxResponse {
	const a = requireAgent(p);
	const limit = Math.min(Math.max(Number(query.get("limit") ?? 20) || 20, 1), 200);
	releaseExpiredClaims(ctx.db, a.actor_id);
	const rows = all(
		ctx.db,
		`SELECT m.* FROM deliveries d JOIN messages m ON m.id = d.message_id
		 WHERE d.recipient_id = ? AND d.status = 'PENDING' ORDER BY m.rowid LIMIT ?`,
		a.actor_id,
		limit,
	);
	const lease = isoPlus(ctx.t.claimMs);
	const ts = nowIso();
	for (const r of rows) run(ctx.db, "UPDATE deliveries SET status = 'CLAIMED', lease_until = ?, claimed_at = ?, attempts = attempts + 1 WHERE message_id = ? AND recipient_id = ?", lease, ts, r.id, a.actor_id);
	return { messages: rows.map(toEnvelope) };
}

export function ackMessage(ctx: Ctx, p: Principal, messageId: string): AckResponse {
	const a = requireAgent(p);
	const d = get(ctx.db, "SELECT * FROM deliveries WHERE message_id = ? AND recipient_id = ?", messageId, a.actor_id);
	if (!d) fail("NOT_FOUND", "no delivery of that message to you");
	if (d.status !== "ACKED") {
		run(ctx.db, "UPDATE deliveries SET status = 'ACKED', acked_at = ?, lease_until = NULL WHERE message_id = ? AND recipient_id = ?", nowIso(), messageId, a.actor_id);
		madeProgress(ctx.db, a.actor_id);
	}
	return { acked: true };
}

/** Restart budget counts relaunches WITHOUT progress (one-shot workers legitimately relaunch often). */
export function madeProgress(db: DB, agentId: string): void {
	run(db, "UPDATE agents SET restart_attempts = 0 WHERE id = ? AND restart_attempts <> 0", agentId);
}

export function inboxPending(db: DB, agentId: string): number {
	return Number(get(db, "SELECT COUNT(*) AS n FROM deliveries WHERE recipient_id = ? AND status <> 'ACKED'", agentId)!.n);
}

// ---- tasks ------------------------------------------------------------------

export function createTask(db: DB, t: { run_id: string; owner_id: string; title: string; spec: Record<string, unknown>; parent_task_id: string | null; assigned_by: string | null; status?: string }): string {
	const id = newId("task");
	const ts = nowIso();
	run(db, "INSERT INTO tasks(id, run_id, parent_task_id, owner_id, title, spec_json, status, assigned_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", id, t.run_id, t.parent_task_id, t.owner_id, t.title, JSON.stringify(t.spec), t.status ?? "ASSIGNED", t.assigned_by, ts, ts);
	return id;
}

export function delegateTask(ctx: Ctx, p: Principal, body: unknown): DelegateTaskResponse {
	const a = requireAgent(p);
	const b = obj(body);
	onlyKeys(b, ["owner_id", "title", "spec", "parent_task_id"]);
	const ownerId = str(b, "owner_id");
	const title = str(b, "title");
	const parentTaskId = str(b, "parent_task_id", { optional: true }) ?? null;
	if (b.spec !== undefined && (typeof b.spec !== "object" || b.spec === null || Array.isArray(b.spec))) fail("INVALID", "spec must be an object");
	const owner = getAgent(ctx.db, ownerId);
	if (owner.run_id !== a.run_id) fail("FORBIDDEN", "owner is in a different run");
	if (isTerminal(owner.status)) fail("CONFLICT", `owner is ${owner.status}`);
	if (ownerId !== a.actor_id && getCurrentManager(ctx.db, ownerId) !== a.actor_id) fail("FORBIDDEN", "tasks can only be delegated to your direct reports (or yourself)");
	if (parentTaskId) {
		const pt = get(ctx.db, "SELECT * FROM tasks WHERE id = ?", parentTaskId);
		if (!pt || pt.run_id !== a.run_id) fail("NOT_FOUND", "parent task not found");
		if (pt.owner_id !== a.actor_id) fail("FORBIDDEN", "parent task must be owned by you");
	}
	const taskId = createTask(ctx.db, { run_id: a.run_id, owner_id: ownerId, title, spec: (b.spec as Record<string, unknown>) ?? {}, parent_task_id: parentTaskId, assigned_by: a.actor_id });
	const messageId = postMessage(ctx.db, { run_id: a.run_id, from: a.actor_id, to: ownerId, type: "task.assigned", payload: { task_id: taskId, title, spec: b.spec ?? {}, parent_task_id: parentTaskId }, correlation_id: taskId });
	emit(ctx.db, { run_id: a.run_id, actor_id: a.actor_id, type: "task.assigned", entity_id: taskId, payload: { owner_id: ownerId, title, parent_task_id: parentTaskId } });
	return { task_id: taskId, message_id: messageId };
}

function ownTask(db: DB, a: { actor_id: string; run_id: string }, taskId: string): Row {
	const t = get(db, "SELECT * FROM tasks WHERE id = ?", taskId);
	if (!t || t.run_id !== a.run_id) fail("NOT_FOUND", "task not found");
	if (t.owner_id !== a.actor_id) fail("FORBIDDEN", "only the task owner may update it");
	return t;
}

export function taskProgress(ctx: Ctx, p: Principal, taskId: string, body: unknown): TaskProgressResponse {
	const a = requireAgent(p);
	const b = obj(body);
	onlyKeys(b, ["note"]);
	const note = str(b, "note");
	const t = ownTask(ctx.db, a, taskId);
	if (["DONE", "FAILED", "CANCELLED"].includes(t.status)) fail("CONFLICT", `task is ${t.status}`);
	run(ctx.db, "UPDATE tasks SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ?", nowIso(), taskId);
	madeProgress(ctx.db, a.actor_id);
	const mgr = getCurrentManager(ctx.db, a.actor_id);
	const messageId = mgr ? postMessage(ctx.db, { run_id: a.run_id, from: a.actor_id, to: mgr, type: "task.progress", payload: { task_id: taskId, note }, correlation_id: taskId }) : null;
	emit(ctx.db, { run_id: a.run_id, actor_id: a.actor_id, type: "task.progress", entity_id: taskId, payload: { note } });
	return { task_id: taskId, status: "IN_PROGRESS", message_id: messageId };
}

/** Artifact URIs: non-file schemes pass; file paths must resolve inside the run's workspace_root. */
export function checkArtifactUri(workspaceRoot: string, uri: string): string {
	let p: string;
	if (/^file:/i.test(uri)) p = fileURLToPath(uri);
	else if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) return uri;
	else p = uri;
	const abs = isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p);
	const rel = relative(workspaceRoot, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) fail("FORBIDDEN", `artifact path escapes workspace root: ${uri}`);
	return abs;
}

export function completeTask(ctx: Ctx, p: Principal, taskId: string, body: unknown): TaskCompleteResponse {
	const a = requireAgent(p);
	const b = obj(body);
	onlyKeys(b, ["summary", "artifacts", "status"]);
	const summary = str(b, "summary");
	const status = oneOf(b, "status", ["DONE", "FAILED", "BLOCKED"] as const, { optional: true }) ?? "DONE";
	const t = ownTask(ctx.db, a, taskId);
	if (["DONE", "FAILED", "CANCELLED"].includes(t.status)) fail("CONFLICT", `task is already ${t.status}`);
	const arts = b.artifacts ?? [];
	if (!Array.isArray(arts)) fail("INVALID", "artifacts must be an array");
	const ws = runConfig(ctx.db, a.run_id).workspace_root;
	const artifactIds: string[] = [];
	for (const x of arts) {
		const o = obj(x);
		onlyKeys(o, ["kind", "uri", "sha256"]);
		const kind = str(o, "kind");
		const uri = str(o, "uri");
		const sha = str(o, "sha256", { optional: true }) ?? null;
		checkArtifactUri(ws, uri);
		const id = newId("art");
		run(ctx.db, "INSERT INTO artifacts(id, task_id, agent_id, kind, uri, sha256, created_at) VALUES (?,?,?,?,?,?,?)", id, taskId, a.actor_id, kind, uri, sha, nowIso());
		artifactIds.push(id);
	}
	madeProgress(ctx.db, a.actor_id);
	run(ctx.db, "UPDATE tasks SET status = ?, result_json = ?, updated_at = ? WHERE id = ?", status, JSON.stringify({ summary, artifact_ids: artifactIds }), nowIso(), taskId);
	const mgr = getCurrentManager(ctx.db, a.actor_id) ?? t.assigned_by;
	const messageId =
		mgr && mgr !== a.actor_id ? postMessage(ctx.db, { run_id: a.run_id, from: a.actor_id, to: mgr, type: "task.completed", payload: { task_id: taskId, status, summary, artifact_ids: artifactIds }, correlation_id: taskId }) : null;
	emit(ctx.db, { run_id: a.run_id, actor_id: a.actor_id, type: "task.completed", entity_id: taskId, payload: { status, summary, artifact_ids: artifactIds } });
	return { task_id: taskId, status, message_id: messageId, artifact_ids: artifactIds };
}

