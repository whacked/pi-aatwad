// Host detection: which environment this Pi runs in, and so where its members' terminals go.
//
// Hosts are tried in order of feature richness: bb > Rex > tmux > built-in session host >
// detached. Each host first *detects* (cheap: its environment markers are present), then is
// *verified* (markers are only claims: inherited variables survive into child processes, so a
// marker is trusted only when the live system confirms this process really is inside that
// terminal). The first host that is detected and usable wins; the rest are fallbacks.
//
// Detection runs once at startup (refreshHost) and can be re-run at any time (/team host
// refresh, or the controller's POST /agents/:id/host/refresh). Until the first verified run,
// currentHost() answers from markers alone.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerminalBackend } from "../shared/protocol.ts";
import { BACKENDS, type DecorationMode } from "./backends.ts";
import { bbControlFrom, showThread, type BbThreadDetails } from "./bb-cli.ts";

const exec = promisify(execFile);

export type HostKind = "bb" | "rex" | "tmux" | "native" | "detached";

export interface HostCandidate {
	host: HostKind;
	label: string;
	/** Its environment markers are present. */
	detected: boolean;
	/** Verified usable; undefined when not checked (a richer host already won). */
	usable?: boolean;
	reason?: string;
}

export interface HostDetection {
	host: HostKind;
	label: string;
	/** Backend that holds member terminals; absent when members run detached. */
	backend?: TerminalBackend;
	/** The leader's own terminal handle on that backend (pane ID, block ID, "native"). */
	leader?: string;
	/** Members get persistent terminals the human can switch into. */
	sessions: boolean;
	beside: boolean;
	decoration: DecorationMode;
	/** False when answered from markers alone (before or without verification). */
	verified: boolean;
	candidates: HostCandidate[];
	detected_at: string;
	/** Why no richer host was used, when members run detached. */
	unavailable?: string;
}

/** Live checks behind verification; injectable for tests. */
export interface HostProbe {
	/** This process's controlling terminal (e.g. "ttys003", "pts/3"), or undefined. */
	tty(): Promise<string | undefined>;
	/** Whether pid is this process or one of its ancestors. */
	contains(pid: number): Promise<boolean>;
	/** The tty device of a tmux pane ("/dev/ttys003"); throws if tmux cannot answer. */
	tmuxPaneTty(pane: string): Promise<string>;
	/** PID of the process running in a Rex block; throws if Rex cannot answer. */
	rexBlockPid(block: string): Promise<number>;
	/** A bb thread's details (undefined when bb does not know it); throws if bb cannot answer. */
	bbThread(thread: string): Promise<BbThreadDetails | undefined>;
}

interface Markers { leader: string }

interface HostProvider {
	kind: HostKind;
	/** Always available as a last resort; it has no markers of its own. */
	fallback?: boolean;
	label: string;
	backend?: TerminalBackend;
	/** Detect: the environment claims this host. */
	markers(env: NodeJS.ProcessEnv): Markers | undefined;
	/** Known unusable without touching the system (unimplemented, unsupported platform). */
	unusable?(): string | undefined;
	/** Verify the claim against the live system; returns why it is not usable. */
	verify?(m: Markers, probe: HostProbe, strict: boolean): Promise<string | undefined>;
}

async function needTerminal(probe: HostProbe): Promise<string | undefined> {
	return await probe.tty() ? undefined : "this Pi has no terminal of its own (inherited markers)";
}

/** Ordered by feature richness. The order is the decision. */
export const HOSTS: readonly HostProvider[] = [
	{
		kind: "bb", label: "bb", backend: "bb",
		markers: (env) => /^thr_[0-9a-z]+$/i.test(env.BB_THREAD_ID ?? "") && env.BB_CLI ? { leader: env.BB_THREAD_ID! } : undefined,
		verify: async (m, probe, strict) => {
			// bb runs its agent Pi headless; a Pi with a terminal was started from a shell inside the thread.
			if (strict && await probe.tty()) return "this Pi has a terminal of its own, so it is not the thread's agent (inherited BB_THREAD_ID)";
			let d: BbThreadDetails | undefined;
			try { d = await probe.bbThread(m.leader); } catch (e) { return `bb cannot answer: ${(e as Error).message}`; }
			if (!d) return `bb does not know thread ${m.leader}`;
			if (d.thread.archivedAt || d.thread.deletedAt) return `bb thread ${m.leader} is archived`;
			if (!d.environment?.hostId) return `bb thread ${m.leader} has no machine to run members on`;
			return undefined;
		},
	},
	{
		kind: "rex", label: "Rex", backend: "rex",
		markers: (env) => env.REX_SERVER && /^block:[0-9a-f-]+$/i.test(env.REX_BLOCK ?? "") ? { leader: env.REX_BLOCK! } : undefined,
		verify: async (m, probe, strict) => {
			if (strict) { const r = await needTerminal(probe); if (r) return r; }
			let pid: number;
			try { pid = await probe.rexBlockPid(m.leader); } catch (e) { return `Rex cannot find ${m.leader}: ${(e as Error).message}`; }
			if (strict && !await probe.contains(pid)) return `${m.leader} does not contain this Pi (inherited REX_BLOCK)`;
			return undefined;
		},
	},
	{
		kind: "tmux", label: "tmux", backend: "tmux",
		markers: (env) => env.TMUX && /^%\d+$/.test(env.TMUX_PANE ?? "") ? { leader: env.TMUX_PANE! } : undefined,
		verify: async (m, probe, strict) => {
			const tty = strict ? await probe.tty() : undefined;
			if (strict && !tty) return "this Pi has no terminal of its own (inherited markers)";
			let paneTty: string;
			try { paneTty = await probe.tmuxPaneTty(m.leader); } catch (e) { return (e as Error).message; }
			// Same terminal device, not just ancestry: a multiplexer nested inside this pane
			// (e.g. Herdr) gives its programs their own terminals, so the pane is not ours.
			if (strict && paneTty.replace(/^\/dev\//, "") !== tty) return `${m.leader} is not this Pi's terminal (inherited TMUX_PANE)`;
			return undefined;
		},
	},
	{
		kind: "native", label: BACKENDS.native.label, backend: "native", fallback: true,
		markers: () => ({ leader: "native" }),
		unusable: () => BACKENDS.native.unsupported(),
	},
	{ kind: "detached", label: "detached workers", fallback: true, markers: () => ({ leader: "detached" }) },
];

const MARKER_KEYS = ["BB_THREAD_ID", "BB_CLI", "REX_SERVER", "REX_BLOCK", "TMUX", "TMUX_PANE", "PI_TEAM_HOST_VERIFY"] as const;
const markerKey = (env: NodeJS.ProcessEnv) => MARKER_KEYS.map((k) => env[k] ?? "").join("\0");

function result(winner: HostProvider, m: Markers, candidates: HostCandidate[], verified: boolean): HostDetection {
	const facts = winner.backend ? BACKENDS[winner.backend] : undefined;
	const skipped = candidates.filter((c) => c.detected && c.usable === false && c.host !== "detached");
	return {
		host: winner.kind, label: winner.label,
		...(facts ? { backend: facts.id, leader: m.leader } : {}),
		sessions: !!facts, beside: facts?.beside ?? false, decoration: facts?.decoration ?? "self",
		verified, candidates, detected_at: new Date().toISOString(),
		...(facts ? {} : { unavailable: `${skipped.map((c) => `${c.label}: ${c.reason}`).join("; ") || "no terminal host"}, so members run detached. Start the leader Pi in a bb thread, Rex or tmux for member terminals.` }),
	};
}

/** Markers only: no processes are run. */
export function detectHostFromMarkers(env: NodeJS.ProcessEnv = process.env): HostDetection {
	const candidates: HostCandidate[] = [];
	let winner: { p: HostProvider; m: Markers } | undefined;
	for (const p of HOSTS) {
		const m = p.markers(env);
		if (!m) { candidates.push({ host: p.kind, label: p.label, detected: false }); continue; }
		if (winner) { candidates.push({ host: p.kind, label: p.label, detected: true }); continue; }
		const reason = p.unusable?.();
		candidates.push({ host: p.kind, label: p.label, detected: true, usable: !reason, ...(reason ? { reason } : {}) });
		if (!reason) winner = { p, m };
	}
	return result(winner!.p, winner!.m, candidates, false);
}

/** Detect and verify, richest host first. */
export async function detectHost(env: NodeJS.ProcessEnv = process.env, probe: HostProbe = systemProbe(env)): Promise<HostDetection> {
	// Opt-out of process verification for wrappers that run Pi outside the terminal they name
	// (and tests driving a multiplexer from outside it). The host must still answer for it.
	const strict = env.PI_TEAM_HOST_VERIFY !== "markers";
	const candidates: HostCandidate[] = [];
	let winner: { p: HostProvider; m: Markers } | undefined;
	for (const p of HOSTS) {
		const m = p.markers(env);
		if (!m) { candidates.push({ host: p.kind, label: p.label, detected: false }); continue; }
		if (winner) { candidates.push({ host: p.kind, label: p.label, detected: true }); continue; }
		let reason = p.unusable?.();
		if (!reason && p.verify) reason = await p.verify(m, probe, strict).catch((e: Error) => `check failed: ${e.message}`);
		candidates.push({ host: p.kind, label: p.label, detected: true, usable: !reason, ...(reason ? { reason } : {}) });
		if (!reason) winner = { p, m };
	}
	return result(winner!.p, winner!.m, candidates, true);
}

let cache: { key: string; detection: HostDetection } | undefined;

/** The in-memory host: the last verified detection for these markers, else markers alone. */
export function currentHost(env: NodeJS.ProcessEnv = process.env): HostDetection {
	return cache?.key === markerKey(env) ? cache.detection : detectHostFromMarkers(env);
}

/** Re-run detection and replace the in-memory host. */
export async function refreshHost(env: NodeJS.ProcessEnv = process.env, probe?: HostProbe): Promise<HostDetection> {
	const detection = await detectHost(env, probe);
	cache = { key: markerKey(env), detection };
	return detection;
}

/** The verified host, detecting now if this environment has not been verified yet. */
export async function ensureHost(env: NodeJS.ProcessEnv = process.env): Promise<HostDetection> {
	const c = currentHost(env);
	return c.verified ? c : refreshHost(env);
}

/** One line per candidate, for /team host and tool output. */
export function describeHost(d: HostDetection): string {
	const lines = [`Host: ${d.label}${d.verified ? "" : " (from environment markers, not yet verified)"}`];
	for (const c of d.candidates) {
		const fallback = HOSTS.find((h) => h.kind === c.host)?.fallback;
		const state = !c.detected ? "not detected" : c.usable === undefined ? (fallback ? "fallback" : "detected, not needed") : c.usable ? (c.host === d.host ? "selected" : "usable") : `skipped: ${c.reason}`;
		lines.push(`  ${c.host === d.host ? "→" : " "} ${c.label}: ${state}`);
	}
	if (d.unavailable) lines.push(d.unavailable);
	return lines.join("\n");
}

/** Process that contains this Pi: pid is this process or an ancestor. */
export async function containsCurrentProcess(pid: number): Promise<boolean> {
	let cur = process.pid;
	for (let depth = 0; cur > 1 && depth < 32; depth++) {
		if (cur === pid) return true;
		const r = await exec("ps", ["-o", "ppid=", "-p", String(cur)], { timeout: 2000 });
		cur = Number(r.stdout.trim());
	}
	return false;
}

export function systemProbe(env: NodeJS.ProcessEnv = process.env): HostProbe {
	return {
		async tty() {
			const r = await exec("ps", ["-o", "tty=", "-p", String(process.pid)], { timeout: 2000 }).catch(() => ({ stdout: "" }));
			const t = r.stdout.trim();
			return t && !/^\?+$/.test(t) ? t : undefined;
		},
		contains: containsCurrentProcess,
		async tmuxPaneTty(pane) {
			try {
				const r = await exec("tmux", ["display-message", "-p", "-t", pane, "#{pane_tty}"], { env, timeout: 3000 });
				return r.stdout.trim();
			} catch (e) {
				const err = e as NodeJS.ErrnoException & { stderr?: string };
				throw new Error(err.code === "ENOENT" ? "tmux is not installed or is not on PATH" : `tmux cannot find ${pane}: ${err.stderr?.trim() || err.message}`);
			}
		},
		async rexBlockPid(block) {
			const { RexView } = await import("./rex.ts");
			return new RexView({ stateDir: "", runId: "" }).paneProcess(block);
		},
		bbThread: (thread) => showThread(bbControlFrom(env), thread),
	};
}

/** Actionable error for an explicit request to open member terminals where none can live. */
export class NoSessionHostError extends Error {
	readonly detection: HostDetection;
	constructor(detection: HostDetection) {
		super(`Team member terminals are unavailable: ${detection.unavailable ?? detection.label}`);
		this.name = "NoSessionHostError";
		this.detection = detection;
	}
}
