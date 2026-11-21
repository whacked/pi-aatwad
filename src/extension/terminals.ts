import type { TeamRuntime } from "./runtime.ts";
import { currentRexBlock, currentTmuxPane } from "../shared/environment.ts";
import { hostCapabilities, NoSessionHostError } from "../terminal/host.ts";
import { savedOptions, teamOwner, terminalView, type TerminalView } from "../terminal/view.ts";
import { DETACH_SEQUENCE, ENV_PTY_HANDLE } from "../terminal/native/protocol.ts";
import type { TerminalBackend, TerminalOptions } from "../shared/protocol.ts";
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

/** The leader's own terminal on a host that can hold member sessions, from its markers. */
function leaderTerminal(): { backend: TerminalBackend; handle: string; noun: string } | undefined {
	const caps = hostCapabilities();
	if (!caps.sessions) return undefined;
	if (caps.backend === "native") return { backend: "native", handle: "native", noun: "terminal" };
	const pane = currentTmuxPane();
	if (pane) return { backend: "tmux", handle: pane, noun: "pane" };
	const rex = currentRexBlock();
	if (rex) return { backend: "rex", handle: rex.block, noun: "block" };
	return undefined;
}

/** Pane convenience must never prevent member creation in SSH, Herdr or a stale terminal environment. */
export async function autoOpenTerminals(rt: TeamRuntime, runId: string): Promise<string | undefined> {
	const leader = leaderTerminal();
	if (rt.managed || !leader) return;
	const token = await rt.commandToken();
	const cfg = await rt.client.get<{ auto_open?: boolean }>(`/runs/${encodeURIComponent(runId)}/terminal`, { token });
	if (cfg.auto_open === false) return;
	try {
		if (leader.backend === "native") { await openTerminals(rt, runId); return; }
		const view = await terminalView({ stateDir: rt.paths.dir, runId, backend: leader.backend });
		const pid = await view.paneProcess(leader.handle);
		if (!await containsCurrentProcess(pid)) return `Inherited ${leader.backend} ${leader.noun} does not contain this Pi; continuing without automatic member ${leader.noun}s.`;
		await openTerminals(rt, runId);
	} catch (e) { return `Automatic member ${leader.noun}s unavailable: ${(e as Error).message}. Member recruitment continues; use /team watch off for detached workers or /team watch open to retry.`; }
}

/** Resolve stale leader tags using controller state, rather than treating them as agent identity. */
export async function openTerminals(rt: TeamRuntime, runId: string, options: { debug?: boolean; occupiesPane?: (panePid: number) => Promise<boolean> } = {}): Promise<TerminalView> {
	const leader = leaderTerminal();
	// Member terminals only ever open beside the leader; never in a detached multiplexer session.
	if (!leader) throw new NoSessionHostError(hostCapabilities());
	const { backend, handle, noun } = leader;
	const token = await rt.commandToken();
	const cfg = await rt.client.get<TerminalOptions>(`/runs/${encodeURIComponent(runId)}/terminal`, { token });
	const view = await terminalView({ stateDir: rt.paths.dir, runId, backend, debug: options.debug ?? cfg.debug ?? false });
	// The built-in host has no shared leader terminal to contest; teams are separated by owner.
	const { owner } = backend === "native" ? {} : await view.readTag(handle);
	if (owner && owner !== view.owner) {
		const runs = (await rt.client.listRuns({ token })).runs;
		const old = runs.find((r) => teamOwner(rt.paths.dir, r.run_id) === owner);
		const panePid = await view.paneProcess(handle).catch(() => NaN);
		if (Number.isInteger(panePid) && await (options.occupiesPane ?? containsCurrentProcess)(panePid).catch(() => false)) {
			// This Pi demonstrably runs in the terminal, and it leads the requested team, so
			// whatever the tag says is history: no other leader or member can live here.
			// Only this terminal's tags change. The previous team keeps its identities, tasks,
			// transcripts and its other terminals; its controller-side terminal check then
			// moves members that were anchored here to detached execution.
			await view.clearTag(handle);
			view.reclaimedFrom = old ? `${old.run_id}${old.active_members ? ` (${old.active_members} active member(s) continue detached; /team resume ${old.run_id} returns to them)` : ""}` : "a team from another controller state directory";
		} else if (old && old.active_members === 0) {
			if ((await view.readTag(handle)).agent !== "leader")
				throw new Error(`This ${noun} is an old team member ${noun}, not its leader; open this team in a fresh ${backend} ${noun}.`);
			// Release only this verified human-terminal association, not a whole saved
			// layout (which can be missing or point elsewhere). The old root-only run stays
			// intact and can still be resumed.
			const stale = await terminalView({ stateDir: rt.paths.dir, runId: old.run_id, backend });
			await stale.releaseLeaderPane(handle);
		} else throw new Error(old
			? `This ${noun} has active members for ${old.run_id}, and this Pi is not running inside it (inherited ${backend === "tmux" ? "TMUX_PANE" : "REX_BLOCK"}). Run /team watch from the Pi that leads ${runId} in its own ${noun}, or use /team resume ${old.run_id} to return to the other team. /team list shows active teams.`
			: `This ${noun} belongs to a team from another controller state directory, and this Pi is not running inside it (inherited ${backend === "tmux" ? "TMUX_PANE" : "REX_BLOCK"}); open this team from its own ${backend} ${noun}.`);
	}
	await view.open(handle);
	await rt.client.post(`/runs/${encodeURIComponent(runId)}/terminal`, savedOptions(view, await view.serverAddress()), { token });
	return view;
}

/** Member side of switching: hand the human back to the leader; the member keeps running. */
export async function leaveToLeader(rt: TeamRuntime, write: (data: string) => void = (d) => { process.stdout.write(d); }): Promise<string> {
	// Built-in host: the attached client watches for this sequence and returns to the leader.
	if (process.env[ENV_PTY_HANDLE]) { write(DETACH_SEQUENCE); return "Returning to the leader; this member keeps running."; }
	const runId = rt.identity!.run_id;
	const terminal = await rt.client.get<TerminalOptions & { enabled?: boolean }>(`/runs/${encodeURIComponent(runId)}/terminal`);
	if (!terminal.enabled || !terminal.location) return "This member is not in a switchable terminal; there is nothing to leave.";
	const view = await terminalView({ stateDir: rt.paths.dir, runId, backend: terminal.backend, socket: terminal.socket, location: terminal.location });
	await view.focus("leader");
	return "Focused the leader; this member keeps running.";
}
