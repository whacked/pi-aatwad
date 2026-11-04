// Reconciler: launches PENDING spawn intents (outside SQL transactions), recovers uncertain launches
// on startup, expires heartbeat leases, and restarts LOST agents within retry policy.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Row, all, get, run, tx, nowIso, isoPlus, emit, parseJson } from "./db.ts";
import type { Ctx } from "./context.ts";
import type { Executor, LaunchSpec, ProcessIdentity } from "../executor/types.ts";
import type { EnrollmentFile } from "../shared/protocol.ts";
import { mintSecret, hashToken } from "./auth.ts";
import { getAgent, getAncestry, getSubtree, isTerminal, runConfig, TERMINAL_SQL } from "./queries.ts";
import { tree, newSessionAttempt } from "./runs.ts";
import { prepareWorkspace } from "../executor/workspace.ts";
import { assertLeaseHeld, FencedError } from "./fence.ts";
import { terminateAgent } from "./topology.ts";
import { postMessage, releaseExpiredClaims } from "./messaging.ts";

export class Reconciler {
	ctx: Ctx;
	executor: Executor;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private again = false;
	private stopped = false;
	/** Intents whose launch() is in flight in THIS process (never treated as orphans). */
	private inFlight = new Set<string>();
	/** Optional fence check; returning false stops the reconciler from writing. */
	isLeader: () => boolean = () => true;

	constructor(ctx: Ctx, executor: Executor) {
		this.ctx = ctx;
		this.executor = executor;
	}

	start(): void {
		this.stopped = false;
		const loop = () => {
			if (this.stopped) return;
			this.timer = setTimeout(() => {
				this.kick();
				loop();
			}, this.ctx.t.tickMs);
			this.timer.unref?.();
		};
		loop();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		if (this.running) await this.running.catch(() => {});
	}

	/** Abandon immediately (crash simulation): do not await in-flight launches. */
	abandon(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
	}

	/** Write transaction guarded by the fencing lease; a fenced controller stops reconciling. */
	private wtx<T>(fn: () => T): T {
		return tx(this.ctx.db, () => {
			try {
				assertLeaseHeld(this.ctx);
			} catch (e) {
				if (e instanceof FencedError) {
					this.ctx.log("error", "reconciler fenced; stopping", { holder: e.details });
					this.abandon();
				}
				throw e;
			}
			return fn();
		});
	}

	kick(): void {
		if (this.stopped) return;
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = (async () => {
			do {
				this.again = false;
				try {
					await this.tick();
				} catch (e) {
					this.ctx.log("error", "reconciler tick failed", { err: String((e as Error)?.stack ?? e) });
				}
			} while (this.again && !this.stopped);
		})().finally(() => {
			this.running = null;
		});
	}

	/** Resolves when the current (and any re-kicked) tick finished. Test helper. */
	async idle(): Promise<void> {
		while (this.running) await this.running.catch(() => {});
	}

	async tick(): Promise<void> {
		if (this.stopped || !this.isLeader()) return;
		const db = this.ctx.db;
		this.wtx(() => releaseExpiredClaims(db));
		this.publishOutbox();
		await this.recoverUncertain(false);
		await this.enforceDeadlines();
		await this.checkTerminals();
		await this.promoteTerminals();
		await this.observeExits();
		this.expireLeases();
		await this.scheduleRestarts();
		const pending = all(db, "SELECT id FROM spawn_intents WHERE status = 'PENDING' ORDER BY created_at, role_index, ordinal");
		for (const r of pending) {
			if (this.stopped) return;
			await this.launch(r.id);
		}
		await this.syncTerminals();
	}

	/** Saved terminal locations may disappear between root sessions or after a tmux/server outage. */
	private async checkTerminals(): Promise<void> {
		if (!this.executor.terminalProblem) return;
		for (const r of all(this.ctx.db, "SELECT id, root_agent_id FROM runs WHERE status IN ('RUNNING','PAUSED')")) {
			const cfg = runConfig(this.ctx.db, r.id);
			if (!cfg.terminal) continue;
			const reason = await this.executor.terminalProblem(this.ctx.paths.dir, r.id, cfg.terminal);
			if (!reason) continue;
			this.wtx(() => {
				const current = runConfig(this.ctx.db, r.id);
				if (JSON.stringify(current.terminal) !== JSON.stringify(cfg.terminal)) return;
				delete current.terminal;
				run(this.ctx.db, "UPDATE runs SET config_json = ? WHERE id = ?", JSON.stringify(current), r.id);
				emit(this.ctx.db, { run_id: r.id, actor_id: "controller", type: "run.terminal_fallback", payload: { reason, mode: "headless" } });
				postMessage(this.ctx.db, { run_id: r.id, from: r.root_agent_id, to: r.root_agent_id, type: "system.notice", payload: {
					kind: "terminal_fallback", reason, text: "Team workers are switching to detached execution because tmux is unavailable. Identities, transcripts and tasks are preserved. Use /team watch open after restoring tmux, or /team watch off to keep detached workers." } });
			});
		}
	}

	/** The existing controller coordinates layout; normal usage needs no control pane/process. */
	private async syncTerminals(): Promise<void> {
		if (!this.executor.syncTerminal) return;
		for (const r of all(this.ctx.db, "SELECT id FROM runs WHERE status IN ('RUNNING','PAUSED')")) {
			const cfg = runConfig(this.ctx.db, r.id);
			if (!cfg.terminal) continue;
			try {
				const nodes = tree(this.ctx, { kind: "operator", actor_id: "operator" }, r.id);
				const flat = (node: typeof nodes.root): typeof nodes.root[] => [node, ...node.children.flatMap(flat)];
				const processes = new Map(all(this.ctx.db, "SELECT a.id, s.pid, s.process_started_at FROM agents a LEFT JOIN sessions s ON s.id=a.current_session_id WHERE a.run_id=?", r.id).map((a) => [a.id, a]));
				await this.executor.syncTerminal(this.ctx.paths.dir, r.id, cfg.terminal, flat(nodes.root).slice(1).map((m) => {
					const p = processes.get(m.agent_id);
					return { ...m, ...(p?.pid ? { process: { pid: p.pid, process_started_at: p.process_started_at ?? "" } } : {}) };
				}));
			} catch (e) { this.ctx.log("warn", "terminal layout update failed", { run_id: r.id, error: String(e) }); }
		}
	}

	/** Outbox: events are already durable in `events`; mark them published after logging (at-least-once). */
	private publishOutbox(): void {
		const db = this.ctx.db;
		const rows = all(db, "SELECT o.id, o.topic, e.run_id, e.entity_id, e.actor_id FROM outbox o JOIN events e ON e.id = o.event_id WHERE o.status = 'PENDING' ORDER BY e.seq LIMIT 500");
		if (!rows.length) return;
		for (const r of rows) this.ctx.log("info", "event", { topic: r.topic, run_id: r.run_id, entity_id: r.entity_id, actor_id: r.actor_id });
		this.wtx(() => {
			for (const r of rows) run(db, "UPDATE outbox SET status = 'PUBLISHED', attempts = attempts + 1 WHERE id = ?", r.id);
		});
	}

	/** Change worker terminal mode once, preserving transcripts, tasks and logical IDs. */
	async promoteTerminals(): Promise<void> {
		const db = this.ctx.db;
		const rows = all(db, `SELECT a.*, s.pid, s.process_started_at, s.process_marker, i.id AS intent_id FROM agents a
		 JOIN sessions s ON s.id = a.current_session_id JOIN spawn_intents i ON i.agent_id = a.id
		 WHERE a.desired_state = 'RUNNING' AND a.status NOT IN ${TERMINAL_SQL} AND i.status = 'LIVE'`);
		for (const a of rows) {
			const terminal = runConfig(db, a.run_id).terminal;
			const marker = parseJson<{ terminal?: boolean; terminal_socket?: string | null; terminal_location?: string }>(a.process_marker, {});
			if (!terminal && !marker.terminal) continue;
			if (terminal && marker.terminal && (marker.terminal_socket ?? null) === (terminal.socket ?? null) && (marker.terminal_location ?? "null") === JSON.stringify(terminal.location ?? null)) continue;
			if (a.pid != null) {
				await this.executor.stop({ pid: a.pid, process_started_at: a.process_started_at ?? "" });
				if (await this.executor.probe({ pid: a.pid, process_started_at: a.process_started_at ?? "" }) === "alive") continue;
			}
			this.wtx(() => {
				const current = getAgent(db, a.id);
				if (current.current_session_id !== a.current_session_id || current.desired_state !== 'RUNNING' || isTerminal(current.status)) return;
				run(db, "UPDATE agents SET observed_state = 'STOPPED', lease_until = NULL WHERE id = ?", a.id);
				run(db, "UPDATE sessions SET status = 'STOPPED', ended_at = ? WHERE id = ?", nowIso(), a.current_session_id);
				run(db, "UPDATE auth_tokens SET revoked_at = ?, revoke_reason = 'worker terminal mode changed' WHERE session_id = ?", nowIso(), a.current_session_id);
				run(db, "UPDATE spawn_intents SET status = 'PENDING', updated_at = ? WHERE id = ?", nowIso(), a.intent_id);
				emit(db, { run_id: a.run_id, actor_id: "controller", type: terminal ? "agent.terminal_promoted" : "agent.terminal_disabled", entity_id: a.id, payload: {} });
			});
		}
	}

	/** One launch attempt for a PENDING intent. Phase 1 (txn) → launch (no txn) → phase 2 (txn). */
	async launch(intentId: string): Promise<void> {
		const ctx = this.ctx;
		const db = ctx.db;
		const prep = this.wtx(() => {
			const it = get(db, "SELECT * FROM spawn_intents WHERE id = ?", intentId);
			if (!it || it.status !== "PENDING") return null;
			const a = getAgent(db, it.agent_id);
			if (isTerminal(a.status)) {
				run(db, "UPDATE spawn_intents SET status = 'CANCELLED', updated_at = ? WHERE id = ?", nowIso(), intentId);
				return null;
			}
			if (a.desired_state !== "RUNNING") return null; // paused before launch: stay PENDING
			const s = newSessionAttempt(ctx, a, { status: "STARTING", spawn_intent_id: intentId });
			const secret = mintSecret("pte");
			const expires = isoPlus(ctx.t.enrollTtlMs);
			const enrollFile = join(ctx.paths.enrollDir, `${intentId}.${s.generation}.json`);
			run(
				db,
				"INSERT INTO enrollment_credentials(token_hash, run_id, agent_id, spawn_intent_id, session_id, enroll_file, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
				hashToken(secret),
				a.run_id,
				a.id,
				intentId,
				s.session_id,
				enrollFile,
				expires,
				nowIso(),
			);
			run(db, "UPDATE spawn_intents SET status = 'LAUNCHING', session_id = ?, attempts = attempts + 1, updated_at = ?, last_error = NULL WHERE id = ?", s.session_id, nowIso(), intentId);
			run(db, "UPDATE agents SET observed_state = 'STARTING' WHERE id = ?", a.id);
			emit(db, { run_id: a.run_id, actor_id: "controller", type: "spawn.launching", entity_id: a.id, payload: { spawn_intent_id: intentId, session_id: s.session_id, generation: s.generation, attempt: it.attempts + 1 } });
			const spec = parseJson<{ task_id?: string; responsibility?: string }>(it.spec_json, {});
			const cfg = runConfig(db, a.run_id);
			const parent = getAncestry(db, a.id)[0] ?? null;
			const launchSpec: LaunchSpec = {
				terminal: cfg.terminal,
				run_id: a.run_id,
				agent_id: a.id,
				session_id: s.session_id,
				spawn_intent_id: intentId,
				role: a.role,
				provider: a.provider,
				model: a.model,
				cwd: a.cwd ?? "", // empty -> isolated worktree prepared below, outside the txn
				pi_session_path: a.pi_session_path ?? join(ctx.paths.dir, "sessions", `${a.id}.jsonl`),
				enroll_file: enrollFile,
				state_dir: ctx.paths.dir,
				log_path: join(ctx.paths.workerLogs, `${a.id}.${s.generation}.log`),
				bootstrap_prompt: bootstrapPrompt(a, parent, spec),
				resume: s.generation > 1 || it.attempts > 0,
			};
			if (launchSpec.resume) launchSpec.resume_prompt = resumePrompt(a, spec);
			const file: EnrollmentFile = { version: 1, socket_path: ctx.paths.socket, run_id: a.run_id, agent_id: a.id, spawn_intent_id: intentId, token: secret, expires_at: expires };
			return { launchSpec, file, sessionId: s.session_id, runId: a.run_id as string, workspaceRoot: cfg.workspace_root as string };
		});
		if (!prep) return;
		const { launchSpec, file, sessionId, runId, workspaceRoot } = prep;
		this.inFlight.add(intentId);
		try {
			if (launchSpec.cwd) mkdirSync(launchSpec.cwd, { recursive: true });
			else launchSpec.cwd = prepareWorkspace(workspaceRoot, runId, launchSpec.agent_id);
			mkdirSync(dirname(launchSpec.pi_session_path), { recursive: true, mode: 0o700 });
			writeFileSync(launchSpec.enroll_file, JSON.stringify(file), { mode: 0o600, flag: "w" });
			let ident: ProcessIdentity;
			try {
				ident = await this.executor.launch(launchSpec);
			} catch (e) {
				this.onLaunchFailure(intentId, sessionId, runId, launchSpec.enroll_file, String((e as Error)?.message ?? e));
				return;
			}
			if (this.stopped || !this.isLeader()) return;
			this.wtx(() => {
				run(db, "UPDATE agents SET cwd = ? WHERE id = ?", launchSpec.cwd, launchSpec.agent_id);
				run(db, "UPDATE sessions SET pid = ?, process_started_at = ?, launch_token = ?, process_marker = ? WHERE id = ?", ident.pid, ident.process_started_at, ident.launch_token, JSON.stringify({ pid: ident.pid, started: ident.process_started_at, terminal: launchSpec.terminal !== undefined, terminal_socket: launchSpec.terminal?.socket ?? null, terminal_location: JSON.stringify(launchSpec.terminal?.location ?? null) }), sessionId);
				const n = run(db, "UPDATE spawn_intents SET status = 'LAUNCHED', updated_at = ? WHERE id = ? AND status = 'LAUNCHING' AND session_id = ?", nowIso(), intentId, sessionId);
				emit(db, { run_id: runId, actor_id: "controller", type: "spawn.launched", entity_id: launchSpec.agent_id, payload: { spawn_intent_id: intentId, session_id: sessionId, pid: ident.pid, already_enrolled: n === 0 } });
			});
		} catch (e) {
			this.onLaunchFailure(intentId, sessionId, runId, launchSpec.enroll_file, String((e as Error)?.message ?? e));
		} finally {
			this.inFlight.delete(intentId);
		}
	}

	private onLaunchFailure(intentId: string, sessionId: string, runId: string, enrollFile: string, err: string): void {
		const db = this.ctx.db;
		safeUnlink(enrollFile);
		this.ctx.log("warn", "launch failed", { spawn_intent_id: intentId, err });
		this.wtx(() => {
			const it = get(db, "SELECT * FROM spawn_intents WHERE id = ?", intentId);
			if (!it || it.session_id !== sessionId || !["LAUNCHING", "LAUNCHED"].includes(it.status)) return;
			run(db, "UPDATE sessions SET status = 'FAILED', ended_at = ? WHERE id = ?", nowIso(), sessionId);
			run(db, "UPDATE enrollment_credentials SET revoked_at = ? WHERE session_id = ? AND used_at IS NULL", nowIso(), sessionId);
			if (it.attempts >= this.ctx.t.maxLaunchAttempts) {
				run(db, "UPDATE spawn_intents SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?", err, nowIso(), intentId);
				emit(db, { run_id: runId, actor_id: "controller", type: "spawn.failed", entity_id: it.agent_id, payload: { spawn_intent_id: intentId, attempts: it.attempts, error: err } });
				terminateAgent(this.ctx, null, it.agent_id, "FAILED", "controller", `launch failed after ${it.attempts} attempts: ${err}`);
				this.notifyManager(it.agent_id, `worker failed to launch: ${err}`);
			} else {
				run(db, "UPDATE spawn_intents SET status = 'PENDING', last_error = ?, updated_at = ? WHERE id = ?", err, nowIso(), intentId);
				run(db, "UPDATE agents SET observed_state = 'FAILED' WHERE id = ?", it.agent_id);
				emit(db, { run_id: runId, actor_id: "controller", type: "spawn.retry", entity_id: it.agent_id, payload: { spawn_intent_id: intentId, attempts: it.attempts, error: err } });
			}
		});
	}

	private notifyManager(agentId: string, text: string): void {
		const db = this.ctx.db;
		const a = getAgent(db, agentId);
		const mgr = getAncestry(db, agentId)[0];
		if (!mgr) return;
		postMessage(db, { run_id: a.run_id, from: agentId, to: mgr, type: "system.notice", payload: { kind: "agent_failed", agent_id: agentId, text } });
	}

	/**
	 * Startup (and periodic) reconciliation of LAUNCHING/LAUNCHED intents not in flight here.
	 * Identity recorded → probe: alive → keep; dead and never enrolled → new attempt.
	 * No identity → if enroll file never consumed (or grace elapsed) → revoke credential, new attempt.
	 */
	async recoverUncertain(startup: boolean): Promise<void> {
		const db = this.ctx.db;
		const rows = all(db, "SELECT i.*, s.pid, s.process_started_at, s.enrolled_at, s.id AS sid FROM spawn_intents i LEFT JOIN sessions s ON s.id = i.session_id WHERE i.status IN ('LAUNCHING','LAUNCHED')");
		for (const r of rows) {
			if (this.inFlight.has(r.id)) continue;
			if (r.enrolled_at) continue; // enrolled: lease logic owns it
			const cred = get(db, "SELECT enroll_file, expires_at FROM enrollment_credentials WHERE session_id = ? ORDER BY created_at DESC LIMIT 1", r.sid);
			const age = Date.now() - Date.parse(r.updated_at ?? r.created_at);
			if (r.pid != null) {
				const alive = (await this.executor.probe({ pid: r.pid, process_started_at: r.process_started_at ?? "" })) === "alive";
				if (alive) {
					const expired = cred && cred.expires_at < nowIso();
					if (!expired) {
						if (startup) this.ctx.log("info", "recovery: launched worker alive, awaiting enrollment", { spawn_intent_id: r.id, pid: r.pid });
						continue;
					}
					// Alive but can never enroll now: stop it, then retry with a fresh attempt.
					await this.executor.stop({ pid: r.pid, process_started_at: r.process_started_at ?? "" }).catch(() => {});
				}
				this.requeue(r, alive ? "enrollment window expired" : "launched process died before enrolling", cred?.enroll_file);
			} else {
				const fileUnconsumed = cred?.enroll_file ? existsSync(cred.enroll_file) : true;
				if (!fileUnconsumed && age < this.ctx.t.launchGraceMs) continue; // something consumed it: give it time to enroll
				if (fileUnconsumed && !startup && age < this.ctx.t.launchGraceMs) continue; // another process' launch may still be starting (only on periodic scans)
				this.requeue(r, fileUnconsumed ? "launch outcome unknown; enrollment file never consumed" : "launch outcome unknown; no enrollment within grace", cred?.enroll_file);
			}
		}
	}

	private requeue(r: Row, why: string, enrollFile: string | undefined): void {
		const db = this.ctx.db;
		if (enrollFile) safeUnlink(enrollFile);
		this.wtx(() => {
			const it = get(db, "SELECT * FROM spawn_intents WHERE id = ?", r.id);
			if (!it || it.session_id !== r.sid || !["LAUNCHING", "LAUNCHED"].includes(it.status)) return;
			const sess = get(db, "SELECT enrolled_at FROM sessions WHERE id = ?", r.sid);
			if (sess?.enrolled_at) return; // enrolled meanwhile
			run(db, "UPDATE sessions SET status = 'FAILED', ended_at = ? WHERE id = ?", nowIso(), r.sid);
			run(db, "UPDATE enrollment_credentials SET revoked_at = ? WHERE session_id = ? AND used_at IS NULL", nowIso(), r.sid);
			const terminal = it.attempts >= this.ctx.t.maxLaunchAttempts;
			const a = getAgent(db, it.agent_id);
			run(db, `UPDATE spawn_intents SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`, terminal ? "FAILED" : "PENDING", why, nowIso(), r.id);
			emit(db, { run_id: a.run_id, actor_id: "controller", type: terminal ? "spawn.failed" : "spawn.recovered", entity_id: it.agent_id, payload: { spawn_intent_id: r.id, old_session_id: r.sid, reason: why, attempts: it.attempts } });
			if (terminal) terminateAgent(this.ctx, null, it.agent_id, "FAILED", "controller", why);
		});
	}

	/** LIVE agents whose heartbeat lease expired become LOST. */
	expireLeases(): void {
		const db = this.ctx.db;
		const now = nowIso();
		const rows = all(db, `SELECT a.*, r.root_agent_id FROM agents a JOIN runs r ON r.id = a.run_id WHERE a.observed_state = 'LIVE' AND a.lease_until IS NOT NULL AND a.lease_until < ? AND a.status NOT IN ${TERMINAL_SQL}`, now);
		for (const a of rows) {
			this.wtx(() => {
				const n = run(db, "UPDATE agents SET observed_state = 'LOST' WHERE id = ? AND observed_state = 'LIVE' AND lease_until < ?", a.id, now);
				if (!n) return;
				run(db, "UPDATE sessions SET status = 'LOST' WHERE id = ? AND status = 'LIVE'", a.current_session_id);
				emit(db, { run_id: a.run_id, actor_id: "controller", type: "agent.lost", entity_id: a.id, payload: { session_id: a.current_session_id, lease_until: a.lease_until } });
				if (a.id === a.root_agent_id && runConfig(db, a.run_id).root_failure_policy === "pause_subtree") {
					const sub = getSubtree(db, a.id).slice(1);
					for (const d of sub) run(db, "UPDATE agents SET desired_state = 'PAUSED', status = CASE WHEN status = 'RUNNING' THEN 'PAUSED' ELSE status END WHERE id = ? AND status NOT IN ('COMPLETED','FAILED','CANCELLED','RETIRED')", d);
					emit(db, { run_id: a.run_id, actor_id: "controller", type: "run.root_lost_paused_subtree", entity_id: a.id, payload: { paused: sub } });
				}
			});
		}
	}

	/** LOST (or STOPPED/FAILED observed) managed agents with desired RUNNING are relaunched within retry policy, never while their process is alive. */
	async scheduleRestarts(): Promise<void> {
		const db = this.ctx.db;
		const rows = all(
			db,
			`SELECT a.*, i.id AS intent_id, i.status AS intent_status, s.pid, s.process_started_at FROM agents a
			 JOIN spawn_intents i ON i.agent_id = a.id LEFT JOIN sessions s ON s.id = a.current_session_id
			 WHERE a.desired_state = 'RUNNING' AND a.status NOT IN ${TERMINAL_SQL} AND a.observed_state IN ('LOST','STOPPED') AND i.status = 'LIVE'`,
		);
		for (const a of rows) {
			// One-shot workers exit after their prompt settles (observed STOPPED). Relaunch only when work is waiting.
			if (a.observed_state === "STOPPED" && !runConfig(db, a.run_id).terminal && !hasPendingWork(db, a.id)) continue;
			if (a.pid != null) {
				const alive = (await this.executor.probe({ pid: a.pid, process_started_at: a.process_started_at ?? "" })) === "alive";
				if (alive) {
					const lostFor = a.lease_until ? Date.now() - Date.parse(a.lease_until) : 0;
					if (lostFor < this.ctx.t.hungMs) continue; // may still be busy; do not double-spawn
					await this.executor.stop({ pid: a.pid, process_started_at: a.process_started_at ?? "" }).catch(() => {});
				}
			}
			this.wtx(() => {
				const cur = getAgent(db, a.id);
				if (cur.current_session_id !== a.current_session_id || !["LOST", "STOPPED"].includes(cur.observed_state) || cur.desired_state !== "RUNNING") return;
				if (cur.restart_attempts >= this.ctx.t.maxRestarts) {
					if (cur.observed_state !== "FAILED") {
						run(db, "UPDATE agents SET observed_state = 'FAILED' WHERE id = ?", a.id);
						emit(db, { run_id: a.run_id, actor_id: "controller", type: "agent.restart_exhausted", entity_id: a.id, payload: { restart_attempts: cur.restart_attempts } });
						this.notifyManager(a.id, "worker lost and restart attempts exhausted");
					}
					return;
				}
				run(db, "UPDATE agents SET restart_attempts = restart_attempts + 1 WHERE id = ?", a.id);
				run(db, "UPDATE sessions SET status = 'FAILED', ended_at = ? WHERE id = ? AND status IN ('LOST','LIVE')", nowIso(), a.current_session_id);
				run(db, "UPDATE spawn_intents SET status = 'PENDING', attempts = 0, updated_at = ? WHERE id = ? AND status = 'LIVE'", nowIso(), a.intent_id);
				emit(db, { run_id: a.run_id, actor_id: "controller", type: "agent.restart_scheduled", entity_id: a.id, payload: { previous_session_id: a.current_session_id, restart_attempt: cur.restart_attempts + 1 } });
			});
		}
	}

	/**
	 * Runtime deadlines for managed agents (desired RUNNING):
	 *  - session: current attempt running longer than envelope.max_session_seconds
	 *  - runtime: since the agent's first session start, longer than its role/proposal max_runtime_seconds
	 * On expiry: stop the process (after commit), apply run deadline_policy to open tasks
	 * (BLOCKED → agent PAUSED, resumable; FAILED → agent FAILED, reservations released), notify the manager, emit an event.
	 */
	async enforceDeadlines(): Promise<void> {
		const db = this.ctx.db;
		const now = Date.now();
		const rows = all(
			db,
			`SELECT a.id, a.run_id, a.metadata_json, a.observed_state, a.current_session_id, al.limits_json, s.pid, s.process_started_at, s.started_at AS session_started,
			        (SELECT MIN(x.started_at) FROM sessions x WHERE x.agent_id = a.id) AS first_started, ru.created_at AS run_created
			 FROM agents a JOIN runs ru ON ru.id = a.run_id JOIN allocations al ON al.agent_id = a.id JOIN spawn_intents i ON i.agent_id = a.id LEFT JOIN sessions s ON s.id = a.current_session_id
			 WHERE a.desired_state = 'RUNNING' AND a.status NOT IN ${TERMINAL_SQL}`,
		);
		for (const r of rows) {
			if (runConfig(db, r.run_id).operator_unlimited) continue;
			const sessionLimit = Number(parseJson<{ max_session_seconds?: number }>(r.limits_json, {}).max_session_seconds ?? 0);
			const meta = parseJson<{ max_runtime_seconds?: number | null; runtime_epoch?: string }>(r.metadata_json, {});
			const runtimeLimit = Number(meta.max_runtime_seconds ?? 0);
			// An explicit resume restarts the runtime clock (runtime_epoch set by lifecycle resume).
			const runtimeStart = [r.first_started, meta.runtime_epoch].filter(Boolean).sort().pop() as string | undefined;
			const running = ["STARTING", "LIVE", "LOST"].includes(r.observed_state);
			const runLimit = Number(runConfig(db, r.run_id).limits.max_run_seconds ?? 0);
			let kind: "run" | "session" | "runtime" | null = null;
			let limit = 0;
			let elapsed = 0;
			if (runLimit > 0 && r.run_created && (elapsed = (now - Date.parse(r.run_created)) / 1000) > runLimit) {
				// Run wallclock (limits.max_run_seconds) applies to every managed (non-root) agent of the run.
				kind = "run";
				limit = runLimit;
			} else if (runtimeLimit > 0 && runtimeStart && (elapsed = (now - Date.parse(runtimeStart)) / 1000) > runtimeLimit) {
				kind = "runtime";
				limit = runtimeLimit;
			} else if (running && sessionLimit > 0 && r.session_started && (elapsed = (now - Date.parse(r.session_started)) / 1000) > sessionLimit) {
				kind = "session";
				limit = sessionLimit;
			}
			if (!kind) continue;
			const stopIdent = running && r.pid != null ? { pid: r.pid as number, process_started_at: (r.process_started_at ?? "") as string } : null;
			const stopNeeded = this.wtx(() => {
				const cur = getAgent(db, r.id);
				if (cur.desired_state !== "RUNNING" || isTerminal(cur.status) || cur.current_session_id !== r.current_session_id) return false;
				const policy = runConfig(db, r.run_id).deadline_policy ?? "BLOCKED";
				const ts = nowIso();
				const tasks = all(db, "SELECT id FROM tasks WHERE owner_id = ? AND status IN ('OPEN','ASSIGNED','IN_PROGRESS')", r.id).map((t) => t.id as string);
				const reason = `${kind} deadline exceeded (${Math.round(elapsed)}s > ${limit}s)`;
				for (const t of tasks) run(db, "UPDATE tasks SET status = ?, result_json = ?, updated_at = ? WHERE id = ?", policy, JSON.stringify({ summary: reason }), ts, t);
				if (kind === "run" && !get(db, "SELECT 1 FROM events WHERE run_id = ? AND type = 'run.wallclock_exceeded'", r.run_id)) {
					emit(db, { run_id: r.run_id, actor_id: "controller", type: "run.wallclock_exceeded", entity_id: r.run_id, payload: { max_run_seconds: limit, elapsed_seconds: Math.round(elapsed), policy } });
				}
				emit(db, { run_id: r.run_id, actor_id: "controller", type: "agent.deadline_exceeded", entity_id: r.id, payload: { kind, limit_seconds: limit, elapsed_seconds: Math.round(elapsed), policy, tasks, session_id: r.current_session_id } });
				const mgr = getAncestry(db, r.id)[0];
				if (mgr) postMessage(db, { run_id: r.run_id, from: r.id, to: mgr, type: "system.notice", payload: { kind: "deadline_exceeded", agent_id: r.id, deadline: kind, limit_seconds: limit, policy, tasks } });
				if (policy === "FAILED") {
					terminateAgent(this.ctx, null, r.id, "FAILED", "controller", reason); // revokes, stops (async), releases reservations
					return false;
				}
				run(db, "UPDATE agents SET desired_state = 'PAUSED', status = 'PAUSED', observed_state = CASE WHEN observed_state IN ('STARTING','LIVE','LOST') THEN 'STOPPED' ELSE observed_state END, lease_until = NULL WHERE id = ?", r.id);
				run(db, "UPDATE sessions SET status = 'STOPPED', ended_at = ? WHERE id = ? AND status IN ('REQUESTED','STARTING','LIVE','LOST')", ts, r.current_session_id);
				run(db, "UPDATE auth_tokens SET revoked_at = ?, revoke_reason = 'deadline exceeded' WHERE session_id = ? AND revoked_at IS NULL", ts, r.current_session_id);
				return true;
			});
			if (stopNeeded && stopIdent) await this.executor.stop(stopIdent).catch((e) => this.ctx.log("warn", "deadline stop failed", { agent_id: r.id, err: String(e) }));
		}
	}

	/**
	 * LIVE managed sessions whose process is gone ended normally (one-shot `pi -p` exits once settled):
	 * observed STOPPED, session STOPPED, its token fenced. scheduleRestarts relaunches if work is pending.
	 * (A stale heartbeat while the process is still alive is handled by expireLeases → LOST.)
	 */
	async observeExits(): Promise<void> {
		const db = this.ctx.db;
		const rows = all(db, `SELECT a.id, a.run_id, a.current_session_id, s.pid, s.process_started_at FROM agents a JOIN sessions s ON s.id = a.current_session_id WHERE a.observed_state = 'LIVE' AND s.pid IS NOT NULL AND a.status NOT IN ${TERMINAL_SQL}`);
		for (const r of rows) {
			if ((await this.executor.probe({ pid: r.pid, process_started_at: r.process_started_at ?? "" })) === "alive") continue;
			this.wtx(() => {
				const n = run(db, "UPDATE agents SET observed_state = 'STOPPED', lease_until = NULL WHERE id = ? AND current_session_id = ? AND observed_state = 'LIVE'", r.id, r.current_session_id);
				if (!n) return;
				run(db, "UPDATE sessions SET status = 'STOPPED', ended_at = ? WHERE id = ? AND status IN ('LIVE','LOST')", nowIso(), r.current_session_id);
				run(db, "UPDATE auth_tokens SET revoked_at = ?, revoke_reason = 'process exited' WHERE session_id = ? AND revoked_at IS NULL", nowIso(), r.current_session_id);
				emit(db, { run_id: r.run_id, actor_id: "controller", type: "agent.exited", entity_id: r.id, payload: { session_id: r.current_session_id, pid: r.pid } });
			});
		}
	}

	/** Startup: probe LIVE managed sessions; mark dead ones LOST so restart policy can apply. */
	async recoverLiveSessions(): Promise<void> {
		const db = this.ctx.db;
		const rows = all(db, `SELECT a.id, a.run_id, a.current_session_id, s.pid, s.process_started_at FROM agents a JOIN sessions s ON s.id = a.current_session_id WHERE a.observed_state IN ('LIVE','STARTING') AND s.pid IS NOT NULL AND a.status NOT IN ${TERMINAL_SQL}`);
		for (const r of rows) {
			const alive = (await this.executor.probe({ pid: r.pid, process_started_at: r.process_started_at ?? "" })) === "alive";
			if (alive) continue;
			this.wtx(() => {
				const n = run(db, "UPDATE agents SET observed_state = 'LOST' WHERE id = ? AND current_session_id = ? AND observed_state IN ('LIVE','STARTING')", r.id, r.current_session_id);
				if (!n) return;
				run(db, "UPDATE sessions SET status = 'LOST' WHERE id = ?", r.current_session_id);
				emit(db, { run_id: r.run_id, actor_id: "controller", type: "agent.lost", entity_id: r.id, payload: { session_id: r.current_session_id, reason: "process not found at controller startup" } });
			});
		}
	}

	async recoverOnStartup(): Promise<void> {
		await this.recoverUncertain(true);
		await this.recoverLiveSessions();
	}
}

function safeUnlink(p: string): void {
	try {
		unlinkSync(p);
	} catch {
		/* already consumed */
	}
}

/** Unacked inbox deliveries or open tasks → a stopped one-shot worker should run again. */
export function hasPendingWork(db: Ctx["db"], agentId: string): boolean {
	return !!(
		get(db, "SELECT 1 FROM deliveries WHERE recipient_id = ? AND status <> 'ACKED' LIMIT 1", agentId) ??
		get(db, "SELECT 1 FROM tasks WHERE owner_id = ? AND status IN ('OPEN','ASSIGNED','IN_PROGRESS') LIMIT 1", agentId)
	);
}

function resumePrompt(a: Row, spec: { task_id?: string }): string {
	return [
		`You are agent ${a.id} ("${a.role}") resuming in a new session; your identity, manager and tasks are unchanged.`,
		"Refresh your org context, process your inbox (team_get_inbox, ack after handling) and continue your open tasks.",
		spec.task_id ? `Original task id: ${spec.task_id}.` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function bootstrapPrompt(a: Row, parentId: string | null, spec: { task_id?: string; responsibility?: string }): string {
	return [
		`You are a managed member of a recursive agent team (agent ${a.id}, role "${a.role}").`,
		parentId ? `You report to ${parentId}.` : "",
		spec.responsibility ? `Responsibility: ${spec.responsibility}` : "",
		spec.task_id ? `Your assigned task id: ${spec.task_id}. Read your inbox (team_get_inbox) for details, report progress, and complete the task with team_complete_task.` : "",
		"Use the team_* tools for all coordination. Requests for more agents are proposals and may be rejected.",
	]
		.filter(Boolean)
		.join("\n");
}

