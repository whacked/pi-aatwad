// Whole-team operator lifecycle: stop is a resumable suspension, remove is permanent.
// Neither touches the operator's Pi process, project files or worktrees.
import type { Ctx, Principal, ReqScope } from "./context.ts";
import type { RunConfig, TeamLifecycleResponse, TeamLifecycleState } from "../shared/protocol.ts";
import { type DB, all, emit, get, newId, nowIso, run, tx } from "./db.ts";
import { fail } from "./errors.ts";
import { obj, onlyKeys, str } from "./validate.ts";
import { getRun, getSubtree, isTerminal, runConfig, TERMINAL_SQL } from "./queries.ts";
import { terminateAgent } from "./topology.ts";

type Proc = { pid: number; process_started_at: string };

function operator(p: Principal): void {
	if (p.kind !== "operator") fail("FORBIDDEN", "operator token required");
}
function save(db: DB, runId: string, cfg: RunConfig): void {
	run(db, "UPDATE runs SET config_json = ? WHERE id = ?", JSON.stringify(cfg), runId);
}
function receipt(runId: string, s: TeamLifecycleState): TeamLifecycleResponse {
	return { operation_id: s.operation_id, run_id: runId, kind: s.kind, state: s.state, ...(s.error ? { error: s.error } : {}) };
}

export function teamLifecycleState(db: DB, runId: string): TeamLifecycleState | undefined {
	return runConfig(db, runId).team_lifecycle;
}
export function isRemoved(cfg: RunConfig): boolean {
	return cfg.team_lifecycle?.state === "REMOVED";
}
/** Removed teams no longer exist for callers; their rows remain only as an audit tombstone. */
function liveConfig(db: DB, runId: string): RunConfig {
	const cfg = runConfig(db, runId);
	if (isRemoved(cfg)) fail("NOT_FOUND", `team ${runId} was permanently removed`);
	return cfg;
}
/** Attach must not revive a suspended team behind the operator's back. */
export function assertAttachable(db: DB, runId: string): void {
	const state = liveConfig(db, runId).team_lifecycle?.state;
	if (state === "STOPPED" || state === "CLEANING") fail("CONFLICT", `team ${runId} is stopped; resume it first (/team resume ${runId})`, { reason: "team_stopped" });
}

/** Stop owned worker processes after commit, then settle CLEANING -> STOPPED. */
function cleanup(ctx: Ctx, scope: ReqScope, runId: string, operationId: string, procs: Proc[]): void {
	scope.after(async () => {
		const errors: string[] = [];
		for (const pr of procs) await ctx.stopProcess(pr.pid, pr.process_started_at).catch((e) => errors.push(`pid ${pr.pid}: ${String((e as Error)?.message ?? e)}`));
		tx(ctx.db, () => {
			const cfg = runConfig(ctx.db, runId), s = cfg.team_lifecycle;
			if (!s || s.operation_id !== operationId || s.state !== "CLEANING") return;
			if (errors.length) s.error = errors.join("; ");
			else { s.state = "STOPPED"; delete s.error; delete s.pending; }
			save(ctx.db, runId, cfg);
		});
		ctx.kick();
	});
}

export function stopTeam(ctx: Ctx, p: Principal, scope: ReqScope, runId: string): TeamLifecycleResponse {
	operator(p);
	const db = ctx.db, r = getRun(db, runId), cfg = liveConfig(db, runId), prev = cfg.team_lifecycle;
	if (prev && (prev.state === "STOPPED" || prev.state === "CLEANING")) {
		// Retry is how an interrupted or failed cleanup finishes.
		if (prev.state === "CLEANING") cleanup(ctx, scope, runId, prev.operation_id, prev.pending ?? []);
		return receipt(runId, prev);
	}
	if (isTerminal(get(db, "SELECT status FROM agents WHERE id = ?", r.root_agent_id)?.status ?? "CANCELLED")) fail("CONFLICT", `team ${runId} has already ended and cannot be stopped`);
	const ts = nowIso(), suspended: string[] = [], procs: Proc[] = [];
	for (const a of all(db, `SELECT a.id, a.desired_state, a.current_session_id, s.pid, s.process_started_at FROM agents a LEFT JOIN sessions s ON s.id = a.current_session_id WHERE a.run_id = ? AND a.status NOT IN ${TERMINAL_SQL}`, runId)) {
		// Only members that were meant to run come back on resume; deliberate pauses stay paused.
		if (a.desired_state === "RUNNING") suspended.push(a.id);
		run(db, "UPDATE agents SET desired_state = CASE WHEN desired_state = 'RUNNING' THEN 'PAUSED' ELSE desired_state END, status = CASE WHEN status = 'RUNNING' THEN 'PAUSED' ELSE status END, observed_state = 'STOPPED', lease_until = NULL WHERE id = ?", a.id);
		run(db, "UPDATE sessions SET status = 'STOPPED', ended_at = COALESCE(ended_at, ?) WHERE agent_id = ? AND status IN ('REQUESTED','STARTING','LIVE','LOST')", ts, a.id);
		run(db, "UPDATE auth_tokens SET revoked_at = ?, revoke_reason = 'team_stopped' WHERE agent_id = ? AND revoked_at IS NULL", ts, a.id);
		run(db, "UPDATE enrollment_credentials SET revoked_at = ? WHERE agent_id = ? AND used_at IS NULL AND revoked_at IS NULL", ts, a.id);
		// The root is the operator's own Pi: never a controller-owned process.
		if (a.id !== r.root_agent_id && a.pid != null) procs.push({ pid: a.pid, process_started_at: a.process_started_at ?? "" });
	}
	const state: TeamLifecycleState = { operation_id: newId("teamop"), kind: "stop", state: procs.length ? "CLEANING" : "STOPPED", at: ts, suspended, ...(procs.length ? { pending: procs } : {}) };
	cfg.team_lifecycle = state;
	save(db, runId, cfg);
	emit(db, { run_id: runId, actor_id: p.actor_id, type: "run.stopped", entity_id: runId, payload: { operation_id: state.operation_id, suspended } });
	if (procs.length) cleanup(ctx, scope, runId, state.operation_id, procs);
	return receipt(runId, state);
}

export function resumeTeam(ctx: Ctx, p: Principal, scope: ReqScope, runId: string): TeamLifecycleResponse {
	operator(p);
	const db = ctx.db;
	getRun(db, runId);
	const cfg = liveConfig(db, runId), s = cfg.team_lifecycle;
	// Teams that were never stopped are trivially resumed: /team resume then only re-attaches.
	if (!s || s.state === "RESUMED") return receipt(runId, s ?? { operation_id: newId("teamop"), kind: "stop", state: "RESUMED", at: nowIso() });
	if (s.state === "CLEANING") {
		cleanup(ctx, scope, runId, s.operation_id, s.pending ?? []);
		return receipt(runId, s);
	}
	const ts = nowIso();
	for (const id of s.suspended ?? []) {
		// A fresh retry budget: stop/resume cycles are operator decisions, not crashes.
		run(db, `UPDATE agents SET desired_state = 'RUNNING', status = CASE WHEN status = 'PAUSED' THEN 'RUNNING' ELSE status END, restart_attempts = 0, metadata_json = json_set(metadata_json, '$.runtime_epoch', ?) WHERE id = ? AND desired_state = 'PAUSED' AND status NOT IN ${TERMINAL_SQL}`, ts, id);
	}
	cfg.team_lifecycle = { operation_id: s.operation_id, kind: "stop", state: "RESUMED", at: ts };
	save(db, runId, cfg);
	emit(db, { run_id: runId, actor_id: p.actor_id, type: "run.resumed", entity_id: runId, payload: { operation_id: s.operation_id, resumed: s.suspended ?? [] } });
	ctx.kick();
	return receipt(runId, cfg.team_lifecycle);
}

export function removeTeam(ctx: Ctx, p: Principal, scope: ReqScope, runId: string, body: unknown): TeamLifecycleResponse {
	operator(p);
	const db = ctx.db, b = obj(body);
	onlyKeys(b, ["confirm_run_id"]);
	if (str(b, "confirm_run_id") !== runId) fail("INVALID", "confirm_run_id must repeat the team being removed");
	const r = getRun(db, runId), cfg = runConfig(db, runId);
	if (isRemoved(cfg)) return receipt(runId, cfg.team_lifecycle!);
	const reason = "team removed by operator";
	// Deepest first, including already-terminal members: interrupted shutdowns may have left
	// sessions, spawn intents or reservations behind. Stops owned processes after commit.
	for (const id of getSubtree(db, r.root_agent_id).reverse()) terminateAgent(ctx, scope, id, "CANCELLED", p.actor_id, reason);
	for (const a of all(db, `SELECT id FROM agents WHERE run_id = ? AND status NOT IN ${TERMINAL_SQL}`, runId)) terminateAgent(ctx, scope, a.id, "CANCELLED", p.actor_id, reason);
	const ts = nowIso();
	run(db, "UPDATE auth_tokens SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, 'team_removed') WHERE run_id = ?", ts, runId);
	run(db, "UPDATE enrollment_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE run_id = ? AND used_at IS NULL", ts, runId);
	const after = runConfig(db, runId);
	delete after.terminal;
	after.team_lifecycle = { operation_id: newId("teamop"), kind: "remove", state: "REMOVED", at: ts };
	save(db, runId, after);
	emit(db, { run_id: runId, actor_id: p.actor_id, type: "run.removed", entity_id: runId, payload: { operation_id: after.team_lifecycle.operation_id } });
	ctx.kick();
	return receipt(runId, after.team_lifecycle);
}

export function teamLifecycle(ctx: Ctx, p: Principal, runId: string): TeamLifecycleResponse | null {
	operator(p);
	getRun(ctx.db, runId);
	const s = teamLifecycleState(ctx.db, runId);
	return s ? receipt(runId, s) : null;
}
