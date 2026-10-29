#!/usr/bin/env node
// Controller process entry: `node src/controller/main.ts`. Thin wrapper around startController().
// Exit codes: 0 = stopped normally OR another healthy controller already owns the state dir; 1 = failed.
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { statePaths } from "../shared/paths.ts";
import type { Executor } from "../executor/types.ts";
import { ControllerAlreadyRunning, probeHealth, startController } from "./bootstrap.ts";
import type { ControllerTunables } from "./context.ts";

async function loadExecutor(): Promise<Executor> {
	try {
		const mod = (await import("../executor/index.ts")) as { createExecutor: () => Executor };
		return mod.createExecutor();
	} catch (e) {
		// Keep the control plane usable (inspection, governance) even if the executor module is broken;
		// launches will fail and be retried/recorded as FAILED.
		const msg = `executor unavailable: ${String((e as Error)?.message ?? e)}`;
		process.stderr.write(msg + "\n");
		return {
			launch: async () => {
				throw new Error(msg);
			},
			probe: async () => "dead",
			stop: async () => {},
		};
	}
}

/**
 * Optional env overrides for reconciler tunables (positive integers; invalid values are ignored).
 * Mainly for tests/demos that need fast expiry; defaults in bootstrap.ts.
 *   PI_TEAM_IDLE_MS              idle self-shutdown (0 = never)            default 600000
 *   PI_TEAM_CLAIM_MS             inbox claim lease before redelivery       default 60000
 *   PI_TEAM_HEARTBEAT_LEASE_MS   session heartbeat lease (→ LOST)          default HEARTBEAT_LEASE_MS (45000)
 *   PI_TEAM_TICK_MS              reconciler tick                           default 1000
 *   PI_TEAM_LAUNCH_GRACE_MS      wait for enrollment of an uncertain launch default 30000
 *   PI_TEAM_ENROLL_TTL_MS        enrollment credential lifetime            default ENROLL_TTL_MS (600000)
 *   PI_TEAM_HUNG_MS              LOST-but-alive grace before stop+restart  default 3 × heartbeat lease
 *   PI_TEAM_MAX_LAUNCH_ATTEMPTS  launch attempts per spawn intent          default 3
 *   PI_TEAM_MAX_RESTARTS         relaunches without progress per agent     default 3
 */
const TUNABLE_ENV: Record<string, keyof ControllerTunables> = {
	PI_TEAM_CLAIM_MS: "claimMs",
	PI_TEAM_HEARTBEAT_LEASE_MS: "leaseMs",
	PI_TEAM_TICK_MS: "tickMs",
	PI_TEAM_LAUNCH_GRACE_MS: "launchGraceMs",
	PI_TEAM_ENROLL_TTL_MS: "enrollTtlMs",
	PI_TEAM_HUNG_MS: "hungMs",
	PI_TEAM_MAX_LAUNCH_ATTEMPTS: "maxLaunchAttempts",
	PI_TEAM_MAX_RESTARTS: "maxRestarts",
};

export function tunablesFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<ControllerTunables> {
	const out: Partial<ControllerTunables> = {};
	for (const [name, key] of Object.entries(TUNABLE_ENV)) {
		const raw = env[name];
		if (raw === undefined || raw === "") continue;
		const n = Number(raw);
		if (Number.isInteger(n) && n > 0) out[key] = n;
		else process.stderr.write(`ignoring invalid ${name}=${raw}\n`);
	}
	return out;
}

async function main(): Promise<void> {
	const executor = await loadExecutor();
	try {
		const h = await startController({
			executor,
			tunables: tunablesFromEnv(),
			onClosed: (reason) => {
				process.exitCode = 0;
				// Give stdio a moment, then exit even if stray handles remain.
				setTimeout(() => process.exit(0), 50).unref();
				void reason;
			},
		});
		const stop = (sig: string) => void h.close({ reason: sig });
		process.on("SIGTERM", () => stop("SIGTERM"));
		process.on("SIGINT", () => stop("SIGINT"));
	} catch (e) {
		if (e instanceof ControllerAlreadyRunning) {
			const socket = statePaths().socket;
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				if (await probeHealth(socket)) process.exit(0);
				await new Promise((r) => setTimeout(r, 100));
			}
			process.stderr.write("another controller holds the lock but is not answering /health\n");
			process.exit(1);
		}
		process.stderr.write(`controller failed to start: ${String((e as Error)?.stack ?? e)}\n`);
		process.exit(1);
	}
}

/** Run only as an entry point (bin symlinks resolved), so tests can import tunablesFromEnv safely. */
function isEntry(): boolean {
	try {
		return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}
if (isEntry()) void main();
