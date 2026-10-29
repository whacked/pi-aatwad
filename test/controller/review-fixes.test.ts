// Regression tests for reviewer findings (round 1): token reissue, run spend cap, depth on moves, orphaned governance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { harness, newRun, ownTask, proposal, recruit, sql, waitFor, type Harness } from "./helpers.ts";
import { tx } from "../../src/controller/db.ts";
import { terminateAgent } from "../../src/controller/topology.ts";

const tok = (hs: Harness, id: string) => hs.ex.tokens.get(id)!;
const firstTask = async (hs: Harness, id: string) => (await hs.call("GET", "/me", { token: tok(hs, id) })).body.tasks[0].task_id as string;

async function manualEnrollable(hs: Harness, rt: string, root: string) {
	hs.ex.mode = "silent";
	const task = await ownTask(hs, rt, root);
	const p = await hs.call("POST", "/expansions", { token: rt, body: proposal(task, [{ max_cost_usd: 1 }]) });
	const d = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: rt, body: { decision: "APPROVE", reason: "ok" } });
	const w = d.body.spawned_agent_ids[0] as string;
	const l = await waitFor(() => hs.ex.launchesFor(w)[0]);
	const f = JSON.parse(readFileSync(l.spec.enroll_file, "utf8"));
	hs.ex.mode = "enroll";
	return { w, l, body: { token: f.token, agent_id: w, spawn_intent_id: f.spawn_intent_id, pid: l.id.pid, process_started_at: l.id.process_started_at } };
}

test("F1: idempotent replay never reissues a token for a retired / exited / superseded session", async () => {
	const hs = await harness();
	try {
		const { run_id, root, token: rt } = await newRun(hs);
		// retired
		const a = await manualEnrollable(hs, rt, root);
		const e1 = await hs.call("POST", "/enroll", { key: "K", body: a.body });
		assert.equal(e1.status, 200);
		const ok = await hs.call("POST", "/enroll", { key: "K", body: a.body });
		assert.equal(ok.status, 200, "replay of a live session still works");
		assert.equal((await hs.call("POST", `/agents/${a.w}/lifecycle`, { token: rt, body: { action: "retire", reason: "done" } })).status, 200);
		const r1 = await hs.call("POST", "/enroll", { key: "K", body: a.body });
		assert.equal(r1.body.error.code, "STALE_SESSION");
		assert.equal(r1.body.token, undefined);
		// exited (one-shot process gone)
		const b = await manualEnrollable(hs, rt, root);
		assert.equal((await hs.call("POST", "/enroll", { key: "K2", body: b.body })).status, 200);
		hs.ex.alive.delete(b.l.id.pid);
		await waitFor(() => sql(hs, "SELECT COUNT(*) n FROM events WHERE type = 'agent.exited' AND entity_id = ?", b.w)[0].n === 1, "exit observed");
		assert.equal((await hs.call("POST", "/enroll", { key: "K2", body: b.body })).body.error.code, "STALE_SESSION");
		// superseded root session (/runs replay after /attach)
		const runs = await hs.call("POST", "/runs", { token: hs.op, key: "R", body: { root: { role: "root", cwd: hs.dir } } });
		assert.equal((await hs.call("POST", `/runs/${runs.body.run_id}/attach`, { token: hs.op, key: "A", body: {} })).status, 200);
		assert.equal((await hs.call("POST", "/runs", { token: hs.op, key: "R", body: { root: { role: "root", cwd: hs.dir } } })).body.error.code, "STALE_SESSION");
		// retired root: attach replay refused
		const at = await hs.call("POST", `/runs/${run_id}/attach`, { token: hs.op, key: "A2", body: {} });
		assert.equal(at.status, 200);
		const cancelled = await hs.call("POST", `/agents/${root}/lifecycle`, { token: hs.op, body: { action: "cancel", reason: "end", children_policy: "cascade" } });
		assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
		assert.equal((await hs.call("POST", `/runs/${run_id}/attach`, { token: hs.op, key: "A2", body: {} })).body.error.code, "STALE_SESSION");
	} finally {
		await hs.cleanup();
	}
});

test("F2: max_run_usd counts consumed spend (incl. root and retired agents); subtree keeps consumed charge", async () => {
	const hs = await harness();
	try {
		const { root, token: rt } = await newRun(hs, { limits: { max_run_usd: 2 } });
		const task = await ownTask(hs, rt, root);
		const [w] = await recruit(hs, rt, rt, task, [{ max_cost_usd: 1.5 }]);
		assert.equal((await hs.call("POST", "/sessions/usage", { token: tok(hs, w), body: { cost_usd: 1.5 } })).status, 200);
		assert.equal((await hs.call("POST", `/agents/${w}/lifecycle`, { token: rt, body: { action: "retire", reason: "x" } })).status, 200);
		// Slot is back, but the consumed $1.5 stays charged.
		const bv = (await hs.call("GET", `/budgets/${root}`, { token: rt })).body;
		assert.deepEqual([bv.reserved_slots, bv.reserved_usd, bv.settled_usd], [0, 0, 1.5]);
		assert.equal(bv.available_usd, 0.1); // root envelope $1.6 (80% of max_run_usd)
		const p = await hs.call("POST", "/expansions", { token: rt, body: proposal(task, [{ max_cost_usd: 1.5 }]) });
		const d = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: rt, body: { decision: "APPROVE", reason: "again" } });
		assert.equal(d.body.error.code, "HARD_CAP");
		// Within what is left (root envelope $1.6 − $1.5 consumed) it still works.
		await recruit(hs, rt, rt, task, [{ max_cost_usd: 0.1 }]);
		// Root's own consumption counts too.
		const hs2 = await harness();
		try {
			const r2 = await newRun(hs2, { limits: { max_run_usd: 2 } });
			const t2 = await ownTask(hs2, r2.token, r2.root);
			await hs2.call("POST", "/sessions/usage", { token: r2.token, body: { cost_usd: 1 } });
			const p2 = await hs2.call("POST", "/expansions", { token: r2.token, body: proposal(t2, [{ max_cost_usd: 1.5 }]) });
			assert.equal((await hs2.call("POST", `/expansions/${p2.body.proposal_id}/decision`, { token: r2.token, body: { decision: "APPROVE", reason: "x" } })).body.error.code, "HARD_CAP");
		} finally {
			await hs2.cleanup();
		}
	} finally {
		await hs.cleanup();
	}
});

test("F3: reparent and transfer_children_to respect emergency_max_depth", async () => {
	const hs = await harness();
	try {
		const { run_id, root, token: rt } = await newRun(hs, { limits: { emergency_max_depth: 3 } });
		const [A] = await recruit(hs, rt, hs.op, await ownTask(hs, rt, root), [{}]);
		const [B] = await recruit(hs, tok(hs, A), hs.op, await firstTask(hs, A), [{}]); // depth 2
		const [C] = await recruit(hs, rt, hs.op, await ownTask(hs, rt, root), [{}]);
		const [D] = await recruit(hs, tok(hs, C), hs.op, await firstTask(hs, C), [{}]); // C(1) → D(2)
		const v = sql(hs, "SELECT topology_version v FROM runs WHERE id = ?", run_id)[0].v;
		const r = await hs.call("POST", `/agents/${C}/reparent`, { token: hs.op, body: { new_parent_id: B, expected_topology_version: v, reason: "x", pending_work_policy: "retain" } });
		assert.equal(r.body.error.code, "HARD_CAP"); // D would be at depth 4
		assert.equal(sql(hs, "SELECT topology_version v FROM runs WHERE id = ?", run_id)[0].v, v);
		assert.equal(sql(hs, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", C)[0].parent_id, root);
		// transfer_children_to: E(1) → F(2) → G(3). Moving F under B(2) would put G at depth 4.
		const [E] = await recruit(hs, rt, hs.op, await ownTask(hs, rt, root), [{}]);
		const [F] = await recruit(hs, tok(hs, E), hs.op, await firstTask(hs, E), [{}]);
		await recruit(hs, tok(hs, F), hs.op, await firstTask(hs, F), [{}]);
		const bad = await hs.call("POST", `/agents/${E}/lifecycle`, { token: hs.op, body: { action: "retire", reason: "x", children_policy: "transfer_children_to", transfer_children_to: B, expected_topology_version: sql(hs, "SELECT topology_version v FROM runs WHERE id = ?", run_id)[0].v } });
		assert.equal(bad.body.error.code, "HARD_CAP");
		assert.equal(sql(hs, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", F)[0].parent_id, E);
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id = ?", E)[0].status, "RUNNING");
		// Within the cap it works: retire C, moving D under the root.
		const t = await hs.call("POST", `/agents/${C}/lifecycle`, { token: hs.op, body: { action: "retire", reason: "x", children_policy: "transfer_children_to", transfer_children_to: root, expected_topology_version: sql(hs, "SELECT topology_version v FROM runs WHERE id = ?", run_id)[0].v } });
		assert.equal(t.status, 200, JSON.stringify(t.body));
		assert.equal(sql(hs, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", D)[0].parent_id, root);
	} finally {
		await hs.cleanup();
	}
});

test("F4: retire/cancel reject pause_subtree; proposals route past terminated managers; terminated reviewers cannot decide", async () => {
	const hs = await harness();
	try {
		const { root, token: rt } = await newRun(hs);
		const [M] = await recruit(hs, rt, rt, await ownTask(hs, rt, root), [{ max_cost_usd: 3 }]);
		const [X] = await recruit(hs, tok(hs, M), hs.op, await firstTask(hs, M), [{ max_cost_usd: 0.5 }]);
		for (const action of ["retire", "cancel"]) {
			const r = await hs.call("POST", `/agents/${M}/lifecycle`, { token: rt, body: { action, reason: "bye", children_policy: "pause_subtree" } });
			assert.equal(r.body.error.code, "INVALID");
		}
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id = ?", M)[0].status, "RUNNING");
		// A manager can still end up terminal with live reports (e.g. FAILED by launch/deadline policy).
		const pending = await hs.call("POST", "/expansions", { token: tok(hs, X), body: proposal(await firstTask(hs, X), [{ max_cost_usd: 0.1 }]) });
		assert.equal(pending.body.reviewer_id, M);
		const mTok = tok(hs, M);
		tx(hs.h.db, () => terminateAgent(hs.h.ctx, null, M, "FAILED", "test", "simulated failure"));
		assert.equal((await hs.call("POST", `/expansions/${pending.body.proposal_id}/decision`, { token: mTok, body: { decision: "APPROVE", reason: "ghost" } })).body.error.code, "STALE_SESSION");
		const fresh = await hs.call("POST", "/expansions", { token: tok(hs, X), body: proposal(await firstTask(hs, X), [{ max_cost_usd: 0.1 }]) });
		assert.equal(fresh.body.reviewer_id, root, "skips the terminated manager");
		// The pending one was rerouted to the live chain at termination time and can be decided.
		assert.equal(sql(hs, "SELECT reviewer_id FROM proposals WHERE id = ?", pending.body.proposal_id)[0].reviewer_id, root);
		const ok = await hs.call("POST", `/expansions/${pending.body.proposal_id}/decision`, { token: rt, body: { decision: "APPROVE", reason: "root steps in" } });
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		// A terminated agent's own open proposals are withdrawn.
		const [Y] = await recruit(hs, rt, rt, await ownTask(hs, rt, root), [{ max_cost_usd: 1 }]);
		const own = await hs.call("POST", "/expansions", { token: tok(hs, Y), body: proposal(await firstTask(hs, Y), [{ max_cost_usd: 0.1 }]) });
		assert.equal((await hs.call("POST", `/agents/${Y}/lifecycle`, { token: rt, body: { action: "cancel", reason: "x" } })).status, 200);
		assert.equal(sql(hs, "SELECT status FROM proposals WHERE id = ?", own.body.proposal_id)[0].status, "REJECTED");
	} finally {
		await hs.cleanup();
	}
});
