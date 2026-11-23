import type { TeamRuntime } from "./runtime.ts";
import { containsCurrentProcess, ensureHost, NoSessionHostError } from "../terminal/hosts.ts";
import { BACKENDS, type BackendFacts } from "../terminal/backends.ts";
import { savedOptions, teamOwner, terminalView, type TerminalView } from "../terminal/view.ts";
import { DETACH_SEQUENCE, ENV_PTY_HANDLE } from "../terminal/native/protocol.ts";
import type { TerminalOptions } from "../shared/protocol.ts";

/** The leader's own terminal on the detected host, when that host can hold member terminals. */
async function leaderTerminal(): Promise<{ facts: BackendFacts; handle: string } | undefined> {
	const host = await ensureHost();
	return host.backend && host.leader ? { facts: BACKENDS[host.backend], handle: host.leader } : undefined;
}

/** Terminal convenience must never prevent member creation in SSH or a stale terminal environment. */
export async function autoOpenTerminals(rt: TeamRuntime, runId: string): Promise<string | undefined> {
	if (rt.managed) return;
	const leader = await leaderTerminal();
	if (!leader) return;
	const token = await rt.commandToken();
	const cfg = await rt.client.get<{ auto_open?: boolean }>(`/runs/${encodeURIComponent(runId)}/terminal`, { token });
	if (cfg.auto_open === false) return;
	try { await openTerminals(rt, runId); }
	catch (e) { return `Automatic member ${leader.facts.noun}s unavailable: ${(e as Error).message}. Member recruitment continues; use /team watch off for detached workers or /team watch open to retry.`; }
}

/** Resolve stale leader tags using controller state, rather than treating them as agent identity. */
export async function openTerminals(rt: TeamRuntime, runId: string, options: { debug?: boolean; occupiesPane?: (panePid: number) => Promise<boolean> } = {}): Promise<TerminalView> {
	const leader = await leaderTerminal();
	// Member terminals only ever open beside the leader; never in a detached multiplexer session.
	if (!leader) throw new NoSessionHostError(await ensureHost());
	const { facts, handle } = leader, backend = facts.id, noun = facts.noun;
	const token = await rt.commandToken();
	const cfg = await rt.client.get<TerminalOptions>(`/runs/${encodeURIComponent(runId)}/terminal`, { token });
	const view = await terminalView({ stateDir: rt.paths.dir, runId, backend, debug: options.debug ?? cfg.debug ?? false });
	// The built-in host has no shared leader terminal to contest; teams are separated by owner.
	const { owner } = facts.fixedLocation ? {} : await view.readTag(handle);
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
				throw new Error(`This ${noun} is an old team member ${noun}, not its leader; open this team in a fresh ${facts.label} ${noun}.`);
			// Release only this verified human-terminal association, not a whole saved
			// layout (which can be missing or point elsewhere). The old root-only run stays
			// intact and can still be resumed.
			const stale = await terminalView({ stateDir: rt.paths.dir, runId: old.run_id, backend });
			await stale.releaseLeaderPane(handle);
		} else throw new Error(old
			? `This ${noun} has active members for ${old.run_id}, and this Pi is not running inside it (inherited ${facts.marker}). Run /team watch from the Pi that leads ${runId} in its own ${noun}, or use /team resume ${old.run_id} to return to the other team. /team list shows active teams.`
			: `This ${noun} belongs to a team from another controller state directory, and this Pi is not running inside it (inherited ${facts.marker}); open this team from its own ${facts.label} ${noun}.`);
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
