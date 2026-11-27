// Taking over an existing team's session (its leader, or any agent) supersedes whoever holds it now,
// so it is the human's decision, not a model's. The human runs this from inside the Claude Code session
// that should take over (`! node …/cli.ts takeover <run> [agent]`): the command finds that session
// through its parent Claude process and attaches it with operator authority. The session's MCP server
// picks the new identity up on its next heartbeat.
import { statePaths, type StatePaths } from "../shared/paths.ts";
import { ensureController, readOperatorToken, TeamApiError, TeamClient } from "../shared/client.ts";
import { HARNESS, claudePid, readIdentity, readPidState, writeIdentity } from "./session.ts";

export async function takeover(args: string[], o: { paths?: StatePaths; cpid?: number; cwd?: string } = {}): Promise<{ code: number; text: string }> {
	const [runRef, agentRef] = args;
	if (!runRef) return { code: 2, text: "usage: takeover <run_id> [agent name or ID]   (run it inside the Claude Code session that should take over, prefixed with !)" };
	const paths = o.paths ?? statePaths();
	const cpid = o.cpid ?? claudePid();
	const sid = readPidState(cpid, paths).session_id;
	if (!sid) return { code: 1, text: "No Claude Code session found above this command. Run it inside Claude Code with the ! prefix, in the session that should take over." };
	const current = readIdentity(sid, paths);
	if (current) return { code: 1, text: `This session is already ${current.agent_id} in team ${current.run_id}; ask it to use team_leave first.` };
	await ensureController(paths);
	const token = await readOperatorToken(paths);
	const api = new TeamClient({ paths, token: () => token });
	try {
		const runId = (await api.listRuns({ token })).runs.find((r) => r.run_id === runRef || r.run_id.startsWith(runRef))?.run_id;
		if (!runId) return { code: 1, text: `No team ${runRef}; run \`pi-team teams\` to list them.` };
		const agentId = agentRef ? await api.resolveAgent(agentRef, runId, { token }) : undefined;
		// The agent may lead a team linked under run_id: attach to that agent's own team.
		const home = agentId ? await api.tree(runId, { token }, false, true).then((t) => {
			const find = (n: { agent_id: string; run_id?: string; children: unknown[] }): string | undefined => n.agent_id === agentId ? (n.run_id ?? runId) : (n.children as typeof n[]).map(find).find(Boolean);
			return find(t.root as never) ?? runId;
		}).catch(() => runId) : runId;
		const r = await api.attach(home, { agent_id: agentId, harness: HARNESS }, { token, idempotencyKey: `claude-takeover:${sid}:${Date.now()}` });
		writeIdentity(sid, { run_id: r.run_id, agent_id: r.agent_id, session_id: r.session_id, token: r.token, role: agentId ? "agent" : "root", cwd: o.cwd ?? readPidState(cpid, paths).cwd ?? process.cwd() }, paths);
		return { code: 0, text: `This Claude Code session is now ${r.agent_id} in team ${r.run_id}${agentId ? "" : " (its leader)"}; any previous session for that agent was superseded. Claude picks it up within a few seconds.` };
	} catch (e) {
		return { code: 1, text: e instanceof TeamApiError ? `${e.code}: ${e.message.replace(/^[A-Z_]+: /, "")}` : String((e as Error)?.message ?? e) };
	}
}
