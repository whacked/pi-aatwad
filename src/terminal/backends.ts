// Backend registry: where member terminals live (tmux panes, Rex blocks, the built-in session
// host). Everything that differs between backends is a fact here, so the controller, executor
// and extension never compare backend names. View code is imported lazily, only when used.
// Which backend to use is decided by host detection (hosts.ts).
import type { TerminalBackend, TerminalLocation } from "../shared/protocol.ts";
import type { LaunchSpec, ProcessIdentity } from "../executor/types.ts";
import { nativeHostSupport } from "./native/client.ts";
import type { TerminalView, WatchOptions } from "./view.ts";

/**
 * How a host can label a member terminal, richest first.
 * - components: host-native rich decoration (future Rex components); no self-drawn header.
 * - border-title: host draws a titled border around the member's terminal.
 * - label: host shows a short name (tmux pane title, Rex block label).
 * - self: host shows nothing; the member Pi draws its own decorated header.
 */
export type DecorationMode = "components" | "border-title" | "label" | "self";

export interface BackendFacts {
	readonly id: TerminalBackend;
	/** Human name, e.g. "tmux" or "built-in session host". */
	readonly label: string;
	/** What one member terminal is called: pane, block, terminal. */
	readonly noun: string;
	/** Members appear on screen beside the leader (otherwise the human attaches to switch). */
	readonly beside: boolean;
	readonly decoration: DecorationMode;
	/** Supports the diagnostic control pane of /team watch debug. */
	readonly debugPane: boolean;
	/** Environment marker naming the leader's terminal, for messages about inherited markers. */
	readonly marker?: string;
	/** Backends without an on-screen place always use this location. */
	readonly fixedLocation?: TerminalLocation;
	/** Whether a saved location has this backend's ID format. */
	validLocation(location: TerminalLocation): boolean;
	/** Describes the location format for validation errors. */
	readonly locationFormat: string;
	/** Why this backend cannot run on this machine at all; undefined when it can. */
	unsupported(): string | undefined;
	view(opts: WatchOptions): Promise<TerminalView>;
	/** Environment the controller keeps to reach this host's CLI (saved with the team's terminal options). */
	readonly controlEnv?: readonly string[];
	/**
	 * Hosts that start member Pi themselves (bb): launch a member there. Otherwise the executor runs
	 * Pi in a terminal the view allocates (launchAgent).
	 */
	launch?(spec: LaunchSpec, prompt: string): Promise<ProcessIdentity>;
}

export const BACKENDS: Readonly<Record<TerminalBackend, BackendFacts>> = {
	tmux: {
		id: "tmux", label: "tmux", noun: "pane", beside: true,
		// In-place panes never change the user's window options, so only pane titles are guaranteed.
		decoration: "label", debugPane: true, marker: "TMUX_PANE",
		validLocation: (l) => /^@\d+$/.test(l.window) && /^%\d+$/.test(l.leader),
		locationFormat: "tmux window/pane IDs",
		unsupported: () => undefined,
		view: async (opts) => new (await import("./tmux.ts")).TmuxWatch(opts),
	},
	rex: {
		id: "rex", label: "Rex", noun: "block", beside: true,
		// Block labels now; Rex components will move this to "components" when Rex ships them.
		decoration: "label", debugPane: false, marker: "REX_BLOCK",
		validLocation: (l) => /^window:[0-9a-f-]+$/i.test(l.window) && /^block:[0-9a-f-]+$/i.test(l.leader),
		locationFormat: "Rex window/block IDs",
		unsupported: () => undefined,
		view: async (opts) => new (await import("./rex.ts")).RexView(opts),
	},
	native: {
		id: "native", label: "built-in session host", noun: "terminal", beside: false,
		// Nothing on screen: the member Pi draws its own header.
		decoration: "self", debugPane: false,
		fixedLocation: { window: "native", leader: "native" },
		validLocation: (l) => l.window === "native" && l.leader === "native",
		locationFormat: "the native marker",
		unsupported: () => nativeHostSupport(),
		view: async (opts) => new (await import("./native.ts")).NativeView(opts),
	},
	bb: {
		id: "bb", label: "bb", noun: "thread", beside: true,
		// Members are child threads in bb's sidebar, titled with their role.
		decoration: "label", debugPane: false, marker: "BB_THREAD_ID",
		validLocation: (l) => /^proj_[0-9a-z]+$/i.test(l.window) && /^thr_[0-9a-z]+$/i.test(l.leader),
		locationFormat: "a bb project and thread ID",
		unsupported: () => undefined,
		controlEnv: ["BB_CLI", "BB_SERVER_URL", "BB_DATA_DIR"],
		view: async (opts) => new (await import("./bb.ts")).BbView(opts),
		launch: async (spec, prompt) => (await import("../executor/bb.ts")).launchBbMember(spec, prompt),
	},
};

/** Saved configurations from before backends were recorded are tmux. */
export function backendFacts(backend: TerminalBackend | undefined): BackendFacts {
	return BACKENDS[backend ?? "tmux"];
}

export function isBackend(value: unknown): value is TerminalBackend {
	return typeof value === "string" && Object.hasOwn(BACKENDS, value);
}
