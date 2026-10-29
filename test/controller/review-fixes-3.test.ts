// Regression tests for the re-review: children of controller-terminated managers, fencing on all writes,
// escalation reroute and withdrawal audit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { harness, newRun, ownTask, proposal, recruit, sql, waitFor, type Harness } from "./helpers.ts";
import { tx } from "../../src/controller/db.ts";
import { terminateAgent } from "../../src/controller/topology.ts";

const tok = (hs: Harness, id: string) => hs.ex.tokens.get(id)!;
const firstTask = async (hs: Harness, id: string) => (await hs.call("GET", "/me", { token: tok(hs, id) })).body.tasks[0].task_id as string;
const parentOf = (hs: Harness, id: string) => sql(hs, "SELECT parent_id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", id)[0]?.parent_id;

test("R1: a manager FAILED by the reconciler (deadline) hands its live reports to the nearest live ancestor", { timeout: 20_000 }, async () => {
	const hs = await harness();
	try {
		const { run_id, root, token: rt } = await newRun(hs, { deadline_policy: "FAILED" });
		const [A] = await recruit(hs, rt, rt, await ownTask(hs, rt, root), [{ max_cost_usd: 4 }]);
		const [M] = await recruit(hs, tok(hs, A), hs.op, await firstTask(hs, A), [{ max_cost_usd: 2, max_runtime_seconds: 2 }]);
		const [X] = await recruit(hs, tok(hs, M), hs.op, await firstTask(hs, M), [{ max_cost_usd: 0.5 }]);
		const [Y] = await recruit(hs, tok(hs, X), hs.op, await firstTask(hs, X), [{ max_cost_usd: 0.1 }]);
		const v0 = sql(hs, "SELECT topology_version v FROM runs WHERE id = ?", run_id)[0].v;
		await waitFor(() => sql(hs, "SELECT status FROM agents WHERE id = ?", M)[0].status === "FAILED", "M FAILED by deadline", 8000);
		assert.equal(parentOf(hs, X), A, "X adopted by M's live manager");
		assert.equal(parentOf(hs, Y), X, "subtree moved intact");
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id = ?", X)[0].status, "RUNNING");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM reservations WHERE ancestor_id = ? AND state = 'ACTIVE'", M)[0].n, 0, "nothing reserved at the dead manager");
		assert.deepEqual(sql(hs, "SELECT ancestor_id FROM reservations WHERE beneficiary_id = ? AND state = 'ACTIVE'", Y).map((r) => r.ancestor_id).sort(), [A, X, root].sort());
		assert.equal(sql(hs, "SELECT topology_version v FROM runs WHERE id = ?", run_id)[0].v, v0 + 1);
		const op = sql(hs, "SELECT from_parent_id, to_parent_id, expected_version, committed_version FROM topology_operations WHERE subject_agent_id = ?", X)[0];
		assert.deepEqual({ ...op }, { from_parent_id: M, to_parent_id: A, expected_version: v0, committed_version: v0 + 1 });
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM events WHERE type = 'agent.children_adopted' AND entity_id = ?", M)[0].n, 1);
		assert.ok(sql(hs, "SELECT payload_json p FROM messages WHERE recipient_id = ? AND type = 'system.notice'", A).some((m) => JSON.parse(m.p).kind === "handoff"));
		// Governance and reporting now flow through the live chain.
		const p = await hs.call("POST", "/expansions", { token: tok(hs, X), body: proposal(await firstTask(hs, X), [{ max_cost_usd: 0.1 }]) });
		assert.equal(p.body.reviewer_id, A);
		const xTask = await firstTask(hs, X);
		const done = await hs.call("POST", `/tasks/${xTask}/complete`, { token: tok(hs, X), body: { summary: "ok" } });
		assert.equal(sql(hs, "SELECT recipient_id FROM messages WHERE id = ?", done.body.message_id)[0].recipient_id, A);
		const limitsM = sql(hs, "SELECT limits_json FROM allocations WHERE agent_id = ?", M)[0].limits_json;
		const ok = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: hs.op, body: { decision: "APPROVE", reason: "ok" } });
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		assert.equal(sql(hs, "SELECT limits_json FROM allocations WHERE agent_id = ?", M)[0].limits_json, limitsM, "dead manager's envelope untouched");
	} finally {
		await hs.cleanup();
	}
});

test("R3: fencing covers GET /inbox and reconciler write transactions", async () => {
	const hs = await harness();
	try {
		const { root, token: rt } = await newRun(hs);
		hs.ex.mode = "silent";
		const t = await ownTask(hs, rt, root);
		const p = await hs.call("POST", "/expansions", { token: rt, body: proposal(t, [{}]) });
		const [a] = (await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: rt, body: { decision: "APPROVE", reason: "ok" } })).body.spawned_agent_ids;
		await waitFor(() => sql(hs, "SELECT status FROM spawn_intents WHERE agent_id = ?", a)[0].status === "LAUNCHED");
		await hs.h.reconciler.idle();
		const intent = sql(hs, "SELECT id FROM spawn_intents WHERE agent_id = ?", a)[0].id;
		const sessionsBefore = sql(hs, "SELECT COUNT(*) n FROM sessions WHERE agent_id = ?", a)[0].n;
		hs.h.db.prepare("UPDATE spawn_intents SET status = 'PENDING' WHERE id = ?").run(intent);
		hs.h.db.prepare("UPDATE controller_lease SET controller_id = 'ctl-other', fencing_epoch = fencing_epoch + 1").run();
		await assert.rejects(hs.h.reconciler.launch(intent), /fenced/);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM sessions WHERE agent_id = ?", a)[0].n, sessionsBefore, "fenced reconciler wrote nothing");
		const inbox = await hs.call("GET", "/inbox", { token: rt });
		assert.equal(inbox.body.error.code, "INTERNAL");
		assert.match(inbox.body.error.message, /fenced/);
		// The controller shuts itself down after detecting the fence; inspect the DB with a fresh connection.
		await waitFor(async () => (await hs.call("GET", "/health").catch(() => null)) === null, "fenced controller stopped");
		const db = new DatabaseSync(join(hs.dir, "org.sqlite"));
		assert.equal((db.prepare("SELECT COUNT(*) n FROM deliveries WHERE status = 'CLAIMED'").get() as { n: number }).n, 0, "no claims by a fenced controller");
		db.close();
	} finally {
		await hs.cleanup();
	}
});

test("R4: ESCALATED proposals stay escalated when their reviewer dies; withdrawals are recorded as decisions", async () => {
	const hs = await harness();
	try {
		const { root, token: rt } = await newRun(hs);
		const [A] = await recruit(hs, rt, rt, await ownTask(hs, rt, root), [{ max_cost_usd: 4 }]);
		const [B] = await recruit(hs, tok(hs, A), hs.op, await firstTask(hs, A), [{ max_cost_usd: 2 }]);
		const [C] = await recruit(hs, tok(hs, B), hs.op, await firstTask(hs, B), [{ max_cost_usd: 1 }]);
		const p = await hs.call("POST", "/expansions", { token: tok(hs, C), body: proposal(await firstTask(hs, C), [{ max_cost_usd: 0.1 }]) });
		assert.equal((await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: tok(hs, B), body: { decision: "ESCALATE", reason: "above me" } })).body.reviewer_id, A);
		tx(hs.h.db, () => terminateAgent(hs.h.ctx, null, A, "FAILED", "test", "simulated crash"));
		const row = sql(hs, "SELECT status, reviewer_id FROM proposals WHERE id = ?", p.body.proposal_id)[0];
		assert.deepEqual({ ...row }, { status: "ESCALATED", reviewer_id: root });
		assert.equal(parentOf(hs, B), root);
		const ok = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: rt, body: { decision: "APPROVE", reason: "root decides" } });
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		// Withdrawal audit: C asks again, then C is cancelled.
		const q = await hs.call("POST", "/expansions", { token: tok(hs, C), body: proposal(await firstTask(hs, C), [{ max_cost_usd: 0.1 }]) });
		const cc = await hs.call("POST", `/agents/${C}/lifecycle`, { token: rt, body: { action: "cancel", reason: "scope cut", children_policy: "cascade" } });
		assert.equal(cc.status, 200, JSON.stringify(cc.body));
		const decs = (await hs.call("GET", "/proposals?scope=all", { token: hs.op })).body.proposals.find((x: any) => x.proposal_id === q.body.proposal_id).decisions;
		assert.equal(decs.length, 1);
		assert.equal(decs[0].decision, "WITHDRAW");
		assert.equal(decs[0].reviewer_id, root);
		assert.match(decs[0].reason, /requester cancelled: scope cut/);
	} finally {
		await hs.cleanup();
	}
});
