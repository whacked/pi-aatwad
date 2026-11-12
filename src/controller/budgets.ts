// Reservations and allocation projections.
// Model: every non-root agent b holds one ACTIVE reservation row at EACH of its current ancestors
// (slots = 1, usd = b's own budget). An ancestor's allocation.reserved_* is the sum of ACTIVE rows
// where it is the ancestor. Terminated descendants leave slot-less CONSUMED rows (their actual spend),
// reported as settled_usd. max_subtree_slots bounds reserved_slots; max_subtree_usd bounds reserved_usd + settled_usd.
import { type DB, all, get, run, newId, nowIso, emit } from "./db.ts";
import { fail, LIMIT_REMEDY } from "./errors.ts";
import { getAllocation, getAncestry, runConfig, getSubtree, TERMINAL_SQL } from "./queries.ts";
import type { BudgetView, Envelope_Limits } from "../shared/protocol.ts";

const EPS = 1e-9;

export function reserveAtAncestors(db: DB, runId: string, beneficiary: string, ancestors: string[], slots: number, usd: number, proposalId: string | null): void {
	const ts = nowIso();
	for (const a of ancestors) {
		run(db, "INSERT INTO reservations(id, run_id, beneficiary_id, ancestor_id, slots, usd, state, proposal_id, created_at) VALUES (?,?,?,?,?,?, 'ACTIVE', ?, ?)", newId("rsv"), runId, beneficiary, a, slots, usd, proposalId, ts);
	}
}

/**
 * Terminal settlement: the slot and the UNCONSUMED part of the budget return to every ancestor.
 * What the agent actually consumed stays charged to each ancestor as a slot-less CONSUMED row,
 * so retire-and-re-recruit cannot spend the same subtree money twice.
 */
export function releaseReservations(db: DB, beneficiary: string): void {
	const rows = all(db, "SELECT * FROM reservations WHERE beneficiary_id = ? AND state = 'ACTIVE'", beneficiary);
	if (!rows.length) return;
	const ts = nowIso();
	run(db, "UPDATE reservations SET state = 'RELEASED', released_at = ? WHERE beneficiary_id = ? AND state = 'ACTIVE'", ts, beneficiary);
	const consumed = Number(get(db, "SELECT consumed_usd FROM allocations WHERE agent_id = ?", beneficiary)?.consumed_usd ?? 0);
	if (consumed <= 0) return;
	for (const r of rows) {
		run(db, "INSERT INTO reservations(id, run_id, beneficiary_id, ancestor_id, slots, usd, state, proposal_id, created_at) VALUES (?,?,?,?,0,?, 'CONSUMED', ?, ?)", newId("rsv"), r.run_id, beneficiary, r.ancestor_id, consumed, r.proposal_id, ts);
	}
}

/** After topology changes: re-point reservations of `beneficiaries` to their current ancestor chains. Returns ancestors whose load increased. */
// Only ACTIVE rows move. CONSUMED (settled) rows of terminated agents deliberately stay with the
// ancestors under which the money was actually spent: those subtrees remain charged for it after a
// move. The global max_run_usd check is unaffected (it sums consumed spend run-wide), so no money can
// be double-spent; a moved subtree's new ancestors simply are not charged for its past spend.
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
		const runId = get(db, "SELECT run_id FROM agents WHERE id=?", a)!.run_id;
		if (runConfig(db, runId).operator_unlimited) continue;
		const al = getAllocation(db, a);
		if ((al.limits.max_subtree_slots !== null && al.reserved_slots > al.limits.max_subtree_slots) || (al.limits.max_subtree_usd !== null && al.committed_usd > al.limits.max_subtree_usd + EPS)) {
			fail("BUDGET_EXCEEDED", `subtree envelope of ${a} would be exceeded. ${LIMIT_REMEDY}`, { agent_id: a, reserved_slots: al.reserved_slots, max_subtree_slots: al.limits.max_subtree_slots, reserved_usd: al.reserved_usd, settled_usd: al.settled_usd, max_subtree_usd: al.limits.max_subtree_usd, hint });
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
	const needUsd = al.committed_usd + addUsd;
	const lim = { ...al.limits };
	let changed = false;
	if (lim.max_subtree_slots !== null && needSlots > lim.max_subtree_slots) {
		lim.max_subtree_slots = needSlots;
		changed = true;
	}
	if (lim.max_subtree_usd !== null && needUsd > lim.max_subtree_usd + EPS) {
		lim.max_subtree_usd = Math.round(needUsd * 1e6) / 1e6;
		changed = true;
	}
	if (!changed) return;
	setLimits(db, agentId, lim);
	emit(db, { run_id: runId, actor_id: actor, type: "budget.grant_raised", entity_id: agentId, payload: { proposal_id: proposalId, before: al.limits, after: lim } });
}

/** Effective pool ceiling; explicit legacy budgets use reservation rows at each ancestor. */
export function ownBudgetUsd(db: DB, agentId: string): number | null {
	const source = get(db, "SELECT run_id FROM agents WHERE id=?", agentId);
	if (!source) fail("INTERNAL", "budget source agent is missing");
	const seen = new Set<string>();
	let id = agentId;
	for (;;) {
		if (seen.has(id)) fail("INTERNAL", "cycle detected in budget pools");
		seen.add(id);
		const a = get(db, "SELECT metadata_json FROM agents WHERE id=? AND run_id=?", id, source.run_id);
		if (!a) fail("INTERNAL", "budget pool is missing or belongs to another run");
		let meta;
		try { meta = JSON.parse(a.metadata_json); } catch { fail("INTERNAL", "invalid budget pool metadata"); }
		if (!meta || typeof meta !== "object" || Array.isArray(meta)) fail("INTERNAL", "invalid budget pool metadata");
		if (meta.budget_inherited && meta.budget_pool_id !== undefined) {
			if (typeof meta.budget_pool_id !== "string" || !meta.budget_pool_id) fail("INTERNAL", "invalid budget pool reference");
			id = meta.budget_pool_id;
			continue;
		}
		const usd = meta.own_budget_usd;
		if (usd !== undefined && usd !== null && (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0)) fail("INTERNAL", "invalid budget pool ceiling");
		// An explicit null is authoritative, never a reason to revive a child's cached ceiling.
		if (usd === null) return null;
		// Roots have no own-budget field: recruitment inherits their current subtree envelope.
		if (id !== agentId && usd === undefined && meta.root === true) return runConfig(db, source.run_id).operator_unlimited ? null : getAllocation(db, id).limits.max_subtree_usd;
		if (meta.budget_inherited) return usd ?? null;
		const r = get(db, "SELECT usd FROM reservations WHERE beneficiary_id = ? AND state = 'ACTIVE' LIMIT 1", id);
		if (id !== agentId && usd === undefined && !r) fail("INTERNAL", "budget pool ceiling is missing");
		return r ? Number(r.usd) : usd ?? null;
	}
}

/** Pool membership survives topology moves and terminal settlements. Explicit budgets start a new pool. */
export function budgetPool(db: DB, agentId: string): { id: string; consumed: number; members: string[] } {
	const a = get(db, "SELECT run_id, metadata_json FROM agents WHERE id=?", agentId)!;
	const id = JSON.parse(a.metadata_json).budget_pool_id ?? agentId;
	const rows = all(db, `SELECT a.id,b.consumed_usd FROM agents a JOIN allocations b ON b.agent_id=a.id
		WHERE a.run_id=? AND COALESCE(json_extract(a.metadata_json,'$.budget_pool_id'),a.id)=?`, a.run_id, id);
	return { id, consumed: rows.reduce((sum, r) => sum + Number(r.consumed_usd), 0), members: rows.map((r) => r.id) };
}

export function budgetView(db: DB, agentId: string): BudgetView {
	const unlimited = !!runConfig(db, get(db, "SELECT run_id FROM agents WHERE id=?", agentId)!.run_id).operator_unlimited;
	const al = getAllocation(db, agentId);
	const sub = getSubtree(db, agentId).slice(1);
	let live = 0;
	if (sub.length) {
		live = Number(get(db, `SELECT COUNT(*) AS n FROM agents WHERE id IN (${sub.map(() => "?").join(",")}) AND status NOT IN ${TERMINAL_SQL}`, ...sub)!.n);
	}
	return {
		agent_id: agentId,
		own_budget_usd: ownBudgetUsd(db, agentId),
		budget_pool_id: budgetPool(db, agentId).id,
		pool_consumed_usd: budgetPool(db, agentId).consumed,
		unlimited,
		limits: al.limits,
		reserved_slots: al.reserved_slots,
		reserved_usd: al.reserved_usd,
		settled_usd: al.settled_usd,
		consumed_usd: al.consumed_usd,
		subtree_live_agents: live,
		available_slots: unlimited || al.limits.max_subtree_slots === null ? null : Math.max(0, al.limits.max_subtree_slots - al.reserved_slots),
		available_usd: unlimited || al.limits.max_subtree_usd === null ? null : Math.max(0, Math.round((al.limits.max_subtree_usd - al.committed_usd) * 1e6) / 1e6),
	};
}
