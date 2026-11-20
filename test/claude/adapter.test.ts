import { test } from "node:test";
import assert from "node:assert/strict";
import { statePaths } from "../../src/shared/paths.ts";
import { ClaudeTeamServer } from "../../src/claude/mcp.ts";
import { sessionStart, stop, userPromptSubmit, wait } from "../../src/claude/hooks.ts";
import { readIdentity, readPidState, updatePidState } from "../../src/claude/session.ts";
import { harness, newRun, sql } from "../controller/helpers.ts";

const ok = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const call = async (s: ClaudeTeamServer, name: string, args: Record<string, unknown> = {}) => {
	const r: any = await s.handle({ id: 1, method: "tools/call", params: { name, arguments: args } });
	const text = r.result.content[0].text as string;
	if (r.result.isError) throw new Error(text);
	return text;
};

test("Claude Code joins a Pi team as a member: hooks deliver messages, the waiter wakes it while idle, it leaves and keeps its identity", async () => {
	const h = await harness();
	const paths = statePaths(h.dir);
	const cpid = 4_000_001;
	const env = { paths, cpid, waiterCommand: "node cli.ts wait" };
	const claude = new ClaudeTeamServer({ paths, cpid, cwd: h.dir });
	try {
		const team = await newRun(h);
		assert.equal(await sessionStart({ session_id: "s1", cwd: h.dir }, env), undefined, "not in a team: no context noise");

		const init: any = await claude.handle({ id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
		assert.equal(init.result.serverInfo.name, "pi-team");
		const list: any = await claude.handle({ id: 1, method: "tools/list" });
		for (const n of ["team_join", "team_leave", "team_delegate_task", "team_reassign", "team_report_to", "team_set_attention"]) assert.ok(list.result.tools.some((t: any) => t.name === n), n);

		assert.match(await call(claude, "team_join", { mode: "member", run_id: team.run_id, name: "Claude", model: "anthropic/claude-opus-5-5" }), /Joined team/);
		const id = readIdentity("s1", paths)!;
		assert.equal(sql(h, "SELECT harness FROM sessions WHERE id = ?", id.session_id)[0].harness, "claude-code");
		assert.match(await call(claude, "team_status"), new RegExp(`Manager: root \\[${team.root}\\]`));

		// Human turn: assigned work rides along with the prompt.
		const d = ok(await h.call("POST", "/tasks", { token: team.token, body: { owner_id: id.agent_id, title: "Port the CLI" } }));
		const prompt: any = await userPromptSubmit({ session_id: "s1" }, env);
		assert.match(prompt.hookSpecificOutput.additionalContext, /\[task\.assigned\][\s\S]*Port the CLI/);
		assert.equal(readPidState(cpid, paths).busy, true);

		// Stop with a pending message: continue with it (like Pi's settle continuation).
		ok(await h.call("POST", "/messages", { token: team.token, body: { to: id.agent_id, type: "question", payload: { text: "ETA?" } } }));
		const cont: any = await stop({ session_id: "s1" }, env);
		assert.equal(cont.decision, "block");
		assert.match(cont.reason, /ETA\?/);
		// Nothing pending and no waiter: ask once to start one; then let the session idle.
		assert.match((await stop({ session_id: "s1" }, env) as any).reason, /waiter is not running/);
		assert.equal(await stop({ session_id: "s1" }, env), undefined, "never nags twice");

		// Idle wake: controller decides (batch 0), the MCP heartbeat records it, the waiter exits with the message.
		ok(await h.call("POST", `/runs/${team.run_id}/attention`, { token: team.token, body: { batch_seconds: 0, stall_seconds: 0 } }));
		ok(await h.call("POST", "/messages", { token: team.token, body: { to: id.agent_id, type: "question", payload: { text: "Status of the CLI?" } } }));
		await claude.heartbeat();
		const woke = await wait({ ...env, sid: "s1", pollMs: 20, maxMs: 2_000 });
		assert.match(woke, /Status of the CLI\?[\s\S]*restart the waiter/);
		assert.equal(await wait({ ...env, sid: "s1", pollMs: 20, maxMs: 100 }), "", "no update: the waiter stays silent");

		// /clear starts a new Claude session id in the same process: the identity follows it.
		await sessionStart({ session_id: "s2", source: "clear" }, env);
		assert.equal(readIdentity("s2", paths)?.agent_id, id.agent_id);
		assert.equal(readIdentity("s1", paths), undefined);

		assert.match(await call(claude, "team_complete_task", { task_id: d.task_id, summary: "ported" }), /DONE/);
		assert.match(await call(claude, "team_leave", { reason: "done for today" }), /remains/);
		assert.equal(readIdentity("s2", paths), undefined);
		const notice = ok(await h.call("GET", "/inbox", { token: team.token })).messages.find((m: any) => m.payload?.kind === "member_left");
		assert.equal(notice.payload.agent_id, id.agent_id);

		// Rejoin the same identity later.
		assert.match(await call(claude, "team_join", { mode: "agent", run_id: team.run_id, agent: id.agent_id }), /Attached/);
		assert.equal(readIdentity("s2", paths)?.agent_id, id.agent_id);
	} finally { claude.stop(); await h.cleanup(); }
});

test("Claude Code founds and leads a team, recruits Pi members, reassigns them, and reports to another leader as a sub-team", async () => {
	const h = await harness();
	const paths = statePaths(h.dir);
	const cpid = 4_000_002;
	updatePidState(cpid, { session_id: "lead" }, paths);
	const claude = new ClaudeTeamServer({ paths, cpid, cwd: h.dir });
	try {
		const other = await newRun(h);
		assert.match(await call(claude, "team_join", { mode: "new_team", model: "anthropic/claude-opus-5-5", unlimited: true }), /you lead it/);
		const me = readIdentity("lead", paths)!;
		assert.match(await call(claude, "team_create_member", { name: "Builder", responsibility: "build" }), /Member provisioned/);
		assert.match(await call(claude, "team_create_member", { name: "Lead2", responsibility: "lead the builders" }), /Member provisioned/);
		const [builder, lead2] = ["Builder", "Lead2"].map((n) => sql(h, "SELECT id FROM agents WHERE run_id = ? AND role = ?", me.run_id, n)[0].id);
		assert.equal(h.ex.launches.filter((l) => [builder, lead2].includes(l.spec.agent_id)).length, 2, "members run as Pi workers");
		assert.match(await call(claude, "team_delegate_task", { owner: "Builder", title: "Build it" }), /Handed off: task .* queued for Builder\..*return control to the human/);
		await call(claude, "team_reassign", { agent: "Builder", new_manager: "Lead2", reason: "rebalance" });
		assert.equal(sql(h, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", builder)[0].parent_id, lead2);
		await call(claude, "team_report_to", { run_id: other.run_id });
		assert.equal(sql(h, "SELECT parent_run_id FROM team_reporting_links WHERE child_run_id = ? AND closed_at IS NULL", me.run_id)[0].parent_run_id, other.run_id);
		assert.match(await call(claude, "team_set_attention", { scope: "team", stall_seconds: 600 }), /stall 10m/);
		await assert.rejects(call(claude, "team_join", { mode: "new_team" }), /already in team/);
	} finally { claude.stop(); await h.cleanup(); }
});
