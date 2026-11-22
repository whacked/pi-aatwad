import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, sql, waitFor, type Harness } from "./helpers.ts";

type Team = Awaited<ReturnType<typeof newRun>>;
const ok = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const connect = async (h: Harness, child: Team, parent: Team) => ok(await h.call("POST", `/runs/${child.run_id}/reporting`, { token: child.token, body: { action: "connect", parent_run_id: parent.run_id } }));
const rosterOf = async (h: Harness, t: Team) => ok(await h.call("GET", `/agents/${t.root}/roster`, { token: t.token })).entries as any[];

test("closed recruits are recalled with their transcript or rehired fresh, from the lead's roster", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), stranger = await newRun(h);
		const member = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Analyst", responsibility: "Analyse the logs" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member), "recruit launched");
		ok(await h.call("POST", `/agents/${member}/lifecycle`, { token: lead.token, body: { action: "cancel", reason: "done" } }));
		const entry = (await rosterOf(h, lead)).find((e) => e.agent_id === member);
		assert.deepEqual({ active: entry.active, status: entry.status, origin: entry.origin, terminatable: entry.terminatable, responsibility: entry.responsibility }, { active: false, status: "CANCELLED", origin: "spawned", terminatable: true, responsibility: "Analyse the logs" });
		assert.equal((await h.call("GET", `/agents/${lead.root}/roster`, { token: stranger.token })).status, 403);

		const transcript = sql(h, "SELECT pi_session_path FROM agents WHERE id = ?", member)[0].pi_session_path;
		const recalled = ok(await h.call("POST", "/roster/recall", { token: lead.token, body: { agent: "Analyst" } }));
		assert.equal(recalled.same_identity, false);
		assert.equal(sql(h, "SELECT pi_session_path FROM agents WHERE id = ?", recalled.agent_id)[0].pi_session_path, transcript, "the recalled contractor continues its transcript");
		assert.equal(sql(h, "SELECT role FROM agents WHERE id = ?", recalled.agent_id)[0].role, "Analyst");

		const rehired = ok(await h.call("POST", "/roster/rehire", { token: lead.token, body: { agent: member } }));
		assert.notEqual(sql(h, "SELECT pi_session_path FROM agents WHERE id = ?", rehired.agent_id)[0].pi_session_path, transcript, "a new hire starts fresh");
		assert.equal(sql(h, "SELECT json_extract(spec_json, '$.responsibility') AS r FROM tasks WHERE owner_id = ?", rehired.agent_id)[0].r, "Analyse the logs");
		assert.equal((await h.call("POST", "/roster/recall", { token: lead.token, body: { agent: "Nobody" } })).status, 404);
		assert.equal((await h.call("POST", "/roster/recall", { token: lead.token, body: { agent: recalled.agent_id } })).status, 409, "an active member needs no recall");
	} finally { await h.cleanup(); }
});

test("a dismissed linked team is recalled with the same identity: resumed if the dismissal stopped it, then linked again", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), stopped = await newRun(h), detached = await newRun(h), operatorStopped = await newRun(h);
		for (const t of [stopped, detached, operatorStopped]) await connect(h, t, lead);
		ok(await h.call("POST", `/agents/${stopped.root}/link`, { token: h.op, body: { terminatable: true } }));
		ok(await h.call("POST", `/agents/${stopped.root}/dismiss`, { token: lead.token, body: {} }));
		ok(await h.call("POST", `/agents/${detached.root}/dismiss`, { token: lead.token, body: {} }));
		ok(await h.call("POST", `/agents/${operatorStopped.root}/dismiss`, { token: lead.token, body: {} }));
		ok(await h.call("POST", `/runs/${operatorStopped.run_id}/stop`, { token: h.op, body: {} }));

		const entries = await rosterOf(h, lead);
		const of = (t: Team) => entries.find((e) => e.agent_id === t.root);
		assert.deepEqual([of(stopped).active, of(stopped).team_state, of(stopped).run_id], [false, "STOPPED", stopped.run_id]);
		assert.deepEqual([of(detached).active, of(detached).team_state], [false, "RUNNING"]);

		const back = ok(await h.call("POST", "/roster/recall", { token: lead.token, body: { agent: stopped.root } }));
		assert.deepEqual({ same: back.same_identity, resumed: back.resumed }, { same: true, resumed: true });
		const link = (t: Team) => sql(h, "SELECT parent_id, terminatable FROM reporting_edges WHERE run_id = ? AND parent_run_id IS NOT NULL AND valid_to IS NULL", t.run_id)[0];
		assert.deepEqual({ ...link(stopped) }, { parent_id: lead.root, terminatable: 1 }, "the link comes back as it was");
		assert.equal(JSON.parse(sql(h, "SELECT config_json FROM runs WHERE id = ?", stopped.run_id)[0].config_json).team_lifecycle.state, "RESUMED");

		assert.equal(ok(await h.call("POST", "/roster/recall", { token: lead.token, body: { agent: detached.root } })).resumed, false);
		assert.equal(link(detached).terminatable, 0);
		assert.match((await h.call("POST", "/roster/recall", { token: lead.token, body: { agent: operatorStopped.root } })).body.error.message, /stopped by the human operator/);
		assert.equal(ok(await h.call("POST", "/roster/recall", { token: h.op, body: { agent: operatorStopped.root, lead_id: lead.root } })).resumed, true, "the operator can");
	} finally { await h.cleanup(); }
});
