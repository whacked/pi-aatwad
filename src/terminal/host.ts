// Host detection layer: which multiplexer hosts the leader, and what it can do for members.
// Backends declare capabilities here; display and session code dispatch on them instead of
// testing environment markers directly.
import { terminalHost, type TerminalHostKind } from "../shared/environment.ts";
import type { TerminalBackend } from "../shared/protocol.ts";
import { nativeHostSupport } from "./native/client.ts";

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
	/** Backend that holds member sessions for this host. */
	backend: TerminalBackend;
	/** Members can run in persistent sessions the human can switch into on this host today. */
	sessions: boolean;
	/** Members appear on screen beside the leader (otherwise the human attaches to switch). */
	beside: boolean;
	decoration: DecorationMode;
	/** Why member sessions are unavailable here; members then run detached. */
	unavailable?: string;
}

export function hostCapabilities(kind: TerminalHostKind = terminalHost()): HostCapabilities {
	switch (kind) {
		// In-place panes never change the user's window options, so only pane titles are guaranteed.
		case "tmux": return { kind, backend: "tmux", sessions: true, beside: true, decoration: "label" };
		// Block labels now; Rex components will move this to "components" when Rex ships them.
		case "rex": return { kind, backend: "rex", sessions: true, beside: true, decoration: "label" };
		// No multiplexer: the built-in session host keeps members; the leader attaches to switch.
		case "herdr":
		case "plain": {
			const unsupported = nativeHostSupport();
			return { kind, backend: "native", sessions: !unsupported, beside: false, decoration: "self",
				...(unsupported ? { unavailable: `${unsupported}, so members run detached. Start the leader Pi inside tmux or Rex for member panes.` } : {}) };
		}
	}
}

/** Actionable error for an explicit request to open member sessions where none can live. */
export class NoSessionHostError extends Error {
	readonly caps: HostCapabilities;
	constructor(caps: HostCapabilities) {
		super(`Team member terminals are unavailable: ${caps.unavailable ?? caps.kind}`);
		this.name = "NoSessionHostError";
		this.caps = caps;
	}
}
