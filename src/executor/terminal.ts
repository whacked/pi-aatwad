// Start Pi attached to tmux's PTY. No pipes, JSON mode or print flag.
import { writeFileSync, unlinkSync } from "node:fs";
import { TmuxWatch } from "../watch/tmux.ts";
import { buildWorkerEnv } from "./env.ts";
import { newLaunchToken } from "./launch.ts";
import { processStartTime } from "./proc.ts";
import type { LaunchSpec, ProcessIdentity } from "./types.ts";

function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

export async function launchTerminal(spec: LaunchSpec, piBin: string, args: string[]): Promise<ProcessIdentity> {
	const token = newLaunchToken();
	const env = buildWorkerEnv(spec, token);
	env.TERM = "xterm-256color";
	const script = `${spec.enroll_file}.terminal.sh`;
	// tmux starts with a clean environment; shell exports don't expose keys in argv.
	// exec replaces the pane shell with Pi, retaining the pane's PID and process group.
	writeFileSync(script, `#!/bin/sh\n/bin/rm -f -- "$0"\n${Object.entries(env).map(([k, v]) => `export ${k}=${quote(v)}`).join("\n")}\nexec ${[piBin, ...args].map(quote).join(" ")}\n`, { mode: 0o600, flag: "wx" });
	const view = new TmuxWatch({ stateDir: spec.state_dir, runId: spec.run_id, socket: spec.terminal?.socket, location: spec.terminal?.location, debug: spec.terminal?.debug });
	let pane: string | undefined;
	try {
		pane = await view.launchAgent(spec.agent_id, spec.role, ["/bin/sh", "-c", 'exec /usr/bin/env -i TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" /bin/sh "$1"', "pi-team", script], spec.cwd);
		const pid = Number(await view.tmux("display-message", "-p", "-t", pane, "#{pane_pid}"));
		const started = await processStartTime(pid);
		if (!Number.isInteger(pid) || !started) throw new Error("interactive Pi exited before its process identity could be recorded");
		return { pid, process_started_at: started, launch_token: token };
	} catch (error) {
		if (pane) await view.tmux("kill-pane", "-t", pane).catch(() => {});
		throw error;
	} finally {
		// Successful launches consume the script themselves; don't unlink before the shell opens it.
		if (!pane) { try { unlinkSync(script); } catch {} }
	}
}
