// Thin wrapper around the bb CLI. Every bb thread gets BB_CLI (the CLI matching its bb server) and
// BB_SERVER_URL in its env; the controller keeps a copy of those (the team's terminal `env`) so it can
// reach the same bb server without inheriting a leader's environment.
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Environment keys the controller needs to drive bb. */
export const BB_CONTROL_ENV = ["BB_CLI", "BB_SERVER_URL", "BB_DATA_DIR"] as const;
export type BbControl = Partial<Record<(typeof BB_CONTROL_ENV)[number], string>>;

/** The control env of the bb that runs this process (from its thread env). */
export function bbControlFrom(env: NodeJS.ProcessEnv = process.env): BbControl {
	// bb sets BB_THREAD_STORAGE=<data dir>/thread-storage/<thread> but not always BB_DATA_DIR.
	const data = env.BB_DATA_DIR ?? (env.BB_THREAD_STORAGE ? dirname(dirname(env.BB_THREAD_STORAGE)) : undefined);
	return {
		...(env.BB_CLI ? { BB_CLI: env.BB_CLI } : {}),
		...(env.BB_SERVER_URL ? { BB_SERVER_URL: env.BB_SERVER_URL } : {}),
		...(data ? { BB_DATA_DIR: data } : {}),
	};
}

export interface BbThread {
	id: string;
	status: string;
	title: string | null;
	projectId: string;
	environmentId?: string | null;
	parentThreadId?: string | null;
	archivedAt?: string | null;
	deletedAt?: string | null;
}
export interface BbThreadDetails { thread: BbThread; environment: { id: string; hostId: string; path?: string } | null }

export class BbError extends Error {
	readonly notFound: boolean;
	constructor(message: string, notFound = false) { super(message); this.name = "BbError"; this.notFound = notFound; }
}

export async function bb(control: BbControl, args: string[], timeoutMs = 30_000): Promise<string> {
	const cli = control.BB_CLI;
	if (!cli) throw new BbError("the bb CLI is unknown (BB_CLI is not set); open member threads from a leader Pi running in a bb thread");
	const env: NodeJS.ProcessEnv = { ...process.env, ...control };
	// Never let an inherited thread marker pick a target implicitly.
	delete env.BB_THREAD_ID;
	try {
		const r = await exec(cli, args, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
		return r.stdout.trim();
	} catch (e) {
		const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
		let message = err.stderr?.trim() || "";
		try { const j = JSON.parse(err.stdout ?? ""); if (j?.error?.message) message = `${j.error.code ? `${j.error.code}: ` : ""}${j.error.message}`; } catch { /* not JSON */ }
		if (err.code === "ENOENT") message = `the bb CLI ${cli} does not exist`;
		message ||= err.message;
		throw new BbError(`bb ${args.slice(0, 2).join(" ")}: ${message}`, /not.?found|404/i.test(message));
	}
}

export async function bbJson<T>(control: BbControl, args: string[], timeoutMs?: number): Promise<T> {
	const out = await bb(control, [...args, "--json"], timeoutMs);
	const j = JSON.parse(out) as T & { ok?: boolean; error?: { code?: string; message?: string } };
	if (j && j.ok === false) throw new BbError(`bb ${args.slice(0, 2).join(" ")}: ${j.error?.message ?? "failed"}`, /not.?found/i.test(`${j.error?.code} ${j.error?.message}`));
	return j;
}

/** Thread details, or undefined when bb does not know the thread. */
export async function showThread(control: BbControl, id: string): Promise<BbThreadDetails | undefined> {
	try { return await bbJson<BbThreadDetails>(control, ["thread", "show", id]); }
	catch (e) { if (e instanceof BbError && e.notFound) return undefined; throw e; }
}

/** A thread that can still run: exists, not archived, not deleted. */
export function threadUsable(d: BbThreadDetails | undefined): d is BbThreadDetails {
	return !!d && !d.thread.archivedAt && !d.thread.deletedAt;
}
