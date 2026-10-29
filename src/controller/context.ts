// Shared per-controller context passed to domain modules.
import type { DB } from "./db.ts";
import type { Logger } from "./log.ts";
import type { StatePaths } from "../shared/paths.ts";

export interface ControllerTunables {
	/** Heartbeat lease length granted to sessions. */
	leaseMs: number;
	/** Inbox claim lease. */
	claimMs: number;
	/** How long a LAUNCHING intent with no recorded identity (and consumed enroll file) may wait for enrollment. */
	launchGraceMs: number;
	/** How long an enrollment credential is valid. */
	enrollTtlMs: number;
	maxLaunchAttempts: number;
	maxRestarts: number;
	/** Reconciler tick. */
	tickMs: number;
	/** LOST but alive process: stop + restart after this long past lease expiry. */
	hungMs: number;
}

export type Principal =
	| { kind: "operator"; actor_id: "operator" }
	| { kind: "agent"; actor_id: string; run_id: string; session_id: string; generation: number };

export interface Ctx {
	db: DB;
	log: Logger;
	paths: StatePaths;
	controllerId: string;
	epoch: () => number;
	t: ControllerTunables;
	/** Wake the reconciler soon (after the current transaction commits). */
	kick: () => void;
	/** Stop a worker process via the executor (call only after commit, i.e. from ReqScope.after). */
	stopProcess: (pid: number, processStartedAt: string) => Promise<void>;
}

/** Per-request scratch: callbacks run only after the request transaction committed. */
export interface ReqScope {
	after: (fn: () => void | Promise<void>) => void;
	idemKey: string | null;
}
