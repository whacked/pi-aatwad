import { test } from "node:test";
import assert from "node:assert/strict";
import { projectName } from "../../src/shared/readable-id.ts";
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
		// With several teams linked under it, a lead routes work by each team's name and project.
		ok(await h.call("POST", `/runs/${sub.run_id}/settings`, { token: sub.token, body: { name: "Parser team" } }));
		const linked = ok(await h.call("GET", "/me", { token: lead.token })).children.find((c: any) => c.agent_id === sub.root);
		assert.deepEqual({ run: linked.run_id, name: linked.team_name, project: linked.project }, { run: sub.run_id, name: "Parser team", project: h.dir });
		const node = ok(await h.call("GET", `/runs/${lead.run_id}/tree?linked=1`, { token: lead.token })).root.children.find((c: any) => c.agent_id === sub.root);
		assert.deepEqual({ name: node.team_name, project: node.project }, { name: "Parser team", project: h.dir });
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

test("a member leaves its team to lead its own, keeping its process and transcript, then joins another team", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), other = await newRun(h);
		const member = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Builder", responsibility: "Build" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member), "recruit enrolled");
		const identity = h.ex.launchesFor(member).at(-1)!.id;
		const transcript = sql(h, "SELECT pi_session_path FROM agents WHERE id = ?", member)[0].pi_session_path;
		const token = h.ex.tokens.get(member)!;
		assert.equal((await h.call("POST", "/sessions/secede", { token: lead.token, body: {} })).status, 409, "a leader links instead");

		const r = ok(await h.call("POST", "/sessions/secede", { token, body: { reason: "moving to the other project" } }));
		assert.equal(r.previous_agent_id, member);
		assert.equal(sql(h, "SELECT status FROM agents WHERE id = ?", member)[0].status, "RETIRED");
		assert.equal(sql(h, "SELECT pi_session_path FROM agents WHERE id = ?", r.root_agent_id)[0].pi_session_path, transcript, "the same conversation continues");
		await h.h.reconciler.idle();
		assert.equal(await h.ex.probe(identity), "alive", "the process is never stopped: this session continues as the new leader");
		assert.ok(!h.ex.stopped.includes(identity.pid));
		assert.equal((await h.call("GET", "/me", { token })).status, 401, "the old member credential is revoked");
		const me = ok(await h.call("GET", "/me", { token: r.token }));
		assert.deepEqual({ is_root: me.is_root, role: me.role, parent: me.parent }, { is_root: true, role: "Builder", parent: null });
		const notice = ok(await h.call("GET", "/inbox", { token: lead.token })).messages.find((m: any) => m.payload?.kind === "member_seceded");
		assert.equal(notice.payload.new_agent_id, r.root_agent_id);
		assert.ok((ok(await h.call("GET", `/agents/${lead.root}/roster`, { token: lead.token })).entries as any[]).some((e) => e.agent_id === member && !e.active), "the old team keeps it on its roster");

		ok(await h.call("POST", `/runs/${r.run_id}/reporting`, { token: r.token, body: { action: "connect", parent_run_id: other.run_id } }));
		assert.equal(sql(h, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", r.root_agent_id)[0].parent_id, other.root);
	} finally { await h.cleanup(); }
});

test("teams have names, project directories and a summary line; settings and activity are scoped", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), sub = await newRun(h), stranger = await newRun(h);
		await connect(h, sub, lead);
		const member = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Builder", responsibility: "Build" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member), "recruit enrolled");
		ok(await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: member, title: "Write the parser" } }));
		assert.equal((await h.call("POST", `/runs/${lead.run_id}/settings`, { token: sub.token, body: { name: "x" } })).status, 403);
		assert.equal(ok(await h.call("POST", `/runs/${lead.run_id}/settings`, { token: lead.token, body: { name: "  Parser\nwork  ", on_leader_exit: "keep" } })).name, "Parser work");
		assert.equal((await h.call("POST", `/runs/${lead.run_id}/settings`, { token: lead.token, body: { on_leader_exit: "maybe" } })).status, 400);
		const runs = ok(await h.call("GET", "/runs", { token: h.op })).runs as any[];
		const mine = runs.find((r) => r.run_id === lead.run_id), empty = runs.find((r) => r.run_id === stranger.run_id);
		assert.deepEqual({ name: mine.name, open: mine.open_tasks, empty: mine.empty, exit: mine.on_leader_exit, cwd: mine.cwd }, { name: "Parser work", open: 2, empty: false, exit: "keep", cwd: h.dir });
		assert.match(mine.summary, /working on: (Write the parser|Builder)/);
		assert.ok(mine.last_activity_at);
		assert.equal(empty.empty, true);
		assert.equal(empty.name, projectName(h.dir, 40), "default name is the project name from its folders");

		await h.call("POST", "/sessions/heartbeat", { token: h.ex.tokens.get(member)!, body: { busy: true } });
		const act = ok(await h.call("GET", `/runs/${lead.run_id}/activity`, { token: lead.token }));
		assert.deepEqual(new Set(act.members.map((m: any) => m.agent_id)), new Set([member, sub.root]), "the whole tree, across links");
		assert.equal(act.busy, 1);
		assert.equal(act.on_leader_exit, "keep");
		assert.equal((await h.call("GET", `/runs/${lead.run_id}/activity`, { token: stranger.token })).status, 403);
	} finally { await h.cleanup(); }
});

test("a team whose leader left is paused once every member is idle; busy members and keep teams are left alone", async () => {
	const h = await harness({ tunables: { tickMs: 50, leaderlessIdleMs: 400 } as any });
	try {
		const gone = await newRun(h), working = await newRun(h), kept = await newRun(h);
		ok(await h.call("POST", `/runs/${kept.run_id}/settings`, { token: kept.token, body: { on_leader_exit: "keep" } }));
		const recruits: Record<string, string> = {};
		for (const t of [gone, working, kept]) {
			recruits[t.run_id] = ok(await h.call("POST", "/members", { token: t.token, body: { name: "Worker", responsibility: "Work" } })).spawned_agent_ids[0];
			await waitFor(() => h.ex.tokens.has(recruits[t.run_id]));
			await h.call("POST", "/sessions/heartbeat", { token: h.ex.tokens.get(recruits[t.run_id])!, body: { busy: t === working } });
			// The leader's harness disappeared without running its exit policy.
			h.h.db.prepare("UPDATE agents SET observed_state = 'LOST', last_heartbeat_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), t.root);
		}
		const state = (t: Team) => JSON.parse(sql(h, "SELECT config_json FROM runs WHERE id = ?", t.run_id)[0].config_json).team_lifecycle?.state ?? "RUNNING";
		await waitFor(() => ["STOPPED", "CLEANING"].includes(state(gone)), "idle leaderless team paused", 5000);
		assert.equal(sql(h, "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'run.auto_paused'", gone.run_id)[0].n, 1);
		assert.equal(JSON.parse(sql(h, "SELECT config_json FROM runs WHERE id = ?", gone.run_id)[0].config_json).team_lifecycle.cause, "leader_absent", "the returning leader may resume it");
		assert.equal((await h.call("POST", `/runs/${kept.run_id}/stop`, { token: h.op, body: { cause: "leader_absent" } })).status, 400, "only the controller records an absence pause");
		await new Promise((r) => setTimeout(r, 600));
		assert.equal(state(working), "RUNNING", "a working member is never interrupted");
		assert.equal(state(kept), "RUNNING", "exit policy keep opts out");

		// /team resume: resume, then attach. The sweep must not pause the team again in between.
		await waitFor(() => state(gone) === "STOPPED", "cleanup settled", 5000);
		ok(await h.call("POST", `/runs/${gone.run_id}/resume`, { token: h.op, body: {} }));
		await new Promise((r) => setTimeout(r, 150)); // a few reconcile ticks, as a slow client would take
		ok(await h.call("POST", `/runs/${gone.run_id}/attach`, { token: h.op, body: {} }));
		assert.equal(sql(h, "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'run.auto_paused'", gone.run_id)[0].n, 1, "not paused again");
	} finally { await h.cleanup(); }
});

test("after the host sleeps, a leader that heartbeats on wake keeps its team", async () => {
	const h = await harness({ tunables: { tickMs: 50, leaderlessIdleMs: 400, leaseMs: 1500 } as any });
	try {
		const t = await newRun(h);
		const worker = ok(await h.call("POST", "/members", { token: t.token, body: { name: "Worker", responsibility: "Work" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(worker));
		await h.call("POST", "/sessions/heartbeat", { token: h.ex.tokens.get(worker)!, body: { busy: false } });
		// The laptop slept for a minute: the controller's ticks stopped, and every heartbeat is old.
		const slept = new Date(Date.now() - 60_000).toISOString();
		h.h.db.prepare("UPDATE agents SET last_heartbeat_at = ?, lease_until = ? WHERE run_id = ?").run(slept, slept, t.run_id);
		(h.h.reconciler as any).lastTickAt = Date.now() - 60_000;
		await new Promise((r) => setTimeout(r, 300)); // several ticks on wake, before the leader's next heartbeat
		// The leader's session is alive: it heartbeats from now on, as Pi does every few seconds.
		const beat = setInterval(() => void h.call("POST", "/sessions/heartbeat", { token: t.token, body: { busy: false } }), 200);
		try { await new Promise((r) => setTimeout(r, 2_000)); } finally { clearInterval(beat); } // past the wake grace
		const state = JSON.parse(sql(h, "SELECT config_json FROM runs WHERE id = ?", t.run_id)[0].config_json).team_lifecycle?.state ?? "RUNNING";
		assert.equal(state, "RUNNING");
		assert.equal(sql(h, "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'run.auto_paused'", t.run_id)[0].n, 0);
		assert.equal(sql(h, "SELECT COUNT(*) AS n FROM events WHERE entity_id = ? AND type = 'agent.lost'", t.root)[0].n, 0, "the leader was never marked lost");
	} finally { await h.cleanup(); }
});

test("a lead resumes a stopped team linked under it; others cannot", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), sub = await newRun(h), stranger = await newRun(h);
		await connect(h, sub, lead);
		const resume = (token: string) => h.call("POST", `/agents/${sub.root}/resume-team`, { token, body: {} });
		assert.equal((await resume(lead.token)).status, 409, "a running team is not resumed");
		ok(await h.call("POST", `/runs/${sub.run_id}/stop`, { token: h.op, body: {} }));
		assert.equal((await resume(stranger.token)).status, 403);
		assert.equal((await resume(sub.token)).status, 401, "the stopped team's own credential was revoked");
		assert.equal(ok(await resume(lead.token)).state, "RESUMED");
		assert.equal(state(h, sub).state, "RESUMED");
		assert.equal(sql(h, "SELECT actor_id FROM events WHERE run_id = ? AND type = 'run.resumed'", sub.run_id)[0].actor_id, lead.root);
		assert.equal((await h.call("POST", `/agents/${lead.root}/resume-team`, { token: stranger.token, body: {} })).status, 404, "only teams linked under someone");
	} finally { await h.cleanup(); }
});

test("the away summary reports what happened since the leader's previous session ended", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), sub = await newRun(h);
		await connect(h, sub, lead);
		const member = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Builder", responsibility: "Build" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member));
		const before = ok(await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: member, title: "Before you left" } }));
		ok(await h.call("POST", `/tasks/${before.task_id}/complete`, { token: h.ex.tokens.get(member)!, body: { summary: "old news" } }));
		// The leader leaves; a new session attaches later (as /team resume does).
		const back = ok(await h.call("POST", `/runs/${lead.run_id}/attach`, { token: h.op, body: {} }));
		await new Promise((r) => setTimeout(r, 20));
		const t1 = ok(await h.call("POST", "/tasks", { token: back.token, body: { owner_id: member, title: "Parser" } }));
		ok(await h.call("POST", `/tasks/${t1.task_id}/progress`, { token: h.ex.tokens.get(member)!, body: { note: "half" } }));
		ok(await h.call("POST", `/tasks/${t1.task_id}/complete`, { token: h.ex.tokens.get(member)!, body: { summary: "parser done" } }));
		const t2 = ok(await h.call("POST", "/tasks", { token: back.token, body: { owner_id: sub.root, title: "Linked work" } }));
		ok(await h.call("POST", `/tasks/${t2.task_id}/complete`, { token: sub.token, body: { summary: "linked done" } }));
		const away = ok(await h.call("GET", `/runs/${lead.run_id}/away`, { token: back.token }));
		assert.deepEqual(away.completed.map((c: any) => [c.title, c.summary]), [["Parser", "parser done"], ["Linked work", "linked done"]], "only what happened after the previous session, including linked teams");
		assert.equal(away.progress_reports, 1);
		assert.ok(away.messages_waiting >= 2);
		assert.equal((await h.call("GET", `/runs/${lead.run_id}/away`, { token: sub.token })).status, 403);
	} finally { await h.cleanup(); }
});
