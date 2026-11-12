import { TmuxWatch } from "../watch/tmux.ts";
import type { TerminalOptions } from "../shared/protocol.ts";
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
export async function openTerminals(rt: TeamRuntime, runId: string, options: { debug?: boolean; occupiesPane?: (panePid: number) => Promise<boolean> } = {}): Promise<TmuxWatch> {
	const token = await rt.commandToken();
	const cfg = await rt.client.get<TerminalOptions>(`/runs/${encodeURIComponent(runId)}/terminal`, { token });
	const view = new TmuxWatch({ stateDir: rt.paths.dir, runId, debug: options.debug ?? cfg.debug ?? false });
	const pane = currentTmuxPane();
	if (pane) {
		const owner = await view.tmux("show-options", "-p", "-qv", "-t", pane, "@pi_team_owner");
		if (owner && owner !== view.owner) {
			const runs = (await rt.client.listRuns({ token })).runs;
			const old = runs.find((r) => new TmuxWatch({ stateDir: rt.paths.dir, runId: r.run_id }).owner === owner);
			const panePid = Number(await view.tmux("display-message", "-p", "-t", pane, "#{pane_pid}"));
			if (Number.isInteger(panePid) && await (options.occupiesPane ?? containsCurrentProcess)(panePid).catch(() => false)) {
				// This Pi demonstrably runs in the pane, and it leads the requested team, so
				// whatever the tag says is history: no other leader or member can live here.
				// Only this pane's tags change. The previous team keeps its identities, tasks,
				// transcripts and its other panes; its controller-side terminal check then
				// moves members that were anchored here to detached execution.
				for (const key of ["@pi_team_owner", "@pi_team_agent", "@pi_team_harness"]) await view.tmux("set-option", "-p", "-u", "-t", pane, key);
				view.reclaimedFrom = old ? `${old.run_id}${old.active_members ? ` (${old.active_members} active member(s) continue detached; /team resume ${old.run_id} returns to them)` : ""}` : "a team from another controller state directory";
			} else if (old && old.active_members === 0) {
				if (await view.tmux("show-options", "-p", "-qv", "-t", pane, "@pi_team_agent") !== "leader")
					throw new Error("This pane is an old team member pane, not its leader; open this team in a fresh tmux pane.");
				// Tags live in tmux, not in the Pi session or controller config.
				// Release only this verified human-pane association on this server,
				// not a whole saved layout (which can be missing or point elsewhere).
				// The old root-only run stays intact and can still be resumed.
				const stale = new TmuxWatch({ stateDir: rt.paths.dir, runId: old.run_id });
				await stale.releaseLeaderPane(pane);
			} else throw new Error(old
				? `This pane has active members for ${old.run_id}, and this Pi is not running inside it (inherited TMUX_PANE). Run /team watch from the Pi that leads ${runId} in its own pane, or use /team resume ${old.run_id} to return to the other team. /team list shows active teams.`
				: "This pane belongs to a team from another controller state directory, and this Pi is not running inside it (inherited TMUX_PANE); open this team from its own tmux pane.");
		}
	}
	await view.open(pane);
	const socket = await view.tmux("display-message", "-p", "#{socket_path}");
	await rt.client.post(`/runs/${encodeURIComponent(runId)}/terminal`, { socket, location: view.opts.location, debug: view.opts.debug }, { token });
	return view;
}
