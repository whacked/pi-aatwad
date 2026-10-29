// ScriptExecutor: launches `node <script>` with the same detached/env contract as PiExecutor.
// Used by tests and the demo (test/fixtures/fake-worker.ts) so no LLM or credentials are needed.
// The script additionally receives parent env vars prefixed PI_TEAM_FAKE_ (scenario knobs) and
// non-secret launch metadata as argv-free env: PI_TEAM_ROLE, PI_TEAM_PI_SESSION_PATH.

import { resolve } from "node:path";
import { buildWorkerEnv } from "./env.ts";
import { launchDetached, newLaunchToken } from "./launch.ts";
import { probeIdentity, stopIdentity } from "./proc.ts";
import type { Executor, LaunchSpec, ProbeResult, ProcessIdentity } from "./types.ts";

export const SCRIPT_ENV_PREFIXES = ["PI_TEAM_FAKE_"] as const;

export class ScriptExecutor implements Executor {
	script: string;
	nodeBin: string;

	constructor(script: string, nodeBin: string = process.execPath) {
		this.script = resolve(script);
		this.nodeBin = nodeBin;
	}

	async launch(spec: LaunchSpec): Promise<ProcessIdentity> {
		const launchToken = newLaunchToken();
		const env = buildWorkerEnv(spec, launchToken, process.env, SCRIPT_ENV_PREFIXES);
		env.PI_TEAM_ROLE = spec.role;
		env.PI_TEAM_PI_SESSION_PATH = spec.pi_session_path;
		return launchDetached({
			spec,
			executor: "script",
			command: this.nodeBin,
			args: [this.script],
			env,
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
