// Topology mutations: reparent (docs/08) and lifecycle (pause/resume/retire/cancel) with children policies.
import { type DB, type Row, all, get, run, newId, nowIso, emit } from "./db.ts";
import { fail } from "./errors.ts";
import type { Ctx, Principal, ReqScope } from "./context.ts";
import type { ReparentResponse, LifecycleResponse, AgentStatus } from "../shared/protocol.ts";
import { obj, str, int, oneOf, onlyKeys } from "./validate.ts";
import { getAgent, getAncestry, runConfig, getChildren, getCurrentManager, getOutstandingCommitments, getRun, getSubtree, isAncestor, isTerminal } from "./queries.ts";
import { assertWithinEnvelopes, rebuildReservations, recomputeAllocations, releaseReservations } from "./budgets.ts";
import { postMessage } from "./messaging.ts";
import { revokeAgentCredentials } from "./auth.ts";
import { defaultReviewer } from "./governance.ts";

function senderFor(db: DB, p: Principal, runId: string): string {
	return p.kind === "agent" ? p.actor_id : (getRun(db, runId).root_agent_id as string);
}

/** Actor may act on `subject` if operator, or a strict ancestor of subject in the same run. */
function assertManages(db: DB, p: Principal, subject: Row): void {
	if (p.kind === "operator") return;
	if (p.run_id !== subject.run_id) fail("FORBIDDEN", "agent belongs to another run");
	if (!isAncestor(db, p.actor_id, subject.id)) fail("FORBIDDEN", "you do not manage this agent");
}
/** Actor may place agents under `target` if operator, target itself, or an ancestor of target. */
function assertCanTarget(db: DB, p: Principal, target: string): void {
	if (p.kind === "operator") return;
	if (p.actor_id !== target && !isAncestor(db, p.actor_id, target)) fail("FORBIDDEN", `no authority over destination ${target}`);
}

function moveEdge(db: DB, runId: string, child: string, newParent: string, version: number, reason: string): void {
	const ts = nowIso();
	run(db, "UPDATE reporting_edges SET valid_to = ?, to_version = ? WHERE child_id = ? AND valid_to IS NULL", ts, version, child);
	run(db, "INSERT INTO reporting_edges(id, run_id, parent_id, child_id, valid_from, from_version, reason) VALUES (?,?,?,?,?,?,?)", newId("edge"), runId, newParent, child, ts, version, reason);
}

/** emergency_max_depth also bounds topology moves: checked on the post-move snapshot inside the txn. */
function assertDepthWithinCap(db: DB, runId: string, moved: string[]): void {
	const cap = runConfig(db, runId).limits.emergency_max_depth;
	let worst = 0;
	let who = "";
	for (const m of moved) {
		const d = getAncestry(db, m).length;
		if (d > worst) {
			worst = d;
			who = m;
		}
	}
	if (worst > cap) fail("HARD_CAP", `emergency_max_depth ${cap} would be exceeded (agent ${who} at depth ${worst})`, { violations: [`emergency_max_depth ${cap} (depth ${worst})`], agent_id: who });
}

/** Transfer the direct children of `subject` to `target`, re-pointing reservations; budget-checked. */
function transferChildren(db: DB, runId: string, subject: string, target: string, version: number, reason: string): string[] {
	const children = getChildren(db, subject);
	const moved: string[] = [];
	for (const c of children) {
		moveEdge(db, runId, c, target, version, reason);
		moved.push(...getSubtree(db, c));
	}
	return moved;
}

export function reparent(ctx: Ctx, p: Principal, scope: ReqScope, agentId: string, body: unknown): ReparentResponse {
	const db = ctx.db;
	const b = obj(body);
	onlyKeys(b, ["new_parent_id", "expected_topology_version", "reason", "pending_work_policy", "move_subtree", "children_policy"]);
	const newParentId = str(b, "new_parent_id");
	const expected = int(b, "expected_topology_version");
	const reason = str(b, "reason");
	const policy = oneOf(b, "pending_work_policy", ["retain", "reassign", "pause"] as const);
	if (b.move_subtree !== undefined && typeof b.move_subtree !== "boolean") fail("INVALID", "move_subtree must be boolean");
	const moveSubtree = b.move_subtree !== false;

	const subject = getAgent(db, agentId);
	const target = getAgent(db, newParentId);
	assertManages(db, p, subject);
	if (target.run_id !== subject.run_id) fail("CONFLICT", "cross-run reparent is not allowed");
	const runRow = getRun(db, subject.run_id);
	if (runRow.root_agent_id === subject.id) fail("CONFLICT", "the root cannot be reparented");
	if (expected !== runRow.topology_version) fail("CONFLICT", `stale topology version ${expected} (current ${runRow.topology_version})`);
	if (subject.id === target.id) fail("CONFLICT", "an agent cannot report to itself");
	if (isTerminal(subject.status) || isTerminal(target.status)) fail("CONFLICT", "terminal agents cannot be reparented or receive reports");
	const oldParent = getCurrentManager(db, subject.id);
	if (!oldParent) fail("CONFLICT", "agent has no active parent");
	if (oldParent === target.id) fail("CONFLICT", "agent already reports to that parent");
	const subtree = getSubtree(db, subject.id);
	if (subtree.includes(target.id)) fail("CONFLICT", "cycle: destination is inside the agent's own subtree");
	assertCanTarget(db, p, target.id);

	const v = Number(runRow.topology_version) + 1;
	const children = getChildren(db, subject.id);
	let transferTo: string | null = null;
	if (!moveSubtree && children.length) {
		const cp = b.children_policy as { kind?: string; agent_id?: string } | undefined;
		if (!cp || cp.kind !== "transfer_children_to" || typeof cp.agent_id !== "string") fail("INVALID", "move_subtree=false with children requires children_policy {kind:'transfer_children_to', agent_id}");
		const x = getAgent(db, cp.agent_id);
		if (x.run_id !== subject.run_id) fail("CONFLICT", "cross-run transfer is not allowed");
		if (isTerminal(x.status)) fail("CONFLICT", "transfer target is terminal");
		if (subtree.includes(x.id)) fail("CONFLICT", "transfer target is inside the agent's own subtree");
		assertCanTarget(db, p, x.id);
		transferTo = x.id;
	}

	moveEdge(db, subject.run_id, subject.id, target.id, v, reason);
	if (transferTo) transferChildren(db, subject.run_id, subject.id, transferTo, v, `children of ${subject.id} transferred: ${reason}`);
	assertDepthWithinCap(db, subject.run_id, subtree);
	const increased = rebuildReservations(db, subtree);
	recomputeAllocations(db, subject.run_id);
	assertWithinEnvelopes(db, increased); // destination chain must absorb the moved subtree; else whole txn rolls back
	run(db, "UPDATE runs SET topology_version = ? WHERE id = ?", v, subject.run_id);
	run(
		db,
		"INSERT INTO topology_operations(id, run_id, subject_agent_id, from_parent_id, to_parent_id, expected_version, committed_version, work_policy, status, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?,?, 'COMMITTED', ?, ?)",
		newId("topo"),
		subject.run_id,
		subject.id,
		oldParent,
		target.id,
		expected,
		v,
		policy,
		`${p.actor_id}:${scope.idemKey ?? newId("k")}`,
		nowIso(),
	);
	if (policy === "pause") {
		run(db, "UPDATE agents SET desired_state = 'PAUSED', status = CASE WHEN status = 'RUNNING' THEN 'PAUSED' ELSE status END WHERE id = ?", subject.id);
	}
	const from = senderFor(db, p, subject.run_id);
	const commitments = getOutstandingCommitments(db, subject.id);
	postMessage(db, { run_id: subject.run_id, from, to: subject.id, type: "system.notice", payload: { kind: "reparented", old_parent_id: oldParent, new_parent_id: target.id, reason, pending_work_policy: policy, topology_version: v } });
	postMessage(db, { run_id: subject.run_id, from, to: target.id, type: "system.notice", payload: { kind: "handoff", agent_id: subject.id, from_parent_id: oldParent, reason, open_tasks: commitments.open_tasks, pending_work_policy: policy } });
	if (oldParent !== from) postMessage(db, { run_id: subject.run_id, from, to: oldParent, type: "system.notice", payload: { kind: "report_moved", agent_id: subject.id, new_parent_id: target.id, reason } });
	emit(db, {
		run_id: subject.run_id,
		actor_id: p.actor_id,
		type: "agent.reparented",
		entity_id: subject.id,
		payload: { old_parent_id: oldParent, new_parent_id: target.id, move_subtree: moveSubtree, transferred_children_to: transferTo, transferred_children: transferTo ? children : [], pending_work_policy: policy, reason, topology_version: v },
	});
	return { agent_id: subject.id, old_parent_id: oldParent, new_parent_id: target.id, topology_version: v };
}

/** Terminal transition for one agent: revoke credentials, stop processes (after commit), release reservations, keep consumed_usd. */
export function terminateAgent(ctx: Ctx, scope: ReqScope | null, agentId: string, status: "RETIRED" | "CANCELLED" | "FAILED", actor: string, reason: string): void {
	const db = ctx.db;
	const a = getAgent(db, agentId);
	if (isTerminal(a.status)) return;
	const ts = nowIso();
	run(db, "UPDATE agents SET status = ?, desired_state = 'RETIRED', observed_state = CASE WHEN ? = 'FAILED' THEN 'FAILED' ELSE 'STOPPED' END, lease_until = NULL WHERE id = ?", status, status, agentId);
	revokeAgentCredentials(db, agentId, status.toLowerCase());
	const procs = all(db, "SELECT pid, process_started_at FROM sessions WHERE agent_id = ? AND status IN ('REQUESTED','STARTING','LIVE','LOST') AND pid IS NOT NULL", agentId);
	run(db, "UPDATE sessions SET status = 'STOPPED', ended_at = ? WHERE agent_id = ? AND status IN ('REQUESTED','STARTING','LIVE','LOST')", ts, agentId);
	run(db, "UPDATE spawn_intents SET status = 'CANCELLED', updated_at = ? WHERE agent_id = ? AND status NOT IN ('CANCELLED','FAILED')", ts, agentId);
	releaseReservations(db, agentId);
	run(db, "UPDATE tasks SET status = 'CANCELLED', updated_at = ? WHERE owner_id = ? AND status IN ('OPEN','ASSIGNED','IN_PROGRESS','BLOCKED')", ts, agentId);
	recomputeAllocations(db, a.run_id);
	// Governance must not stall on a terminated agent: its own open proposals are withdrawn,
	// proposals it was reviewing go to the nearest live manager of their requester (or the operator).
	const openProps = "status IN ('PENDING','UNDER_REVIEW','ESCALATED')";
	for (const pr of all(db, `SELECT id FROM proposals WHERE requester_id = ? AND ${openProps}`, agentId)) {
		run(db, "UPDATE proposals SET status = 'REJECTED', decided_at = ?, updated_at = ? WHERE id = ?", ts, ts, pr.id);
		emit(db, { run_id: a.run_id, actor_id: actor, type: "proposal.withdrawn", entity_id: pr.id, payload: { reason: `requester ${status.toLowerCase()}` } });
	}
	for (const pr of all(db, `SELECT id, requester_id FROM proposals WHERE reviewer_id = ? AND ${openProps}`, agentId)) {
		const fresh = defaultReviewer(db, pr.requester_id);
		run(db, "UPDATE proposals SET reviewer_id = ?, status = 'PENDING', updated_at = ? WHERE id = ?", fresh, ts, pr.id);
		emit(db, { run_id: a.run_id, actor_id: actor, type: "proposal.rerouted", entity_id: pr.id, payload: { stale_reviewer: agentId, new_reviewer: fresh, reason: `reviewer ${status.toLowerCase()}` } });
		if (fresh && fresh !== pr.requester_id) postMessage(db, { run_id: a.run_id, from: pr.requester_id, to: fresh, type: "team.expand.request", payload: { proposal_id: pr.id, rerouted: true }, correlation_id: pr.id });
	}
	emit(db, { run_id: a.run_id, actor_id: actor, type: "agent.terminated", entity_id: agentId, payload: { status, reason, consumed_usd: get(db, "SELECT consumed_usd FROM allocations WHERE agent_id = ?", agentId)?.consumed_usd ?? 0 } });
	for (const pr of procs) {
		const stop = () => ctx.stopProcess(pr.pid, pr.process_started_at ?? "").catch((e) => ctx.log("warn", "stop failed", { agent_id: agentId, pid: pr.pid, err: String(e) }));
		if (scope) scope.after(stop);
		else void stop();
	}
}

export function lifecycle(ctx: Ctx, p: Principal, scope: ReqScope, agentId: string, body: unknown): LifecycleResponse {
	const db = ctx.db;
	const b = obj(body);
	onlyKeys(b, ["action", "reason", "children_policy", "transfer_children_to", "expected_topology_version"]);
	const expectedVersion = int(b, "expected_topology_version", { optional: true });
	const action = oneOf(b, "action", ["pause", "resume", "retire", "cancel"] as const);
	const reason = str(b, "reason");
	const cpol = oneOf(b, "children_policy", ["cascade", "transfer_children_to", "pause_subtree"] as const, { optional: true });
	const subject = getAgent(db, agentId);
	assertManages(db, p, subject);
	if (isTerminal(subject.status)) fail("CONFLICT", `agent is already ${subject.status}`);
	const runId = subject.run_id as string;
	const from = senderFor(db, p, runId);
	const liveDescendants = getSubtree(db, agentId)
		.slice(1)
		.filter((id) => !isTerminal(getAgent(db, id).status));
	const affected: string[] = [];
	const notify = (to: string, extra: Record<string, unknown> = {}) => postMessage(db, { run_id: runId, from, to, type: "agent.lifecycle", payload: { action, agent_id: to, reason, ...extra } });

	if (action === "pause" || action === "resume") {
		const targets = cpol === "cascade" || cpol === "pause_subtree" ? [agentId, ...liveDescendants] : [agentId];
		for (const t of targets) {
			if (action === "pause") run(db, "UPDATE agents SET desired_state = 'PAUSED', status = CASE WHEN status = 'RUNNING' THEN 'PAUSED' ELSE status END WHERE id = ?", t);
			else
				run(
					db,
					"UPDATE agents SET desired_state = 'RUNNING', status = CASE WHEN status = 'PAUSED' AND observed_state = 'LIVE' THEN 'RUNNING' ELSE status END, metadata_json = json_set(metadata_json, '$.runtime_epoch', ?) WHERE id = ?",
					nowIso(),
					t,
				);
			notify(t);
			affected.push(t);
		}
		if (action === "resume") {
			// Work blocked by a deadline becomes actionable again (this is what triggers a relaunch of a stopped worker).
			for (const t of targets) run(db, "UPDATE tasks SET status = 'ASSIGNED', updated_at = ? WHERE owner_id = ? AND status = 'BLOCKED'", nowIso(), t);
			ctx.kick();
		}
	} else {
		const final: AgentStatus = action === "retire" ? "RETIRED" : "CANCELLED";
		let targets = [agentId];
		if (liveDescendants.length) {
			if (!cpol) fail("CONFLICT", "agent has active reports; children_policy (cascade | transfer_children_to) is required");
			// pause_subtree would leave live reports under a terminated manager (stalled governance): not allowed here.
			if (cpol === "pause_subtree") fail("INVALID", `children_policy pause_subtree is only valid for pause; ${action} requires cascade or transfer_children_to`);
			if (cpol === "cascade") targets = [...liveDescendants.reverse(), agentId]; // deepest first
			else if (cpol === "transfer_children_to") {
				const x = getAgent(db, str(b, "transfer_children_to"));
				if (x.run_id !== runId) fail("CONFLICT", "cross-run transfer is not allowed");
				if (isTerminal(x.status)) fail("CONFLICT", "transfer target is terminal");
				if (getSubtree(db, agentId).includes(x.id)) fail("CONFLICT", "transfer target is inside the agent's own subtree");
				assertCanTarget(db, p, x.id);
				const runRow = getRun(db, runId);
				// Moving children is a topology change: optimistic version check like reparent.
				if (expectedVersion === undefined) fail("INVALID", "expected_topology_version is required when transfer_children_to moves children");
				if (expectedVersion !== runRow.topology_version) fail("CONFLICT", `stale topology version ${expectedVersion} (current ${runRow.topology_version})`);
				const v = Number(runRow.topology_version) + 1;
				const children = getChildren(db, agentId);
				const moved = transferChildren(db, runId, agentId, x.id, v, `${action} of ${agentId}: ${reason}`);
				assertDepthWithinCap(db, runId, moved);
				const increased = rebuildReservations(db, moved);
				recomputeAllocations(db, runId);
				assertWithinEnvelopes(db, increased);
				run(db, "UPDATE runs SET topology_version = ? WHERE id = ?", v, runId);
				for (const c of children) {
					run(
						db,
						"INSERT INTO topology_operations(id, run_id, subject_agent_id, from_parent_id, to_parent_id, expected_version, committed_version, work_policy, status, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?, 'retain', 'COMMITTED', ?, ?)",
						newId("topo"),
						runId,
						c,
						agentId,
						x.id,
						expectedVersion,
						v,
						`${p.actor_id}:${scope.idemKey ?? newId("k")}:${c}`,
						nowIso(),
					);
				}
				emit(db, { run_id: runId, actor_id: p.actor_id, type: "agent.children_transferred", entity_id: agentId, payload: { to: x.id, children, topology_version: v } });
				for (const c of children) postMessage(db, { run_id: runId, from, to: c, type: "system.notice", payload: { kind: "reparented", old_parent_id: agentId, new_parent_id: x.id, reason } });
			}
		}
		for (const t of targets) {
			notify(t);
			terminateAgent(ctx, scope, t, final as "RETIRED" | "CANCELLED", p.actor_id, reason);
			affected.push(t);
		}
	}
	const mgr = getCurrentManager(db, agentId);
	if (mgr && mgr !== from) postMessage(db, { run_id: runId, from, to: mgr, type: "agent.lifecycle", payload: { action, agent_id: agentId, reason } });
	emit(db, { run_id: runId, actor_id: p.actor_id, type: "agent.lifecycle", entity_id: agentId, payload: { action, reason, children_policy: cpol ?? null, affected_agent_ids: affected } });
	const after = getAgent(db, agentId);
	return { agent_id: agentId, status: after.status, desired_state: after.desired_state, affected_agent_ids: affected };
}

