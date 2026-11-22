// Sessions started outside the controller (another harness such as Claude Code, or a human Pi) joining
// and leaving teams. Identity, hierarchy, tasks and reassignment stay controller-owned, so reparenting,
// transfer and reporting links work the same for every harness.
import type { Ctx, Principal, ReqScope } from "./context.ts";
import type { AttachResponse, CreateRunResponse, LeaveResponse } from "../shared/protocol.ts";
import { obj, str, onlyKeys } from "./validate.ts";
import { fail, CommittedError } from "./errors.ts";
import { createTask, postMessage, requireAgent } from "./messaging.ts";
import { getAgent, getLead, getRun, isTerminal, runConfig } from "./queries.ts";
import { emit, newId, nowIso, isoPlus, run, get, parseJson } from "./db.ts";
import { createExpansion, decide } from "./governance.ts";
import { registerRunModel } from "./members.ts";
import { createRun, harnessName, newSessionAttempt } from "./runs.ts";
import { terminateAgent } from "./topology.ts";
import { issueSessionToken, revokeSessionTokens } from "./auth.ts";
import { assertAttachable } from "./team-lifecycle.ts";

function requireOperator(p: Principal): void {
	if (p.kind !== "operator") fail("FORBIDDEN", "joining a team requires the human operator token");
}

/** POST /runs/:id/join */
export function joinTeam(ctx: Ctx, p: Principal, runId: string, body: unknown): AttachResponse {
	requireOperator(p);
	const db = ctx.db;
	const b = obj(body);
	onlyKeys(b, ["manager_id", "name", "responsibility", "harness", "provider", "model", "cwd", "max_cost_usd"]);
	const runRow = getRun(db, runId);
	assertAttachable(db, runId);
	const managerId = str(b, "manager_id", { optional: true }) ?? runRow.root_agent_id;
	const manager = getAgent(db, managerId);
	if (manager.run_id !== runId) fail("NOT_FOUND", "manager not in this team");
	if (isTerminal(manager.status)) fail("CONFLICT", `manager is ${manager.status}`);
	const harness = harnessName({ harness: b.harness ?? "claude-code" });
	const provider = str(b, "provider"), model = str(b, "model");
	const cost = b.max_cost_usd;
	if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) fail("INVALID", "max_cost_usd must be a non-negative number");
	const name = str(b, "name", { optional: true }) ?? `${harness}-member`;
	const responsibility = str(b, "responsibility", { optional: true }) ?? `Externally joined ${harness} session; takes assignments from its manager.`;
	const cfg = runConfig(db, runId);
	const existing = cfg.models.find((m) => m.provider === provider && m.model === model);
	const modelId = existing?.id ?? registerRunModel(ctx, p, runId, { id: newId("model"), provider, model, capability_tags: ["general", "reasoning", "coding", "tools"], tool_support: true }).id;

	// Normal governance: the manager requests one role and the operator approves it.
	const managerP: Principal = { kind: "agent", actor_id: managerId, run_id: runId, session_id: manager.current_session_id ?? "", generation: 0 };
	const task = createTask(db, { run_id: runId, owner_id: managerId, title: `Join ${name}`, spec: { responsibility, harness }, parent_task_id: null, assigned_by: managerId });
	const proposal = createExpansion(ctx, managerP, { version: 1, task_id: task, reason: `External ${harness} session joins: ${responsibility}`, alternatives: "Manager performs the work", estimated_cost_usd: cost ?? 0,
		roles: [{ title: name, responsibility, count: 1, capabilities: [], preferred_model_id: modelId, ...(cost !== undefined ? { max_cost_usd: cost } : {}) }] });
	const decision = decide(ctx, p, proposal.proposal_id, { decision: "APPROVE", reason: `Operator joined an external ${harness} session` });
	if (decision instanceof CommittedError) throw decision.err;
	run(db, "UPDATE tasks SET status = 'DONE' WHERE id = ?", task);
	const agentId = decision.spawned_agent_ids[0];

	// Never launched or relaunched by the controller: the external session is the process.
	const intent = get(db, "SELECT id FROM spawn_intents WHERE agent_id = ?", agentId)!;
	run(db, "UPDATE spawn_intents SET status = 'EXTERNAL', updated_at = ? WHERE id = ?", nowIso(), intent.id);
	// An existing session attached itself: a join, which dismissal severs rather than stops.
	run(db, "UPDATE reporting_edges SET origin = 'joined', terminatable = 0 WHERE child_id = ? AND parent_run_id IS NULL AND valid_to IS NULL", agentId);
	const cwd = str(b, "cwd", { optional: true });
	if (cwd) run(db, "UPDATE agents SET cwd = ? WHERE id = ?", cwd, agentId);
	const a = getAgent(db, agentId);
	const s = newSessionAttempt(ctx, a, { status: "LIVE", harness, provider, model });
	const ts = nowIso();
	run(db, "UPDATE sessions SET enrolled_at = ? WHERE id = ?", ts, s.session_id);
	run(db, "UPDATE agents SET observed_state = 'LIVE', status = 'RUNNING', last_heartbeat_at = ?, lease_until = ? WHERE id = ?", ts, isoPlus(ctx.t.leaseMs), agentId);
	const token = issueSessionToken(db, { run_id: runId, agent_id: agentId, session_id: s.session_id, generation: s.generation });
	emit(db, { run_id: runId, actor_id: "operator", type: "session.joined", entity_id: agentId, payload: { session_id: s.session_id, harness, manager_id: managerId } });
	return { run_id: runId, agent_id: agentId, session_id: s.session_id, token };
}

/** POST /sessions/leave: end this session without closing the agent; its manager is told. */
export function leaveSession(ctx: Ctx, p: Principal, body: unknown): LeaveResponse {
	const a = requireAgent(p);
	const db = ctx.db;
	const b = obj(body ?? {});
	onlyKeys(b, ["reason"]);
	const reason = str(b, "reason", { optional: true }) ?? "session left";
	const ts = nowIso();
	run(db, "UPDATE sessions SET status = 'STOPPED', ended_at = COALESCE(ended_at, ?) WHERE id = ?", ts, a.session_id);
	run(db, "UPDATE agents SET observed_state = 'STOPPED', lease_until = NULL WHERE id = ? AND current_session_id = ?", a.actor_id, a.session_id);
	revokeSessionTokens(db, a.session_id, "session left");
	// The lead hears about it, whether it manages this agent in-team or through a link.
	const mgr = getLead(db, a.actor_id);
	if (mgr && !isTerminal(getAgent(db, mgr).status)) postMessage(db, { run_id: getAgent(db, mgr).run_id, from: a.actor_id, to: mgr, type: "system.notice", payload: { kind: "member_left", agent_id: a.actor_id, reason, text: `${a.actor_id} left its session (${reason}). Its tasks and identity remain; it can rejoin with /runs/:id/attach. Reassign its open work or close it if it should not return.` } });
	emit(db, { run_id: a.run_id, actor_id: a.actor_id, type: "session.left", entity_id: a.actor_id, payload: { session_id: a.session_id, reason } });
	return { agent_id: a.actor_id, session_id: a.session_id, notified: mgr };
}

/**
 * A member leaves its team to lead its own (docs/design/unified-team-links.md): rerouting a
 * non-root member is leaving, then joining. The old identity is retired in its team (history,
 * roster and the manager's notice remain) without stopping the process: this same session
 * continues, with its transcript, as the root of a new empty team that it can then link
 * under any agent.
 */
export function secede(ctx: Ctx, p: Principal, scope: ReqScope, body: unknown): CreateRunResponse & { previous_agent_id: string; previous_run_id: string } {
	const a = requireAgent(p);
	const db = ctx.db;
	const b = obj(body ?? {});
	onlyKeys(b, ["reason"]);
	const reason = str(b, "reason", { optional: true }) ?? "left the team to lead its own";
	const me = getAgent(db, a.actor_id);
	if (getRun(db, a.run_id).root_agent_id === me.id) fail("CONFLICT", "you already lead this team; link it with /team join instead");
	if (isTerminal(me.status)) fail("CONFLICT", `agent is ${me.status}`);
	const old = runConfig(db, a.run_id);
	const session = get(db, "SELECT pi_session_path, harness FROM sessions WHERE id = ?", a.session_id);
	const meta = parseJson<{ actual_model?: { provider: string; model: string } }>(me.metadata_json, {});
	const current = meta.actual_model ?? me;
	const created = createRun(ctx, { kind: "operator", actor_id: me.id } as Principal, {
		root: { role: me.role, cwd: me.cwd ?? old.workspace_root, provider: current.provider ?? undefined, model: current.model ?? undefined,
			harness: session?.harness ?? "pi", ...(me.pi_session_path || session?.pi_session_path ? { pi_session_path: me.pi_session_path ?? session!.pi_session_path } : {}) },
		config: { models: old.models, limits: old.limits },
	});
	const lead = getLead(db, me.id);
	if (lead && !isTerminal(getAgent(db, lead).status)) postMessage(db, { run_id: getAgent(db, lead).run_id, from: me.id, to: lead, type: "system.notice", payload: {
		kind: "member_seceded", agent_id: me.id, new_run_id: created.run_id, new_agent_id: created.root_agent_id, reason,
		text: `${me.role} [${me.id}] left this team to lead its own team ${created.run_id} as ${created.root_agent_id} (${reason}). Its open tasks here were cancelled; its members, if any, now report to you. It may link under another agent.`,
	} });
	terminateAgent(ctx, scope, me.id, "RETIRED", me.id, `seceded: ${reason}`, { keepProcess: true });
	emit(db, { run_id: a.run_id, actor_id: me.id, type: "agent.seceded", entity_id: me.id, payload: { new_run_id: created.run_id, new_agent_id: created.root_agent_id, reason } });
	return { ...created, previous_agent_id: me.id, previous_run_id: a.run_id };
}
