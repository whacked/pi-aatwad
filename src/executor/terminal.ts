// Start Pi attached to tmux's PTY. No pipes, JSON mode or print flag.
import { writeFileSync, unlinkSync } from "node:fs";
import { TmuxWatch } from "../watch/tmux.ts";
import { TerminalAllocationError } from "../watch/terminal-error.ts";
import { buildWorkerEnv } from "./env.ts";
import { newLaunchToken } from "./launch.ts";
import { processStartTime } from "./proc.ts";
import type { LaunchSpec, ProcessIdentity } from "./types.ts";

function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

export async function launchTerminal(spec: LaunchSpec, piBin: string, args: string[]): Promise<ProcessIdentity> {
	const token = newLaunchToken();
	const env = buildWorkerEnv(spec, token);
	env.TERM = "xterm-256color";
	// Unique per launch: an orphan shell must never observe a later attempt's gate.
	const script = `${spec.enroll_file}.${token}.terminal.sh`;
	const gate = `${script}.ready`;
	// A split/respawn can succeed even when tmux's reply or later pane setup fails.
	// Do not let that shell consume enrollment or write the transcript until setup
	// and identity capture succeed. Removing the script cancels even an unknown pane.
	// tmux starts with a clean environment; exports don't expose keys in argv.
	writeFileSync(script, `#!/bin/sh\nwhile [ ! -f ${quote(gate)} ]; do\n  [ -f "$0" ] || exit 0\n  /bin/sleep 0.05\ndone\n/bin/rm -f -- "$0" ${quote(gate)}\n${Object.entries(env).map(([k, v]) => `export ${k}=${quote(v)}`).join("\n")}\nexec ${[piBin, ...args].map(quote).join(" ")}\n`, { mode: 0o600, flag: "wx" });
	const view = new TmuxWatch({ stateDir: spec.state_dir, runId: spec.run_id, socket: spec.terminal?.socket, location: spec.terminal?.location, debug: spec.terminal?.debug });
	let pane: string | undefined;
	let committed = false;
	try {
		pane = await view.launchAgent(spec.agent_id, spec.role, ["/bin/sh", "-c", 'exec /usr/bin/env -i TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" /bin/sh "$1"', "pi-team", script], spec.cwd);
		let pid: number;
		let started: string | null;
		try {
			pid = Number(await view.tmux("display-message", "-p", "-t", pane, "#{pane_pid}"));
			started = Number.isInteger(pid) && pid > 0 ? await processStartTime(pid) : null;
			if (!started) throw new Error("terminal startup shell exited before its process identity could be recorded");
		} catch (error) {
			throw new TerminalAllocationError((error as Error).message, { cause: error });
		}
		writeFileSync(gate, "", { mode: 0o600, flag: "wx" });
		committed = true;
		return { pid, process_started_at: started, launch_token: token };
	} catch (error) {
		if (pane) await view.tmux("kill-pane", "-t", pane).catch(() => {});
		throw error;
	} finally {
		// Successful launches consume both files themselves. Failed allocation never
		// opens the gate, including when kill-pane fails or the pane ID was lost.
		if (!committed) {
			try { unlinkSync(script); } catch {}
			try { unlinkSync(gate); } catch {}
		}
	}
}
