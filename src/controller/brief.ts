// The team brief: what is going on under an agent, and what changed since it last looked, built
// from the database and the event log, with no model involved. Fast and free, it costs the reader
// no context it did not ask for: a lead (or the human) reads it instead of polling members, and
// heartbeats or idle check-ins never need to reach anyone's transcript to keep them informed.
import type { Ctx, Principal } from "./context.ts";
import type { BriefResponse, MemberThread, SummaryView } from "../shared/protocol.ts";
import { type DB, all, get, parseJson, run } from "./db.ts";
import { fail } from "./errors.ts";
import { getAgent, getLinkChildren, getLinkParent, getSubtree, isAncestor, runConfig } from "./queries.ts";
import { headSeq, payloadOf, scanEvents } from "./history.ts";
import { statusDigest } from "./attention.ts";
import { teamLifecycleState } from "./team-lifecycle.ts";
import { latestSummary, listSummaries, summarizeIfDue } from "./summaries.ts";

/** Event kinds worth telling a lead about, and how to say them. Everything else is plumbing. */
const NOTABLE = ["task.completed", "agent.created", "agent.terminated", "agent.restart_exhausted", "spawn.failed", "budget.exhausted", "agent.deadline_exceeded", "run.stopped", "run.resumed", "run.auto_paused", "link.dismissed"] as const;
const MAX_CHANGES = 30;

/** The agent's model and the human looking at its session read separately; neither hides changes from the other. */
type Reader = "agent" | "human";
const SEEN_KEY: Record<Reader, string> = { agent: "brief_seen_seq", human: "brief_seen_seq_human" };
function reader(v: unknown): Reader {
	if (v === undefined || v === null || v === "agent") return "agent";
	if (v === "human") return "human";
	return fail("INVALID", "reader must be agent or human");
}
function seenSeq(db: DB, agentId: string, who: Reader): number | undefined {
	const v = parseJson<Record<string, unknown>>(getAgent(db, agentId).metadata_json, {})[SEEN_KEY[who]];
	return typeof v === "number" ? v : undefined;
}

/** Only the agent itself, an agent above it, or the human operator may read its brief. */
function authorize(db: DB, p: Principal, agentId: string): void {
	getAgent(db, agentId);
	if (p.kind === "operator" || p.actor_id === agentId) return;
	if (isAncestor(db, p.actor_id, agentId) || getLinkParent(db, agentId) === p.actor_id) return;
	fail("FORBIDDEN", "only the agent, its leads or the human operator may read its brief");
}

export function brief(ctx: Ctx, p: Principal, agentId: string, q: URLSearchParams): BriefResponse {
	const db = ctx.db;
	authorize(db, p, agentId);
	const head = headSeq(db);
	const asked = q.get("since_seq");
	const sinceSeq = asked !== null ? Number(asked) || 0 : seenSeq(db, agentId, reader(q.get("reader")));
	const d = statusDigest(db, agentId);

	// Scope: this agent's subtree and the teams linked directly under it.
	const subtree = getSubtree(db, agentId);
	const linked = getLinkChildren(db, agentId);
	const agents = new Set([...subtree, ...linked]);
	const runs = new Set([...agents].map((id) => String(getAgent(db, id).run_id)));
	const tasks = all(db, `SELECT id, title FROM tasks WHERE owner_id IN (${[...agents].map(() => "?").join(",")})`, ...agents);
	const taskTitle = new Map(tasks.map((t) => [String(t.id), String(t.title)]));
	const ownRun = String(getAgent(db, agentId).run_id);
	const role = (id: string | null): string => {
		if (!id) return "controller";
		const a = get(db, "SELECT role, run_id FROM agents WHERE id = ?", id);
		if (!a) return id;
		return a.run_id !== ownRun ? `${a.role} (team ${runConfig(db, String(a.run_id)).name ?? a.run_id})` : String(a.role);
	};

	const changes: BriefResponse["changes"] = [];
	let progress = 0;
	if (sinceSeq !== undefined) {
		for (const runId of runs) {
			for (const e of scanEvents(db, { run_id: runId, after_seq: sinceSeq, types: [...NOTABLE, "task.progress"], limit: 2000 })) {
				const inScope = e.type.startsWith("task.") ? taskTitle.has(e.entity_id ?? "") : e.type.startsWith("run.") ? true : agents.has(e.entity_id ?? "") || agents.has(e.actor_id ?? "");
				if (!inScope) continue;
				if (e.type === "task.progress") { progress++; continue; }
				const pl = payloadOf<Record<string, unknown>>(e);
				const text =
					e.type === "task.completed" ? `${role(e.actor_id)} finished "${taskTitle.get(e.entity_id!)}"${pl.status && pl.status !== "DONE" ? ` (${String(pl.status)})` : ""}${pl.headline || pl.summary ? `: ${String(pl.headline ?? pl.summary).slice(0, 160)}` : ""}${pl.briefing ? " [briefing]" : ""}`
					: e.type === "agent.created" ? `${role(e.entity_id)} joined`
					: e.type === "agent.terminated" ? `${role(e.entity_id)} was closed`
					: e.type === "agent.restart_exhausted" ? `${role(e.entity_id)} kept failing and was not restarted again`
					: e.type === "spawn.failed" ? `${role(e.entity_id)} could not be started`
					: e.type === "budget.exhausted" ? `${role(e.entity_id)} ran out of budget and was paused`
					: e.type === "agent.deadline_exceeded" ? `${role(e.entity_id)} hit its time limit and was paused`
					: e.type === "run.stopped" ? `team ${runId} stopped`
					: e.type === "run.resumed" ? `team ${runId} resumed`
					: e.type === "run.auto_paused" ? `team ${runId} was paused while its leader was away`
					: `a linked team was dismissed`;
				changes.push({ seq: e.seq, at: e.created_at, type: e.type, text });
			}
		}
		changes.sort((a, b) => a.seq - b.seq);
	}

	// Questions and answers wait for the reader; progress and completions are already among the changes.
	const unread = all(db, `SELECT m.id, m.type, m.sender_id, m.payload_json, m.created_at FROM deliveries d JOIN messages m ON m.id = d.message_id
		WHERE d.recipient_id = ? AND d.status <> 'ACKED' ORDER BY m.created_at`, agentId);
	const waiting = unread.filter((m) => m.type === "question" || m.type === "answer").map((m) => {
		const pl = parseJson<{ text?: string; note?: string; summary?: string }>(m.payload_json, {});
		const body = String(pl.text ?? pl.note ?? pl.summary ?? "").replace(/\s+/g, " ");
		return { message_id: String(m.id), type: String(m.type), from: role(m.sender_id), preview: body.slice(0, 140), at: String(m.created_at) };
	});
	const proposals = Number(get(db, "SELECT COUNT(*) AS n FROM proposals WHERE reviewer_id = ? AND status IN ('PENDING','UNDER_REVIEW','ESCALATED')", agentId)!.n);
	const stoppedTeams = linked.map((id) => String(getAgent(db, id).run_id)).filter((r) => ["STOPPED", "CLEANING"].includes(teamLifecycleState(db, r)?.state ?? ""));

	// A summary is made on demand: reading the brief is the signal that someone wants one.
	const runId = String(getAgent(db, agentId).run_id);
	setImmediate(() => void summarizeIfDue(ctx, runId, ctx.summarize));
	const summary = latestSummary(db, runId);
	return {
		agent_id: agentId,
		as_of_seq: head,
		...(summary ? { summary: { summary_id: summary.summary_id, to_seq: summary.to_seq, overview: summary.overview, created_at: summary.created_at, model: summary.model } } : {}),
		since_seq: sinceSeq ?? null,
		members: d.reports.map((r) => ({
			agent_id: r.id, role: r.role, state: r.observed !== "LIVE" ? r.observed.toLowerCase() : r.busy ? "working" : "idle", idle_ms: r.idleFor,
			linked_run_id: linked.includes(r.id) ? String(getAgent(db, r.id).run_id) : undefined,
			tasks: d.tasks.filter((t) => t.owner_id === r.id).map((t) => ({ task_id: t.id, title: t.title, status: t.status, picked_up: t.received })),
		})),
		deeper_open_tasks: d.tasks.filter((t) => !d.reports.some((r) => r.id === t.owner_id)).length,
		needs_you: { messages: waiting, other_unread: unread.length - waiting.length, proposals_to_review: proposals, stopped_linked_teams: stoppedTeams },
		changes: changes.slice(-MAX_CHANGES),
		changes_omitted: Math.max(0, changes.length - MAX_CHANGES),
		progress_reports: progress,
	};
}

/** The reader has seen everything up to seq; the next brief reports changes after it. */
export function markBriefSeen(ctx: Ctx, p: Principal, agentId: string, body: { seq?: unknown; reader?: unknown } = {}): { agent_id: string; seen_seq: number } {
	const seq = body.seq, who = reader(body.reader);
	const db = ctx.db;
	if (p.kind !== "operator" && p.actor_id !== agentId) fail("FORBIDDEN", "only the agent itself or the human operator may mark its brief as read");
	getAgent(db, agentId);
	const s = typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? Math.min(seq, headSeq(db)) : headSeq(db);
	run(db, `UPDATE agents SET metadata_json = json_set(metadata_json, '$.${SEEN_KEY[who]}', ?) WHERE id = ?`, s, agentId);
	return { agent_id: agentId, seen_seq: s };
}

/** Who may read a team's history: its own agents, the lead it is linked under, or the operator. */
function authorizeRun(db: DB, p: Principal, runId: string): void {
	if (p.kind === "operator" || p.run_id === runId) return;
	const root = String(get(db, "SELECT root_agent_id FROM runs WHERE id = ?", runId)?.root_agent_id ?? "");
	if (!root) fail("NOT_FOUND", `team ${runId} not found`);
	if (getLinkParent(db, root) === p.actor_id) return;
	fail("FORBIDDEN", "only the team's agents, the lead it is linked under, or the human operator may read its history");
}

/** GET /runs/:id/summaries?q=&before_seq=&limit= : summarized windows, newest first. */
export function summariesRoute(ctx: Ctx, p: Principal, runId: string, q: URLSearchParams): { summaries: SummaryView[]; head_seq: number } {
	authorizeRun(ctx.db, p, runId);
	setImmediate(() => void summarizeIfDue(ctx, runId, ctx.summarize));
	const before = q.get("before_seq");
	return listSummaries(ctx.db, runId, { q: q.get("q") ?? undefined, before_seq: before !== null ? Number(before) : undefined, limit: Number(q.get("limit") ?? 10) || 10 });
}

/**
 * GET /agents/:id/thread/:member : one member's stream as the agent sees it, oldest first: the
 * messages between them and that member's task events. Pulls one conversation out of the river.
 */
export function threadRoute(ctx: Ctx, p: Principal, agentId: string, memberId: string, q: URLSearchParams): MemberThread {
	const db = ctx.db;
	authorize(db, p, agentId);
	getAgent(db, memberId);
	const below = new Set([...getSubtree(db, agentId), ...getLinkChildren(db, agentId)]);
	if (!below.has(memberId) || memberId === agentId) fail("INVALID", `${memberId} is not below ${agentId}`);
	const limit = Math.min(Math.max(Number(q.get("limit") ?? 30) || 30, 1), 200);
	const before = q.get("before");
	const role = (id: string) => String(get(db, "SELECT role FROM agents WHERE id = ?", id)?.role ?? id);
	const items: MemberThread["items"] = [];
	for (const m of all(db, `SELECT id, sender_id, recipient_id, type, payload_json, created_at FROM messages
		WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))${before ? " AND created_at < ?" : ""} ORDER BY created_at DESC LIMIT ?`,
		agentId, memberId, memberId, agentId, ...(before ? [before] : []), limit)) {
		const pl = parseJson<Record<string, unknown>>(m.payload_json, {});
		let text = String(pl.text ?? (pl.headline ? `${pl.headline}\n${pl.note ?? pl.summary ?? ""}` : pl.note ?? pl.summary ?? pl.title ?? ""));
		// The briefing stays out of the lead's inbox; this on-demand view is where it is read.
		if (m.type === "task.completed" && pl.has_briefing && pl.task_id) {
			const briefing = parseJson<{ briefing?: string }>(get(db, "SELECT result_json FROM tasks WHERE id = ?", pl.task_id)?.result_json, {}).briefing;
			if (briefing) text += `\nBriefing:\n${briefing}`;
		}
		items.push({ at: String(m.created_at), from: role(String(m.sender_id)), kind: String(m.type), text: text.slice(0, 24_000), message_id: String(m.id) });
	}
	const tasks = all(db, "SELECT id, title FROM tasks WHERE owner_id = ?", memberId);
	const title = new Map(tasks.map((t) => [String(t.id), String(t.title)]));
	if (tasks.length) {
		for (const e of scanEvents(db, { types: ["task.progress", "task.completed"], entity_ids: [...title.keys()], order: "desc", limit })) {
			if (before && e.created_at >= before) continue;
			const pl = payloadOf<Record<string, unknown>>(e);
			// Progress and completion also arrive as messages to the lead; keep the event only when no message carries it.
			if (items.some((i) => i.kind === e.type && Math.abs(Date.parse(i.at) - Date.parse(e.created_at)) < 1000)) continue;
			const body = [pl.headline, pl.note ?? pl.summary].filter(Boolean).join("\n") + (pl.briefing ? `\nBriefing:\n${String(pl.briefing)}` : "");
			items.push({ at: e.created_at, from: role(memberId), kind: e.type, text: `${title.get(e.entity_id!)}: ${body}`.slice(0, 24_000) });
		}
	}
	items.sort((a, b) => a.at.localeCompare(b.at));
	const shown = items.slice(-limit);
	return { agent_id: agentId, member_id: memberId, member_role: role(memberId), items: shown, more_before: items.length > shown.length || shown.length === limit ? shown[0]?.at ?? null : null };
}
