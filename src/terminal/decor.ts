// Member decoration: one description per member, rendered by whatever the host supports.
// planDecoration() is the single dispatch point; when a host gains richer native display
// (for example Rex components) only its capability and this switch change.
import type { DecorationMode } from "./backends.ts";

export interface MemberDecor {
	agent_id: string;
	name: string;
	leader: boolean;
	/** xterm-256 color index, stable per agent ID. */
	color: number;
	/** Short instruction shown after the identity, such as how to return to the leader. */
	hint?: string;
}

export interface DecorationPlan {
	/** Native decoration the host applies, if any. */
	native?: Exclude<DecorationMode, "self">;
	/** Whether the member Pi draws its own header line. */
	selfHeader: boolean;
}

export function planDecoration(mode: DecorationMode): DecorationPlan {
	switch (mode) {
		case "components": return { native: "components", selfHeader: false };
		case "border-title": return { native: "border-title", selfHeader: true };
		case "label": return { native: "label", selfHeader: true };
		case "self": return { selfHeader: true };
	}
}

// Mid-luminance colors that stay legible on both dark and light terminal backgrounds.
const PALETTE = [33, 37, 71, 136, 166, 168, 134, 98, 31, 107, 173, 61];

export function memberColor(agentId: string): number {
	let hash = 0x811c9dc5;
	for (const char of agentId) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
	return PALETTE[hash % PALETTE.length];
}

function plain(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

export function memberDecor(agentId: string, name: string | undefined, leader = false): MemberDecor {
	return { agent_id: agentId, name: plain(leader ? name || "Team leader" : name || "Agent"), leader, color: memberColor(agentId) };
}

/** Short single-line label for hosts that only show text (tmux pane title, Rex block label). */
export function nativeLabel(decor: MemberDecor, max = 80): string {
	const label = decor.leader ? decor.name : `${decor.name} [${decor.agent_id}]`;
	return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** Plain text of the self-drawn header; the renderer fits it to the width and colors it. */
export function headerText(decor: MemberDecor): string {
	return ` ${decor.name}  ${decor.leader ? "team leader" : `team member · ${decor.agent_id}`}${decor.hint ? `  ·  ${decor.hint}` : ""} `;
}
