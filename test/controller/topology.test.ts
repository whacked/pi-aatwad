import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, ownTask, proposal, recruit, sql, waitFor, type Harness } from "./helpers.ts";

const tv = (hs: Harness, run: string) => sql(hs, "SELECT topology_version v FROM runs WHERE id = ?", run)[0].v as number;
const tok = (hs: Harness, id: string) => hs.ex.tokens.get(id)!;
const firstTask = async (hs: Harness, id: string) => (await hs.call("GET", "/me", { token: tok(hs, id) })).body.tasks[0].task_id as string;
const activeAncestors = (hs: Harness, b: string) => sql(hs, "SELECT ancestor_id FROM reservations WHERE beneficiary_id = ? AND state='ACTIVE'", b).map((r) => r.ancestor_id).sort();

/** root → lead1 → w → e ; root → lead2 (lead2 holds 2 free slots). */
async function org(hs: Harness) {
	const { run_id, root, token: rootTok } = await newRun(hs);
	const t = await ownTask(hs, rootTok, root);
	const [lead1, lead2] = await recruit(hs, rootTok, rootTok, t, [{ title: "lead", count: 2, max_cost_usd: 3 }]);
	const [w] = await recruit(hs, tok(hs, lead1), hs.op, await firstTask(hs, lead1), [{ title: "w", max_cost_usd: 1 }]);
	const [e] = await recruit(hs, tok(hs, w), hs.op, await firstTask(hs, w), [{ title: "e", max_cost_usd: 0.5 }]);
	// Give lead2 a 2-slot ceiling by approving and then cancelling two temps.
	const temps = await recruit(hs, tok(hs, lead2), hs.op, await firstTask(hs, lead2), [{ title: "tmp", count: 2, max_cost_usd: 1 }]);
	for (const x of temps) assert.equal((await hs.call("POST", `/agents/${x}/lifecycle`, { token: tok(hs, lead2), body: { action: "cancel", reason: "temp" } })).status, 200);
	return { run_id, root, rootTok, lead1, lead2, w, e };
}

test("reparent moves the whole subtree atomically; history kept; reservations transferred", async () => {
	const hs = await harness();
	try {
		const o = await org(hs);
		const v0 = tv(hs, o.run_id);
		// Saturated destination: lead1's subtree (3 slots) does not fit lead2 (2 slots) → rejected without mutation.
		const sat = await hs.call("POST", `/agents/${o.lead1}/reparent`, { token: hs.op, body: { new_parent_id: o.lead2, expected_topology_version: v0, reason: "consolidate", pending_work_policy: "retain" } });
		assert.equal(sat.body.error.code, "BUDGET_EXCEEDED");
		assert.equal(tv(hs, o.run_id), v0);
		assert.equal(sql(hs, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", o.lead1)[0].parent_id, o.root);
		assert.deepEqual(activeAncestors(hs, o.e), [o.lead1, o.root, o.w].sort());

		// Move w (with e) from lead1 to lead2 — by root, which manages both scopes.
		const r = await hs.call("POST", `/agents/${o.w}/reparent`, { token: o.rootTok, body: { new_parent_id: o.lead2, expected_topology_version: v0, reason: "rebalance", pending_work_policy: "retain" } });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.deepEqual(r.body, { agent_id: o.w, old_parent_id: o.lead1, new_parent_id: o.lead2, topology_version: v0 + 1 });
		assert.equal(sql(hs, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", o.e)[0].parent_id, o.w, "subtree moved with its manager");
		assert.deepEqual(activeAncestors(hs, o.e), [o.lead2, o.root, o.w].sort());
		assert.deepEqual(activeAncestors(hs, o.w), [o.lead2, o.root].sort());
		assert.equal(sql(hs, "SELECT reserved_slots n FROM allocations WHERE agent_id = ?", o.lead1)[0].n, 0);
		assert.equal(sql(hs, "SELECT reserved_slots n FROM allocations WHERE agent_id = ?", o.lead2)[0].n, 2);
		const hist = (await hs.call("GET", `/agents/${o.w}`, { token: hs.op })).body.reporting_history;
		assert.deepEqual(hist.map((h: any) => [h.parent_id, h.valid_to === null]), [[o.lead1, false], [o.lead2, true]]);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM events WHERE type = 'agent.reparented' AND entity_id = ?", o.w)[0].n, 1);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM topology_operations WHERE subject_agent_id = ?", o.w)[0].n, 1);
		// Version-scoped ancestry still answers the old shape.
		const { getAncestry } = await import("../../src/controller/queries.ts");
		assert.deepEqual(getAncestry(hs.h.db, o.e, v0), [o.w, o.lead1, o.root]);
		assert.deepEqual(getAncestry(hs.h.db, o.e), [o.w, o.lead2, o.root]);
		// Invariant: one active parent per non-root.
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM (SELECT child_id FROM reporting_edges WHERE valid_to IS NULL GROUP BY child_id HAVING COUNT(*) > 1)")[0].n, 0);

		// Stale version, cycle, self, root, cross-run, unauthorized.
		const v1 = v0 + 1;
		const base = { reason: "x", pending_work_policy: "retain" };
		assert.equal((await hs.call("POST", `/agents/${o.w}/reparent`, { token: hs.op, body: { ...base, new_parent_id: o.lead1, expected_topology_version: v0 } })).body.error.code, "CONFLICT");
		const cyc = await hs.call("POST", `/agents/${o.lead2}/reparent`, { token: hs.op, body: { ...base, new_parent_id: o.e, expected_topology_version: v1 } });
		assert.equal(cyc.body.error.code, "CONFLICT");
		assert.match(cyc.body.error.message, /cycle/);
		assert.equal((await hs.call("POST", `/agents/${o.w}/reparent`, { token: hs.op, body: { ...base, new_parent_id: o.w, expected_topology_version: v1 } })).body.error.code, "CONFLICT");
		assert.equal((await hs.call("POST", `/agents/${o.root}/reparent`, { token: hs.op, body: { ...base, new_parent_id: o.lead1, expected_topology_version: v1 } })).body.error.code, "CONFLICT");
		const other = await newRun(hs);
		assert.match((await hs.call("POST", `/agents/${o.w}/reparent`, { token: hs.op, body: { ...base, new_parent_id: other.root, expected_topology_version: v1 } })).body.error.message, /cross-run/);
		assert.equal((await hs.call("POST", `/agents/${o.e}/reparent`, { token: tok(hs, o.lead1), body: { ...base, new_parent_id: o.lead1, expected_topology_version: v1 } })).body.error.code, "FORBIDDEN");
		assert.equal(tv(hs, o.run_id), v1, "rejections never bump the version");

		// Individual move without subtree requires an explicit children policy.
		assert.equal((await hs.call("POST", `/agents/${o.w}/reparent`, { token: hs.op, body: { ...base, new_parent_id: o.lead1, expected_topology_version: v1, move_subtree: false } })).body.error.code, "INVALID");
		const ind = await hs.call("POST", `/agents/${o.w}/reparent`, {
			token: hs.op,
			body: { ...base, new_parent_id: o.lead1, expected_topology_version: v1, move_subtree: false, children_policy: { kind: "transfer_children_to", agent_id: o.lead2 } },
		});
		assert.equal(ind.status, 200, JSON.stringify(ind.body));
		assert.equal(sql(hs, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", o.e)[0].parent_id, o.lead2);
		assert.equal(sql(hs, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", o.w)[0].parent_id, o.lead1);
		assert.deepEqual(activeAncestors(hs, o.e), [o.lead2, o.root].sort());
	} finally {
		await hs.cleanup();
	}
});

test("stale reviewer after a move cannot approve; proposal is returned for fresh review", async () => {
	const hs = await harness();
	try {
		const o = await org(hs);
		const p = await hs.call("POST", "/expansions", { token: tok(hs, o.e), body: proposal(await firstTask(hs, o.e), [{ max_cost_usd: 0.1 }]) });
		assert.equal(p.body.reviewer_id, o.w);
		const mv = await hs.call("POST", `/agents/${o.e}/reparent`, { token: hs.op, body: { new_parent_id: o.lead2, expected_topology_version: tv(hs, o.run_id), reason: "move", pending_work_policy: "retain" } });
		assert.equal(mv.status, 200, JSON.stringify(mv.body));
		const stale = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: tok(hs, o.w), body: { decision: "APPROVE", reason: "old boss" } });
		assert.equal(stale.body.error.code, "CONFLICT");
		assert.equal(stale.body.error.details.new_reviewer_id, o.lead2);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM agents WHERE run_id = ?", o.run_id)[0].n, 7, "no child created");
		const row = sql(hs, "SELECT status, reviewer_id, original_reviewer_id FROM proposals WHERE id = ?", p.body.proposal_id)[0];
		assert.deepEqual({ ...row }, { status: "PENDING", reviewer_id: o.lead2, original_reviewer_id: o.w });
		// Stale expected_topology_version on a decision is rejected too.
		const sv = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: tok(hs, o.lead2), body: { decision: "APPROVE", reason: "x", expected_topology_version: 0 } });
		assert.equal(sv.body.error.code, "CONFLICT");
		const ok = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: tok(hs, o.lead2), body: { decision: "APPROVE", reason: "new boss" } });
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
	} finally {
		await hs.cleanup();
	}
});

test("lifecycle: children policy required; cascade cancel revokes tokens, stops processes, releases reservations, keeps consumed cost", async () => {
	const hs = await harness();
	try {
		const o = await org(hs);
		const wTok = tok(hs, o.w);
		const eTok = tok(hs, o.e);
		assert.equal((await hs.call("POST", "/sessions/usage", { token: eTok, body: { cost_usd: 0.2 } })).body.consumed_usd, 0.2);
		// pause/resume
		const pz = await hs.call("POST", `/agents/${o.e}/lifecycle`, { token: wTok, body: { action: "pause", reason: "hold" } });
		assert.deepEqual([pz.body.status, pz.body.desired_state], ["PAUSED", "PAUSED"]);
		assert.equal((await hs.call("POST", "/sessions/heartbeat", { token: eTok, body: {} })).body.desired_state, "PAUSED");
		const rs = await hs.call("POST", `/agents/${o.e}/lifecycle`, { token: wTok, body: { action: "resume", reason: "go" } });
		assert.deepEqual([rs.body.status, rs.body.desired_state], ["RUNNING", "RUNNING"]);
		// Self/peers cannot cancel.
		assert.equal((await hs.call("POST", `/agents/${o.w}/lifecycle`, { token: wTok, body: { action: "cancel", reason: "x" } })).body.error.code, "FORBIDDEN");
		// No silent orphaning.
		assert.equal((await hs.call("POST", `/agents/${o.w}/lifecycle`, { token: tok(hs, o.lead1), body: { action: "retire", reason: "x" } })).body.error.code, "CONFLICT");
		const ePid = sql(hs, "SELECT s.pid FROM sessions s JOIN agents a ON a.current_session_id = s.id WHERE a.id = ?", o.e)[0].pid;
		const c = await hs.call("POST", `/agents/${o.w}/lifecycle`, { token: tok(hs, o.lead1), body: { action: "cancel", reason: "done", children_policy: "cascade" } });
		assert.equal(c.status, 200, JSON.stringify(c.body));
		assert.deepEqual([...c.body.affected_agent_ids].sort(), [o.e, o.w].sort());
		assert.equal(c.body.status, "CANCELLED");
		await waitFor(() => hs.ex.stopped.includes(ePid), "executor.stop for e");
		assert.equal((await hs.call("GET", "/me", { token: eTok })).body.error.code, "STALE_SESSION");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM reservations WHERE beneficiary_id IN (?,?) AND state = 'ACTIVE'", o.w, o.e)[0].n, 0);
		assert.equal(sql(hs, "SELECT reserved_slots n FROM allocations WHERE agent_id = ?", o.lead1)[0].n, 0);
		assert.equal(sql(hs, "SELECT consumed_usd c FROM allocations WHERE agent_id = ?", o.e)[0].c, 0.2);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM tasks WHERE owner_id = ? AND status = 'CANCELLED'", o.e)[0].n, 1);
		// Retire with transfer_children_to.
		const [x] = await recruit(hs, tok(hs, o.lead1), hs.op, await firstTask(hs, o.lead1), [{ title: "x", max_cost_usd: 0.5 }]);
		const rt = await hs.call("POST", `/agents/${o.lead1}/lifecycle`, { token: o.rootTok, body: { action: "retire", reason: "reorg", children_policy: "transfer_children_to", transfer_children_to: o.lead2, expected_topology_version: tv(hs, o.run_id) } });
		assert.equal(rt.status, 200, JSON.stringify(rt.body));
		assert.equal(sql(hs, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", x)[0].parent_id, o.lead2);
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id = ?", o.lead1)[0].status, "RETIRED");
		assert.ok(sql(hs, "SELECT COUNT(*) n FROM events WHERE type = 'agent.lifecycle'")[0].n >= 4);
	} finally {
		await hs.cleanup();
	}
});
