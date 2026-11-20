import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, ownTask, recruit, sql, waitFor } from "./helpers.ts";

const ok = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an external Claude Code session joins as a new member, takes work, is reassigned, leaves and rejoins; the controller never launches it", async () => {
	const h = await harness();
	try {
		const t = await newRun(h);
		const task = await ownTask(h, t.token, t.root);
		const [lead] = await recruit(h, t.token, t.token, task, [{ title: "Lead" }]);
		const launches = h.ex.launches.length;

		assert.equal((await h.call("POST", `/runs/${t.run_id}/join`, { token: t.token, body: { harness: "claude-code", provider: "anthropic", model: "claude-opus-5-5" } })).status, 403, "agents cannot add external members");
		const joined = ok(await h.call("POST", `/runs/${t.run_id}/join`, { token: h.op, body: { name: "Claude", harness: "claude-code", provider: "anthropic", model: "claude-opus-5-5", cwd: h.dir } }));
		const me = ok(await h.call("GET", "/me", { token: joined.token }));
		assert.equal(me.parent.agent_id, t.root);
		assert.equal(sql(h, "SELECT harness FROM sessions WHERE id = ?", joined.session_id)[0].harness, "claude-code");
		assert.equal(sql(h, "SELECT status FROM spawn_intents WHERE agent_id = ?", joined.agent_id)[0].status, "EXTERNAL");

		// Leader hands off; the external member works the task like any member.
		const d = ok(await h.call("POST", "/tasks", { token: t.token, body: { owner_id: joined.agent_id, title: "Review the parser" } }));
		assert.equal(d.handoff.owner_live, true);
		const assigned = ok(await h.call("GET", "/inbox", { token: joined.token })).messages.find((m: any) => m.type === "task.assigned" && m.payload.task_id === d.task_id);
		ok(await h.call("POST", `/messages/${assigned.message_id}/ack`, { token: joined.token, body: {} }));
		ok(await h.call("POST", `/tasks/${d.task_id}/progress`, { token: joined.token, body: { note: "reading" } }));

		// Dynamic reassignment applies unchanged: move it under the lead.
		const v = sql(h, "SELECT topology_version FROM runs WHERE id = ?", t.run_id)[0].topology_version;
		ok(await h.call("POST", `/agents/${joined.agent_id}/reparent`, { token: t.token, body: { new_parent_id: lead, expected_topology_version: v, reason: "rebalance", pending_work_policy: "retain" } }));
		assert.equal(ok(await h.call("GET", "/me", { token: joined.token })).parent.agent_id, lead);

		// Leaving ends the session only; the manager is told; nothing is launched in its place.
		const left = ok(await h.call("POST", "/sessions/leave", { token: joined.token, body: { reason: "user closed Claude Code" } }));
		assert.equal(left.notified, lead);
		assert.equal((await h.call("GET", "/me", { token: joined.token })).status, 401, "the left session's token is revoked");
		const leadToken = await waitFor(() => h.ex.tokens.get(lead), "lead token");
		const notice = ok(await h.call("GET", "/inbox", { token: leadToken })).messages.find((m: any) => m.payload?.kind === "member_left");
		assert.equal(notice.payload.agent_id, joined.agent_id);
		await sleep(300);
		assert.equal(h.ex.launches.length, launches, "external members are never launched or relaunched");

		// Rejoin the same identity, with its tasks.
		const back = ok(await h.call("POST", `/runs/${t.run_id}/attach`, { token: h.op, body: { agent_id: joined.agent_id, harness: "claude-code" } }));
		const again = ok(await h.call("GET", "/me", { token: back.token }));
		assert.ok(again.tasks.some((x: any) => x.task_id === d.task_id && x.status === "IN_PROGRESS"));
		assert.equal(sql(h, "SELECT harness FROM sessions WHERE id = ?", back.session_id)[0].harness, "claude-code");
	} finally { await h.cleanup(); }
});

test("join validates manager, harness and team state", async () => {
	const h = await harness();
	try {
		const a = await newRun(h), b = await newRun(h);
		const body = { harness: "claude-code", provider: "anthropic", model: "m" };
		assert.equal((await h.call("POST", `/runs/${a.run_id}/join`, { token: h.op, body: { ...body, manager_id: b.root } })).status, 404);
		assert.equal((await h.call("POST", `/runs/${a.run_id}/join`, { token: h.op, body: { ...body, harness: "Claude Code!" } })).status, 400);
		assert.equal((await h.call("POST", `/runs/${a.run_id}/join`, { token: h.op, body: { harness: "claude-code" } })).status, 400, "provider/model required");
	} finally { await h.cleanup(); }
});
