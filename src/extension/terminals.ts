import { TmuxWatch } from "../watch/tmux.ts";
import type { TerminalLocation, TerminalOptions } from "../shared/protocol.ts";
import type { TeamRuntime } from "./runtime.ts";
import { currentTmuxPane } from "../shared/environment.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

/** Automatic panes must actually contain this Pi, not just be named by inherited markers. */
async function containsCurrentProcess(panePid: number): Promise<boolean> {
	let pid = process.pid;
	for (let depth = 0; pid > 1 && depth < 32; depth++) {
		if (pid === panePid) return true;
		const result = await exec("ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 2000 });
		pid = Number(result.stdout.trim());
	}
	return false;
}

/** Pane convenience must never prevent member creation in SSH, Herdr or a stale terminal environment. */
export async function autoOpenTerminals(rt: TeamRuntime, runId: string): Promise<string | undefined> {
	const pane = currentTmuxPane();
	if (rt.managed || !pane) return;
	const token = await rt.commandToken();
	const cfg = await rt.client.get<{ auto_open?: boolean }>(`/runs/${encodeURIComponent(runId)}/terminal`, { token });
	if (cfg.auto_open === false) return;
	try {
		const view = new TmuxWatch({ stateDir: rt.paths.dir, runId });
		const pid = Number(await view.tmux("display-message", "-p", "-t", pane, "#{pane_pid}"));
		if (!Number.isInteger(pid) || !await containsCurrentProcess(pid)) return "Inherited tmux pane does not contain this Pi; continuing without automatic panes.";
		await openTerminals(rt, runId);
	} catch (e) { return `Automatic tmux panes unavailable: ${(e as Error).message}. Member recruitment continues; use /team watch off for detached workers or /team watch open to retry panes.`; }
}

/** Resolve stale pane tags using controller state, rather than treating them as agent identity. */
export async function openTerminals(rt: TeamRuntime, runId: string, options: { debug?: boolean } = {}): Promise<TmuxWatch> {
	const token = await rt.commandToken();
	const cfg = await rt.client.get<TerminalOptions>(`/runs/${encodeURIComponent(runId)}/terminal`, { token });
	const view = new TmuxWatch({ stateDir: rt.paths.dir, runId, debug: options.debug ?? cfg.debug ?? false });
	const pane = currentTmuxPane();
	if (pane) {
		const owner = await view.tmux("show-options", "-p", "-qv", "-t", pane, "@pi_team_owner");
		if (owner && owner !== view.owner) {
			const runs = (await rt.client.listRuns({ token })).runs;
			const old = runs.find((r) => new TmuxWatch({ stateDir: rt.paths.dir, runId: r.run_id }).owner === owner);
			if (old && old.active_members === 0) {
				const cfg = await rt.client.get<{ socket?: string; location?: TerminalLocation }>(`/runs/${encodeURIComponent(old.run_id)}/terminal`, { token });
				await new TmuxWatch({ stateDir: rt.paths.dir, runId: old.run_id, ...cfg }).releaseLayout();
			} else throw new Error(old
				? `This pane has active members for ${old.run_id}. Use /team resume ${old.run_id} to return to them, /team stop ${old.run_id} to end them, or open the new team in another pane. /team list shows active teams.`
				: "This pane belongs to a team from another controller state directory; use its controller to stop it or open this team in a fresh tmux pane.");
		}
	}
	await view.open(pane);
	const socket = await view.tmux("display-message", "-p", "#{socket_path}");
	await rt.client.post(`/runs/${encodeURIComponent(runId)}/terminal`, { socket, location: view.opts.location, debug: view.opts.debug }, { token });
	return view;
}
