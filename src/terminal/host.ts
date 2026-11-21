// Host detection layer: which multiplexer hosts the leader, and what it can do for members.
// Backends declare capabilities here; display and session code dispatch on them instead of
// testing environment markers directly.
import { terminalHost, type TerminalHostKind } from "../shared/environment.ts";

/**
 * How a host can label a member terminal, richest first.
 * - components: host-native rich decoration (future Rex components); no self-drawn header.
 * - border-title: host draws a titled border around the member's terminal.
 * - label: host shows a short name (tmux pane title, Rex block label).
 * - self: host shows nothing; the member Pi draws its own decorated header.
 */
export type DecorationMode = "components" | "border-title" | "label" | "self";

export interface HostCapabilities {
	kind: TerminalHostKind;
	/** Members can run in persistent sessions the human can switch into on this host today. */
	sessions: boolean;
	decoration: DecorationMode;
	/** Why member sessions are unavailable here; members then run detached. */
	unavailable?: string;
}

const CAPABILITIES: Record<TerminalHostKind, Omit<HostCapabilities, "kind">> = {
	// In-place panes never change the user's window options, so only pane titles are guaranteed.
	tmux: { sessions: true, decoration: "label" },
	// Block labels now; Rex components will move this to "components" when Rex ships them.
	rex: { sessions: true, decoration: "label" },
	herdr: { sessions: false, decoration: "self",
		unavailable: "Herdr has no team pane backend, so members run detached." },
	plain: { sessions: false, decoration: "self",
		unavailable: "This terminal has no multiplexer, so members run detached. Start the leader Pi inside tmux for switchable member panes; a built-in session host is planned." },
};

export function hostCapabilities(kind: TerminalHostKind = terminalHost()): HostCapabilities {
	return { kind, ...CAPABILITIES[kind] };
}

/** Actionable error for an explicit request to open member sessions where none can live. */
export class NoSessionHostError extends Error {
	readonly caps: HostCapabilities;
	constructor(caps: HostCapabilities) {
		super(`Team member panes are unavailable: ${caps.unavailable ?? caps.kind}`);
		this.caps = caps;
		this.name = "NoSessionHostError";
	}
}
