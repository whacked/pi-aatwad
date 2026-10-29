// Reservations and allocation projections.
// Model: every non-root agent b holds one ACTIVE reservation row at EACH of its current ancestors
// (slots = 1, usd = b's own budget). An ancestor's allocation.reserved_* is the sum of ACTIVE rows
// where it is the ancestor; its envelope (max_subtree_slots/usd) bounds that sum.
import { type DB, all, get, run, newId, nowIso, emit } from "./db.ts";
import { fail } from "./errors.ts";
import { getAllocation, getAncestry, getSubtree, TERMINAL_SQL } from "./queries.ts";
import type { BudgetView, Envelope_Limits } from "../shared/protocol.ts";

const EPS = 1e-9;

export function reserveAtAncestors(db: DB, runId: string, beneficiary: string, ancestors: string[], slots: number, usd: number, proposalId: string | null): void {
	const ts = nowIso();
	for (const a of ancestors) {
		run(db, "INSERT INTO reservations(id, run_id, beneficiary_id, ancestor_id, slots, usd, state, proposal_id, created_at) VALUES (?,?,?,?,?,?, 'ACTIVE', ?, ?)", newId("rsv"), runId, beneficiary, a, slots, usd, proposalId, ts);
	}
}

export function releaseReservations(db: DB, beneficiary: string): void {
	run(db, "UPDATE reservations SET state = 'RELEASED', released_at = ? WHERE beneficiary_id = ? AND state = 'ACTIVE'", nowIso(), beneficiary);
}

/** After topology changes: re-point reservations of `beneficiaries` to their current ancestor chains. Returns ancestors whose load increased. */
export function rebuildReservations(db: DB, beneficiaries: string[]): Set<string> {
	const increased = new Set<string>();
	const ts = nowIso();
	for (const b of beneficiaries) {
		const rows = all(db, "SELECT * FROM reservations WHERE beneficiary_id = ? AND state = 'ACTIVE'", b);
		if (!rows.length) continue;
		const { run_id, slots, usd, proposal_id } = rows[0];
		const chain = getAncestry(db, b);
		for (const r of rows) if (!chain.includes(r.ancestor_id)) run(db, "UPDATE reservations SET state = 'MOVED', released_at = ? WHERE id = ?", ts, r.id);
		const have = new Set(rows.map((r) => r.ancestor_id));
		const add = chain.filter((a) => !have.has(a));
		reserveAtAncestors(db, run_id, b, add, slots, usd, proposal_id);
		for (const a of add) increased.add(a);
	}
	return increased;
}

export function recomputeAllocations(db: DB, runId: string): void {
	run(
		db,
		`UPDATE allocations SET
		   reserved_slots = COALESCE((SELECT SUM(slots) FROM reservations r WHERE r.ancestor_id = allocations.agent_id AND r.state = 'ACTIVE'), 0),
		   reserved_usd   = COALESCE((SELECT SUM(usd)   FROM reservations r WHERE r.ancestor_id = allocations.agent_id AND r.state = 'ACTIVE'), 0)
		 WHERE agent_id IN (SELECT id FROM agents WHERE run_id = ?)`,
		runId,
	);
}

export function assertWithinEnvelopes(db: DB, agents: Iterable<string>, hint?: string): void {
	for (const a of agents) {
		const al = getAllocation(db, a);
		if (al.reserved_slots > al.limits.max_subtree_slots || al.reserved_usd > al.limits.max_subtree_usd + EPS) {
			fail("BUDGET_EXCEEDED", `subtree envelope of ${a} would be exceeded`, { agent_id: a, reserved_slots: al.reserved_slots, max_subtree_slots: al.limits.max_subtree_slots, reserved_usd: al.reserved_usd, max_subtree_usd: al.limits.max_subtree_usd, hint });
		}
	}
}

export function setLimits(db: DB, agentId: string, limits: Envelope_Limits): void {
	run(db, "UPDATE allocations SET limits_json = ? WHERE agent_id = ?", JSON.stringify(limits), agentId);
}

/** Raise an agent's subtree ceilings just enough to absorb an approved grant (used for agents below the approving reviewer). */
export function raiseEnvelopeFor(db: DB, runId: string, actor: string, agentId: string, addSlots: number, addUsd: number, proposalId: string): void {
	const al = getAllocation(db, agentId);
	const needSlots = al.reserved_slots + addSlots;
	const needUsd = al.reserved_usd + addUsd;
	const lim = { ...al.limits };
	let changed = false;
	if (needSlots > lim.max_subtree_slots) {
		lim.max_subtree_slots = needSlots;
		changed = true;
	}
	if (needUsd > lim.max_subtree_usd + EPS) {
		lim.max_subtree_usd = Math.round(needUsd * 1e6) / 1e6;
		changed = true;
	}
	if (!changed) return;
	setLimits(db, agentId, lim);
	emit(db, { run_id: runId, actor_id: actor, type: "budget.grant_raised", entity_id: agentId, payload: { proposal_id: proposalId, before: al.limits, after: lim } });
}

/** The agent's own budget = usd of its reservation rows (same amount at every ancestor). */
export function ownBudgetUsd(db: DB, agentId: string): number | null {
	const r = get(db, "SELECT usd FROM reservations WHERE beneficiary_id = ? AND state = 'ACTIVE' LIMIT 1", agentId);
	return r ? Number(r.usd) : null;
}

export function budgetView(db: DB, agentId: string): BudgetView {
	const al = getAllocation(db, agentId);
	const sub = getSubtree(db, agentId).slice(1);
	let live = 0;
	if (sub.length) {
		live = Number(get(db, `SELECT COUNT(*) AS n FROM agents WHERE id IN (${sub.map(() => "?").join(",")}) AND status NOT IN ${TERMINAL_SQL}`, ...sub)!.n);
	}
	return {
		agent_id: agentId,
		limits: al.limits,
		reserved_slots: al.reserved_slots,
		reserved_usd: al.reserved_usd,
		consumed_usd: al.consumed_usd,
		subtree_live_agents: live,
		available_slots: Math.max(0, al.limits.max_subtree_slots - al.reserved_slots),
		available_usd: Math.max(0, Math.round((al.limits.max_subtree_usd - al.reserved_usd) * 1e6) / 1e6),
	};
}
