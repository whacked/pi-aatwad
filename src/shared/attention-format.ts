// Harness-neutral formatting shared by the Pi extension and the Claude Code adapter (no Pi imports).
import type { AttentionPatch } from "./client.ts";
import type { AttentionView, Handoff } from "./protocol.ts";

/** Seconds from 15s / 3m / 1h / off / bare seconds. */
export function parseDuration(v: string | undefined): number {
	if (v === undefined) throw new Error("missing duration");
	if (v === "off" || v === "0") return 0;
	const m = /^(\d+)(s|m|h)?$/.exec(v);
	if (!m) throw new Error(`invalid duration ${v} (use 30s, 5m, 1h or off)`);
	return Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
}

export function parseAttention(a: string[]): AttentionPatch {
	const patch: AttentionPatch = {};
	for (let i = 0; i < a.length; i++) {
		const k = a[i], v = a[i + 1];
		if (k === "reset") { patch.reset = true; continue; }
		i++;
		if (k === "on-message") {
			if (v !== "wake" && v !== "next-turn") throw new Error("on-message takes wake or next-turn");
			patch.on_message = v === "wake" ? "wake" : "next_turn";
		} else if (k === "batch") patch.batch_seconds = parseDuration(v);
		else if (k === "stall") patch.stall_seconds = parseDuration(v);
		else if (k === "tick") patch.tick_seconds = parseDuration(v);
		else if (k === "cap") {
			if (!v || !/^\d+$/.test(v)) throw new Error("cap takes a whole number of wakes per hour");
			patch.max_wakes_per_hour = Number(v);
		} else throw new Error("usage: /team attention [team|name|agent_id] [on-message wake|next-turn] [batch 15s] [stall 3m|off] [tick 10m|off] [cap N] [reset]");
	}
	return patch;
}

export function formatAttention(v: AttentionView): string {
	const e = v.effective;
	const secs = (n: number) => (n === 0 ? "off" : n % 3600 === 0 ? `${n / 3600}h` : n % 60 === 0 ? `${n / 60}m` : `${n}s`);
	const set = Object.keys(v.configured);
	return [
		`attention for ${v.agent_id ?? `team ${v.run_id}`}${set.length ? ` (set here: ${set.join(", ")})` : " (inherited defaults)"}`,
		`  on-message ${e.on_message === "wake" ? "wake" : "next-turn"} · batch ${secs(e.batch_seconds)} · stall ${secs(e.stall_seconds)} · tick ${secs(e.tick_seconds)} · cap ${e.max_wakes_per_hour}/h`,
	].join("\n");
}

/** Handoff acknowledgement: the controller has the work; the leader should return control, not poll. */
export function handoffText(what: string, owner: string, h: Handoff | undefined): string {
	const state = !h ? "" : h.desired_state !== "RUNNING" ? ` ${owner} is ${h.desired_state.toLowerCase()}; it picks the work up when resumed.`
		: !h.owner_live ? ` ${owner} is not live yet; it receives the work when it starts.`
		: h.owner_busy ? ` ${owner} is busy and receives it when its current turn ends.`
		: ` ${owner} is idle and picks it up within about 10 seconds.`;
	return `Handed off: ${what} queued for ${owner}.${state} Do not poll or wait for the result; return control to the human now. Reports arrive as team messages and wake you.`;
}

