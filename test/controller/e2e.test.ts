// End-to-end with real detached worker processes: ScriptExecutor + test/fixtures/fake-worker.ts (no LLM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptExecutor } from "../../src/executor/script.ts";
import { harness, newRun, ownTask, proposal, sql, waitFor } from "./helpers.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-worker.ts", import.meta.url));

test("real worker processes: lead recruits a verifier through review, both complete tasks, cascade cancel stops processes", { timeout: 60_000 }, async () => {
	const ex = new ScriptExecutor(FAKE);
	const hs = await harness({ executor: ex as never, tunables: { tickMs: 100 } });
	const script = join(hs.dir, "script.json");
	writeFileSync(
		script,
		JSON.stringify({
			Lead: [
				{ op: "request_expansion", body: { version: 1, reason: "Verification queue needs an independent checker.", alternatives: "serial", estimated_cost_usd: 0.5, roles: [{ title: "DRC verifier", responsibility: "run checks", count: 1, capabilities: [], max_cost_usd: 0.5 }] } },
				{ op: "wait_children", count: 1 },
				{ op: "complete_task", summary: "lead done" },
			],
			"DRC verifier": [{ op: "complete_task", summary: "no violations" }],
		}),
	);
	const saved = { s: process.env.PI_TEAM_FAKE_SCRIPT, h: process.env.PI_TEAM_FAKE_HEARTBEAT_MS };
	process.env.PI_TEAM_FAKE_SCRIPT = script;
	process.env.PI_TEAM_FAKE_HEARTBEAT_MS = "200";
	try {
		const { run_id, root, token } = await newRun(hs);
		const t = await ownTask(hs, token, root);
		const p = await hs.call("POST", "/expansions", { token, body: proposal(t, [{ title: "Lead", max_cost_usd: 2, capabilities: [] }]) });
		const d = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token, body: { decision: "APPROVE", reason: "go" } });
		assert.equal(d.status, 200, JSON.stringify(d.body));
		const [lead] = d.body.spawned_agent_ids;
		// The lead's own proposal reaches root for review.
		const prop = await waitFor(async () => (await hs.call("GET", "/proposals?scope=review", { token })).body.proposals[0], "lead's proposal", 20_000);
		assert.equal(prop.requester_id, lead);
		const ok = await hs.call("POST", `/expansions/${prop.proposal_id}/decision`, { token, body: { decision: "APPROVE", reason: "fine" } });
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		const [verifier] = ok.body.spawned_agent_ids;
		await waitFor(() => sql(hs, "SELECT COUNT(*) n FROM tasks WHERE owner_id IN (?,?) AND status = 'DONE'", lead, verifier)[0].n === 2, "both tasks DONE", 30_000);
		const live = sql(hs, "SELECT a.id, a.observed_state, s.pid, s.process_started_at, s.enrolled_at FROM agents a JOIN sessions s ON s.id = a.current_session_id WHERE a.id IN (?,?)", lead, verifier);
		for (const r of live) {
			assert.equal(r.observed_state, "LIVE");
			assert.ok(r.enrolled_at);
			assert.equal(await ex.probe({ pid: r.pid, process_started_at: r.process_started_at }), "alive");
		}
		const tree = (await hs.call("GET", `/runs/${run_id}/tree`, { token: hs.op })).body;
		assert.equal(tree.root.children[0].agent_id, lead);
		assert.equal(tree.root.children[0].children[0].agent_id, verifier);
		// task.completed reached the manager's inbox.
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM messages WHERE type = 'task.completed' AND recipient_id = ? AND sender_id = ?", lead, verifier)[0].n, 1);
		// Workers live under the run's workspace root.
		const cwd = sql(hs, "SELECT cwd FROM agents WHERE id = ?", verifier)[0].cwd;
		assert.ok(cwd.includes(join(".team-worktrees", run_id, verifier)), cwd);

		const c = await hs.call("POST", `/agents/${lead}/lifecycle`, { token, body: { action: "cancel", reason: "wrap up", children_policy: "cascade" } });
		assert.equal(c.status, 200, JSON.stringify(c.body));
		for (const r of live) await waitFor(async () => (await ex.probe({ pid: r.pid, process_started_at: r.process_started_at })) === "dead", `pid ${r.pid} stopped`, 15_000);
		await new Promise((r) => setTimeout(r, 300));
		await hs.h.reconciler.idle();
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM sessions WHERE agent_id IN (?,?)", lead, verifier)[0].n, 2, "no relaunch of cancelled agents");
		assert.equal(sql(hs, "SELECT reserved_slots n FROM allocations WHERE agent_id = ?", root)[0].n, 0);
	} finally {
		process.env.PI_TEAM_FAKE_SCRIPT = saved.s;
		process.env.PI_TEAM_FAKE_HEARTBEAT_MS = saved.h;
		if (saved.s === undefined) delete process.env.PI_TEAM_FAKE_SCRIPT;
		if (saved.h === undefined) delete process.env.PI_TEAM_FAKE_HEARTBEAT_MS;
		// Make sure no worker survives the test.
		for (const r of sql(hs, "SELECT pid, process_started_at FROM sessions WHERE pid IS NOT NULL")) await ex.stop({ pid: r.pid, process_started_at: r.process_started_at }, 200).catch(() => {});
		await hs.cleanup();
	}
});
