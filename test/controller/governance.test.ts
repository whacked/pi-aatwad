import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, ownTask, proposal, recruit, sql, waitFor } from "./helpers.ts";

test("protocol header and auth are enforced", async () => {
	const hs = await harness();
	try {
		assert.equal((await hs.call("GET", "/health", {})).status, 200);
		const { api } = await import("./helpers.ts");
		const r = await api(hs.sock, "GET", "/health", { protocol: "99" });
		assert.equal(r.status, 426);
		assert.equal(r.body.error.code, "PROTOCOL_MISMATCH");
		assert.equal((await hs.call("GET", "/runs", {})).body.error.code, "UNAUTHENTICATED");
		assert.equal((await hs.call("GET", "/runs", { token: "nope" })).body.error.code, "UNAUTHENTICATED");
		assert.equal((await hs.call("POST", "/runs", { token: hs.op, key: null, body: {} })).body.error.code, "INVALID");
	} finally {
		await hs.cleanup();
	}
});

test("idempotency: same key+payload replays, different payload → IDEMPOTENCY_MISMATCH", async () => {
	const hs = await harness();
	try {
		const body = { root: { role: "root", cwd: hs.dir } };
		const a = await hs.call("POST", "/runs", { token: hs.op, key: "k1", body });
		const b = await hs.call("POST", "/runs", { token: hs.op, key: "k1", body });
		assert.equal(a.status, 200);
		assert.equal(b.status, 200);
		assert.equal(b.body.run_id, a.body.run_id);
		assert.equal(b.body.session_id, a.body.session_id);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM runs")[0].n, 1);
		// Tokens are never stored: the replay mints a fresh one for the same session; it works.
		assert.notEqual(b.body.token, a.body.token);
		assert.equal((await hs.call("GET", "/me", { token: b.body.token })).status, 200);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM idempotency WHERE response_json LIKE '%pts_%'")[0].n, 0);
		const c = await hs.call("POST", "/runs", { token: hs.op, key: "k1", body: { root: { role: "other", cwd: hs.dir } } });
		assert.equal(c.status, 409);
		assert.equal(c.body.error.code, "IDEMPOTENCY_MISMATCH");
		// Agent-level idempotency on messages.
		const t = b.body.token;
		const m1 = await hs.call("POST", "/messages", { token: t, key: "m", body: { to: a.body.root_agent_id, type: "system.notice", payload: { x: 1 } } });
		const m2 = await hs.call("POST", "/messages", { token: t, key: "m", body: { to: a.body.root_agent_id, type: "system.notice", payload: { x: 1 } } });
		assert.equal(m1.body.message_id, m2.body.message_id);
		assert.equal((await hs.call("POST", "/messages", { token: t, key: "m", body: { to: a.body.root_agent_id, type: "system.notice", payload: { x: 2 } } })).body.error.code, "IDEMPOTENCY_MISMATCH");
	} finally {
		await hs.cleanup();
	}
});

test("demo flow: root → lead → workers → nested worker via escalation; differing models; hard cap refusal", async () => {
	const hs = await harness();
	try {
		const { run_id, root, token: rootTok } = await newRun(hs);
		const rootTask = await ownTask(hs, rootTok, root);
		// Root recruits Lead B on a different model (root self-reviews within its envelope).
		const [lead] = await recruit(hs, rootTok, rootTok, rootTask, [{ title: "lead", max_cost_usd: 4, preferred_model_id: "economy-coder" }]);
		const leadTok = hs.ex.tokens.get(lead)!;
		const leadRow = sql(hs, "SELECT provider, model, model_id, status, observed_state FROM agents WHERE id = ?", lead)[0];
		assert.deepEqual({ ...leadRow }, { provider: "openrouter", model: "cheap-coder", model_id: "economy-coder", status: "RUNNING", observed_state: "LIVE" });
		const me = (await hs.call("GET", "/me", { token: leadTok })).body;
		assert.equal(me.parent.agent_id, root);
		const leadTask = me.tasks[0].task_id;

		// B proposes 2 workers; B's manager (root) approves.
		const p = await hs.call("POST", "/expansions", { token: leadTok, body: proposal(leadTask, [{ title: "verifier", count: 2, max_cost_usd: 1.5 }]) });
		assert.equal(p.body.reviewer_id, root);
		assert.equal((await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: leadTok, body: { decision: "APPROVE", reason: "self" } })).body.error.code, "FORBIDDEN");
		const d = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: rootTok, body: { decision: "APPROVE", reason: "within envelope" } });
		assert.equal(d.status, 200, JSON.stringify(d.body));
		const [c, dd] = d.body.spawned_agent_ids;
		await waitFor(() => hs.ex.tokens.has(c) && hs.ex.tokens.has(dd));
		// No preference → cheapest eligible; "leader" has null cost (treated as 0, flagged as estimate). Differs from its parent's model.
		const cRow = sql(hs, "SELECT model_id, metadata_json FROM agents WHERE id = ?", c)[0];
		assert.equal(cRow.model_id, "leader");
		assert.equal(JSON.parse(cRow.metadata_json).cost_estimated, true);
		// Reservations at every ancestor.
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM reservations WHERE beneficiary_id = ? AND state='ACTIVE'", c)[0].n, 2);
		assert.equal((await hs.call("GET", `/budgets/${lead}`, { token: leadTok })).body.reserved_slots, 2);

		// C (itself a subordinate) proposes nested worker E. B's subtree is full → B cannot approve; B escalates; root approves.
		const cTok = hs.ex.tokens.get(c)!;
		const cTask = (await hs.call("GET", "/me", { token: cTok })).body.tasks[0].task_id;
		const pe = await hs.call("POST", "/expansions", { token: cTok, body: proposal(cTask, [{ title: "nested", max_cost_usd: 0.5 }]) });
		assert.equal(pe.body.reviewer_id, lead);
		const denied = await hs.call("POST", `/expansions/${pe.body.proposal_id}/decision`, { token: leadTok, body: { decision: "APPROVE", reason: "try" } });
		assert.equal(denied.body.error.code, "BUDGET_EXCEEDED");
		assert.equal(denied.body.error.details.hint, "ESCALATE");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM agents")[0].n, 4, "failed approval must not create agents");
		const esc = await hs.call("POST", `/expansions/${pe.body.proposal_id}/decision`, { token: leadTok, body: { decision: "ESCALATE", reason: "needs more slots than I hold" } });
		assert.equal(esc.body.status, "ESCALATED");
		assert.equal(esc.body.reviewer_id, root);
		const ok = await hs.call("POST", `/expansions/${pe.body.proposal_id}/decision`, { token: rootTok, body: { decision: "APPROVE", reason: "bounded grant" } });
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		const [e] = ok.body.spawned_agent_ids;
		await waitFor(() => hs.ex.tokens.has(e));
		const anc = sql(hs, "SELECT ancestor_id FROM reservations WHERE beneficiary_id = ? AND state='ACTIVE' ORDER BY ancestor_id", e).map((r) => r.ancestor_id).sort();
		assert.deepEqual(anc, [c, lead, root].sort());
		assert.ok(sql(hs, "SELECT COUNT(*) n FROM events WHERE type='budget.grant_raised'")[0].n >= 2);
		const decisions = sql(hs, "SELECT decision FROM proposal_decisions WHERE proposal_id = ? ORDER BY created_at, rowid", pe.body.proposal_id).map((r) => r.decision);
		assert.deepEqual(decisions, ["ESCALATE", "APPROVE"]);

		// D proposes 100 workers → global hard cap refusal, audited, no spawn — even root cannot override.
		const dTok = hs.ex.tokens.get(dd)!;
		const dTask = (await hs.call("GET", "/me", { token: dTok })).body.tasks[0].task_id;
		const roles = Array.from({ length: 7 }, () => ({ count: 15, max_cost_usd: 0.01 }));
		const big = await hs.call("POST", "/expansions", { token: dTok, body: proposal(dTask, roles) });
		await hs.call("POST", `/expansions/${big.body.proposal_id}/decision`, { token: leadTok, body: { decision: "ESCALATE", reason: "far beyond my authority" } });
		const before = sql(hs, "SELECT COUNT(*) n FROM spawn_intents")[0].n;
		const hc = await hs.call("POST", `/expansions/${big.body.proposal_id}/decision`, { token: rootTok, body: { decision: "APPROVE", reason: "root tries to override" } });
		assert.equal(hc.status, 409);
		assert.equal(hc.body.error.code, "HARD_CAP");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM spawn_intents")[0].n, before);
		assert.equal(sql(hs, "SELECT status FROM proposals WHERE id = ?", big.body.proposal_id)[0].status, "REJECTED");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM events WHERE type='governance.hard_cap_denied' AND entity_id = ?", big.body.proposal_id)[0].n, 1);
		// Operator can't override either.
		const tree = (await hs.call("GET", `/runs/${run_id}/tree`, { token: hs.op })).body;
		assert.equal(tree.root.children[0].agent_id, lead);
		assert.equal(tree.root.children[0].children.length, 2);
	} finally {
		await hs.cleanup();
	}
});

test("per-decision grant exceeded → FORBIDDEN with escalate hint; REJECT and AMEND keep history", async () => {
	const hs = await harness();
	try {
		const { root, token: rootTok } = await newRun(hs);
		const t = await ownTask(hs, rootTok, root);
		const [lead] = await recruit(hs, rootTok, rootTok, t, [{ title: "lead", max_cost_usd: 2 }]);
		const leadTok = hs.ex.tokens.get(lead)!;
		const leadTask = (await hs.call("GET", "/me", { token: leadTok })).body.tasks[0].task_id;
		const [w] = await recruit(hs, leadTok, rootTok, leadTask, [{ max_cost_usd: 1 }]);
		const wTok = hs.ex.tokens.get(w)!;
		const wTask = (await hs.call("GET", "/me", { token: wTok })).body.tasks[0].task_id;
		const p = await hs.call("POST", "/expansions", { token: wTok, body: proposal(wTask, [{ count: 3, max_cost_usd: 0.1 }]) });
		const f = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: leadTok, body: { decision: "APPROVE", reason: "x" } });
		assert.equal(f.body.error.code, "FORBIDDEN");
		assert.equal(f.body.error.details.hint, "ESCALATE");
		const am = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: leadTok, body: { decision: "AMEND", reason: "one is enough", amended_roles: proposal(wTask, [{ count: 1, max_cost_usd: 0.1 }]).roles } });
		assert.equal(am.body.status, "PENDING");
		assert.equal(am.body.revision, 2);
		const revs = sql(hs, "SELECT revision, request_json FROM proposal_revisions WHERE proposal_id = ? ORDER BY revision", p.body.proposal_id);
		assert.equal(revs.length, 2);
		assert.equal(JSON.parse(revs[0].request_json).roles[0].count, 3);
		assert.equal(JSON.parse(revs[1].request_json).roles[0].count, 1);
		const rj = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: leadTok, body: { decision: "REJECT", reason: "not now" } });
		assert.equal(rj.body.status, "REJECTED");
		const view = (await hs.call("GET", "/proposals?scope=mine", { token: wTok })).body.proposals[0];
		assert.deepEqual(view.decisions.map((d: any) => d.decision), ["AMEND", "REJECT"]);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM agents")[0].n, 3, "unapproved expansion never spawns");
	} finally {
		await hs.cleanup();
	}
});

test("concurrent sibling approvals cannot overcommit an ancestor", async () => {
	const hs = await harness();
	try {
		const { root, token: rootTok } = await newRun(hs, { root_envelope: { max_subtree_slots: 3, max_subtree_usd: 10, max_grant_slots: 3, max_grant_usd: 10 } });
		const t = await ownTask(hs, rootTok, root);
		const [a, b] = await recruit(hs, rootTok, rootTok, t, [{ title: "sib", count: 2, max_cost_usd: 1 }]);
		// Root has 1 slot left. Both siblings ask for one worker; root approves both concurrently.
		const props = await Promise.all(
			[a, b].map(async (id) => {
				const tok = hs.ex.tokens.get(id)!;
				const task = (await hs.call("GET", "/me", { token: tok })).body.tasks[0].task_id;
				return (await hs.call("POST", "/expansions", { token: tok, body: proposal(task, [{ max_cost_usd: 1 }]) })).body.proposal_id;
			}),
		);
		const res = await Promise.all(props.map((pid) => hs.call("POST", `/expansions/${pid}/decision`, { token: rootTok, body: { decision: "APPROVE", reason: "race" } })));
		const codes = res.map((r) => (r.status === 200 ? "OK" : r.body.error.code)).sort();
		assert.deepEqual(codes, ["BUDGET_EXCEEDED", "OK"]);
		const al = sql(hs, "SELECT reserved_slots, limits_json FROM allocations WHERE agent_id = ?", root)[0];
		assert.equal(al.reserved_slots, 3);
		assert.ok(al.reserved_slots <= JSON.parse(al.limits_json).max_subtree_slots);
	} finally {
		await hs.cleanup();
	}
});

test("repeat approval does not double spawn", async () => {
	const hs = await harness();
	try {
		const { root, token: rootTok } = await newRun(hs);
		const t = await ownTask(hs, rootTok, root);
		const p = await hs.call("POST", "/expansions", { token: rootTok, body: proposal(t, [{ count: 2 }]) });
		const body = { decision: "APPROVE", reason: "go" };
		const [r1, r2] = await Promise.all([
			hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: rootTok, key: "same", body }),
			hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: rootTok, key: "same", body }),
		]);
		assert.deepEqual(r1.body, r2.body);
		const r3 = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: rootTok, key: "other", body });
		assert.equal(r3.body.error.code, "CONFLICT");
		await waitFor(() => hs.ex.launches.length >= 2);
		await hs.h.reconciler.idle();
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM spawn_intents")[0].n, 2);
		assert.equal(hs.ex.launches.length, 2);
	} finally {
		await hs.cleanup();
	}
});

test("agent cannot impersonate via body fields; messaging scope and inbox lease/ack", async () => {
	const hs = await harness({ tunables: { claimMs: 100 } });
	try {
		const { run_id, root, token: rootTok } = await newRun(hs);
		const t = await ownTask(hs, rootTok, root);
		const [a, b] = await recruit(hs, rootTok, rootTok, t, [{ count: 2 }]);
		const aTok = hs.ex.tokens.get(a)!;
		// `from` in body is ignored; sender is the token's agent.
		const m = await hs.call("POST", "/messages", { token: aTok, body: { to: root, from: b, type: "question", payload: { q: "?" } } });
		assert.equal(m.status, 200, JSON.stringify(m.body));
		assert.equal(sql(hs, "SELECT sender_id FROM messages WHERE id = ?", m.body.message_id)[0].sender_id, a);
		// requester_id in an expansion body is ignored too.
		const aTask = (await hs.call("GET", "/me", { token: aTok })).body.tasks[0].task_id;
		const px = await hs.call("POST", "/expansions", { token: aTok, body: { ...proposal(aTask, [{}]), requester_id: b, run_id: "run-x" } });
		assert.equal(sql(hs, "SELECT requester_id, run_id FROM proposals WHERE id = ?", px.body.proposal_id)[0].requester_id, a);
		// Sibling (same manager) is a teammate → allowed (cross-team cases: peers.test.ts). Unknown envelope field → invalid.
		assert.equal((await hs.call("POST", "/messages", { token: aTok, body: { to: b, type: "question", payload: {} } })).status, 200);
		assert.equal((await hs.call("POST", "/messages", { token: aTok, body: { to: root, type: "bogus", payload: {} } })).body.error.code, "INVALID");
		assert.equal((await hs.call("POST", "/messages", { token: aTok, body: { to: root, type: "question", payload: {}, admin: true } })).body.error.code, "INVALID");
		// Agent cannot decide its own proposal or act as operator.
		assert.equal((await hs.call("GET", "/runs", { token: aTok })).body.error.code, "FORBIDDEN");
		assert.equal((await hs.call("POST", `/agents/${b}/lifecycle`, { token: aTok, body: { action: "cancel", reason: "x" } })).body.error.code, "FORBIDDEN");
		assert.equal((await hs.call("GET", `/budgets/${b}`, { token: aTok })).body.error.code, "FORBIDDEN");
		// Inbox: claim, lease expiry → redelivery, ack, duplicate ack harmless.
		const inbox1 = (await hs.call("GET", "/inbox", { token: rootTok })).body.messages;
		assert.ok(inbox1.some((x: any) => x.message_id === m.body.message_id));
		assert.equal((await hs.call("GET", "/inbox", { token: rootTok })).body.messages.length, 0, "claimed messages are not redelivered within lease");
		await new Promise((r) => setTimeout(r, 150));
		const inbox2 = (await hs.call("GET", "/inbox", { token: rootTok })).body.messages;
		assert.ok(inbox2.some((x: any) => x.message_id === m.body.message_id), "expired claim redelivered");
		assert.equal((await hs.call("POST", `/messages/${m.body.message_id}/ack`, { token: rootTok })).body.acked, true);
		assert.equal((await hs.call("POST", `/messages/${m.body.message_id}/ack`, { token: rootTok })).body.acked, true);
		assert.equal((await hs.call("POST", `/messages/${m.body.message_id}/ack`, { token: aTok })).body.error.code, "NOT_FOUND");
		await new Promise((r) => setTimeout(r, 150));
		assert.ok(!(await hs.call("GET", "/inbox", { token: rootTok })).body.messages.some((x: any) => x.message_id === m.body.message_id));
		// Tasks: delegate only to direct reports; complete with artifacts inside workspace only.
		const aTokTask = await hs.call("POST", "/tasks", { token: aTok, body: { owner_id: b, title: "x" } });
		assert.equal(aTokTask.body.error.code, "FORBIDDEN");
		const bad = await hs.call("POST", `/tasks/${aTask}/complete`, { token: aTok, body: { summary: "done", artifacts: [{ kind: "file", uri: "../../etc/passwd" }] } });
		assert.equal(bad.body.error.code, "FORBIDDEN");
		const good = await hs.call("POST", `/tasks/${aTask}/complete`, { token: aTok, body: { summary: "done", artifacts: [{ kind: "file", uri: "out/report.md", sha256: "abc" }, { kind: "commit", uri: "git:deadbeef" }] } });
		assert.equal(good.status, 200, JSON.stringify(good.body));
		assert.ok(good.body.message_id);
		assert.equal(sql(hs, "SELECT type FROM messages WHERE id = ?", good.body.message_id)[0].type, "task.completed");
		const evs = (await hs.call("GET", `/events?run_id=${run_id}`, { token: hs.op })).body.events;
		assert.ok(evs.some((e: any) => e.type === "task.completed"));
	} finally {
		await hs.cleanup();
	}
});

test("model constraints: unavailable / unknown preferred model rejected; /models shows eligibility", async () => {
	const hs = await harness();
	try {
		const { root, token: rootTok } = await newRun(hs);
		const t = await ownTask(hs, rootTok, root);
		assert.equal((await hs.call("POST", "/expansions", { token: rootTok, body: proposal(t, [{ preferred_model_id: "offline" }]) })).body.error.code, "INVALID");
		assert.equal((await hs.call("POST", "/expansions", { token: rootTok, body: proposal(t, [{ preferred_model_id: "nope" }]) })).body.error.code, "INVALID");
		assert.equal((await hs.call("POST", "/expansions", { token: rootTok, body: proposal(t, [{ capabilities: ["vision"] }]) })).body.error.code, "INVALID");
		const ms = (await hs.call("GET", "/models", { token: rootTok })).body.models;
		assert.equal(ms.find((m: any) => m.id === "offline").eligible, false);
		assert.equal(ms.find((m: any) => m.id === "leader").eligible, true);
	} finally {
		await hs.cleanup();
	}
});
