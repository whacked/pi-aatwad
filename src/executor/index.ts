// Executor factory. PI_TEAM_EXECUTOR unset or "pi" -> real Pi workers; anything else is a
// path to a node script launched by ScriptExecutor (tests / demo, no LLM).

import { ENV_EXECUTOR } from "../shared/protocol.ts";
import { PiExecutor } from "./pi.ts";
import { ScriptExecutor } from "./script.ts";
import type { Executor } from "./types.ts";

export function createExecutor(env: NodeJS.ProcessEnv = process.env): Executor {
	const choice = env[ENV_EXECUTOR];
	if (!choice || choice === "pi") return new PiExecutor();
	return new ScriptExecutor(choice);
}

export type { Executor, LaunchSpec, ProbeResult, ProcessIdentity } from "./types.ts";
export { PiExecutor, buildPiArgs, DEFAULT_RESUME_PROMPT, defaultExtensionPath } from "./pi.ts";
export { ScriptExecutor } from "./script.ts";
export { buildWorkerEnv, ENV_ALLOWLIST, ENV_LAUNCH_TOKEN } from "./env.ts";
export { probeIdentity, stopIdentity, processStartTime, processStartTimeSync } from "./proc.ts";
export { prepareWorkspace, assertInside, worktreePath } from "./workspace.ts";
