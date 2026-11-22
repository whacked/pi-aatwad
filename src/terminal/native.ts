// Built-in session host for terminals without a multiplexer (plain terminals, SSH, Herdr).
// Members live in ptyd, not beside the leader on screen; the human switches into one by
// attaching the leader's terminal (/team watch focus) and returns with /team back.
import type { TerminalLocation, TreeNode } from "../shared/protocol.ts";
import { TerminalAllocationError } from "../watch/terminal-error.ts";
import { memberDecor, nativeLabel } from "./decor.ts";
import { PtydClient } from "./native/client.ts";
import { ENV_PTY_HANDLE, ENV_PTYD_SOCKET } from "./native/protocol.ts";
import { teamOwner, type Pane, type PaneTag, type TerminalView, type WatchOptions } from "./view.ts";

/** Members are not placed beside the leader, so the location is a fixed marker. */
export const NATIVE_LOCATION: TerminalLocation = { window: "native", leader: "native" };
const HANDLE = /^pty:[0-9a-f]+$/;

export class NativeView implements TerminalView {
	readonly backend = "native" as const;
	readonly memberEnvKeys = [ENV_PTYD_SOCKET, ENV_PTY_HANDLE] as const;
	opts: WatchOptions;
	owner: string;
	reclaimedFrom?: string;
	readonly client: PtydClient;

	constructor(opts: WatchOptions) {
		this.opts = { ...opts, location: NATIVE_LOCATION };
		this.owner = teamOwner(opts.stateDir, opts.runId);
		this.client = new PtydClient(opts.stateDir);
	}

	/** Running host only; preflight checks platform support without starting the daemon. */
	async exists(): Promise<boolean> { return this.client.running(); }
	async assertOwned(): Promise<void> {}
	async panes(): Promise<Pane[]> {
		if (!await this.client.running()) return [];
		return (await this.client.list(this.owner)).map((p) => ({ id: p.handle, window: NATIVE_LOCATION.window, agent: p.agent, dead: !p.alive }));
	}
	async open(): Promise<void> {
		if (this.opts.debug) throw new Error("The debug control pane is tmux-only; use /team watch open here");
		await this.client.ensure();
	}
	async close(): Promise<void> {}
	/** Switching needs the leader's terminal; the leader UI attaches instead (see attachMember). */
	async focus(agent = "leader"): Promise<void> {
		if (agent === "leader") return;
		throw new Error(`Members here run in the built-in session host. Ask the human to run /team watch focus ${agent} in the leader Pi (or pi-team-attach ${agent} in another terminal); /team back returns.`);
	}
	async member(agent: string): Promise<Pane | undefined> {
		return (await this.panes()).find((p) => p.agent === agent);
	}

	async launchAgent(agent: string, role: string, command: string[], cwd: string): Promise<string> {
		try {
			await this.client.ensure();
			// No respawn in place: replace any previous terminal for this member.
			for (const old of (await this.client.list(this.owner)).filter((p) => p.agent === agent)) await this.client.request({ op: "kill", handle: old.handle });
			const created = await this.client.request<{ handle: string }>({ op: "spawn", owner: this.owner, agent, label: nativeLabel(memberDecor(agent, role)), command, cwd });
			return created.handle;
		} catch (error) {
			throw new TerminalAllocationError((error as Error).message, { cause: error });
		}
	}
	async sync(nodes: TreeNode[]): Promise<void> {
		const ptys = await this.client.list(this.owner);
		for (const node of nodes) {
			const label = nativeLabel(memberDecor(node.agent_id, node.role));
			for (const p of ptys.filter((p) => p.agent === node.agent_id && p.label !== label)) await this.client.request({ op: "tag", handle: p.handle, label });
		}
	}
	async removeMember(agent: string): Promise<void> {
		for (const p of (await this.client.list(this.owner)).filter((p) => p.agent === agent)) await this.killPane(p.handle);
	}
	async readTag(handle: string): Promise<PaneTag> {
		if (!HANDLE.test(handle) || !await this.client.running()) return {};
		try { const p = await this.client.info(handle); return { owner: p.owner, agent: p.agent }; }
		catch (e) { if (/not found/.test((e as Error).message)) return {}; throw e; }
	}
	async tag(handle: string, agent: string): Promise<void> { await this.client.request({ op: "tag", handle, owner: this.owner, agent }); }
	async clearTag(handle: string): Promise<void> { if (HANDLE.test(handle)) await this.client.request({ op: "tag", handle, owner: "", agent: "" }); }
	async releaseLeaderPane(): Promise<void> {}
	async paneProcess(handle: string): Promise<number> {
		const p = await this.client.info(handle);
		if (!p.alive) throw new Error(`member terminal ${handle} has exited`);
		return p.pid;
	}
	async killPane(handle: string): Promise<void> {
		if (await this.client.running()) await this.client.request({ op: "kill", handle });
	}
	async serverAddress(): Promise<string> { return this.client.socketPath; }
}
