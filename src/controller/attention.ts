// Attention: when an idle agent's model should get a turn without a human prompt.
// Liveness heartbeats never reach a model; this module only answers "wake now, and why".
// Decisions live in the controller so every harness (Pi, Claude Code) follows one policy.
import { all, get, run, emit, parseJson, type DB } from "./db.ts";
import type { Ctx, Principal } from "./context.ts";
import { DEFAULT_ATTENTION, type AttentionPolicy, type AttentionView, type Handoff, type Wake } from "../shared/protocol.ts";
import { getAgent, getDirectSubs, getLinkChildren, getRun, getSubtree, isAncestor, isTerminal, runConfig } from "./queries.ts";
import { fail } from "./errors.ts";
import { obj, onlyKeys } from "./validate.ts";

const KEYS = ["on_message", "batch_seconds", "stall_seconds", "tick_seconds", "checkin_seconds", "max_wakes_per_hour"] as const;
const OPEN_TASKS = "('ASSIGNED','IN_PROGRESS','BLOCKED')";

// ---- in-memory activity (resets with the controller; conservative after restart) ----------------
interface Activity { busy: boolean; since: number }
interface WakeState { wakes: number[]; stallSig?: string; tickAt?: number; tickSig?: string; checkinAt?: number }
interface Tracker { startedAt: number; activity: Map<string, Activity>; wakes: Map<string, WakeState> }
const trackers = new WeakMap<DB, Tracker>();
function tracker(db: DB): Tracker {
	let t = trackers.get(db);
	if (!t) trackers.set(db, (t = { startedAt: Date.now(), activity: new Map(), wakes: new Map() }));
	return t;
}

/** Record the busy flag a heartbeat reported; `since` changes only on transitions. */
export function noteActivity(db: DB, agentId: string, busy: boolean, now = Date.now()): void {
	const a = tracker(db).activity;
	const prev = a.get(agentId);
	if (!prev || prev.busy !== busy) a.set(agentId, { busy, since: now });
}
export function activity(db: DB, agentId: string): Activity | undefined {
	return tracker(db).activity.get(agentId);
}

// ---- policy ------------------------------------------------------------------------------------
function validate(body: unknown): Partial<AttentionPolicy> {
	const b = obj(body);
	onlyKeys(b, [...KEYS]);
	const out: Partial<AttentionPolicy> = {};
	if (b.on_message !== undefined) {
		if (b.on_message !== "wake" && b.on_message !== "next_turn") fail("INVALID", "on_message must be wake or next_turn");
		out.on_message = b.on_message;
	}
	for (const k of ["batch_seconds", "stall_seconds", "tick_seconds", "checkin_seconds", "max_wakes_per_hour"] as const) {
		if (b[k] === undefined) continue;
		const v = b[k];
		if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 7 * 86_400) fail("INVALID", `${k} must be a non-negative integer`);
		out[k] = v as number;
	}
	return out;
}

function clean(p: Partial<AttentionPolicy> | undefined): Partial<AttentionPolicy> {
	const out: Partial<AttentionPolicy> = {};
	for (const k of KEYS) if (p?.[k] !== undefined && p[k] !== null) (out as Record<string, unknown>)[k] = p[k];
	return out;
}

export function runAttention(db: DB, runId: string): Partial<AttentionPolicy> {
	return clean(runConfig(db, runId)?.attention);
}
export function agentAttention(db: DB, agentId: string): Partial<AttentionPolicy> {
	return clean(parseJson<{ attention?: Partial<AttentionPolicy> }>(getAgent(db, agentId).metadata_json, {}).attention);
}
export function effectiveAttention(db: DB, agentId: string): AttentionPolicy {
	const a = getAgent(db, agentId);
	return { ...DEFAULT_ATTENTION, ...runAttention(db, a.run_id), ...agentAttention(db, agentId) };
}

/** Writes a partial run default. `null` values clear a field. Used by /team attention and legacy reporting wake. */
export function setRunAttention(db: DB, runId: string, patch: Partial<Record<keyof AttentionPolicy, unknown>>): void {
	const r = getRun(db, runId);
	const cfg = parseJson<Record<string, unknown>>(r.config_json, {});
	const next = { ...(cfg.attention as Record<string, unknown> | undefined) };
	for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k]; else next[k] = v;
	cfg.attention = next;
	run(db, "UPDATE runs SET config_json = ? WHERE id = ?", JSON.stringify(cfg), runId);
}

function authorizeRun(db: DB, p: Principal, runId: string): void {
	if (p.kind === "operator") return;
	if (p.run_id !== runId || getRun(db, runId).root_agent_id !== p.actor_id) fail("FORBIDDEN", "only this team's root or the operator may change team attention defaults");
}
function authorizeAgent(db: DB, p: Principal, agentId: string): void {
	const a = getAgent(db, agentId);
	if (p.kind === "operator") return;
	if (p.run_id !== a.run_id || (p.actor_id !== agentId && !isAncestor(db, p.actor_id, agentId))) fail("FORBIDDEN", "attention is managed by the agent itself, its managers, or the operator");
}

/** GET|POST /runs/:id/attention */
export function runAttentionRoute(ctx: Ctx, p: Principal, runId: string, body?: unknown): AttentionView {
	const db = ctx.db;
	if (body !== undefined) {
		authorizeRun(db, p, runId);
		const raw = obj(body);
		const reset = raw.reset === true;
		const { reset: _r, ...rest } = raw;
		const patch = validate(rest);
		if (reset) setRunAttention(db, runId, Object.fromEntries(KEYS.map((k) => [k, null])));
		setRunAttention(db, runId, patch);
		emit(db, { run_id: runId, actor_id: p.actor_id, type: "attention.run_changed", entity_id: runId, payload: { ...patch, reset } });
	} else if (p.kind === "agent" && p.run_id !== runId) fail("FORBIDDEN", "different run");
	const configured = runAttention(db, runId);
	return { run_id: runId, configured, effective: { ...DEFAULT_ATTENTION, ...configured } };
}

/** GET|POST /agents/:id/attention */
export function agentAttentionRoute(ctx: Ctx, p: Principal, agentId: string, body?: unknown): AttentionView {
	const db = ctx.db;
	authorizeAgent(db, p, agentId);
	const a = getAgent(db, agentId);
	if (body !== undefined) {
		const raw = obj(body);
		const reset = raw.reset === true;
		const { reset: _r, ...rest } = raw;
		const patch = validate(rest);
		const meta = parseJson<Record<string, unknown>>(a.metadata_json, {});
		meta.attention = { ...(reset ? {} : clean(meta.attention as Partial<AttentionPolicy>)), ...patch };
		run(db, "UPDATE agents SET metadata_json = ? WHERE id = ?", JSON.stringify(meta), agentId);
		emit(db, { run_id: a.run_id, actor_id: p.actor_id, type: "attention.agent_changed", entity_id: agentId, payload: { ...patch, reset } });
	}
	return { run_id: a.run_id, agent_id: agentId, configured: agentAttention(db, agentId), effective: effectiveAttention(db, agentId) };
}

// ---- handoff ack ---------------------------------------------------------------------------------
export function handoff(db: DB, ownerId: string): Handoff {
	const o = getAgent(db, ownerId);
	const live = o.observed_state === "LIVE";
	const act = activity(db, ownerId);
	return { owner_id: ownerId, owner_live: live, owner_busy: live && act ? act.busy : null, desired_state: o.desired_state };
}

// ---- wake decision ----------------------------------------------------------------------------------
function fmtAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
}

interface ReportState { id: string; role: string; status: string; observed: string; idleFor: number | null; busy: boolean }

function reportStates(db: DB, agentId: string, now: number): ReportState[] {
	const t = tracker(db);
	// Direct reports, including leads of teams linked under this agent.
	return getDirectSubs(db, agentId).map((id) => getAgent(db, id)).filter((c) => !isTerminal(c.status)).map((c) => {
		const act = t.activity.get(c.id);
		const live = c.observed_state === "LIVE";
		const busy = live && !!act?.busy;
		const idleSince = busy ? null : act && !act.busy ? act.since : t.startedAt;
		return { id: c.id, role: c.role, status: c.status, observed: c.observed_state, idleFor: idleSince === null ? null : now - idleSince, busy };
	});
}

function openTasks(db: DB, agentId: string): { id: string; owner_id: string; title: string; status: string; received: boolean }[] {
	// This team's subtree, plus the agents linked directly under it (their tasks from this lead live here).
	const subtree = [...getSubtree(db, agentId).filter((id) => id !== agentId), ...getLinkChildren(db, agentId)];
	if (!subtree.length) return [];
	const marks = subtree.map(() => "?").join(",");
	return all(db, `SELECT t.id, t.owner_id, t.title, t.status,
		EXISTS (SELECT 1 FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE m.correlation_id = t.id AND m.type = 'task.assigned' AND d.status = 'ACKED') AS received
		FROM tasks t WHERE t.owner_id IN (${marks}) AND t.status IN ${OPEN_TASKS} ORDER BY t.rowid`, ...subtree)
		.map((r) => ({ id: r.id, owner_id: r.owner_id, title: r.title, status: r.status, received: !!r.received }));
}

/** Human-readable team status for a manager; also the signature used to suppress unchanged wakes. */
export function statusDigest(db: DB, agentId: string, now = Date.now()): { text: string; sig: string; reports: ReportState[]; tasks: ReturnType<typeof openTasks> } {
	const reports = reportStates(db, agentId, now);
	const tasks = openTasks(db, agentId);
	const pending = Number(get(db, "SELECT COUNT(*) AS n FROM deliveries WHERE recipient_id = ? AND status <> 'ACKED'", agentId)!.n);
	const lines = reports.map((r) => {
		const mine = tasks.filter((t) => t.owner_id === r.id);
		const state = r.observed !== "LIVE" ? r.observed.toLowerCase() : r.busy ? "working" : `idle ${fmtAge(r.idleFor ?? 0)}`;
		const work = mine.length ? mine.map((t) => `"${t.title}" ${t.status}${t.received ? "" : " (not yet picked up)"}`).join("; ") : "no open tasks";
		return `- ${r.role} [${r.id}]: ${state}, ${r.status}; ${work}`;
	});
	const deeper = tasks.filter((t) => !reports.some((r) => r.id === t.owner_id)).length;
	const text = [
		...lines,
		...(deeper ? [`- ${deeper} open task(s) further down the tree`] : []),
		...(pending ? [`Unread messages for you: ${pending}`] : []),
	].join("\n");
	// The signature ignores idle durations so an unchanged stalled team does not wake repeatedly.
	const sig = JSON.stringify([reports.map((r) => [r.id, r.status, r.observed, r.busy]), tasks.map((t) => [t.id, t.status, t.received]), pending]);
	return { text, sig, reports, tasks };
}

/**
 * Called from the heartbeat. Returns a wake only for an idle, RUNNING agent, within the hourly cap,
 * and only when something changed: no status change means no message to the model.
 */
export function decideWake(db: DB, agentId: string, busy: boolean, now = Date.now()): Wake | undefined {
	const a = getAgent(db, agentId);
	if (busy || a.desired_state !== "RUNNING" || isTerminal(a.status)) return undefined;
	const policy = effectiveAttention(db, agentId);
	const t = tracker(db);
	const st = t.wakes.get(agentId) ?? { wakes: [] };
	t.wakes.set(agentId, st);
	st.wakes = st.wakes.filter((w) => now - w < 3_600_000);
	if (st.wakes.length >= policy.max_wakes_per_hour) return undefined;
	const fire = (w: Wake): Wake => { st.wakes.push(now); return w; };

	if (policy.on_message === "wake") {
		// Progress reports alone never wake an idle agent: they ride along with the next turn and are
		// counted in the team brief. Questions, answers, completions and notices still wake it.
		const oldest = get(db, `SELECT MIN(m.created_at) AS at FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.recipient_id = ? AND d.status = 'PENDING' AND m.type <> 'task.progress'`, agentId)?.at as string | null | undefined;
		if (oldest && now - Date.parse(oldest) >= policy.batch_seconds * 1000) return fire({ reason: "message" });
	}
	const needsDigest = policy.stall_seconds > 0 || policy.tick_seconds > 0 || policy.checkin_seconds > 0;
	if (!needsDigest) return undefined;
	const d = statusDigest(db, agentId, now);
	if (policy.stall_seconds > 0 && d.reports.length && d.tasks.length) {
		const stalled = d.reports.every((r) => !r.busy && (r.idleFor ?? 0) >= policy.stall_seconds * 1000);
		if (stalled && st.stallSig !== d.sig) {
			st.stallSig = d.sig;
			return fire({ reason: "stall", text: `Your team has been idle for at least ${fmtAge(policy.stall_seconds * 1000)} with open work. Decide the next step: reassign, unblock, message a member, or report to the human. team_brief shows what changed without asking anyone. If nothing is needed, say so briefly and stop.\n${d.text}` });
		}
		if (!stalled) st.stallSig = undefined;
	}
	if (policy.checkin_seconds > 0 && d.reports.length) {
		// Fixed schedule, independent of change: the first check-in comes one interval after it starts.
		if (st.checkinAt === undefined) st.checkinAt = now;
		else if (now - st.checkinAt >= policy.checkin_seconds * 1000) {
			st.checkinAt = now;
			return fire({ reason: "checkin", text: `Scheduled check-in (every ${fmtAge(policy.checkin_seconds * 1000)}). Follow your standing check-in instructions from the human; if you have none, ask your direct reports for a brief status, keep your records current, and report anything that needs the human.\n${d.text}` });
		}
	}
	if (policy.tick_seconds > 0 && d.reports.length) {
		if (st.tickAt === undefined) st.tickAt = now;
		else if (now - st.tickAt >= policy.tick_seconds * 1000) {
			st.tickAt = now;
			if (st.tickSig !== d.sig) {
				st.tickSig = d.sig;
				return fire({ reason: "tick", text: `Scheduled team check-in (team status changed since the last one). Act only if something needs you; otherwise reply briefly and stop.\n${d.text}` });
			}
		}
	}
	return undefined;
}
