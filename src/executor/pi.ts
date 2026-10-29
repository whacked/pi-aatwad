// PiExecutor: runs each worker as a detached, non-interactive `pi` process.
//
// Verified against Pi 1.4.0 (see test/executor/pi-smoke.test.ts, which runs real `pi`
// against a local fake OpenAI-compatible server, no paid credentials):
//
//   pi --mode json -p --session <pi_session_path> --provider <P> --model <M> \
//      -e <packageRoot>/src/extension/index.ts -- "<prompt>"
//
// * `--mode json -p`: one-shot, JSONL events on stdout (into the worker log), exits when
//   the agent settles. stdin is ignored. The worker does NOT stay alive waiting for new
//   messages after its prompt is done; the controller relaunches with resume=true.
// * `--session <path>`: creates the session file (and parent dir) if missing; when it
//   exists, Pi reopens it and the prior transcript is sent to the model (same session id).
//   So fresh launch and resume use the identical flag; only the prompt differs.
//   (--continue is NOT used: it picks "most recent session for the cwd", which is ambiguous.)
// * `-e <extension>`: Pi dedupes extension paths by canonical path (resource-loader
//   mergePaths), and packageRoot() resolves to the copy the controller is running from,
//   i.e. the installed package itself -> the installed package and -e load it once.
//   -e also guarantees the extension loads when the package is only project-installed
//   (untrusted project-local config is ignored without --approve).
// * No --approve: workers do not auto-trust project-local .pi config of the workspace.
// * `--` ends option parsing so a prompt starting with "-" is not read as a flag.
// * Credentials come only from env (allowlist in env.ts) / ~/.pi/agent/auth.json, never argv.

import { join } from "node:path";
import { packageRoot } from "../shared/paths.ts";
import { buildWorkerEnv } from "./env.ts";
import { launchDetached, newLaunchToken } from "./launch.ts";
import { probeIdentity, stopIdentity } from "./proc.ts";
import type { Executor, LaunchSpec, ProbeResult, ProcessIdentity } from "./types.ts";

export const DEFAULT_RESUME_PROMPT =
	"You were restarted by the team controller. Your previous conversation is above. " +
	"Check your organization context and inbox, then continue your assigned task.";

export interface PiExecutorOptions {
	/** pi binary (default: env PI_TEAM_PI_BIN or "pi" from PATH). */
	piBin?: string;
	/** Extension entry passed with -e (default: <packageRoot>/src/extension/index.ts). */
	extensionPath?: string;
}

export function defaultExtensionPath(): string {
	return join(packageRoot(), "src", "extension", "index.ts");
}

/** argv (without the binary) for a worker launch. Pure; exported for tests. */
export function buildPiArgs(spec: LaunchSpec, extensionPath: string = defaultExtensionPath()): string[] {
	const prompt = spec.resume ? (spec.resume_prompt ?? DEFAULT_RESUME_PROMPT) : spec.bootstrap_prompt;
	return [
		"--mode", "json",
		"-p",
		"--session", spec.pi_session_path,
		// "default" = controller had no explicit leader model: let pi pick its configured default.
		...(spec.provider && spec.provider !== "default" ? ["--provider", spec.provider] : []),
		...(spec.model && spec.model !== "default" ? ["--model", spec.model] : []),
		"-e", extensionPath,
		"--",
		prompt,
	];
}

export class PiExecutor implements Executor {
	piBin: string;
	extensionPath: string;

	constructor(opts: PiExecutorOptions = {}) {
		this.piBin = opts.piBin ?? process.env.PI_TEAM_PI_BIN ?? "pi";
		this.extensionPath = opts.extensionPath ?? defaultExtensionPath();
	}

	async launch(spec: LaunchSpec): Promise<ProcessIdentity> {
		const launchToken = newLaunchToken();
		return launchDetached({
			spec,
			executor: "pi",
			command: this.piBin,
			args: buildPiArgs(spec, this.extensionPath),
			env: buildWorkerEnv(spec, launchToken),
			launchToken,
		});
	}

	probe(id: Pick<ProcessIdentity, "pid" | "process_started_at">): Promise<ProbeResult> {
		return probeIdentity(id);
	}

	stop(id: Pick<ProcessIdentity, "pid" | "process_started_at">, graceMs?: number): Promise<void> {
		return stopIdentity(id, graceMs);
	}
}
