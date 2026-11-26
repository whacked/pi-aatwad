// Durable cross-team links: reporting_edges rows whose parent is another team's agent
// (parent_run_id set). They never change in-team edges, grants or budgets.
import { all, get, run, emit, newId, nowIso, type DB, type Row } from "./db.ts";
import { scanEvents } from "./history.ts";
import type { Ctx, Principal } from "./context.ts";
import type { ReportingLink, ReportingStatus } from "../shared/protocol.ts";
import { getRun, getAgent, getAllocation, isTerminal, runConfig } from "./queries.ts";
import { setLimits } from "./budgets.ts";
import { fail } from "./errors.ts";
import { obj, str, oneOf, onlyKeys } from "./validate.ts";
import { postMessage } from "./messaging.ts";
import { effectiveAttention, setRunAttention } from "./attention.ts";

export const LINK_COLUMNS = `e.id, e.run_id AS child_run_id, e.child_id AS child_agent_id, e.parent_run_id, e.parent_id AS parent_agent_id,
	e.valid_from AS created_at, e.valid_to AS closed_at, e.close_reason, e.origin, e.terminatable`;

function authorize(db: DB, p: Principal, runId: string): void {
	const root = getRun(db, runId).root_agent_id;
	if (p.kind === "agent" && (p.run_id !== runId || p.actor_id !== root)) fail("FORBIDDEN", "only this team's root or the operator may manage reporting");
}

function liveRoot(db: DB, runId: string): string {
	const r = getRun(db, runId);
	const a = getAgent(db, r.root_agent_id);
	if (isTerminal(r.status) || isTerminal(a.status)) fail("CONFLICT", `team ${runId} is terminal`);
	return a.id;
}

export function reportingStatus(db: DB, runId: string, history = false): ReportingStatus {
	const links = all(db, `SELECT ${LINK_COLUMNS} FROM reporting_edges e
		WHERE e.parent_run_id IS NOT NULL AND (e.run_id = ? OR e.parent_run_id = ?) ${history ? "" : "AND e.valid_to IS NULL"} ORDER BY e.rowid`, runId, runId).map((l) => ({ ...l, terminatable: !!l.terminatable })) as ReportingLink[];
	// Legacy view of the attention policy: does this root's inbox start turns?
	return { run_id: runId, wake_on_message: effectiveAttention(db, getRun(db, runId).root_agent_id).on_message === "wake", links };
}

export function readReporting(ctx: Ctx, p: Principal, runId: string, history = false): ReportingStatus {
	authorize(ctx.db, p, runId);
	return reportingStatus(ctx.db, runId, history);
}

/** Only linked roots can exchange coordination messages; members receive no cross-run authority. */
export function coordinationLink(db: DB, from: string, to: string): Row | undefined {
	return get(db, `SELECT ${LINK_COLUMNS} FROM reporting_edges e
		WHERE e.parent_run_id IS NOT NULL AND e.valid_to IS NULL AND ((e.child_id = ? AND e.parent_id = ?) OR (e.parent_id = ? AND e.child_id = ?))`, from, to, from, to);
}

/** The active link of an agent to an agent in another team, if any. */
export function linkOfChild(db: DB, childAgentId: string): Row | undefined {
	return get(db, `SELECT ${LINK_COLUMNS} FROM reporting_edges e WHERE e.child_id = ? AND e.parent_run_id IS NOT NULL AND e.valid_to IS NULL`, childAgentId);
}

/** The child team's active link to another team, if any. */
function activeLink(db: DB, childRun: string): Row | undefined {
	return get(db, `SELECT ${LINK_COLUMNS} FROM reporting_edges e WHERE e.run_id = ? AND e.parent_run_id IS NOT NULL AND e.valid_to IS NULL`, childRun);
}

function notice(db: DB, link: Row, kind: string, extra: Record<string, unknown> = {}, tracked = false): void {
	const child = link.child_agent_id as string;
	const parent = link.parent_agent_id as string;
	for (const [to, from, runId] of [[child, parent, link.child_run_id], [parent, child, link.parent_run_id]]) {
		if (isTerminal(getAgent(db, to).status)) continue;
		const id = postMessage(db, { run_id: runId, from, to, type: "system.notice", payload: {
			kind, reporting_link_id: link.id, child_run_id: link.child_run_id, parent_run_id: link.parent_run_id,
			...extra,
		} });
		if (tracked) run(db, "INSERT INTO team_reporting_messages(message_id, link_id) VALUES (?,?)", id, link.id);
	}
}

function audit(db: DB, link: Row, actor: string, type: string, extra: Record<string, unknown>): void {
	for (const runId of [link.child_run_id, link.parent_run_id]) emit(db, { run_id: runId, actor_id: actor, type, entity_id: link.id, payload: { child_run_id: link.child_run_id, parent_run_id: link.parent_run_id, ...extra } });
}

export function closeLink(db: DB, link: Row, actor: string, reason: string): void {
	const ts = nowIso();
	run(db, "UPDATE reporting_edges SET valid_to = ?, close_reason = ? WHERE id = ? AND valid_to IS NULL", ts, reason, link.id);
	// History stays intact. Unconsumed coordination requests must not arrive as fresh instructions later.
	const pending = all(db, `SELECT r.message_id FROM team_reporting_messages r
		JOIN messages m ON m.id = r.message_id JOIN deliveries d ON d.message_id = m.id
		WHERE r.link_id = ? AND (d.status <> 'ACKED' OR (m.type = 'question' AND NOT EXISTS (
			SELECT 1 FROM messages answer JOIN team_reporting_messages ar ON ar.message_id = answer.id
			WHERE ar.link_id = r.link_id AND answer.type = 'answer' AND answer.sender_id = m.recipient_id
			AND answer.recipient_id = m.sender_id AND (answer.causation_id = m.id OR answer.correlation_id = m.id
			OR (m.correlation_id IS NOT NULL AND answer.correlation_id = m.correlation_id))
		)))`, link.id).map((m) => m.message_id);
	for (const id of pending) {
		run(db, "UPDATE team_reporting_messages SET withdrawn_at = ? WHERE message_id = ?", ts, id);
		run(db, "UPDATE deliveries SET status = 'ACKED', acked_at = ?, lease_until = NULL WHERE message_id = ?", ts, id);
	}
	notice(db, link, "reporting.disconnected", { reason, withdrawn_message_ids: pending, instruction: "This reporting link has ended. Withdraw unanswered requests on this link; retain already delivered project directions unless the human changes them. Your own project continues independently." });
	audit(db, link, actor, "reporting.disconnected", { reason, withdrawn_message_ids: pending });
}

/** Called by every terminal root transition, including ordinary /team stop. Offline roots keep links. */
export function closeReportingForRun(db: DB, runId: string, actor: string, reason: string): void {
	for (const link of reportingStatus(db, runId).links) closeLink(db, link, actor, reason);
	run(db, "UPDATE team_reporting_settings SET wake_on_message = 0 WHERE run_id = ?", runId);
}

function connect(db: DB, childRun: string, parentRun: string, actor: string, parentAgentId?: string, terminatable = false): void {
	const child = liveRoot(db, childRun);
	liveRoot(db, parentRun);
	if (parentAgentId) {
		const pa = getAgent(db, parentAgentId);
		if (pa.run_id !== parentRun) fail("INVALID", "parent_agent_id is not in parent_run_id");
		if (isTerminal(pa.status)) fail("CONFLICT", `agent ${parentAgentId} is ${pa.status}`);
	}
	let cursor: string | undefined = parentRun;
	const seen = new Set<string>();
	while (cursor) {
		if (cursor === childRun || seen.has(cursor)) fail("CONFLICT", "reporting link would create a cycle");
		seen.add(cursor);
		cursor = activeLink(db, cursor)?.parent_run_id;
	}
	const current = activeLink(db, childRun);
	const parent = parentAgentId ?? getRun(db, parentRun).root_agent_id as string;
	if (current?.parent_agent_id === parent) {
		if (terminatable && !current.terminatable) run(db, "UPDATE reporting_edges SET terminatable = 1 WHERE id = ?", current.id);
		return;
	}
	if (current) fail("CONFLICT", "team is already linked under another agent; detach it first, then join again");
	const link = { id: newId("report"), child_run_id: childRun, child_agent_id: child, parent_run_id: parentRun, parent_agent_id: parent, created_at: nowIso() };
	// A join: dismissing the child only severs this link unless an operator marks it terminatable.
	run(db, `INSERT INTO reporting_edges(id, run_id, parent_id, child_id, valid_from, reason, parent_run_id, origin, terminatable)
		VALUES (?,?,?,?,?,?,?, 'joined', ?)`, link.id, childRun, parent, child, link.created_at, "reporting link", parentRun, terminatable ? 1 : 0);
	const tasks = all(db, "SELECT id AS task_id, title, status FROM tasks WHERE run_id = ? AND status NOT IN ('DONE','FAILED','CANCELLED') ORDER BY created_at LIMIT 30", childRun);
	const members = all(db, "SELECT id AS agent_id, role, status, observed_state FROM agents WHERE run_id = ? AND status NOT IN ('COMPLETED','FAILED','CANCELLED','RETIRED') ORDER BY created_at LIMIT 30", childRun);
	const latest = scanEvents(db, { run_id: childRun, types: ["task.progress", "task.completed"], order: "desc", limit: 5 }).map((e) => ({ type: e.type, payload_json: e.payload_json, created_at: e.created_at }));
	joinGrant(db, childRun, parentRun, child, actor);
	notice(db, link, "reporting.connected", { tasks, members, recent_progress: latest, instruction: `Team leader ${child}: send your reporting parent an initial report using team_send_message: goal, progress, active members, blockers, pending decisions and next action. Continue sending meaningful updates. Receiving leader: maintain consolidated status and follow up with the reporting leader. This link grants coordination only; budgets, recruitment, approvals and team control remain with each team.` }, true);
	audit(db, link, actor, "reporting.connected", {});
}

/** A joined team keeps its budget; the lead's default member budget, if any, is added once. */
function joinGrant(db: DB, childRun: string, parentRun: string, childRoot: string, actor: string): void {
	const grant = runConfig(db, parentRun).member_default_usd;
	if (!grant || grant <= 0 || runConfig(db, childRun).operator_unlimited) return;
	const before = getAllocation(db, childRoot).limits;
	if (before.max_subtree_usd === null) return;
	const after = { ...before, max_subtree_usd: before.max_subtree_usd + grant };
	setLimits(db, childRoot, after);
	emit(db, { run_id: childRun, actor_id: actor, type: "budget.join_grant", entity_id: childRoot, payload: { lead_run_id: parentRun, added_usd: grant, before: before.max_subtree_usd, after: after.max_subtree_usd } });
}

export function changeReporting(ctx: Ctx, p: Principal, runId: string, body: unknown): ReportingStatus {
	const db = ctx.db;
	authorize(db, p, runId);
	const b = obj(body);
	onlyKeys(b, ["action", "parent_run_id", "parent_agent_id", "terminatable", "wake_on_message", "reason"]);
	if (b.terminatable !== undefined && typeof b.terminatable !== "boolean") fail("INVALID", "terminatable must be boolean");
	if (b.terminatable && p.kind !== "operator") fail("FORBIDDEN", "only the human operator may make a link terminatable");
	const action = oneOf(b, "action", ["connect", "disconnect", "dismiss", "transfer", "wake"] as const);
	const reason = str(b, "reason", { optional: true }) ?? action;
	if (b.wake_on_message !== undefined && typeof b.wake_on_message !== "boolean") fail("INVALID", "wake_on_message must be boolean");
	if (action !== "disconnect" && action !== "dismiss") liveRoot(db, runId);
	if (action === "wake") {
		if (b.wake_on_message === undefined) fail("INVALID", "wake requires wake_on_message");
		run(db, "INSERT OR IGNORE INTO team_reporting_settings(run_id) VALUES (?)", runId);
		if (b.wake_on_message !== undefined) run(db, "UPDATE team_reporting_settings SET wake_on_message = ? WHERE run_id = ?", b.wake_on_message, runId);
		// The toggle now writes the team attention default (see /team attention).
		setRunAttention(db, runId, { on_message: b.wake_on_message ? "wake" : "next_turn" });
		emit(db, { run_id: runId, actor_id: p.actor_id, type: `reporting.${action}`, payload: { wake_on_message: b.wake_on_message } });
	} else if (action === "connect") {
		const parentAgent = str(b, "parent_agent_id", { optional: true });
		const parentRun = parentAgent ? getAgent(db, parentAgent).run_id as string : str(b, "parent_run_id");
		if (parentAgent && b.parent_run_id !== undefined && b.parent_run_id !== parentRun) fail("INVALID", "parent_agent_id is not in parent_run_id");
		connect(db, runId, parentRun, p.actor_id, parentAgent, b.terminatable === true);
	}
	else if (action === "disconnect") {
		const link = activeLink(db, runId);
		if (link) closeLink(db, link, p.actor_id, reason);
	} else if (action === "dismiss") {
		for (const link of reportingStatus(db, runId).links) closeLink(db, link, p.actor_id, reason);
	}
	else {
		const destination = str(b, "parent_run_id");
		if (destination === runId) fail("CONFLICT", "destination must be a different team leader");
		liveRoot(db, destination);
		const links = reportingStatus(db, runId).links.filter((l) => l.parent_run_id === runId);
		for (const link of links) {
			// Delivered reports and unanswered questions are copied as reference, never as new directives.
			const messages = all(db, `SELECT m.id, m.sender_id, m.recipient_id, m.type, m.payload_json, m.created_at FROM team_reporting_messages r
				JOIN messages m ON m.id = r.message_id WHERE r.link_id = ? ORDER BY m.rowid DESC LIMIT 30`, link.id);
			closeLink(db, link, p.actor_id, `reports transferred: ${reason}`);
			connect(db, link.child_run_id, destination, p.actor_id);
			const to = getRun(db, destination).root_agent_id;
			const handoffId = postMessage(db, { run_id: destination, from: getRun(db, runId).root_agent_id, to, type: "system.notice", payload: { kind: "reporting.handoff", previous_parent_run_id: runId, child_run_id: link.child_run_id, reference_only: true, recent_messages: messages, instruction: "Reconstruct consolidated status and unresolved questions from this reference history, then confirm current facts with the reporting leader." } });
			const newLink = activeLink(db, link.child_run_id)!;
			run(db, "INSERT INTO team_reporting_messages(message_id, link_id) VALUES (?,?)", handoffId, newLink.id);
		}
		emit(db, { run_id: runId, actor_id: p.actor_id, type: "reporting.transferred", payload: { parent_run_id: destination, teams: links.map((l) => l.child_run_id) } });
	}
	return reportingStatus(db, runId);
}
