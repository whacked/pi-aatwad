// Backend-neutral view of a team's member terminals beside the leader.
// tmux panes and Rex blocks both implement it; callers never branch on the multiplexer.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { TerminalBackend, TerminalLocation, TerminalOptions, TreeNode } from "../shared/protocol.ts";

export interface WatchOptions { stateDir: string; runId: string; socket?: string; node?: string; location?: TerminalLocation; debug?: boolean }
/** One member terminal. `id` is the backend handle: a tmux pane ID or a Rex block ID. */
export interface Pane { id: string; window: string; agent: string; dead: boolean }
/** Ownership marker on a terminal: which team placed it and which member it hosts. */
export interface PaneTag { owner?: string; agent?: string }

export interface TerminalView {
	readonly backend: TerminalBackend;
	opts: WatchOptions;
	readonly owner: string;
	/** Set when opening took over a leader terminal still tagged for another team. */
	reclaimedFrom?: string;
	/** Environment variables a member must keep so it can identify its own host terminal. */
	readonly memberEnvKeys: readonly string[];
	exists(): Promise<boolean>;
	assertOwned(): Promise<void>;
	panes(): Promise<Pane[]>;
	/** Claim the leader terminal (when given) and prepare the team's region beside it. */
	open(leader?: string): Promise<void>;
	/** Hide optional view chrome; never stops members or touches the user's own terminals. */
	close(): Promise<void>;
	focus(agent?: string): Promise<void>;
	launchAgent(agent: string, role: string, command: string[], cwd: string): Promise<string>;
	sync(nodes: TreeNode[], interactive?: boolean): Promise<void>;
	removeMember(agent: string): Promise<void>;
	readTag(handle: string): Promise<PaneTag>;
	tag(handle: string, agent: string): Promise<void>;
	clearTag(handle: string): Promise<void>;
	releaseLeaderPane(handle: string): Promise<void>;
	/** PID of the process the multiplexer started in this terminal. */
	paneProcess(handle: string): Promise<number>;
	killPane(handle: string): Promise<void>;
	/** Address the controller should use to reach this multiplexer server. */
	serverAddress(): Promise<string>;
}

/** Stable per team and controller state directory; shared by every backend's ownership tags. */
export function teamOwner(stateDir: string, runId: string): string {
	return createHash("sha256").update(resolve(stateDir)).update("\0").update(runId).digest("hex");
}

/** Saved options select the backend; older saved configurations are tmux. */
export async function terminalView(opts: WatchOptions & { backend?: TerminalBackend }): Promise<TerminalView> {
	const { backend = "tmux", ...rest } = opts;
	if (backend === "rex") return new (await import("./rex.ts")).RexView(rest);
	if (backend === "native") return new (await import("./native.ts")).NativeView(rest);
	return new (await import("../watch/tmux.ts")).TmuxWatch(rest);
}

export function savedOptions(view: TerminalView, socket: string): TerminalOptions {
	return { ...(view.backend === "tmux" ? {} : { backend: view.backend }), socket, location: view.opts.location, ...(view.opts.debug ? { debug: true } : {}) };
}
