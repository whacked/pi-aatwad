// Expansion proposals and decisions (APPROVE / REJECT / AMEND / ESCALATE) with atomic reservation + durable spawn intents.
import { join } from "node:path";
import { type DB, type Row, all, get, run, newId, nowIso, emit, parseJson } from "./db.ts";
import { ApiErr, CommittedError, fail } from "./errors.ts";
import type { Ctx, Principal } from "./context.ts";
import type { CreateExpansionResponse, DecisionResponse, ExpansionProposal, ExpansionRole, ProposalView, ProposalStatus } from "../shared/protocol.ts";
import { assertSchema, obj, str, oneOf, onlyKeys, int } from "./validate.ts";
import { getAgent, getAllocation, getAncestry, getCurrentManager, getRun, isTerminal, runConfig, TERMINAL_SQL } from "./queries.ts";
import { childEnvelope, resolveModel, type ModelChoice } from "./config.ts";
import { assertWithinEnvelopes, raiseEnvelopeFor, recomputeAllocations, reserveAtAncestors } from "./budgets.ts";
import { createTask, postMessage, requireAgent } from "./messaging.ts";

const OPEN_STATUSES: ProposalStatus[] = ["PENDING", "UNDER_REVIEW", "ESCALATED"];

/** Reviewer for a fresh/amended proposal: requester's current manager, or the root itself. */
function defaultReviewer(db: DB, requester: string): string {
	return getCurrentManager(db, requester) ?? requester;
}

function providerChain(db: DB, agentId: string): string[][] {
	return [agentId, ...getAncestry(db, agentId)].map((a) => getAllocation(db, a).limits.allowed_providers);
}

function checkRoles(db: DB, requester: string, roles: ExpansionRole[], runId: string): ModelChoice[] {
	const cfg = runConfig(db, runId);
	const env = getAllocation(db, requester).limits;
	const chain = providerChain(db, requester);
	return roles.map((r) => {
		if (env.allowed_capabilities.length) {
			const bad = r.capabilities.filter((c) => !env.allowed_capabilities.includes(c));
			if (bad.length) fail("FORBIDDEN", `capabilities not delegated to you: ${bad.join(", ")}`);
		}
		return resolveModel(cfg, chain, r);
	});
}

export function createExpansion(ctx: Ctx, p: Principal, body: unknown): CreateExpansionResponse {
	const a = requireAgent(p);
	const b = obj(body);
	const { run_id: _r, requester_id: _q, ...rest } = b;
	const full = { ...rest, run_id: a.run_id, requester_id: a.actor_id } as unknown as ExpansionProposal;
	assertSchema("expansion", full);
	const db = ctx.db;
	const me = getAgent(db, a.actor_id);
	if (isTerminal(me.status)) fail("CONFLICT", `requester is ${me.status}`);
	const task = get(db, "SELECT * FROM tasks WHERE id = ?", full.task_id);
	if (!task || task.run_id !== a.run_id) fail("NOT_FOUND", `task ${full.task_id} not found`);
	if (task.owner_id !== a.actor_id) fail("FORBIDDEN", "proposals must be tied to a task you own");
	checkRoles(db, a.actor_id, full.roles, a.run_id);
	const reviewer = defaultReviewer(db, a.actor_id);
	const id = newId("prop");
	const ts = nowIso();
	run(db, "INSERT INTO proposals(id, run_id, requester_id, reviewer_id, original_reviewer_id, task_id, revision, status, request_json, created_at, updated_at) VALUES (?,?,?,?,?,?,1,'PENDING',?,?,?)", id, a.run_id, a.actor_id, reviewer, reviewer, full.task_id, JSON.stringify(full), ts, ts);
	run(db, "INSERT INTO proposal_revisions(proposal_id, revision, request_json, author_id, created_at) VALUES (?,1,?,?,?)", id, JSON.stringify(full), a.actor_id, ts);
	if (reviewer !== a.actor_id) {
		postMessage(db, { run_id: a.run_id, from: a.actor_id, to: reviewer, type: "team.expand.request", payload: { proposal_id: id, reason: full.reason, roles: full.roles, estimated_cost_usd: full.estimated_cost_usd }, correlation_id: id });
	}
	emit(db, { run_id: a.run_id, actor_id: a.actor_id, type: "proposal.created", entity_id: id, payload: { reviewer_id: reviewer, request: full } });
	return { proposal_id: id, status: "PENDING", reviewer_id: reviewer };
}

function getProposal(db: DB, id: string): Row {
	const r = get(db, "SELECT * FROM proposals WHERE id = ?", id);
	if (!r) fail("NOT_FOUND", `proposal ${id} not found`);
	return r;
}

function recordDecision(db: DB, proposalId: string, reviewer: string, decision: string, reason: string, revision: number): void {
	// proposal_decisions.reviewer_id references agents; operator decisions are attributed to the run root and flagged in the reason.
	run(db, "INSERT INTO proposal_decisions(id, proposal_id, reviewer_id, decision, reason, revision, created_at) VALUES (?,?,?,?,?,?,?)", newId("dec"), proposalId, reviewer, decision, reason, revision, nowIso());
}

export function decide(ctx: Ctx, p: Principal, proposalId: string, body: unknown): DecisionResponse | CommittedError {
	const db = ctx.db;
	const b = obj(body);
	onlyKeys(b, ["decision", "reason", "amended_roles", "expected_topology_version"]);
	const decision = oneOf(b, "decision", ["APPROVE", "REJECT", "AMEND", "ESCALATE"] as const);
	const reason = str(b, "reason");
	const expectedVersion = int(b, "expected_topology_version", { optional: true });
	const prop = getProposal(db, proposalId);
	const runRow = getRun(db, prop.run_id);
	if (p.kind === "agent" && p.run_id !== prop.run_id) fail("FORBIDDEN", "proposal belongs to another run");
	if (!OPEN_STATUSES.includes(prop.status)) fail("CONFLICT", `proposal already ${prop.status}`);
	if (expectedVersion !== undefined && expectedVersion !== runRow.topology_version) fail("CONFLICT", `stale topology version ${expectedVersion} (current ${runRow.topology_version})`);
	const requester = getAgent(db, prop.requester_id);
	if (isTerminal(requester.status)) fail("CONFLICT", `requester is ${requester.status}`);

	const actor = p.actor_id;
	const decidedBy = p.kind === "operator" ? runRow.root_agent_id : actor; // FK-safe attribution
	if (p.kind === "agent") {
		if (prop.reviewer_id !== actor) fail("FORBIDDEN", "you are not the reviewer of this proposal");
		// Revalidate the reviewer against CURRENT topology.
		const ancestry = getAncestry(db, prop.requester_id);
		const valid =
			prop.status === "ESCALATED"
				? ancestry.includes(actor) || (ancestry.length === 0 && actor === prop.requester_id)
				: actor === defaultReviewer(db, prop.requester_id);
		if (!valid) {
			const fresh = defaultReviewer(db, prop.requester_id);
			run(db, "UPDATE proposals SET reviewer_id = ?, status = 'PENDING', updated_at = ? WHERE id = ?", fresh, nowIso(), proposalId);
			emit(db, { run_id: prop.run_id, actor_id: actor, type: "proposal.rerouted", entity_id: proposalId, payload: { stale_reviewer: actor, new_reviewer: fresh, reason: "reviewer no longer in requester's management chain" } });
			if (fresh !== prop.requester_id) postMessage(db, { run_id: prop.run_id, from: prop.requester_id, to: fresh, type: "team.expand.request", payload: { proposal_id: proposalId, rerouted: true }, correlation_id: proposalId });
			return new CommittedError(new ApiErr("CONFLICT", "stale reviewer: topology changed; proposal returned for fresh review", { new_reviewer_id: fresh }));
		}
	}

	const request = parseJson<ExpansionProposal>(prop.request_json, null as unknown as ExpansionProposal);
	const ts = nowIso();
	const notify = (status: string, extra: Record<string, unknown> = {}) => {
		if (decidedBy !== prop.requester_id || p.kind === "operator")
			postMessage(db, { run_id: prop.run_id, from: decidedBy, to: prop.requester_id, type: "team.expand.decision", payload: { proposal_id: proposalId, decision, status, reason, ...extra }, correlation_id: proposalId });
	};

	if (decision === "REJECT") {
		run(db, "UPDATE proposals SET status = 'REJECTED', decided_at = ?, updated_at = ? WHERE id = ?", ts, ts, proposalId);
		recordDecision(db, proposalId, decidedBy, "REJECT", p.kind === "operator" ? `[operator] ${reason}` : reason, prop.revision);
		notify("REJECTED");
		emit(db, { run_id: prop.run_id, actor_id: actor, type: "proposal.rejected", entity_id: proposalId, payload: { reason, revision: prop.revision } });
		return { proposal_id: proposalId, status: "REJECTED", revision: prop.revision, spawned_agent_ids: [], reviewer_id: null };
	}

	if (decision === "AMEND") {
		if (!Array.isArray(b.amended_roles)) fail("INVALID", "AMEND requires amended_roles");
		const amended = { ...request, roles: b.amended_roles as ExpansionRole[] };
		assertSchema("expansion", amended);
		checkRoles(db, prop.requester_id, amended.roles, prop.run_id);
		const rev = prop.revision + 1;
		const reviewer = defaultReviewer(db, prop.requester_id);
		recordDecision(db, proposalId, decidedBy, "AMEND", reason, prop.revision);
		run(db, "INSERT INTO proposal_revisions(proposal_id, revision, request_json, author_id, created_at) VALUES (?,?,?,?,?)", proposalId, rev, JSON.stringify(amended), actor, ts);
		run(db, "UPDATE proposals SET revision = ?, request_json = ?, status = 'PENDING', reviewer_id = ?, updated_at = ? WHERE id = ?", rev, JSON.stringify(amended), reviewer, ts, proposalId);
		notify("PENDING", { revision: rev, amended_roles: amended.roles });
		emit(db, { run_id: prop.run_id, actor_id: actor, type: "proposal.amended", entity_id: proposalId, payload: { from_revision: prop.revision, revision: rev, reason } });
		return { proposal_id: proposalId, status: "PENDING", revision: rev, spawned_agent_ids: [], reviewer_id: reviewer };
	}

	if (decision === "ESCALATE") {
		if (p.kind === "operator") fail("CONFLICT", "operator is the final authority; nothing to escalate to");
		const next = getCurrentManager(db, actor); // null => operator
		run(db, "UPDATE proposals SET status = 'ESCALATED', reviewer_id = ?, updated_at = ? WHERE id = ?", next, ts, proposalId);
		recordDecision(db, proposalId, decidedBy, "ESCALATE", reason, prop.revision);
		if (next) postMessage(db, { run_id: prop.run_id, from: actor, to: next, type: "team.expand.request", payload: { proposal_id: proposalId, escalated_by: actor, reason }, correlation_id: proposalId });
		notify("ESCALATED", { reviewer_id: next });
		emit(db, { run_id: prop.run_id, actor_id: actor, type: "proposal.escalated", entity_id: proposalId, payload: { from_reviewer: actor, to_reviewer: next, reason } });
		return { proposal_id: proposalId, status: "ESCALATED", revision: prop.revision, spawned_agent_ids: [], reviewer_id: next };
	}

	return approve(ctx, p, prop, request, reason, decidedBy);
}

function approve(ctx: Ctx, p: Principal, prop: Row, request: ExpansionProposal, reason: string, decidedBy: string): DecisionResponse | CommittedError {
	const db = ctx.db;
	const runId = prop.run_id as string;
	const actor = p.actor_id;
	const cfg = runConfig(db, runId);
	const requester = prop.requester_id as string;
	const choices = checkRoles(db, requester, request.roles, runId);
	const n = request.roles.reduce((s, r) => s + r.count, 0);
	const usd = request.roles.reduce((s, r) => s + r.count * r.max_cost_usd, 0);
	const runRow = getRun(db, runId);

	// 1) Global hard caps. Nobody (root, operator) overrides these.
	const L = cfg.limits;
	const live = Number(get(db, `SELECT COUNT(*) AS n FROM agents WHERE run_id = ? AND status NOT IN ${TERMINAL_SQL}`, runId)!.n);
	const pending = Number(get(db, "SELECT COUNT(*) AS n FROM spawn_intents i JOIN agents a ON a.id = i.agent_id WHERE a.run_id = ? AND i.status IN ('PENDING','LAUNCHING','LAUNCHED')", runId)!.n);
	const chain = [requester, ...getAncestry(db, requester)];
	const depth = chain.length; // depth of the new child (root = 0)
	const rootReserved = getAllocation(db, runRow.root_agent_id).reserved_usd;
	const violations: string[] = [];
	if (live + n > L.max_live_agents) violations.push(`max_live_agents ${L.max_live_agents} (live ${live} + requested ${n})`);
	if (pending + n > L.max_pending_spawns) violations.push(`max_pending_spawns ${L.max_pending_spawns} (pending ${pending} + requested ${n})`);
	if (depth > L.emergency_max_depth) violations.push(`emergency_max_depth ${L.emergency_max_depth} (new depth ${depth})`);
	if (rootReserved + usd > L.max_run_usd + 1e-9) violations.push(`max_run_usd ${L.max_run_usd} (reserved ${rootReserved} + requested ${usd})`);
	for (const c of choices) if (!L.allow_providers.includes(c.entry.provider)) violations.push(`provider ${c.entry.provider} not in allow_providers`);
	if (violations.length) {
		const ts = nowIso();
		run(db, "UPDATE proposals SET status = 'REJECTED', decided_at = ?, updated_at = ? WHERE id = ?", ts, ts, prop.id);
		recordDecision(db, prop.id, decidedBy, "REJECT", `HARD_CAP: ${violations.join("; ")}`, prop.revision);
		postMessage(db, { run_id: runId, from: decidedBy, to: requester, type: "team.expand.decision", payload: { proposal_id: prop.id, decision: "REJECT", status: "REJECTED", reason: `global hard cap: ${violations.join("; ")}` }, correlation_id: prop.id });
		emit(db, { run_id: runId, actor_id: actor, type: "governance.hard_cap_denied", entity_id: prop.id, payload: { violations, requested_slots: n, requested_usd: usd } });
		return new CommittedError(new ApiErr("HARD_CAP", `global hard cap: ${violations.join("; ")}`, { violations, proposal_status: "REJECTED" }));
	}

	// 2) Reviewer's per-decision grant authority.
	if (p.kind === "agent") {
		const g = getAllocation(db, actor).limits;
		if (n > g.max_grant_slots || usd > g.max_grant_usd + 1e-9) {
			fail("FORBIDDEN", `request (${n} slots, $${usd}) exceeds your per-decision grant (${g.max_grant_slots} slots, $${g.max_grant_usd}); ESCALATE to your manager`, { hint: "ESCALATE", max_grant_slots: g.max_grant_slots, max_grant_usd: g.max_grant_usd });
		}
	}

	// 3) Subtree envelopes: agents strictly below the reviewer receive the grant; reviewer and above must absorb it.
	const reviewerIdx = p.kind === "operator" ? chain.length - 1 : chain.indexOf(actor);
	if (reviewerIdx < 0) fail("CONFLICT", "reviewer is not in the requester's management chain");
	const below = chain.slice(0, reviewerIdx);
	const checked = chain.slice(reviewerIdx);
	for (const a of checked) {
		const al = getAllocation(db, a);
		if (al.reserved_slots + n > al.limits.max_subtree_slots || al.reserved_usd + usd > al.limits.max_subtree_usd + 1e-9) {
			fail("BUDGET_EXCEEDED", `subtree envelope of ${a} cannot absorb ${n} slots / $${usd}`, {
				agent_id: a,
				reserved_slots: al.reserved_slots,
				max_subtree_slots: al.limits.max_subtree_slots,
				reserved_usd: al.reserved_usd,
				max_subtree_usd: al.limits.max_subtree_usd,
				hint: a === actor ? "ESCALATE" : undefined,
			});
		}
	}
	for (const a of below) raiseEnvelopeFor(db, runId, actor, a, n, usd, prop.id);

	// 4) Create agents, edges, allocations, reservations, spawn intents, tasks.
	const v = Number(runRow.topology_version) + 1;
	const ts = nowIso();
	const reqEnv = getAllocation(db, requester).limits;
	const spawned: string[] = [];
	request.roles.forEach((role, i) => {
		const choice = choices[i];
		for (let j = 0; j < role.count; j++) {
			const agentId = newId("agent");
			const meta = { proposal_id: prop.id, responsibility: role.responsibility, capabilities: role.capabilities, requested_model_id: role.preferred_model_id ?? null, model_id: choice.entry.id, model_selection_reason: choice.reason, model_candidates: choice.candidates, cost_estimated: choice.cost_estimated };
			const cwd = join(cfg.workspace_root, ".team-worktrees", agentId);
			const piSession = join(ctx.paths.dir, "sessions", `${agentId}.jsonl`);
			run(
				db,
				`INSERT INTO agents(id, run_id, role, status, created_at, metadata_json, desired_state, observed_state, provider, model, model_id, cwd, pi_session_path)
				 VALUES (?,?,?, 'PROVISIONING', ?, ?, 'RUNNING', 'STOPPED', ?,?,?,?,?)`,
				agentId,
				runId,
				role.title,
				ts,
				JSON.stringify(meta),
				choice.entry.provider,
				choice.entry.model,
				choice.entry.id,
				cwd,
				piSession,
			);
			run(db, "INSERT INTO reporting_edges(id, run_id, parent_id, child_id, valid_from, from_version, reason) VALUES (?,?,?,?,?,?,?)", newId("edge"), runId, requester, agentId, ts, v, `approved ${prop.id}`);
			run(db, "INSERT INTO allocations(agent_id, limits_json) VALUES (?,?)", agentId, JSON.stringify(childEnvelope(role, reqEnv, cfg.limits)));
			reserveAtAncestors(db, runId, agentId, chain, 1, role.max_cost_usd, prop.id);
			const taskId = createTask(db, { run_id: runId, owner_id: agentId, title: role.title, spec: { responsibility: role.responsibility, proposal_id: prop.id }, parent_task_id: prop.task_id, assigned_by: requester });
			const intentId = newId("spawn");
			run(
				db,
				"INSERT INTO spawn_intents(id, proposal_id, role_index, ordinal, agent_id, status, created_at, updated_at, spec_json) VALUES (?,?,?,?,?, 'PENDING', ?, ?, ?)",
				intentId,
				prop.id,
				i,
				j,
				agentId,
				ts,
				ts,
				JSON.stringify({ task_id: taskId, responsibility: role.responsibility, parent_id: requester }),
			);
			postMessage(db, { run_id: runId, from: requester, to: agentId, type: "task.assigned", payload: { task_id: taskId, title: role.title, spec: { responsibility: role.responsibility }, parent_task_id: prop.task_id }, correlation_id: taskId });
			emit(db, { run_id: runId, actor_id: actor, type: "agent.created", entity_id: agentId, payload: { parent_id: requester, role: role.title, proposal_id: prop.id, spawn_intent_id: intentId, model_id: choice.entry.id, provider: choice.entry.provider, model: choice.entry.model, reason: choice.reason, cost_estimated: choice.cost_estimated, topology_version: v } });
			spawned.push(agentId);
		}
	});
	recomputeAllocations(db, runId);
	assertWithinEnvelopes(db, chain); // defence in depth
	run(db, "UPDATE runs SET topology_version = ? WHERE id = ?", v, runId);
	run(db, "UPDATE proposals SET status = 'APPROVED', decided_at = ?, updated_at = ? WHERE id = ?", ts, ts, prop.id);
	recordDecision(db, prop.id, decidedBy, "APPROVE", p.kind === "operator" ? `[operator] ${reason}` : reason, prop.revision);
	postMessage(db, { run_id: runId, from: decidedBy, to: requester, type: "team.expand.decision", payload: { proposal_id: prop.id, decision: "APPROVE", status: "APPROVED", reason, spawned_agent_ids: spawned }, correlation_id: prop.id });
	emit(db, { run_id: runId, actor_id: actor, type: "proposal.approved", entity_id: prop.id, payload: { revision: prop.revision, spawned_agent_ids: spawned, slots: n, usd, topology_version: v } });
	ctx.kick();
	return { proposal_id: prop.id, status: "APPROVED", revision: prop.revision, spawned_agent_ids: spawned, reviewer_id: null };
}

export function proposalView(db: DB, r: Row): ProposalView {
	return {
		proposal_id: r.id,
		requester_id: r.requester_id,
		reviewer_id: r.reviewer_id ?? null,
		status: r.status,
		revision: r.revision,
		request: parseJson(r.request_json, null as unknown as ExpansionProposal),
		decisions: all(db, "SELECT reviewer_id, decision, reason, revision, created_at FROM proposal_decisions WHERE proposal_id = ? ORDER BY created_at, rowid", r.id) as never,
	};
}

export function listProposals(ctx: Ctx, p: Principal, q: URLSearchParams): { proposals: ProposalView[] } {
	const scope = q.get("scope") ?? (p.kind === "operator" ? "all" : "review");
	const open = "status IN ('PENDING','UNDER_REVIEW','ESCALATED')";
	let rows: Row[];
	if (p.kind === "operator") {
		const runId = q.get("run_id");
		if (scope === "review") rows = all(ctx.db, `SELECT * FROM proposals WHERE reviewer_id IS NULL AND ${open} ${runId ? "AND run_id = ?" : ""} ORDER BY created_at`, ...(runId ? [runId] : []));
		else rows = all(ctx.db, `SELECT * FROM proposals ${runId ? "WHERE run_id = ?" : ""} ORDER BY created_at`, ...(runId ? [runId] : []));
	} else if (scope === "review") rows = all(ctx.db, `SELECT * FROM proposals WHERE reviewer_id = ? AND ${open} ORDER BY created_at`, p.actor_id);
	else if (scope === "mine") rows = all(ctx.db, "SELECT * FROM proposals WHERE requester_id = ? ORDER BY created_at", p.actor_id);
	else fail("INVALID", "scope must be review or mine");
	return { proposals: rows.map((r) => proposalView(ctx.db, r)) };
}

export function getProposalRevisions(db: DB, proposalId: string): Row[] {
	return all(db, "SELECT revision, request_json, author_id, created_at FROM proposal_revisions WHERE proposal_id = ? ORDER BY revision", proposalId);
}
