// Read-side helpers and the required queries from docs/08 (get_ancestry, get_subtree, ...).
import { type DB, type Row, all, get, parseJson } from "./db.ts";
import { fail } from "./errors.ts";
import type { AgentStatus, Envelope_Limits, RecoveryStatus, RunConfig } from "../shared/protocol.ts";

export const TERMINAL: AgentStatus[] = ["COMPLETED", "FAILED", "CANCELLED", "RETIRED"];
export const TERMINAL_SQL = "('COMPLETED','FAILED','CANCELLED','RETIRED')";
export const isTerminal = (s: string) => (TERMINAL as string[]).includes(s);

export function getRun(db: DB, runId: string): Row {
	const r = get(db, "SELECT * FROM runs WHERE id = ?", runId);
	if (!r) fail("NOT_FOUND", `run ${runId} not found`);
	return r;
}
export function runConfig(db: DB, runId: string): RunConfig {
	return parseJson<RunConfig>(getRun(db, runId).config_json, null as unknown as RunConfig);
}
export function getAgent(db: DB, agentId: string): Row {
	const a = get(db, "SELECT * FROM agents WHERE id = ?", agentId);
	if (!a) fail("NOT_FOUND", `agent ${agentId} not found`);
	return a;
}
export interface AllocationView {
	limits: Envelope_Limits;
	reserved_slots: number;
	/** Active reservations of live descendants. */
	reserved_usd: number;
	/** Spend actually consumed by terminated descendants: stays charged to this subtree. */
	settled_usd: number;
	/** reserved_usd + settled_usd: what max_subtree_usd bounds. */
	committed_usd: number;
	consumed_usd: number;
}
export function getAllocation(db: DB, agentId: string): AllocationView {
	const r = get(db, "SELECT a.*, (SELECT COALESCE(SUM(usd),0) FROM reservations x WHERE x.ancestor_id = a.agent_id AND x.state = 'CONSUMED') AS settled FROM allocations a WHERE a.agent_id = ?", agentId);
	if (!r) fail("NOT_FOUND", `allocation for ${agentId} not found`);
	const settled = Number(r.settled);
	return {
		limits: parseJson<Envelope_Limits>(r.limits_json, null as unknown as Envelope_Limits),
		reserved_slots: r.reserved_slots,
		reserved_usd: r.reserved_usd,
		settled_usd: settled,
		committed_usd: Number(r.reserved_usd) + settled,
		consumed_usd: r.consumed_usd,
	};
}

function edgeFilter(atVersion?: number): { sql: string; params: unknown[] } {
	if (atVersion === undefined) return { sql: "e.valid_to IS NULL", params: [] };
	return { sql: "e.from_version <= ? AND (e.to_version IS NULL OR e.to_version > ?)", params: [atVersion, atVersion] };
}

/** Ancestors nearest-first (parent, grandparent, ..., root). Excludes the agent itself. */
export function getAncestry(db: DB, agentId: string, atVersion?: number): string[] {
	const f = edgeFilter(atVersion);
	const out: string[] = [];
	let cur = agentId;
	for (let i = 0; i < 10_000; i++) {
		const r = get(db, `SELECT e.parent_id FROM reporting_edges e WHERE e.child_id = ? AND ${f.sql}`, cur, ...f.params);
		if (!r) return out;
		if (out.includes(r.parent_id) || r.parent_id === agentId) fail("INTERNAL", "cycle detected in reporting graph");
		out.push(r.parent_id);
		cur = r.parent_id;
	}
	fail("INTERNAL", "ancestry too deep");
}

/** The agent itself followed by all descendants (BFS order). */
export function getSubtree(db: DB, agentId: string, atVersion?: number): string[] {
	const f = edgeFilter(atVersion);
	const out = [agentId];
	for (let i = 0; i < out.length; i++) {
		for (const r of all(db, `SELECT e.child_id FROM reporting_edges e WHERE e.parent_id = ? AND ${f.sql} ORDER BY e.valid_from, e.child_id`, out[i], ...f.params)) {
			if (!out.includes(r.child_id)) out.push(r.child_id);
		}
	}
	return out;
}

export function getChildren(db: DB, agentId: string): string[] {
	return all(db, "SELECT child_id FROM reporting_edges WHERE parent_id = ? AND valid_to IS NULL ORDER BY valid_from, child_id", agentId).map((r) => r.child_id);
}

export function getCurrentManager(db: DB, agentId: string): string | null {
	return get(db, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", agentId)?.parent_id ?? null;
}

export function getReportingHistory(db: DB, agentId: string): { parent_id: string; valid_from: string; valid_to: string | null; from_version: number | null; to_version: number | null; reason: string | null }[] {
	return all(db, "SELECT parent_id, valid_from, valid_to, from_version, to_version, reason FROM reporting_edges WHERE child_id = ? ORDER BY valid_from, rowid", agentId) as never;
}

export function getAgentSessions(db: DB, agentId: string): Row[] {
	return all(db, "SELECT * FROM sessions WHERE agent_id = ? ORDER BY generation, started_at", agentId);
}

/** Is `a` a strict ancestor of `b` (current topology)? */
export function isAncestor(db: DB, a: string, b: string): boolean {
	return getAncestry(db, b).includes(a);
}

export function depthOf(db: DB, agentId: string): number {
	return getAncestry(db, agentId).length;
}

export function getRecoveryStatus(db: DB, runId: string): RecoveryStatus {
	getRun(db, runId);
	const agents = all(
		db,
		`SELECT a.id, a.desired_state, a.observed_state, a.current_session_id, s.pid FROM agents a LEFT JOIN sessions s ON s.id = a.current_session_id
		 WHERE a.run_id = ? AND a.status NOT IN ${TERMINAL_SQL} ORDER BY a.created_at, a.id`,
		runId,
	).map((r) => ({ agent_id: r.id, desired_state: r.desired_state, observed_state: r.observed_state, session_id: r.current_session_id ?? null, pid: r.pid ?? null }));
	const pending_spawn_intents = all(
		db,
		`SELECT i.id, i.agent_id, i.status FROM spawn_intents i JOIN agents a ON a.id = i.agent_id WHERE a.run_id = ? AND i.status IN ('PENDING','LAUNCHING','LAUNCHED') ORDER BY i.created_at`,
		runId,
	).map((r) => ({ id: r.id, agent_id: r.agent_id, status: r.status }));
	const unacked = get(db, "SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE m.run_id = ? AND d.status <> 'ACKED'", runId)!.n;
	return { run_id: runId, agents, pending_spawn_intents, unacked_deliveries: Number(unacked) };
}

export interface Commitments {
	open_tasks: { task_id: string; title: string; status: string }[];
	proposals_requested: { proposal_id: string; status: string }[];
	proposals_to_review: { proposal_id: string; status: string }[];
	unacked_messages: number;
	active_reservations: { ancestor_id: string; slots: number; usd: number }[];
}

export function getOutstandingCommitments(db: DB, agentId: string): Commitments {
	return {
		open_tasks: all(db, "SELECT id AS task_id, title, status FROM tasks WHERE owner_id = ? AND status IN ('OPEN','ASSIGNED','IN_PROGRESS','BLOCKED') ORDER BY created_at", agentId) as never,
		proposals_requested: all(db, "SELECT id AS proposal_id, status FROM proposals WHERE requester_id = ? AND status IN ('PENDING','UNDER_REVIEW','ESCALATED')", agentId) as never,
		proposals_to_review: all(db, "SELECT id AS proposal_id, status FROM proposals WHERE reviewer_id = ? AND status IN ('PENDING','UNDER_REVIEW','ESCALATED')", agentId) as never,
		unacked_messages: Number(get(db, "SELECT COUNT(*) AS n FROM deliveries WHERE recipient_id = ? AND status <> 'ACKED'", agentId)!.n),
		active_reservations: all(db, "SELECT ancestor_id, slots, usd FROM reservations WHERE beneficiary_id = ? AND state = 'ACTIVE'", agentId) as never,
	};
}

/** Managed (non-root) agents that currently have, or are about to have, a live process. */
export function liveWorkerCount(db: DB): number {
	const a = get(
		db,
		`SELECT COUNT(*) AS n FROM agents a JOIN runs r ON r.id = a.run_id
		 WHERE a.id IS NOT r.root_agent_id AND a.status NOT IN ${TERMINAL_SQL} AND a.observed_state IN ('STARTING','LIVE')`,
	)!.n;
	return Number(a);
}
export function pendingSpawnCount(db: DB): number {
	return Number(get(db, "SELECT COUNT(*) AS n FROM spawn_intents WHERE status IN ('PENDING','LAUNCHING','LAUNCHED')")!.n);
}
