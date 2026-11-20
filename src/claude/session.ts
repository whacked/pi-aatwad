// Claude Code adapter state. A Claude Code session is an ordinary team agent (harness "claude-code"):
// identity, hierarchy, tasks and reassignment live in the controller. This module only maps one Claude
// Code session to its agent credential and shares liveness/wake state between the MCP server, the hooks
// and the background waiter, which are separate processes.
//
// Files under <state dir>/claude/ (0600):
//   sess-<claude_session_id>.json  identity (run, agent, bearer); survives `claude --resume`
//   pid-<claude_pid>.json          {session_id, busy, continuations}: written by hooks, read by the MCP server
//   wake-<claude_session_id>.json  last controller wake for this session; consumed by the Stop hook or waiter
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { statePaths, type StatePaths } from "../shared/paths.ts";
import { TeamClient } from "../shared/client.ts";
import type { Wake } from "../shared/protocol.ts";

export const HARNESS = "claude-code";

export interface Identity { run_id: string; agent_id: string; session_id: string; token: string; role?: string; cwd?: string; updated_at: string }
export interface PidState { session_id?: string; busy?: boolean; busy_since?: string; continuations?: number; cwd?: string; waiter_pid?: number; waiter_prompted?: boolean }
export interface WakeFile { wake: Wake; at: string; inbox_pending: number }

export function claudeDir(paths: StatePaths = statePaths()): string {
	const d = join(paths.dir, "claude");
	mkdirSync(d, { recursive: true, mode: 0o700 });
	return d;
}

function readJson<T>(file: string): T | undefined {
	try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return undefined; }
}
function writeJson(file: string, v: unknown): void {
	const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

export const identityFile = (sid: string, paths?: StatePaths) => join(claudeDir(paths), `sess-${safe(sid)}.json`);
export const pidFile = (pid: number, paths?: StatePaths) => join(claudeDir(paths), `pid-${pid}.json`);
export const wakeFile = (sid: string, paths?: StatePaths) => join(claudeDir(paths), `wake-${safe(sid)}.json`);

export const readIdentity = (sid: string, paths?: StatePaths) => readJson<Identity>(identityFile(sid, paths));
export const writeIdentity = (sid: string, id: Omit<Identity, "updated_at">, paths?: StatePaths) => writeJson(identityFile(sid, paths), { ...id, updated_at: new Date().toISOString() });
export const clearIdentity = (sid: string, paths?: StatePaths) => rmSync(identityFile(sid, paths), { force: true });
export const readPidState = (pid: number, paths?: StatePaths) => readJson<PidState>(pidFile(pid, paths)) ?? {};
export function updatePidState(pid: number, patch: PidState, paths?: StatePaths): PidState {
	const next = { ...readPidState(pid, paths), ...patch };
	writeJson(pidFile(pid, paths), next);
	return next;
}
export const readWake = (sid: string, paths?: StatePaths) => readJson<WakeFile>(wakeFile(sid, paths));
export const writeWake = (sid: string, w: WakeFile, paths?: StatePaths) => writeJson(wakeFile(sid, paths), w);
export const clearWake = (sid: string, paths?: StatePaths) => rmSync(wakeFile(sid, paths), { force: true });
export const hasWake = (sid: string, paths?: StatePaths) => existsSync(wakeFile(sid, paths));

/**
 * The Claude Code process that the MCP server, hooks and waiter all descend from: the nearest ancestor whose
 * command line mentions claude (native binary or the npm cli.js), skipping this adapter's own processes and
 * their wrapper shells. Falls back to the parent. PI_TEAM_CLAUDE_PID overrides (tests, unusual launchers).
 */
export function claudePid(start = process.pid): number {
	const forced = Number(process.env.PI_TEAM_CLAUDE_PID);
	if (forced > 0) return forced;
	let pid = start;
	for (let i = 0; i < 10; i++) {
		let line: string;
		try { line = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { break; }
		const m = /^(\d+)\s+(.*)$/.exec(line);
		if (!m) break;
		if (pid !== start && isClaudeCommand(m[2])) return pid;
		const ppid = Number(m[1]);
		if (ppid <= 1) break;
		pid = ppid;
	}
	return process.ppid;
}

export function isClaudeCommand(args: string): boolean {
	if (/src\/claude\/cli\.ts/.test(args)) return false;
	return /(^|[\/\s])claude(\s|$)/.test(args) || /claude-code\/cli\.(m?js)/.test(args) || /[\/]claude(\.exe)?(\s|$)/.test(args);
}

export function client(token?: () => string | undefined, paths: StatePaths = statePaths()): TeamClient {
	return new TeamClient({ paths, token });
}
