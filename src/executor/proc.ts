// OS process identity helpers: pid + OS-reported start time (guards against pid reuse).
// Works on macOS and Linux via `ps`. Start time is normalized to an ISO-8601 UTC string
// by running `ps` with TZ=UTC and LC_ALL=C, so it is stable across controller restarts
// regardless of the controller's own locale / timezone.

import { execFile, execFileSync } from "node:child_process";
import type { ProbeResult, ProcessIdentity } from "./types.ts";

const PS_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" };

interface PsInfo {
	stat: string; // process state, e.g. "S", "R", "Z" (zombie)
	started_at: string; // ISO UTC
}

function parsePs(out: string): PsInfo | null {
	const line = out.trim();
	if (!line) return null;
	// "<stat> <Dow> <Mon> <day> <HH:MM:SS> <YYYY>"
	const m = /^(\S+)\s+(.+)$/.exec(line);
	if (!m) return null;
	const lstart = m[2].replace(/\s+/g, " ").trim();
	const t = Date.parse(`${lstart} UTC`);
	return { stat: m[1], started_at: Number.isFinite(t) ? new Date(t).toISOString() : lstart };
}

const PS_ARGS = (pid: number) => ["-o", "stat=,lstart=", "-p", String(pid)];

function validPid(pid: number): boolean {
	return Number.isInteger(pid) && pid > 1;
}

export async function psInfo(pid: number): Promise<PsInfo | null> {
	if (!validPid(pid)) return null;
	return new Promise((resolve) => {
		execFile("ps", PS_ARGS(pid), { env: PS_ENV, timeout: 5000 }, (err, stdout) => {
			// ps exits 1 when the pid does not exist.
			resolve(err ? null : parsePs(String(stdout)));
		});
	});
}

export function psInfoSync(pid: number): PsInfo | null {
	if (!validPid(pid)) return null;
	try {
		return parsePs(execFileSync("ps", PS_ARGS(pid), { env: PS_ENV, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString());
	} catch {
		return null;
	}
}

/** OS start time of a live process (ISO UTC), or null if it does not exist / is a zombie. */
export async function processStartTime(pid: number): Promise<string | null> {
	const info = await psInfo(pid);
	return info && !info.stat.startsWith("Z") ? info.started_at : null;
}

export function processStartTimeSync(pid: number): string | null {
	const info = psInfoSync(pid);
	return info && !info.stat.startsWith("Z") ? info.started_at : null;
}

function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
	}
}

/** Alive iff the pid exists, is not a zombie, AND its start time equals the recorded one. */
export async function probeIdentity(id: Pick<ProcessIdentity, "pid" | "process_started_at">): Promise<ProbeResult> {
	if (!validPid(id.pid) || !id.process_started_at) return "dead";
	if (!pidExists(id.pid)) return "dead";
	const started = await processStartTime(id.pid);
	return started !== null && started === id.process_started_at ? "alive" : "dead";
}

function groupExists(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function killGroup(pgid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(-pgid, sig);
	} catch {
		/* ESRCH: group already gone */
	}
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop a detached worker and its whole process group (workers are launched detached, so
 * pid == pgid). No-op if the identity does not match a live process (dead or pid reused).
 * SIGTERM -> wait up to graceMs for the leader to exit -> SIGKILL whatever is left of the group.
 */
export async function stopIdentity(id: Pick<ProcessIdentity, "pid" | "process_started_at">, graceMs = 5000): Promise<void> {
	if ((await probeIdentity(id)) !== "alive") return;
	const pgid = id.pid;
	killGroup(pgid, "SIGTERM");
	const deadline = Date.now() + Math.max(0, graceMs);
	while (Date.now() < deadline) {
		if ((await probeIdentity(id)) === "dead") break;
		await delay(50);
	}
	// Leader still alive, or leader gone but grandchildren still in its group: SIGKILL the group.
	// (The group id was verified to belong to our process a moment ago; reuse within this
	// window would require the pid to be recycled as a new group leader in < graceMs.)
	if ((await probeIdentity(id)) === "alive" || groupExists(pgid)) killGroup(pgid, "SIGKILL");
	const killDeadline = Date.now() + 2000;
	while (Date.now() < killDeadline && (await probeIdentity(id)) === "alive") await delay(25);
}
