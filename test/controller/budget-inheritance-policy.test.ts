import { test } from "node:test";
import assert from "node:assert/strict";
import { ownBudgetUsd } from "../../src/controller/budgets.ts";
import { ApiErr } from "../../src/controller/errors.ts";
import { harness, newRun, ownTask, recruit, sql, type Harness } from "./helpers.ts";

function patchMetadata(hs: Harness, id: string, patch: Record<string, unknown>): void {
	const meta = JSON.parse(sql(hs, "SELECT metadata_json FROM agents WHERE id=?", id)[0].metadata_json);
	hs.h.db.prepare("UPDATE agents SET metadata_json=? WHERE id=?").run(JSON.stringify({ ...meta, ...patch }), id);
}

async function children(hs: Harness, lead: string, reviewer: string, roles: Parameters<typeof recruit>[4]) {
	const token = hs.ex.tokens.get(lead)!;
	const task = (await hs.call("GET", "/me", { token })).body.tasks[0].task_id;
	return recruit(hs, token, reviewer, task, roles);
}

async function view(hs: Harness, id: string, token: string) {
	const r = await hs.call("GET", `/budgets/${id}`, { token });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return r.body;
}

test("default recursive recruitment remains unbounded and shares the recruiting lead's pool", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		let lead = root;
		let reviewer = token;
		for (let depth = 0; depth < 3; depth++) {
			const leadToken = lead === root ? token : hs.ex.tokens.get(lead)!;
			const task = await ownTask(hs, leadToken, lead);
			const ids = await recruit(hs, leadToken, reviewer, task, [{ count: 2, max_cost_usd: undefined }]);
			for (const id of ids) {
				const budget = await view(hs, id, token);
				assert.equal(budget.own_budget_usd, null);
				assert.equal(budget.budget_pool_id, root);
				assert.equal(budget.limits.max_subtree_usd, null);
			}
			reviewer = leadToken;
			lead = ids[0];
		}
		assert.ok(sql(hs, "SELECT usd FROM reservations WHERE state='ACTIVE'").every((r) => r.usd === 0));
		const usage = await hs.call("POST", "/sessions/usage", { token: hs.ex.tokens.get(lead)!, body: { cost_usd: 30 } });
		assert.equal(usage.status, 200);
		assert.equal(usage.body.budget_exhausted, false, "no historical $20/$25 default cap");
	} finally { await hs.cleanup(); }
});

test("distinct explicit lead pools pass their own ceilings to inherited children", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const leads = await recruit(hs, token, token, await ownTask(hs, token, root), [{ max_cost_usd: 5 }, { max_cost_usd: 9 }]);
		for (const [i, lead] of leads.entries()) {
			const ids = await children(hs, lead, token, [{ count: 2, max_cost_usd: undefined }]);
			for (const id of ids) {
				const budget = await view(hs, id, token);
				assert.equal(budget.own_budget_usd, [5, 9][i]);
				assert.equal(budget.budget_pool_id, lead);
				assert.ok(sql(hs, "SELECT usd FROM reservations WHERE beneficiary_id=? AND state='ACTIVE'", id).every((r) => r.usd === 0));
			}
		}
		assert.equal((await view(hs, root, token)).reserved_usd, 14, "inherited siblings do not multiply explicit reservations");
	} finally { await hs.cleanup(); }
});

test("nested explicit pools isolate inherited descendants from enclosing pool changes and usage", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const [lead] = await recruit(hs, token, token, await ownTask(hs, token, root), [{ max_cost_usd: 12 }]);
		const [inherited, nested] = await children(hs, lead, token, [{ max_cost_usd: undefined }, { max_cost_usd: 3 }]);
		const [leaf] = await children(hs, nested, hs.ex.tokens.get(lead)!, [{ max_cost_usd: undefined }]);
		const changed = await hs.call("POST", `/budgets/${lead}`, { token, body: { max_cost_usd: 15 } });
		assert.equal(changed.status, 200, JSON.stringify(changed.body));
		assert.equal((await view(hs, inherited, token)).own_budget_usd, 15);
		assert.equal((await view(hs, leaf, token)).own_budget_usd, 3);
		assert.equal((await view(hs, leaf, token)).budget_pool_id, nested);
		const usage = await hs.call("POST", "/sessions/usage", { token: hs.ex.tokens.get(leaf)!, body: { cost_usd: 3 } });
		assert.equal(usage.status, 200);
		assert.equal(usage.body.budget_exhausted, true);
		assert.equal((await view(hs, lead, token)).pool_consumed_usd, 0);
		assert.equal((await view(hs, nested, token)).pool_consumed_usd, 3);
	} finally { await hs.cleanup(); }
});

test("an authoritative unbounded source never revives finite inherited snapshots", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const [lead] = await recruit(hs, token, token, await ownTask(hs, token, root), [{ max_cost_usd: 5 }]);
		const [child] = await children(hs, lead, token, [{ max_cost_usd: undefined }]);
		const [leaf] = await children(hs, child, hs.ex.tokens.get(lead)!, [{ max_cost_usd: undefined }]);
		assert.equal(ownBudgetUsd(hs.h.db, leaf), 5);
		// Test-only policy change: do not add a live repair/migration API or rewrite reservations.
		patchMetadata(hs, lead, { own_budget_usd: null });
		// Also exercise a chain of inherited references, not only flattened recruitment metadata.
		patchMetadata(hs, leaf, { budget_pool_id: child });
		assert.equal(ownBudgetUsd(hs.h.db, lead), null);
		assert.equal(ownBudgetUsd(hs.h.db, child), null);
		assert.equal(ownBudgetUsd(hs.h.db, leaf), null);
		assert.equal((await view(hs, child, token)).own_budget_usd, null);
		const usage = await hs.call("POST", "/sessions/usage", { token: hs.ex.tokens.get(child)!, body: { cost_usd: 6 } });
		assert.equal(usage.status, 200);
		assert.equal(usage.body.budget_exhausted, false, "the stale $5 snapshot does not pause an unbounded member");
		assert.equal(JSON.parse(sql(hs, "SELECT metadata_json FROM agents WHERE id=?", child)[0].metadata_json).own_budget_usd, 5);
		assert.equal(sql(hs, "SELECT usd FROM reservations WHERE beneficiary_id=? AND state='ACTIVE'", lead)[0].usd, 5);
	} finally { await hs.cleanup(); }
});

test("a root without an own-budget field supplies its current envelope, not a child's snapshot", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs, { root_envelope: { max_subtree_usd: 25 } });
		const [child] = await recruit(hs, token, token, await ownTask(hs, token, root), [{ max_cost_usd: undefined }]);
		assert.equal(ownBudgetUsd(hs.h.db, child), 25, "explicit root envelopes remain effective");
		const limits = JSON.parse(sql(hs, "SELECT limits_json FROM allocations WHERE agent_id=?", root)[0].limits_json);
		hs.h.db.prepare("UPDATE allocations SET limits_json=? WHERE agent_id=?").run(JSON.stringify({ ...limits, max_subtree_usd: null }), root);
		assert.equal(ownBudgetUsd(hs.h.db, child), null);
	} finally { await hs.cleanup(); }
});

test("legacy explicit budgets still prefer active reservations and retain intentional finite caps", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const [lead] = await recruit(hs, token, token, await ownTask(hs, token, root), [{ max_cost_usd: 20 }]);
		// Pre-pool metadata used reservations as the authoritative explicit ceiling.
		hs.h.db.prepare("UPDATE agents SET metadata_json=? WHERE id=?").run(JSON.stringify({ own_budget_usd: 25 }), lead);
		assert.equal(ownBudgetUsd(hs.h.db, lead), 20);
		hs.h.db.prepare("UPDATE reservations SET state='RELEASED' WHERE beneficiary_id=?").run(lead);
		assert.equal(ownBudgetUsd(hs.h.db, lead), 25);
	} finally { await hs.cleanup(); }
});

test("corrupt, missing, cyclic and foreign budget sources fail closed without recursive overflow", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const foreign = await newRun(hs);
		const [a, b] = await recruit(hs, token, token, await ownTask(hs, token, root), [{ count: 2, max_cost_usd: undefined }]);
		const closed = () => assert.throws(() => ownBudgetUsd(hs.h.db, a), (e: unknown) => e instanceof ApiErr && e.code === "INTERNAL");
		for (const target of ["missing-pool", foreign.root, a, "", 42, null]) {
			patchMetadata(hs, a, { budget_pool_id: target });
			closed();
		}
		patchMetadata(hs, a, { budget_pool_id: b });
		patchMetadata(hs, b, { budget_pool_id: a });
		closed();
		patchMetadata(hs, b, { budget_inherited: false, own_budget_usd: "unbounded" });
		closed();
		for (const metadata of ["{", "null", "[]"]) {
			hs.h.db.prepare("UPDATE agents SET metadata_json=? WHERE id=?").run(metadata, b);
			closed();
		}
		assert.throws(() => ownBudgetUsd(hs.h.db, "missing-agent"), (e: unknown) => e instanceof ApiErr && e.code === "INTERNAL");
	} finally { await hs.cleanup(); }
});
