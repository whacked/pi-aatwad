// Shared detached-launch mechanics for PiExecutor and ScriptExecutor.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { processStartTimeSync } from "./proc.ts";
import type { LaunchSpec, ProcessIdentity } from "./types.ts";

export function newLaunchToken(): string {
	return randomBytes(18).toString("base64url");
}

function logLine(logPath: string, record: Record<string, unknown>): void {
	try {
		appendFileSync(logPath, `[pi-team-executor] ${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
	} catch {
		/* logging must never fail a launch */
	}
}

export interface DetachedLaunch {
	spec: LaunchSpec;
	executor: string; // "pi" | "script"
	command: string;
	args: string[]; // must not contain secrets
	env: Record<string, string>;
	launchToken: string;
}

/**
 * Spawn `command args` detached (own process group / session), stdout+stderr appended to
 * spec.log_path, stdin ignored, then unref so neither the controller nor the parent Pi
 * keeps or kills it. Resolves once the OS has created the process.
 */
export async function launchDetached(l: DetachedLaunch): Promise<ProcessIdentity> {
	const { spec } = l;
	mkdirSync(dirname(spec.log_path), { recursive: true, mode: 0o700 });
	// Launch record: argv and env *names* only, never env values (credentials) or tokens.
	logLine(spec.log_path, {
		event: "launch",
		executor: l.executor,
		run_id: spec.run_id,
		agent_id: spec.agent_id,
		session_id: spec.session_id,
		spawn_intent_id: spec.spawn_intent_id,
		resume: spec.resume,
		cwd: spec.cwd,
		command: l.command,
		args: l.args,
		env_keys: Object.keys(l.env).sort(),
	});
	const fd = openSync(spec.log_path, "a", 0o600);
	let child;
	try {
		child = spawn(l.command, l.args, {
			cwd: spec.cwd,
			env: l.env,
			detached: true,
			stdio: ["ignore", fd, fd],
			windowsHide: true,
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", () => resolve());
			child.once("error", (err) => reject(err));
		});
	} catch (err) {
		logLine(spec.log_path, { event: "launch_failed", agent_id: spec.agent_id, error: String((err as Error).message ?? err) });
		throw err;
	} finally {
		closeSync(fd);
	}
	child.unref();
	const pid = child.pid as number;
	// If the process already exited (it cannot have done real work yet), started_at is ""
	// and probe() reports dead -> controller treats it like a crashed launch.
	const process_started_at = processStartTimeSync(pid) ?? "";
	logLine(spec.log_path, { event: "launched", agent_id: spec.agent_id, pid, process_started_at });
	return { pid, process_started_at, launch_token: l.launchToken };
}
