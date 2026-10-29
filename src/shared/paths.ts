// Per-user state locations. Never a world-accessible /tmp socket.
import { mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_STATE_DIR } from "./protocol.ts";

export function stateDir(): string {
	const override = process.env[ENV_STATE_DIR];
	if (override) return override;
	if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "pi-recursive-team");
	if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "pi-recursive-team");
	return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-recursive-team");
}

export interface StatePaths {
	dir: string;
	socket: string; // short name: macOS sun_path limit is 104 bytes
	db: string;
	lock: string; // exclusive controller lock (O_EXCL file with pid/start-time/epoch)
	controllerInfo: string; // JSON written once listening: {pid, controller_id, epoch, socket}
	operatorToken: string;
	log: string;
	enrollDir: string; // one-time enrollment credential files
	workerLogs: string;
}

export function statePaths(dir = stateDir()): StatePaths {
	return {
		dir,
		socket: join(dir, "c.sock"),
		db: join(dir, "org.sqlite"),
		lock: join(dir, "controller.lock"),
		controllerInfo: join(dir, "controller.json"),
		operatorToken: join(dir, "operator.token"),
		log: join(dir, "controller.log"),
		enrollDir: join(dir, "enroll"),
		workerLogs: join(dir, "workers"),
	};
}

/** Create the state dir tree with 0700 permissions. Idempotent. */
export function ensureStateDir(p: StatePaths = statePaths()): StatePaths {
	for (const d of [p.dir, p.enrollDir, p.workerLogs]) {
		mkdirSync(d, { recursive: true, mode: 0o700 });
		chmodSync(d, 0o700);
	}
	return p;
}

/** Package root (directory containing package.json), resolved from this file. */
export function packageRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function controllerEntry(): string {
	return join(packageRoot(), "src", "controller", "main.ts");
}

export function migrationsDir(): string {
	return join(packageRoot(), "db");
}
