import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, sql, type Harness } from "./helpers.ts";

type Team = Awaited<ReturnType<typeof newRun>>;
const ok = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const link = (h: Harness, child: Team, parent: Team) => h.call("POST", `/runs/${child.run_id}/reporting`, { token: child.token, body: { action: "connect", parent_run_id: parent.run_id } });
const inbox = async (h: Harness, token: string) => (await h.call("GET", "/inbox", { token })).body.messages as any[];

test("a lead directs one step down across a link: tasks live in the lead's team, the sub reports and may break them down", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), sub = await newRun(h), stranger = await newRun(h);
		ok(await link(h, sub, lead));
		// The sub-team has its own member, two steps below the lead.
		const member = ok(await h.call("POST", "/members", { token: sub.token, body: { name: "Builder", responsibility: "Build" } })).spawned_agent_ids[0];

		const task = ok(await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: sub.root, title: "Ship the feature", spec: { goal: "x" } } }));
		const row = sql(h, "SELECT run_id, owner_id, assigned_by FROM tasks WHERE id = ?", task.task_id)[0];
		assert.deepEqual({ ...row }, { run_id: lead.run_id, owner_id: sub.root, assigned_by: lead.root }, "the task lives in the lead's team, owned by the sub");
		const assigned = (await inbox(h, sub.token)).find((m) => m.type === "task.assigned");
		assert.equal(assigned.payload.task_id, task.task_id);
		assert.equal(assigned.payload.lead_run_id, lead.run_id);
		assert.ok(ok(await h.call("GET", "/me", { token: sub.token })).tasks.some((t: any) => t.task_id === task.task_id), "the sub sees the task as its own");

		// The sub breaks it down in its own team and reports up.
		const part = ok(await h.call("POST", "/tasks", { token: sub.token, body: { owner_id: member, title: "Part one", parent_task_id: task.task_id } }));
		assert.deepEqual({ ...sql(h, "SELECT run_id, parent_task_id FROM tasks WHERE id = ?", part.task_id)[0] }, { run_id: sub.run_id, parent_task_id: task.task_id });
		ok(await h.call("POST", `/tasks/${task.task_id}/progress`, { token: sub.token, body: { note: "half way" } }));
		ok(await h.call("POST", `/tasks/${task.task_id}/complete`, { token: sub.token, body: { summary: "shipped" } }));
		const up = await inbox(h, lead.token);
		assert.ok(up.some((m) => m.type === "task.progress" && m.from === sub.root && m.payload.task_id === task.task_id));
		assert.ok(up.some((m) => m.type === "task.completed" && m.from === sub.root && m.payload.summary === "shipped"));
		assert.equal(sql(h, "SELECT status FROM tasks WHERE id = ?", task.task_id)[0].status, "DONE");

		// One step only, and only along links.
		assert.equal((await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: member, title: "Skip a level" } })).status, 403);
		assert.equal((await h.call("POST", "/messages", { token: lead.token, body: { to: member, type: "question", payload: { text: "hi" } } })).status, 403);
		assert.equal((await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: stranger.root, title: "Not linked" } })).status, 403);
		assert.equal((await h.call("POST", "/tasks", { token: sub.token, body: { owner_id: lead.root, title: "Control never flows up" } })).status, 403);
		assert.equal((await h.call("POST", `/tasks/${task.task_id}/progress`, { token: stranger.token, body: { note: "x" } })).status, 404);
	} finally { await h.cleanup(); }
});

test("leads read their whole linked subtree, peers talk sideways, and severing the link ends both", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), a = await newRun(h), b = await newRun(h), deep = await newRun(h), stranger = await newRun(h);
		ok(await link(h, a, lead)); ok(await link(h, b, lead)); ok(await link(h, deep, a));
		const tree = ok(await h.call("GET", `/runs/${lead.run_id}/tree?linked=1`, { token: lead.token }));
		const ids = (n: any): string[] => [n.agent_id, ...n.children.flatMap(ids)];
		assert.deepEqual(new Set(ids(tree.root)), new Set([lead.root, a.root, b.root, deep.root]), "linked teams appear under their leads, any depth");
		assert.equal(tree.root.children.find((c: any) => c.agent_id === a.root).run_id, a.run_id);
		assert.deepEqual(ids(ok(await h.call("GET", `/runs/${lead.run_id}/tree`, { token: lead.token })).root), [lead.root], "plain trees are unchanged");
		ok(await h.call("GET", `/runs/${deep.run_id}/tree`, { token: lead.token }));
		ok(await h.call("GET", `/agents/${deep.root}`, { token: lead.token }));
		assert.equal((await h.call("GET", `/runs/${lead.run_id}/tree`, { token: a.token })).status, 403, "reads never flow up");
		assert.equal((await h.call("GET", `/runs/${stranger.run_id}/tree`, { token: lead.token })).status, 403);

		const me = ok(await h.call("GET", "/me", { token: a.token }));
		assert.deepEqual({ ...me.parent }, { agent_id: lead.root, role: "root", run_id: lead.run_id });
		assert.deepEqual(me.peers.map((p: any) => p.agent_id), [b.root]);
		assert.deepEqual(me.children.map((c: any) => [c.agent_id, c.run_id]), [[deep.root, deep.run_id]]);
		ok(await h.call("POST", "/messages", { token: a.token, body: { to: b.root, type: "question", payload: { text: "need your API" } } }));
		assert.ok((await inbox(h, b.token)).some((m) => m.from === a.root && m.payload.text === "need your API"));

		ok(await h.call("POST", `/runs/${a.run_id}/reporting`, { token: a.token, body: { action: "disconnect" } }));
		assert.equal((await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: a.root, title: "After severing" } })).status, 403);
		assert.equal((await h.call("POST", "/messages", { token: a.token, body: { to: b.root, type: "question", payload: { text: "still there?" } } })).status, 403);
		assert.equal((await h.call("GET", `/runs/${deep.run_id}/tree`, { token: lead.token })).status, 403, "the subtree below a severed link is no longer readable");
	} finally { await h.cleanup(); }
});
