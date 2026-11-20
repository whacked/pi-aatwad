// Claude Code hooks: the Claude Code equivalents of the Pi extension's delivery paths.
//   SessionStart      ~ before_agent_start context   (identity + org context; carries identity across /clear and --resume)
//   UserPromptSubmit  ~ messages ride along with a human turn (busy=true)
//   Stop              ~ agent_before_settle continuation (deliver pending messages / stall digests; busy=false)
//   waiter (cli wait) ~ heartbeat-triggered turn while idle: a background command that exits on a controller wake
// Hooks talk to the controller directly with the session credential; the MCP server owns the heartbeat.
import { statePaths, type StatePaths } from "../shared/paths.ts";
import { readOperatorToken, TeamApiError } from "../shared/client.ts";
import type { Envelope } from "../shared/protocol.ts";
import { formatEnvelope, formatOrgContext } from "../extension/format.ts";
import { HARNESS, claudePid, clearIdentity, clearWake, client, readIdentity, readPidState, readWake, updatePidState, writeIdentity, type Identity } from "./session.ts";

export interface HookInput { session_id?: string; cwd?: string; hook_event_name?: string; source?: string; stop_hook_active?: boolean; prompt?: string }
export interface HookEnv { paths?: StatePaths; cpid?: number; waiterCommand?: string; waiter?: boolean }
type Out = Record<string, unknown> | undefined;

/** Bound automatic Stop continuations per human turn so message streams cannot loop forever. */
export const MAX_CONTINUATIONS = 5;

const ctxOut = (event: string, text: string): Out => (text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : undefined);

function alive(pid: number | undefined): boolean {
	if (!pid) return false;
	try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

async function claimAll(id: Identity, paths: StatePaths): Promise<Envelope[]> {
	const api = client(() => id.token, paths);
	const r = await api.inbox(20, { timeoutMs: 5_000 });
	for (const m of r.messages) await api.ack(m.message_id, { timeoutMs: 5_000 });
	return r.messages;
}

export function messagesText(id: Identity, messages: Envelope[], digest?: string): string {
	const parts: string[] = [];
	if (messages.length) parts.push(`Team inbox: ${messages.length} new message(s) for ${id.agent_id}. They are durable org messages delivered by the controller.\n\n${messages.map((m) => formatEnvelope(m)).join("\n\n---\n\n")}`);
	if (digest) parts.push(digest);
	return parts.join("\n\n");
}

/** Identity for this Claude Code session, carried over from the previous session id after /clear. */
function identityFor(sid: string, cpid: number, paths: StatePaths): Identity | undefined {
	const own = readIdentity(sid, paths);
	if (own) return own;
	const prev = readPidState(cpid, paths).session_id;
	if (!prev || prev === sid) return undefined;
	const carried = readIdentity(prev, paths);
	if (carried) {
		const { updated_at: _u, ...rest } = carried;
		writeIdentity(sid, rest, paths);
		clearIdentity(prev, paths);
	}
	return carried;
}

export async function sessionStart(input: HookInput, env: HookEnv = {}): Promise<Out> {
	const paths = env.paths ?? statePaths();
	const cpid = env.cpid ?? claudePid();
	const sid = input.session_id;
	if (!sid) return undefined;
	let id = identityFor(sid, cpid, paths);
	updatePidState(cpid, { session_id: sid, busy: false, continuations: 0, cwd: input.cwd }, paths);
	if (!id) return undefined;
	const api = client(() => id!.token, paths);
	let me;
	try {
		me = await api.me({ timeoutMs: 5_000 });
	} catch (e) {
		if (!(e instanceof TeamApiError) || e.status !== 401) return ctxOut("SessionStart", `pi-aatwad: this session belongs to team ${id.run_id} as ${id.agent_id}, but the controller is unreachable (${(e as Error).message.slice(0, 120)}).`);
		// The credential ended (left, superseded or controller restarted): reattach the same agent identity.
		try {
			const r = await api.attach(id.run_id, { agent_id: id.agent_id, harness: HARNESS }, { token: await readOperatorToken(paths, 1_000), idempotencyKey: `claude-resume:${sid}:${Date.now()}` });
			id = { ...id, session_id: r.session_id, token: r.token };
			const { updated_at: _u, ...rest } = id;
			writeIdentity(sid, rest, paths);
			me = await api.me({ timeoutMs: 5_000 });
		} catch (e2) {
			clearIdentity(sid, paths);
			return ctxOut("SessionStart", `pi-aatwad: could not rejoin team ${id.run_id} as ${id.agent_id}: ${(e2 as Error).message.slice(0, 160)}. Use team_join to join again.`);
		}
	}
	let text = formatOrgContext(me);
	if (me.is_root) text += "\nYou lead this team. Dispatching is a handoff: once team_create_member, team_delegate_task or team_send_message succeeds, summarize and end your turn; do not poll. Member reports arrive automatically.";
	else text += "\nCompleting a task does not end your membership; stay available for your manager. Leave only when the human asks (team_leave).";
	if (env.waiter !== false && env.waiterCommand) text += `\nTo receive team messages while idle, run this command in the background (run_in_background) now and again whenever it exits: ${env.waiterCommand}`;
	return ctxOut("SessionStart", text);
}

export async function userPromptSubmit(input: HookInput, env: HookEnv = {}): Promise<Out> {
	const paths = env.paths ?? statePaths();
	const cpid = env.cpid ?? claudePid();
	const sid = input.session_id;
	if (!sid) return undefined;
	updatePidState(cpid, { session_id: sid, busy: true, busy_since: new Date().toISOString(), continuations: 0, waiter_prompted: false }, paths);
	const id = readIdentity(sid, paths);
	if (!id) return undefined;
	try {
		const digest = readWake(sid, paths)?.wake.text;
		clearWake(sid, paths);
		return ctxOut("UserPromptSubmit", messagesText(id, await claimAll(id, paths), digest));
	} catch { return undefined; }
}

export async function stop(input: HookInput, env: HookEnv = {}): Promise<Out> {
	const paths = env.paths ?? statePaths();
	const cpid = env.cpid ?? claudePid();
	const sid = input.session_id;
	if (!sid) return undefined;
	const state = updatePidState(cpid, { session_id: sid, busy: false }, paths);
	const id = readIdentity(sid, paths);
	if (!id) return undefined;
	const api = client(() => id.token, paths);
	try {
		const policy = (await api.attention({ agent_id: id.agent_id }, { timeoutMs: 5_000 })).effective;
		if (policy.on_message !== "wake") return undefined;
		if ((state.continuations ?? 0) >= MAX_CONTINUATIONS) return undefined;
		const me = await api.me({ timeoutMs: 5_000 });
		const digest = readWake(sid, paths)?.wake.text;
		if (me.inbox_pending > 0 || digest) {
			clearWake(sid, paths);
			const text = messagesText(id, me.inbox_pending > 0 ? await claimAll(id, paths) : [], digest);
			if (text) {
				updatePidState(cpid, { busy: true, continuations: (state.continuations ?? 0) + 1 }, paths);
				return { decision: "block", reason: text };
			}
		}
		// Nothing pending: make sure an idle wake path exists (once per stop; the waiter persists across turns).
		if (env.waiter !== false && env.waiterCommand && !alive(state.waiter_pid) && !state.waiter_prompted) {
			updatePidState(cpid, { continuations: (state.continuations ?? 0) + 1, waiter_prompted: true }, paths);
			return { decision: "block", reason: `Team waiter is not running. Start it in the background (run_in_background) and then stop: ${env.waiterCommand}` };
		}
	} catch { /* never trap the session on controller trouble */ }
	return undefined;
}

/**
 * Background waiter: exits when the controller wakes this session, printing what arrived, so Claude Code
 * takes a turn while otherwise idle. Silent (no model traffic) until then.
 */
export async function wait(env: HookEnv & { sid?: string; pollMs?: number; maxMs?: number } = {}): Promise<string> {
	const paths = env.paths ?? statePaths();
	const cpid = env.cpid ?? claudePid();
	const sid = env.sid ?? readPidState(cpid, paths).session_id;
	if (!sid) return "pi-aatwad waiter: no Claude Code session id yet (are the plugin hooks installed?)";
	updatePidState(cpid, { waiter_pid: process.pid, waiter_prompted: false }, paths);
	const deadline = env.maxMs ? Date.now() + env.maxMs : Infinity;
	try {
		for (;;) {
			const id = readIdentity(sid, paths);
			if (!id) return "pi-aatwad waiter: this session is no longer in a team; not restarting.";
			const w = readWake(sid, paths);
			if (w) {
				clearWake(sid, paths);
				const messages = await claimAll(id, paths).catch(() => [] as Envelope[]);
				const text = messagesText(id, messages, w.wake.text);
				if (text) return `${text}\n\nHandle this, then restart the waiter in the background: ${env.waiterCommand ?? "(waiter command)"}`;
			}
			if (Date.now() >= deadline) return "";
			await new Promise((r) => setTimeout(r, env.pollMs ?? 1_000));
		}
	} finally {
		if (readPidState(cpid, paths).waiter_pid === process.pid) updatePidState(cpid, { waiter_pid: undefined }, paths);
	}
}
