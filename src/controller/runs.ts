import { reportingStatus } from "./reporting.ts";
// Runs, sessions (attach/enroll/heartbeat/usage) and read projections (tree, me, inspect, budgets, models, events).
import { isAbsolute } from "node:path";
import { type DB, type Row, all, get, run, newId, nowIso, isoPlus, emit, parseJson } from "./db.ts";
import { fail } from "./errors.ts";
import type { Ctx, Principal } from "./context.ts";
import type {
	AttachResponse,
	BudgetView,
	CreateRunResponse,
	EnrollResponse,
	EventsResponse,
	HeartbeatResponse,
	InspectResponse,
	ModelsResponse,
	OrgContext,
	RunConfig,
	RunListResponse,
	TreeNode,
	TreeResponse,
	UsageReportResponse,
} from "../shared/protocol.ts";
import { obj, str, int, onlyKeys } from "./validate.ts";
import { buildRunConfig, modelIneligibility } from "./config.ts";
import { hashToken, issueSessionToken, revokeAgentCredentials } from "./auth.ts";
import { getAgent, getAllocation, getAncestry, getChildren, getCurrentManager, getReportingHistory, getRun, getSubtree, isAncestor, isTerminal, runConfig } from "./queries.ts";
import { budgetPool, budgetView, ownBudgetUsd } from "./budgets.ts";
import { inboxPending, postMessage, requireAgent } from "./messaging.ts";

function requireOperator(p: Principal): void {
	if (p.kind !== "operator") fail("FORBIDDEN", "operator token required");
}

/** Scoped read: operator, or an agent of the same run. */
function assertRunRead(p: Principal, runId: string): void {
	if (p.kind === "agent" && p.run_id !== runId) fail("FORBIDDEN", "other run");
}

function nextGeneration(db: DB, agentId: string): number {
	return Number(get(db, "SELECT COALESCE(MAX(generation),0) AS g FROM sessions WHERE agent_id = ?", agentId)!.g) + 1;
}

/** New session attempt for an agent; fences (revokes) every older token/credential and supersedes older sessions. */
export function newSessionAttempt(
	ctx: Ctx,
	a: Row,
	s: { status: string; provider?: string | null; model?: string | null; pi_session_id?: string | null; pi_session_path?: string | null; spawn_intent_id?: string | null },
): { session_id: string; generation: number } {
	const db = ctx.db;
	const id = newId("ses");
	const gen = nextGeneration(db, a.id);
	const ts = nowIso();
	revokeAgentCredentials(db, a.id, "superseded");
	run(db, "UPDATE sessions SET status = CASE WHEN status IN ('LIVE','STARTING','REQUESTED') THEN 'STOPPED' ELSE status END, ended_at = COALESCE(ended_at, ?) WHERE agent_id = ? AND status IN ('LIVE','STARTING','REQUESTED','LOST')", ts, a.id);
	run(
		db,
		`INSERT INTO sessions(id, agent_id, harness, provider, model, status, started_at, pi_session_path, pi_session_id, controller_epoch, generation, spawn_intent_id)
		 VALUES (?,?, 'pi', ?,?,?,?,?,?,?,?,?)`,
		id,
		a.id,
		s.provider ?? a.provider ?? "default",
		s.model ?? a.model ?? "default",
		s.status,
		ts,
		s.pi_session_path ?? a.pi_session_path ?? null,
		s.pi_session_id ?? null,
		ctx.epoch(),
		gen,
		s.spawn_intent_id ?? null,
	);
	run(db, "UPDATE agents SET current_session_id = ? WHERE id = ?", id, a.id);
	return { session_id: id, generation: gen };
}

export function createRun(ctx: Ctx, p: Principal, body: unknown): CreateRunResponse {
	requireOperator(p);
	const db = ctx.db;
	const b = obj(body);
	onlyKeys(b, ["config", "root"]);
	const root = obj(b.root);
	onlyKeys(root, ["role", "pi_session_id", "pi_session_path", "cwd", "provider", "model"]);
	const role = str(root, "role");
	const cwd = str(root, "cwd");
	if (!isAbsolute(cwd)) fail("INVALID", "root.cwd must be absolute");
	const provider = str(root, "provider", { optional: true });
	const model = str(root, "model", { optional: true });
	if (b.config !== undefined && (typeof b.config !== "object" || b.config === null)) fail("INVALID", "config must be an object");
	const cfg: RunConfig = buildRunConfig(b.config as Partial<RunConfig> | undefined, { role, cwd, provider, model });
	const runId = newId("run");
	const agentId = newId("agent");
	const ts = nowIso();
	run(db, "INSERT INTO runs(id, created_at, status, config_json, topology_version) VALUES (?,?, 'RUNNING', ?, 0)", runId, ts, JSON.stringify(cfg));
	run(
		db,
		`INSERT INTO agents(id, run_id, role, status, created_at, metadata_json, desired_state, observed_state, provider, model, model_id, cwd, pi_session_path, last_heartbeat_at, lease_until)
		 VALUES (?,?,?, 'RUNNING', ?, ?, 'RUNNING', 'LIVE', ?,?, 'leader', ?,?,?,?)`,
		agentId,
		runId,
		role,
		ts,
		JSON.stringify({ root: true }),
		provider ?? "default",
		model ?? "default",
		cwd,
		str(root, "pi_session_path", { optional: true }) ?? null,
		ts,
		isoPlus(ctx.t.leaseMs),
	);
	run(db, "UPDATE runs SET root_agent_id = ? WHERE id = ?", agentId, runId);
	run(db, "INSERT INTO allocations(agent_id, limits_json) VALUES (?,?)", agentId, JSON.stringify(cfg.root_envelope));
	const a = getAgent(db, agentId);
	const s = newSessionAttempt(ctx, a, { status: "LIVE", pi_session_id: str(root, "pi_session_id", { optional: true }), pi_session_path: str(root, "pi_session_path", { optional: true }) });
	run(db, "UPDATE sessions SET enrolled_at = ? WHERE id = ?", ts, s.session_id);
	const token = issueSessionToken(db, { run_id: runId, agent_id: agentId, session_id: s.session_id, generation: s.generation });
	emit(db, { run_id: runId, actor_id: "operator", type: "run.created", entity_id: runId, payload: { root_agent_id: agentId, limits: cfg.limits, models: cfg.models.map((m) => m.id) } });
	emit(db, { run_id: runId, actor_id: "operator", type: "agent.created", entity_id: agentId, payload: { parent_id: null, role, root: true, envelope: cfg.root_envelope, topology_version: 0 } });
	return { run_id: runId, root_agent_id: agentId, session_id: s.session_id, token, envelope: cfg.root_envelope };
}

export function listRuns(ctx: Ctx, p: Principal): RunListResponse {
	requireOperator(p);
	const rows = all(ctx.db, `SELECT r.*, root.status AS root_status, (SELECT COUNT(*) FROM agents a WHERE a.run_id = r.id) AS n,
		(SELECT COUNT(*) FROM agents a WHERE a.run_id = r.id AND a.id <> r.root_agent_id AND a.status NOT IN ('COMPLETED','FAILED','CANCELLED','RETIRED')) AS active_members,
		(SELECT COUNT(*) FROM agents a WHERE a.run_id = r.id AND a.id <> r.root_agent_id AND a.status NOT IN ('COMPLETED','FAILED','CANCELLED','RETIRED') AND a.observed_state = 'LIVE' AND a.desired_state = 'RUNNING') AS live_members
		FROM runs r LEFT JOIN agents root ON root.id = r.root_agent_id ORDER BY r.created_at`);
	return { runs: rows.map((r) => ({
		reports_to_run_id: get(ctx.db, "SELECT parent_run_id FROM team_reporting_links WHERE child_run_id = ? AND closed_at IS NULL", r.id)?.parent_run_id ?? null,
		reporting_teams: Number(get(ctx.db, "SELECT COUNT(*) AS n FROM team_reporting_links WHERE parent_run_id = ? AND closed_at IS NULL", r.id)!.n),
		run_id: r.id, status: r.root_status === "CANCELLED" ? "CANCELLED" : r.status, root_status: r.root_status, active_members: Number(r.active_members), live_members: Number(r.live_members), root_agent_id: r.root_agent_id, created_at: r.created_at, topology_version: r.topology_version, agents: Number(r.n) })) };
}

export function attach(ctx: Ctx, p: Principal, runId: string, body: unknown): AttachResponse {
	requireOperator(p);
	const db = ctx.db;
	const b = obj(body ?? {});
	onlyKeys(b, ["agent_id", "pi_session_id", "pi_session_path", "mode"]);
	if (b.mode !== undefined && b.mode !== "attach") fail("FORBIDDEN", "only mode=attach is supported in v1 (fork requires approval)");
	const runRow = getRun(db, runId);
	const agentId = str(b, "agent_id", { optional: true }) ?? runRow.root_agent_id;
	const a = getAgent(db, agentId);
	if (a.run_id !== runId) fail("NOT_FOUND", "agent not in run");
	if (isTerminal(a.status)) fail("CONFLICT", `agent is ${a.status}`);
	const s = newSessionAttempt(ctx, a, { status: "LIVE", pi_session_id: str(b, "pi_session_id", { optional: true }), pi_session_path: str(b, "pi_session_path", { optional: true }) });
	const ts = nowIso();
	run(db, "UPDATE sessions SET enrolled_at = ? WHERE id = ?", ts, s.session_id);
	run(
		db,
		"UPDATE agents SET observed_state = 'LIVE', last_heartbeat_at = ?, lease_until = ?, status = CASE WHEN status IN ('PROVISIONING','PAUSED') AND desired_state = 'RUNNING' THEN 'RUNNING' ELSE status END WHERE id = ?",
		ts,
		isoPlus(ctx.t.leaseMs),
		agentId,
	);
	const token = issueSessionToken(db, { run_id: runId, agent_id: agentId, session_id: s.session_id, generation: s.generation });
	emit(db, { run_id: runId, actor_id: "operator", type: "session.attached", entity_id: agentId, payload: { session_id: s.session_id, generation: s.generation } });
	return { run_id: runId, agent_id: agentId, session_id: s.session_id, token };
}

export function enroll(ctx: Ctx, body: unknown): EnrollResponse {
	const db = ctx.db;
	const b = obj(body);
	onlyKeys(b, ["token", "agent_id", "spawn_intent_id", "pi_session_id", "pi_session_path", "pid", "process_started_at", "launch_token"]);
	const secret = str(b, "token");
	const agentId = str(b, "agent_id");
	const intentId = str(b, "spawn_intent_id");
	const pid = int(b, "pid");
	const cred = get(db, "SELECT * FROM enrollment_credentials WHERE token_hash = ?", hashToken(secret));
	if (!cred) fail("UNAUTHENTICATED", "invalid enrollment credential");
	if (cred.agent_id !== agentId || cred.spawn_intent_id !== intentId) fail("UNAUTHENTICATED", "enrollment credential does not match agent/spawn intent");
	if (cred.used_at) fail("UNAUTHENTICATED", "enrollment credential already used");
	if (cred.expires_at < nowIso()) fail("UNAUTHENTICATED", "enrollment credential expired");
	if (cred.revoked_at) fail("STALE_SESSION", "enrollment credential was revoked (launch attempt superseded)");
	const a = getAgent(db, agentId);
	if (isTerminal(a.status)) fail("CONFLICT", `agent is ${a.status}`);
	if (a.current_session_id !== cred.session_id) fail("STALE_SESSION", "launch attempt superseded");
	const intent = get(db, "SELECT * FROM spawn_intents WHERE id = ?", intentId);
	if (!intent || !["LAUNCHING", "LAUNCHED"].includes(intent.status) || intent.session_id !== cred.session_id) fail("CONFLICT", `spawn intent is ${intent?.status ?? "missing"}`);
	const launchToken = str(b, "launch_token", { optional: true }) ?? null;
	const sess = get(db, "SELECT launch_token FROM sessions WHERE id = ?", cred.session_id);
	if (launchToken && sess?.launch_token && sess.launch_token !== launchToken) fail("UNAUTHENTICATED", "launch token does not match the launched process");
	const ts = nowIso();
	run(db, "UPDATE enrollment_credentials SET used_at = ? WHERE token_hash = ?", ts, cred.token_hash);
	if (launchToken) run(db, "UPDATE sessions SET launch_token = COALESCE(launch_token, ?) WHERE id = ?", launchToken, cred.session_id);
	const procStart = str(b, "process_started_at", { optional: true }) ?? null;
	run(
		db,
		`UPDATE sessions SET status = 'LIVE', enrolled_at = ?, reported_pid = ?, pid = COALESCE(pid, ?), process_started_at = COALESCE(process_started_at, ?),
		 pi_session_id = COALESCE(?, pi_session_id), pi_session_path = COALESCE(?, pi_session_path) WHERE id = ?`,
		ts,
		pid,
		pid,
		procStart,
		str(b, "pi_session_id", { optional: true }) ?? null,
		str(b, "pi_session_path", { optional: true }) ?? null,
		cred.session_id,
	);
	run(
		db,
		`UPDATE agents SET observed_state = 'LIVE', last_heartbeat_at = ?, lease_until = ?,
		 status = CASE WHEN desired_state = 'PAUSED' THEN 'PAUSED' WHEN status IN ('PROVISIONING','PAUSED') THEN 'RUNNING' ELSE status END WHERE id = ?`,
		ts,
		isoPlus(ctx.t.leaseMs),
		agentId,
	);
	run(db, "UPDATE spawn_intents SET status = 'LIVE', updated_at = ? WHERE id = ?", ts, intentId);
	const session = get(db, "SELECT generation FROM sessions WHERE id = ?", cred.session_id)!;
	const token = issueSessionToken(db, { run_id: a.run_id, agent_id: agentId, session_id: cred.session_id, generation: session.generation });
	emit(db, { run_id: a.run_id, actor_id: agentId, type: "session.enrolled", entity_id: agentId, payload: { session_id: cred.session_id, generation: session.generation, pid, spawn_intent_id: intentId } });
	const spec = parseJson<{ task_id?: string }>(intent.spec_json, {});
	return { run_id: a.run_id, agent_id: agentId, session_id: cred.session_id, token, parent_id: getCurrentManager(db, agentId), task_id: spec.task_id ?? null };
}

export function heartbeat(ctx: Ctx, p: Principal, body: unknown): HeartbeatResponse {
	const a = requireAgent(p);
	const db = ctx.db;
	const b = obj(body ?? {});
	onlyKeys(b, ["busy", "pi_session_id", "pi_session_path", "last_entry_id"]);
	const ts = nowIso();
	const lease = isoPlus(ctx.t.leaseMs);
	const before = getAgent(db, a.actor_id);
	run(db, "UPDATE agents SET last_heartbeat_at = ?, lease_until = ?, observed_state = 'LIVE' WHERE id = ?", ts, lease, a.actor_id);
	run(
		db,
		"UPDATE sessions SET status = 'LIVE', pi_session_id = COALESCE(?, pi_session_id), pi_session_path = COALESCE(?, pi_session_path) WHERE id = ?",
		str(b, "pi_session_id", { optional: true }) ?? null,
		str(b, "pi_session_path", { optional: true }) ?? null,
		a.session_id,
	);
	const last = str(b, "last_entry_id", { optional: true });
	if (last) {
		const prev = get(db, "SELECT last_entry_id FROM session_checkpoints WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", a.session_id);
		if (prev?.last_entry_id !== last) run(db, "INSERT INTO session_checkpoints(id, session_id, last_entry_id, created_at) VALUES (?,?,?,?)", newId("ckpt"), a.session_id, last, ts);
	}
	if (before.observed_state !== "LIVE") emit(db, { run_id: a.run_id, actor_id: a.actor_id, type: "agent.reconnected", entity_id: a.actor_id, payload: { from: before.observed_state, session_id: a.session_id } });
	const change = parseJson<{ model_change?: import("../shared/protocol.ts").ModelChange }>(before.metadata_json, {}).model_change;
	return { reporting_wake: getRun(db, a.run_id).root_agent_id === a.actor_id && reportingStatus(db, a.run_id).wake_on_message, lease_until: lease, inbox_pending: inboxPending(db, a.actor_id), desired_state: before.desired_state, ...(change ? { model_change: change } : {}) };
}

/** POST /sessions/usage (UsageReportRequest). */
export function reportUsage(ctx: Ctx, p: Principal, body: unknown): UsageReportResponse {
	const a = requireAgent(p);
	const db = ctx.db;
	const b = obj(body);
	onlyKeys(b, ["cost_usd", "input_tokens", "output_tokens", "model"]);
	const cost = b.cost_usd;
	if (typeof cost !== "number" || !(cost >= 0)) fail("INVALID", "cost_usd must be a non-negative number");
	run(db, "UPDATE allocations SET consumed_usd = consumed_usd + ? WHERE agent_id = ?", cost, a.actor_id);
	const consumed = getAllocation(db, a.actor_id).consumed_usd;
	emit(db, { run_id: a.run_id, actor_id: a.actor_id, type: "usage.reported", entity_id: a.actor_id, payload: { cost_usd: cost, input_tokens: b.input_tokens ?? null, output_tokens: b.output_tokens ?? null, consumed_usd: consumed } });
	const own = ownBudgetUsd(db, a.actor_id);
	// Inherited pools charge actual spend once; exhausting one pauses the whole affected subtree.
	const cfg = runConfig(db, a.run_id);
	const exhaustedPools = cfg.operator_unlimited ? [] : [a.actor_id, ...getAncestry(db, a.actor_id)].filter((id) => {
		const al = getAllocation(db, id);
		return al.limits.max_subtree_usd !== null && al.spent_usd >= al.limits.max_subtree_usd - 1e-9;
	});
	for (const pool of exhaustedPools) for (const id of getSubtree(db, pool).filter((id) => id !== a.actor_id)) {
		run(db, "UPDATE agents SET desired_state='PAUSED', status=CASE WHEN status='RUNNING' THEN 'PAUSED' ELSE status END WHERE id=? AND desired_state='RUNNING'", id);
	}
	const pool = budgetPool(db, a.actor_id);
	const ownExhausted = own !== null && pool.consumed >= own - 1e-9;
	if (ownExhausted) for (const id of pool.members.filter((id) => id !== a.actor_id)) {
		run(db, "UPDATE agents SET desired_state='PAUSED', status=CASE WHEN status='RUNNING' THEN 'PAUSED' ELSE status END WHERE id=? AND desired_state='RUNNING' AND status NOT IN ('CANCELLED','RETIRED','FAILED')", id);
	}
	const exhausted = ownExhausted || exhaustedPools.length > 0;
	if (exhausted && getAgent(db, a.actor_id).desired_state === "RUNNING") {
		run(db, "UPDATE agents SET desired_state = 'PAUSED', status = CASE WHEN status = 'RUNNING' THEN 'PAUSED' ELSE status END WHERE id = ?", a.actor_id);
		emit(db, { run_id: a.run_id, actor_id: "controller", type: "budget.exhausted", entity_id: a.actor_id, payload: { consumed_usd: consumed, budget_usd: own } });
		postMessage(db, { run_id: a.run_id, from: getCurrentManager(db, a.actor_id) ?? a.actor_id, to: a.actor_id, type: "agent.lifecycle", payload: { action: "pause", agent_id: a.actor_id, reason: "budget exhausted" } });
		const mgr = getCurrentManager(db, a.actor_id);
		if (mgr) {
			postMessage(db, { run_id: a.run_id, from: a.actor_id, to: mgr, type: "system.notice", payload: { kind: "budget_paused", agent_id: a.actor_id, consumed_usd: consumed, budget_usd: own, text: `worker paused: budget exhausted ($${consumed} of $${own}). Its process stays up (tmux pane, if any, is unaffected); resume it with team_set_budget (resume: true) or a lifecycle resume.` } });
		}
	}
	return { consumed_usd: consumed, budget_exhausted: exhausted };
}

// ---- read projections --------------------------------------------------------

function nodeOf(db: DB, a: Row): Omit<TreeNode, "children"> {
	const meta = parseJson<{ actual_model?: { provider: string; model: string }; model_change?: { provider: string; model: string } }>(a.metadata_json, {});
	const current = meta.model_change && meta.actual_model ? meta.actual_model : a;
	return { agent_id: a.id, role: a.role, status: a.status, desired_state: a.desired_state, observed_state: a.observed_state, model: current.model ? `${current.provider}/${current.model}` : null, ...(meta.model_change ? { pending_model: `${meta.model_change.provider}/${meta.model_change.model}` } : {}), parent_id: getCurrentManager(db, a.id) };
}

export function tree(ctx: Ctx, p: Principal, runId: string, activeOnly = false): TreeResponse {
	assertRunRead(p, runId);
	const db = ctx.db;
	const r = getRun(db, runId);
	const build = (id: string): TreeNode => ({ ...nodeOf(db, getAgent(db, id)), children: getChildren(db, id).filter((child) => !activeOnly || !isTerminal(getAgent(db, child).status)).map(build) });
	const history = all(db, "SELECT child_id, parent_id, valid_from, valid_to FROM reporting_edges WHERE run_id = ? ORDER BY valid_from, rowid", runId) as TreeResponse["history"];
	return { run_id: runId, topology_version: r.topology_version, root: build(r.root_agent_id), history };
}

export function me(ctx: Ctx, p: Principal): OrgContext {
	const a = requireAgent(p);
	const db = ctx.db;
	const ag = getAgent(db, a.actor_id);
	const parentId = getCurrentManager(db, a.actor_id);
	const parent = parentId ? getAgent(db, parentId) : null;
	return {
		run_id: a.run_id,
		agent_id: a.actor_id,
		session_id: a.session_id,
		role: ag.role,
		is_root: parentId === null,
		...(parentId === null ? { reporting: reportingStatus(db, a.run_id) } : {}),
		parent: parent ? { agent_id: parent.id, role: parent.role } : null,
		children: getChildren(db, a.actor_id).filter((id) => !isTerminal(getAgent(db, id).status)).map((c) => {
			const x = getAgent(db, c);
			return { agent_id: x.id, role: x.role, status: x.status, observed_state: x.observed_state };
		}),
		peers: parentId
			? getChildren(db, parentId)
					.filter((c) => c !== a.actor_id)
					.map((c) => getAgent(db, c))
					.filter((x) => !isTerminal(x.status))
					.map((x) => ({ agent_id: x.id, role: x.role, status: x.status, observed_state: x.observed_state }))
			: [],
		tasks: all(db, "SELECT id, title, status, parent_task_id FROM tasks WHERE owner_id = ? AND status NOT IN ('DONE','CANCELLED','FAILED') ORDER BY created_at", a.actor_id).map((t) => ({ task_id: t.id, title: t.title, status: t.status, parent_task_id: t.parent_task_id ?? null })),
		envelope: getAllocation(db, a.actor_id).limits,
		budget: budgetView(db, a.actor_id),
		pending_proposals_to_review: Number(get(db, "SELECT COUNT(*) AS n FROM proposals WHERE reviewer_id = ? AND status IN ('PENDING','UNDER_REVIEW','ESCALATED')", a.actor_id)!.n),
		inbox_pending: inboxPending(db, a.actor_id),
		desired_state: ag.desired_state,
		topology_version: getRun(db, a.run_id).topology_version,
	};
}

export function inspect(ctx: Ctx, p: Principal, agentId: string): InspectResponse {
	const db = ctx.db;
	const a = getAgent(db, agentId);
	assertRunRead(p, a.run_id);
	return {
		agent: { ...nodeOf(db, a), children: [], metadata: parseJson(a.metadata_json, {}), created_at: a.created_at, last_heartbeat_at: a.last_heartbeat_at ?? null },
		sessions: all(db, "SELECT * FROM sessions WHERE agent_id = ? ORDER BY generation", agentId).map((s) => ({
			session_id: s.id,
			status: s.status,
			provider: s.provider,
			model: s.model,
			pi_session_path: s.pi_session_path ?? null,
			started_at: s.started_at ?? null,
			ended_at: s.ended_at ?? null,
			pid: s.pid ?? null,
			process_started_at: s.process_started_at ?? null,
		})),
		tasks: all(db, "SELECT id, title, status FROM tasks WHERE owner_id = ? ORDER BY created_at", agentId).map((t) => ({ task_id: t.id, title: t.title, status: t.status })),
		reporting_history: getReportingHistory(db, agentId).map((h) => ({ parent_id: h.parent_id, valid_from: h.valid_from, valid_to: h.valid_to })),
		budget: budgetView(db, agentId),
	};
}

export function budget(ctx: Ctx, p: Principal, agentId: string): BudgetView {
	const a = getAgent(ctx.db, agentId);
	if (p.kind === "agent") {
		if (p.run_id !== a.run_id) fail("FORBIDDEN", "other run");
		if (p.actor_id !== agentId && !isAncestor(ctx.db, p.actor_id, agentId)) fail("FORBIDDEN", "budgets are visible to self and ancestors only");
	}
	return budgetView(ctx.db, agentId);
}

export function models(ctx: Ctx, p: Principal, q: URLSearchParams): ModelsResponse {
	const runId = p.kind === "agent" ? p.run_id : q.get("run_id");
	if (!runId) fail("INVALID", "run_id required for operator");
	const cfg = runConfig(ctx.db, runId);
	const chain = p.kind === "agent" ? [p.actor_id, ...getAncestry(ctx.db, p.actor_id)].map((x) => getAllocation(ctx.db, x).limits.allowed_providers) : [];
	return {
		models: cfg.models.map((m) => {
			const why = modelIneligibility(m, cfg, chain);
			return why ? { ...m, eligible: false, ineligible_reason: why } : { ...m, eligible: true };
		}),
	};
}

export function events(ctx: Ctx, p: Principal, q: URLSearchParams): EventsResponse {
	const runId = p.kind === "agent" ? p.run_id : q.get("run_id");
	if (p.kind === "agent" && q.get("run_id") && q.get("run_id") !== p.run_id) fail("FORBIDDEN", "other run");
	const after = Number(q.get("after") ?? 0) || 0;
	const limit = Math.min(Math.max(Number(q.get("limit") ?? 200) || 200, 1), 1000);
	const rows = runId ? all(ctx.db, "SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?", runId, after, limit) : all(ctx.db, "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit);
	const evs = rows.map((r) => ({ seq: r.seq, id: r.id, run_id: r.run_id, actor_id: r.actor_id ?? null, type: r.type, entity_id: r.entity_id ?? null, payload: parseJson(r.payload_json, {}), created_at: r.created_at }));
	return { events: evs, next_after: evs.length ? evs[evs.length - 1].seq : after };
}
