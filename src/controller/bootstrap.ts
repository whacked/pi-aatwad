// Singleton bootstrap: O_EXCL lock with stale recovery, DB fencing epoch, unix socket listener,
// controller.json, operator token, idle self-shutdown, graceful stop.
import { chmodSync, closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { ensureStateDir, migrationsDir as defaultMigrationsDir, statePaths, type StatePaths } from "../shared/paths.ts";
import { HEARTBEAT_LEASE_MS, ENROLL_TTL_MS, PROTOCOL_VERSION, HDR_PROTOCOL, SCHEMA_VERSION, type HealthResponse } from "../shared/protocol.ts";
import type { Executor } from "../executor/types.ts";
import { type DB, openDb, get, run, tx, nowIso, isoPlus } from "./db.ts";
import { createLogger, type Logger } from "./log.ts";
import { ensureOperatorToken } from "./auth.ts";
import type { Ctx, ControllerTunables } from "./context.ts";
import { createApiServer } from "./server.ts";
import { Reconciler } from "./reconciler.ts";
import { liveWorkerCount, pendingSpawnCount } from "./queries.ts";

/** Number of migrations this controller applies (db/001..004) = protocol SCHEMA_VERSION. */
export const CONTROLLER_SCHEMA_VERSION = SCHEMA_VERSION;
const CONTROLLER_LEASE_MS = 30_000;

export interface ControllerOptions {
	stateDir?: string;
	executor: Executor;
	/** Idle self-shutdown after this long without work/requests. 0 disables. Default env PI_TEAM_IDLE_MS or 600000. */
	idleMs?: number;
	migrationsDir?: string;
	tunables?: Partial<ControllerTunables>;
	/** Called once after the controller fully stopped (main.ts exits the process). */
	onClosed?: (reason: string) => void;
}

export interface ControllerHandle {
	controllerId: string;
	epoch: number;
	paths: StatePaths;
	operatorToken: string;
	db: DB;
	reconciler: Reconciler;
	ctx: Ctx;
	/** Graceful stop. `crash: true` simulates a hard crash (no waiting, DB left as-is) but still releases the lock so tests can restart in-process. */
	close(opts?: { crash?: boolean; reason?: string }): Promise<void>;
}

export class ControllerAlreadyRunning extends Error {
	owner: LockInfo | null;
	constructor(owner: LockInfo | null) {
		super(`controller already running (pid ${owner?.pid ?? "?"})`);
		this.owner = owner;
	}
}

interface LockInfo {
	pid: number;
	started_at: string | null;
	controller_id: string;
	acquired_at: string;
}

// ---- process identity helpers ------------------------------------------------

export function processStartTime(pid: number): string | null {
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return out || null;
	} catch {
		return null;
	}
}
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---- lock ---------------------------------------------------------------------

function readLock(path: string): { raw: string; info: LockInfo | null } | null {
	try {
		const raw = readFileSync(path, "utf8");
		try {
			return { raw, info: JSON.parse(raw) as LockInfo };
		} catch {
			return { raw, info: null };
		}
	} catch {
		return null;
	}
}

function lockOwnerLive(info: LockInfo): boolean {
	if (!pidAlive(info.pid)) return false;
	if (info.started_at == null) return true;
	const st = processStartTime(info.pid);
	return st == null || st === info.started_at; // st==null: cannot tell → assume live (conservative)
}

/** Serializes stale-lock removal so a contender never deletes a lock freshly created by another. */
function withRecoverMutex<T>(lockPath: string, fn: () => T): T | undefined {
	const m = `${lockPath}.recover`;
	for (let i = 0; i < 200; i++) {
		try {
			const fd = openSync(m, "wx", 0o600);
			writeSync(fd, String(process.pid));
			closeSync(fd);
			try {
				return fn();
			} finally {
				try {
					unlinkSync(m);
				} catch {
					/* ignore */
				}
			}
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			try {
				if (Date.now() - statSync(m).mtimeMs > 5000) unlinkSync(m); // holder died mid-recovery
			} catch {
				/* gone */
			}
			sleepSync(10);
		}
	}
	return undefined;
}

function acquireLock(path: string, controllerId: string): { ok: true; info: LockInfo } | { ok: false; owner: LockInfo | null } {
	const mine: LockInfo = { pid: process.pid, started_at: processStartTime(process.pid), controller_id: controllerId, acquired_at: nowIso() };
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeSync(fd, JSON.stringify(mine));
			closeSync(fd);
			return { ok: true, info: mine };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		const cur = readLock(path);
		if (!cur) continue; // vanished; retry
		if (!cur.info) {
			// Being written right now, or garbage left by a crash during write.
			let age = 0;
			try {
				age = Date.now() - statSync(path).mtimeMs;
			} catch {
				continue;
			}
			if (age < 2000) {
				sleepSync(20);
				continue;
			}
		} else if (lockOwnerLive(cur.info)) {
			return { ok: false, owner: cur.info };
		}
		withRecoverMutex(path, () => {
			const again = readLock(path);
			if (again && again.raw === cur.raw) unlinkSync(path);
		});
	}
	return { ok: false, owner: readLock(path)?.info ?? null };
}

function releaseLock(path: string, controllerId: string): void {
	const cur = readLock(path);
	if (cur?.info?.controller_id === controllerId) {
		try {
			unlinkSync(path);
		} catch {
			/* ignore */
		}
	}
}

// ---- health probe (used by contenders / main.ts) --------------------------------

export function probeHealth(socket: string, timeoutMs = 1000): Promise<HealthResponse | null> {
	return new Promise((resolve) => {
		const req = request({ socketPath: socket, path: "/health", method: "GET", headers: { [HDR_PROTOCOL]: String(PROTOCOL_VERSION) }, timeout: timeoutMs }, (res) => {
			let s = "";
			res.on("data", (c) => (s += c));
			res.on("end", () => {
				try {
					const j = JSON.parse(s) as HealthResponse;
					resolve(res.statusCode === 200 && j.ok ? j : null);
				} catch {
					resolve(null);
				}
			});
		});
		req.on("error", () => resolve(null));
		req.on("timeout", () => {
			req.destroy();
			resolve(null);
		});
		req.end();
	});
}

// ---- start -----------------------------------------------------------------------

export async function startController(opts: ControllerOptions): Promise<ControllerHandle> {
	const paths = ensureStateDir(statePaths(opts.stateDir));
	if (Buffer.byteLength(paths.socket) > 103) throw new Error(`socket path too long for AF_UNIX (${paths.socket})`);
	const controllerId = `ctl-${randomBytes(6).toString("hex")}`;
	const log: Logger = createLogger(paths.log, { controller_id: controllerId, pid: process.pid });
	const lock = acquireLock(paths.lock, controllerId);
	if (!lock.ok) {
		log("info", "controller already running; not starting", { owner_pid: lock.owner?.pid });
		throw new ControllerAlreadyRunning(lock.owner);
	}
	let db: DB;
	let epoch = 0;
	try {
		db = openDb(paths.db, opts.migrationsDir ?? defaultMigrationsDir());
		const applied = Number(get(db, "SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations")!.v);
		if (applied !== SCHEMA_VERSION) throw new Error(`database schema ${applied} is incompatible with this controller (expects ${SCHEMA_VERSION})`);
		epoch = tx(db, () => {
			const prev = get(db, "SELECT fencing_epoch FROM controller_lease WHERE singleton_key = 'local'");
			const e = Number(prev?.fencing_epoch ?? 0) + 1;
			run(
				db,
				`INSERT INTO controller_lease(singleton_key, controller_id, fencing_epoch, lease_until, updated_at) VALUES ('local', ?, ?, ?, ?)
				 ON CONFLICT(singleton_key) DO UPDATE SET controller_id = excluded.controller_id, fencing_epoch = excluded.fencing_epoch, lease_until = excluded.lease_until, updated_at = excluded.updated_at`,
				controllerId,
				e,
				isoPlus(CONTROLLER_LEASE_MS),
				nowIso(),
			);
			return e;
		});
	} catch (e) {
		releaseLock(paths.lock, controllerId);
		throw e;
	}
	const operatorToken = ensureOperatorToken(paths.operatorToken);
	const t: ControllerTunables = {
		leaseMs: HEARTBEAT_LEASE_MS,
		claimMs: 60_000,
		launchGraceMs: 30_000,
		enrollTtlMs: ENROLL_TTL_MS,
		maxLaunchAttempts: 3,
		maxRestarts: 3,
		tickMs: 1000,
		hungMs: 3 * HEARTBEAT_LEASE_MS,
		...(opts.tunables ?? {}),
	};
	const startedAt = nowIso();
	let reconciler: Reconciler;
	const ctx: Ctx = {
		db,
		log,
		paths,
		controllerId,
		epoch: () => epoch,
		t,
		kick: () => setImmediate(() => reconciler?.kick()),
		stopProcess: async (pid, st) => {
			const identity = { pid, process_started_at: st };
			if (await opts.executor.probe(identity) === "alive") await opts.executor.stop(identity);
		},
	};
	reconciler = new Reconciler(ctx, opts.executor);
	reconciler.isLeader = () => {
		try {
			const r = get(db, "SELECT controller_id FROM controller_lease WHERE singleton_key = 'local'");
			return r?.controller_id === controllerId;
		} catch {
			return false;
		}
	};
	log("info", "controller starting", { epoch, state_dir: paths.dir });
	await reconciler.recoverOnStartup();

	let lastActivity = Date.now();
	let closing: Promise<void> | null = null;
	let server: Server;
	let housekeeping: NodeJS.Timeout | undefined;
	const idleMs = opts.idleMs ?? (Number(process.env.PI_TEAM_IDLE_MS ?? "") || 600_000);

	const health = (): HealthResponse => ({
		ok: true,
		protocol: PROTOCOL_VERSION,
		schema: CONTROLLER_SCHEMA_VERSION,
		controller_id: controllerId,
		fencing_epoch: epoch,
		pid: process.pid,
		started_at: startedAt,
		state_dir: paths.dir,
		live_workers: liveWorkerCount(db),
	});

	const close = (o: { crash?: boolean; reason?: string } = {}): Promise<void> => {
		if (closing) return closing;
		closing = (async () => {
			const reason = o.reason ?? (o.crash ? "crash" : "close");
			log("info", "controller stopping", { reason });
			if (housekeeping) clearInterval(housekeeping);
			if (o.crash) reconciler.abandon();
			else await reconciler.stop();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			});
			try {
				db.close();
			} catch {
				/* ignore */
			}
			for (const f of [paths.socket, paths.controllerInfo]) {
				try {
					// Only remove artifacts we own.
					if (f === paths.controllerInfo) {
						const info = JSON.parse(readFileSync(f, "utf8"));
						if (info.controller_id !== controllerId) continue;
					}
					unlinkSync(f);
				} catch {
					/* ignore */
				}
			}
			releaseLock(paths.lock, controllerId);
			log("info", "controller stopped", { reason });
			opts.onClosed?.(reason);
		})();
		return closing;
	};

	server = createApiServer(ctx, {
		operatorToken,
		health,
		shutdown: () => void close({ reason: "shutdown requested" }),
		touch: () => {
			lastActivity = Date.now();
		},
	});
	// We hold the lock: any socket file is stale.
	if (existsSync(paths.socket)) unlinkSync(paths.socket);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(paths.socket, () => {
			server.off("error", reject);
			resolve();
		});
	});
	chmodSync(paths.socket, 0o600);
	writeFileSync(paths.controllerInfo, JSON.stringify({ pid: process.pid, controller_id: controllerId, epoch, socket: paths.socket, started_at: startedAt, protocol: PROTOCOL_VERSION, schema: CONTROLLER_SCHEMA_VERSION }), { mode: 0o600 });

	housekeeping = setInterval(
		() => {
			if (closing) return;
			try {
				// Renew our DB lease; if someone else holds it we are fenced → stop.
				const n = run(db, "UPDATE controller_lease SET lease_until = ?, updated_at = ? WHERE singleton_key = 'local' AND controller_id = ?", isoPlus(CONTROLLER_LEASE_MS), nowIso(), controllerId);
				if (n === 0) {
					log("error", "fenced by another controller; stopping");
					void close({ reason: "fenced" });
					return;
				}
				if (idleMs > 0 && Date.now() - lastActivity > idleMs && liveWorkerCount(db) === 0 && pendingSpawnCount(db) === 0) {
					void close({ reason: "idle" });
				}
				// Idempotency rows older than a day are no longer useful.
				run(db, "DELETE FROM idempotency WHERE created_at < ?", isoPlus(-24 * 3600_000));
			} catch (e) {
				log("warn", "housekeeping failed", { err: String(e) });
			}
		},
		Math.max(50, Math.min(5000, idleMs > 0 ? Math.floor(idleMs / 4) : 5000)),
	);
	housekeeping.unref?.();
	reconciler.start();
	reconciler.kick();
	log("info", "controller listening", { socket: paths.socket, epoch });
	return {
		controllerId,
		epoch,
		paths,
		operatorToken,
		db,
		reconciler,
		ctx,
		close,
	};
}
