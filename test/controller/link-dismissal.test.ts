import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, sql, waitFor, type Harness } from "./helpers.ts";

type Team = Awaited<ReturnType<typeof newRun>>;
const ok = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const connect = async (h: Harness, child: Team, parent: Team) => ok(await h.call("POST", `/runs/${child.run_id}/reporting`, { token: child.token, body: { action: "connect", parent_run_id: parent.run_id } }));
const terminatable = async (h: Harness, agent: string, value: boolean) => ok(await h.call("POST", `/agents/${agent}/link`, { token: h.op, body: { terminatable: value } }));
const state = (h: Harness, t: Team) => JSON.parse(sql(h, "SELECT config_json FROM runs WHERE id = ?", t.run_id)[0].config_json).team_lifecycle;
const activeLink = (h: Harness, t: Team) => sql(h, "SELECT parent_run_id, terminatable FROM reporting_edges WHERE run_id = ? AND parent_run_id IS NOT NULL AND valid_to IS NULL", t.run_id)[0];

test("dismissing a joined team only severs the link by default; the team keeps running", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), sub = await newRun(h), stranger = await newRun(h);
		await connect(h, sub, lead);
		assert.equal(activeLink(h, sub).terminatable, 0, "joins default to not terminatable");
		assert.equal((await h.call("POST", `/agents/${sub.root}/dismiss`, { token: stranger.token, body: {} })).status, 403);
		assert.equal((await h.call("POST", `/agents/${lead.root}/dismiss`, { token: sub.token, body: {} })).status, 404, "a lead is not linked under its sub");
		assert.equal((await h.call("POST", `/agents/${sub.root}/dismiss`, { token: lead.token, body: { stop: true } })).status, 403, "only the operator overrides");
		assert.equal((await h.call("POST", `/agents/${sub.root}/link`, { token: lead.token, body: { terminatable: true } })).status, 403);
		const r = ok(await h.call("POST", `/agents/${sub.root}/dismiss`, { token: lead.token, body: { reason: "project done" } }));
		assert.deepEqual({ severed: r.severed, stopped: r.stopped, stopped_run_ids: r.stopped_run_ids }, { severed: true, stopped: false, stopped_run_ids: [] });
		assert.equal(activeLink(h, sub), undefined);
		assert.equal(state(h, sub), undefined, "the sub-team was not stopped");
		assert.equal(ok(await h.call("GET", "/me", { token: sub.token })).parent, null);
		assert.match(sql(h, "SELECT close_reason FROM reporting_edges WHERE run_id = ? AND parent_run_id IS NOT NULL", sub.run_id)[0].close_reason, /dismissed: project done/);
	} finally { await h.cleanup(); }
});

test("dismissing a terminatable team stops it, cascades through terminatable links and severs joined teams below", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), sub = await newRun(h), joinedBelow = await newRun(h), ownedBelow = await newRun(h);
		await connect(h, sub, lead); await connect(h, joinedBelow, sub); await connect(h, ownedBelow, sub);
		await terminatable(h, sub.root, true);
		await terminatable(h, ownedBelow.root, true);
		const member = ok(await h.call("POST", "/members", { token: sub.token, body: { name: "Builder", responsibility: "Build" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member), "recruit launched");
		const r = ok(await h.call("POST", `/agents/${sub.root}/dismiss`, { token: lead.token, body: {} }));
		assert.deepEqual(r.stopped_run_ids, [sub.run_id, ownedBelow.run_id]);
		assert.deepEqual(r.severed_below, [joinedBelow.run_id]);
		assert.ok(["STOPPED", "CLEANING"].includes(state(h, sub).state));
		assert.equal(state(h, sub).stopped_by_run_id, lead.run_id);
		assert.equal(state(h, ownedBelow).stopped_by_run_id, sub.run_id);
		assert.equal(state(h, joinedBelow), undefined, "a joined team below keeps running");
		assert.equal(activeLink(h, joinedBelow), undefined, "and becomes independent");
		assert.equal(activeLink(h, sub), undefined, "the dismissed link is closed");
		assert.equal(sql(h, "SELECT status FROM agents WHERE id = ?", member)[0].status, "PAUSED", "recruits stop with their team, resumably");
		assert.notEqual(sql(h, "SELECT status FROM agents WHERE id = ?", sub.root)[0].status, "CANCELLED", "stopping is not removal");
	} finally { await h.cleanup(); }
});

test("stopping a lead stops terminatable teams with it, keeps joined ones linked and running, and resumes what it stopped", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), owned = await newRun(h), joined = await newRun(h), deep = await newRun(h);
		await connect(h, owned, lead); await connect(h, joined, lead); await connect(h, deep, owned);
		await terminatable(h, owned.root, true); await terminatable(h, deep.root, true);
		ok(await h.call("POST", `/runs/${lead.run_id}/stop`, { token: h.op, body: {} }));
		assert.equal(state(h, owned).stopped_by_run_id, lead.run_id);
		assert.equal(state(h, deep).stopped_by_run_id, owned.run_id);
		assert.equal(state(h, joined), undefined);
		assert.equal(activeLink(h, joined).parent_run_id, lead.run_id, "joined teams stay linked; their reports queue");
		assert.equal(activeLink(h, owned).parent_run_id, lead.run_id, "stopping is resumable, so links stay");
		ok(await h.call("POST", "/messages", { token: joined.token, body: { to: lead.root, type: "task.progress", payload: { text: "while you were away" } } }));
		ok(await h.call("POST", `/runs/${lead.run_id}/resume`, { token: h.op, body: {} }));
		for (const t of [lead, owned, deep]) assert.equal(state(h, t).state, "RESUMED", t.run_id);
		// The operator can make any dismissal stop the team, whatever the link says.
		const r = ok(await h.call("POST", `/agents/${joined.root}/dismiss`, { token: h.op, body: { stop: true } }));
		assert.deepEqual(r.stopped_run_ids, [joined.run_id]);
	} finally { await h.cleanup(); }
});

test("a lead cannot end a member that joined its team unless the operator made it terminatable", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h);
		const joined = ok(await h.call("POST", `/runs/${lead.run_id}/join`, { token: h.op, body: { name: "Contractor", harness: "claude-code", provider: "anthropic", model: "claude-opus-5-5", cwd: h.dir } }));
		const cancel = (token: string) => h.call("POST", `/agents/${joined.agent_id}/lifecycle`, { token, body: { action: "cancel", reason: "done" } });
		assert.match((await cancel(lead.token)).body.error.message, /not terminatable/);
		await terminatable(h, joined.agent_id, true);
		ok(await cancel(lead.token));
	} finally { await h.cleanup(); }
});
