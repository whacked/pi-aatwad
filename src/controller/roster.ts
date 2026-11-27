// A lead's roster: every agent ever linked under it (docs/design/unified-team-links.md).
// Recall brings a former child back with its context; rehire fills its position with a fresh one.
import type { Ctx, Principal, ReqScope } from "./context.ts";
import { parseJson, all, emit, run } from "./db.ts";
import { fail } from "./errors.ts";
import { obj, onlyKeys, str } from "./validate.ts";
import { getAgent, getRun, isTerminal } from "./queries.ts";
import { requireAgent } from "./messaging.ts";
import { changeReporting } from "./reporting.ts";
import { resumeWithCascade, teamLifecycleState } from "./team-lifecycle.ts";
import { createMember } from "./members.ts";

export type { RosterEntry } from "../shared/protocol.ts";
import type { RosterEntry } from "../shared/protocol.ts";

function leadFor(p: Principal, body: Record<string, unknown>): string {
	if (p.kind === "operator") return str(body, "lead_id");
	return requireAgent(p).actor_id;
}

function responsibilityOf(rows: { spec_json?: string }[]): string | undefined {
	for (const r of rows) {
		try { const spec = JSON.parse(String(r.spec_json)); if (typeof spec.responsibility === "string") return spec.responsibility; } catch {}
	}
	return undefined;
}

/**
 * Everyone ever linked under a lead. `q` keeps entries whose role, responsibility, task titles or
 * task results mention every word: a closed member keeps its identity and transcript, so a past
 * member who did similar work can be recalled with that experience instead of recruiting afresh.
 */
export function roster(ctx: Ctx, p: Principal, leadId: string, q?: string): { lead_id: string; entries: RosterEntry[] } {
	const db = ctx.db;
	if (p.kind === "agent" && p.actor_id !== leadId) fail("FORBIDDEN", "a roster is visible to its lead and the human operator");
	getAgent(db, leadId);
	const latest = all(db, `SELECT e.* FROM reporting_edges e WHERE e.parent_id = ? AND e.rowid = (
		SELECT MAX(x.rowid) FROM reporting_edges x WHERE x.child_id = e.child_id AND x.parent_id = e.parent_id) ORDER BY e.valid_from, e.rowid`, leadId);
	const entries = latest.map((e): RosterEntry | undefined => {
		const a = getAgent(db, e.child_id);
		const other = !!e.parent_run_id;
		const tasks = all(db, "SELECT title, status, spec_json, result_json FROM tasks WHERE owner_id = ? ORDER BY created_at, rowid", e.child_id);
		const responsibility = responsibilityOf(tasks);
		// Cancelled tasks (e.g. the recruitment task of a closed member) say nothing about its work.
		const recent = [...tasks].reverse().filter((t) => t.status !== "CANCELLED").slice(0, 5).map((t) => {
			const r = parseJson<{ headline?: string; summary?: string }>(t.result_json, {});
			const result = r.headline ?? r.summary;
			return { title: String(t.title), status: String(t.status), ...(result ? { result: String(result).slice(0, 200) } : {}) };
		});
		const haystack = [a.role, responsibility ?? "", ...tasks.flatMap((t) => { const r = parseJson<{ headline?: string; summary?: string; briefing?: string }>(t.result_json, {}); return [t.title, r.headline ?? "", r.summary ?? "", r.briefing ?? ""]; })].join("\n").toLowerCase();
		if (q && !q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => haystack.includes(w))) return undefined;
		return {
			agent_id: a.id, role: a.role, ...(other ? { run_id: a.run_id, team_state: teamLifecycleState(db, a.run_id)?.state ?? "RUNNING" } : {}),
			origin: e.origin, terminatable: !!e.terminatable, active: e.valid_to === null && !isTerminal(a.status), status: a.status,
			...(responsibility ? { responsibility } : {}), missions: { tasks: tasks.length, recent }, since: e.valid_from, ended_at: e.valid_to ?? null, close_reason: e.close_reason ?? null,
		};
	}).filter((x): x is RosterEntry => !!x);
	return { lead_id: leadId, entries };
}

function pick(ctx: Ctx, leadId: string, ref: string): RosterEntry {
	const entries = roster(ctx, { kind: "operator", actor_id: "operator" } as Principal, leadId).entries;
	const byId = entries.find((e) => e.agent_id === ref);
	if (byId) return byId;
	const named = entries.filter((e) => e.role.toLowerCase() === ref.trim().toLowerCase());
	const former = named.filter((e) => !e.active);
	if (former.length === 1) return former[0];
	if (named.length === 1) return named[0];
	fail(named.length ? "CONFLICT" : "NOT_FOUND", named.length ? `several roster entries are named ${ref}; use an agent ID` : `${ref} is not on this roster`);
}

/** Bring a former child back with its context. */
export function recall(ctx: Ctx, p: Principal, scope: ReqScope, body: unknown) {
	const db = ctx.db;
	const b = obj(body);
	onlyKeys(b, ["agent", "lead_id"]);
	const leadId = leadFor(p, b);
	const lead = getAgent(db, leadId);
	if (isTerminal(lead.status)) fail("CONFLICT", `lead ${leadId} is ${lead.status}`);
	const entry = pick(ctx, leadId, str(b, "agent"));
	if (entry.active) fail("CONFLICT", `${entry.role} is already linked under you`);
	if (entry.run_id) {
		// A former linked team: same identity. Resume it if this lead's dismissal stopped it, then link again.
		const state = teamLifecycleState(db, entry.run_id);
		if (state?.state === "REMOVED") fail("CONFLICT", `team ${entry.run_id} was permanently removed; rehire instead`);
		if (isTerminal(getAgent(db, entry.agent_id).status)) fail("CONFLICT", `${entry.role} has ended; rehire instead`);
		const resumed = state?.state === "STOPPED" || state?.state === "CLEANING";
		// A lead may undo its own terminating dismissal; a stop by anyone else is the operator's to undo.
		if (resumed && p.kind !== "operator" && state?.stopped_by_run_id !== lead.run_id) fail("CONFLICT", `team ${entry.run_id} was stopped by the human operator; ask them to resume it`);
		if (resumed) resumeWithCascade(ctx, scope, entry.run_id, p.actor_id);
		const childRoot = getRun(db, entry.run_id).root_agent_id;
		changeReporting(ctx, { kind: "operator", actor_id: p.actor_id } as Principal, entry.run_id, { action: "connect", parent_agent_id: leadId, ...(entry.terminatable ? { terminatable: true } : {}) });
		emit(db, { run_id: lead.run_id, actor_id: p.actor_id, type: "roster.recalled", entity_id: childRoot, payload: { lead_id: leadId, run_id: entry.run_id, resumed } });
		return { recalled: entry.agent_id, run_id: entry.run_id, resumed, same_identity: true };
	}
	// A closed recruit of this team: a new member in the same position that continues the old transcript.
	if (!isTerminal(entry.status)) fail("CONFLICT", `${entry.role} is not closed; nothing to recall`);
	const old = getAgent(db, entry.agent_id);
	const made = createMember(ctx, p.kind === "operator" ? rootPrincipal(ctx, lead.run_id) : p, { name: entry.role, responsibility: entry.responsibility ?? `Resume your previous work as ${entry.role}.` }) as { spawned_agent_ids: string[] };
	const agentId = made.spawned_agent_ids[0];
	if (old.pi_session_path) run(db, "UPDATE agents SET pi_session_path = ? WHERE id = ?", old.pi_session_path, agentId);
	emit(db, { run_id: lead.run_id, actor_id: p.actor_id, type: "roster.recalled", entity_id: agentId, payload: { lead_id: leadId, previous_agent_id: entry.agent_id, transcript: old.pi_session_path ?? null } });
	return { recalled: entry.agent_id, agent_id: agentId, same_identity: false, transcript_restored: !!old.pi_session_path };
}

/** Fill a former child's position with a new agent and a fresh context. */
export function rehire(ctx: Ctx, p: Principal, body: unknown) {
	const db = ctx.db;
	const b = obj(body);
	onlyKeys(b, ["agent", "lead_id"]);
	const leadId = leadFor(p, b);
	const lead = getAgent(db, leadId);
	const entry = pick(ctx, leadId, str(b, "agent"));
	const made = createMember(ctx, p.kind === "operator" ? rootPrincipal(ctx, lead.run_id) : p, {
		name: entry.role,
		responsibility: entry.responsibility ?? `Take over the position of ${entry.role}${entry.run_id ? ` (formerly team ${entry.run_id})` : ""}.`,
	}) as { spawned_agent_ids: string[] };
	emit(db, { run_id: lead.run_id, actor_id: p.actor_id, type: "roster.rehired", entity_id: made.spawned_agent_ids[0], payload: { lead_id: leadId, position_of: entry.agent_id } });
	return { rehired: entry.agent_id, agent_id: made.spawned_agent_ids[0] };
}

/** Recruiting runs as the team's root; the operator acts on its behalf. */
function rootPrincipal(ctx: Ctx, runId: string): Principal {
	const r = getRun(ctx.db, runId);
	const root = getAgent(ctx.db, r.root_agent_id);
	return { kind: "agent", actor_id: root.id, run_id: runId, session_id: root.current_session_id ?? "", generation: 0 } as Principal;
}
