// Regression tests for reviewer findings 5, 6, 8 and env tunables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, harness, newRun, ownTask, proposal, recruit, shortStateDir, sql, waitFor, type Harness } from "./helpers.ts";
import { tunablesFromEnv } from "../../src/controller/main.ts";

const tok = (hs: Harness, id: string) => hs.ex.tokens.get(id)!;
const firstTask = async (hs: Harness, id: string) => (await hs.call("GET", "/me", { token: tok(hs, id) })).body.tasks[0].task_id as string;
const tv = (hs: Harness, run: string) => sql(hs, "SELECT topology_version v FROM runs WHERE id = ?", run)[0].v as number;

test("F5: retire/cancel with transfer_children_to is version-checked and recorded per moved child", async () => {
	const hs = await harness();
	try {
		const { run_id, root, token: rt } = await newRun(hs);
		const [M, N] = await recruit(hs, rt, rt, await ownTask(hs, rt, root), [{ count: 2, max_cost_usd: 2 }]);
		const [x, y] = await recruit(hs, tok(hs, M), hs.op, await firstTask(hs, M), [{ count: 2, max_cost_usd: 0.5 }]);
		// Give N room for two reports.
		const tmp = await recruit(hs, tok(hs, N), hs.op, await firstTask(hs, N), [{ count: 2, max_cost_usd: 0.5 }]);
		for (const t of tmp) await hs.call("POST", `/agents/${t}/lifecycle`, { token: rt, body: { action: "cancel", reason: "tmp" } });
		const body = { action: "retire", reason: "reorg", children_policy: "transfer_children_to", transfer_children_to: N };
		assert.equal((await hs.call("POST", `/agents/${M}/lifecycle`, { token: rt, body })).body.error.code, "INVALID");
		const v = tv(hs, run_id);
		assert.equal((await hs.call("POST", `/agents/${M}/lifecycle`, { token: rt, body: { ...body, expected_topology_version: v - 1 } })).body.error.code, "CONFLICT");
		assert.equal(sql(hs, "SELECT status FROM agents WHERE id = ?", M)[0].status, "RUNNING");
		const ok = await hs.call("POST", `/agents/${M}/lifecycle`, { token: rt, key: "retire-M", body: { ...body, expected_topology_version: v } });
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		assert.equal(tv(hs, run_id), v + 1);
		const ops = sql(hs, "SELECT subject_agent_id, from_parent_id, to_parent_id, expected_version, committed_version FROM topology_operations WHERE from_parent_id = ? ORDER BY subject_agent_id", M);
		assert.deepEqual(
			ops.map((o) => ({ ...o })),
			[x, y].sort().map((c) => ({ subject_agent_id: c, from_parent_id: M, to_parent_id: N, expected_version: v, committed_version: v + 1 })),
		);
		// A retire that moves no children needs no version.
		const [leaf] = await recruit(hs, rt, rt, await ownTask(hs, rt, root), [{ max_cost_usd: 0.5 }]);
		assert.equal((await hs.call("POST", `/agents/${leaf}/lifecycle`, { token: rt, body: { action: "retire", reason: "x" } })).status, 200);
	} finally {
		await hs.cleanup();
	}
});

test("F6: legacy max_run_seconds cannot expire a resumed run or its workers", { timeout: 20_000 }, async () => {
	const hs = await harness();
	try {
		const { run_id, root, token: rt } = await newRun(hs, { limits: { max_run_seconds: 1 } });
		const task = await ownTask(hs, rt, root);
		const [a] = await recruit(hs, rt, rt, task, [{}]);
		hs.h.db.prepare("UPDATE runs SET created_at=? WHERE id=?").run("2000-01-01T00:00:00Z", run_id);
		await hs.restart({ crash: true });
		await hs.h.reconciler.idle();
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM events WHERE type IN ('run.wallclock_exceeded', 'agent.deadline_exceeded') AND run_id=?", run_id)[0].n, 0);
		assert.equal(sql(hs, "SELECT desired_state FROM agents WHERE id=?", a)[0].desired_state, "RUNNING");
		const p = await hs.call("POST", "/expansions", { token: rt, body: proposal(task, [{}]) });
		const d = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: rt, body: { decision: "APPROVE", reason: "late" } });
		assert.equal(d.status, 200, JSON.stringify(d.body));
		assert.equal(d.body.spawned_agent_ids.length, 1);
	} finally {
		await hs.cleanup();
	}
});

test("F8: a fenced controller refuses mutations (INTERNAL) and shuts down", async () => {
	const hs = await harness();
	try {
		const { root, token: rt } = await newRun(hs);
		// Another controller took over the DB lease.
		hs.h.db.prepare("UPDATE controller_lease SET controller_id = 'ctl-other', fencing_epoch = fencing_epoch + 1").run();
		const r = await hs.call("POST", "/tasks", { token: rt, body: { owner_id: root, title: "x" } });
		assert.equal(r.status, 500);
		assert.equal(r.body.error.code, "INTERNAL");
		assert.match(r.body.error.message, /fenced/);
		await waitFor(async () => (await hs.call("GET", "/health").catch(() => null)) === null, "listener closed");
		const db = new DatabaseSync(join(hs.dir, "org.sqlite"));
		assert.equal((db.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n, 0, "nothing written");
		assert.match(readFileSync(join(hs.dir, "controller.log"), "utf8"), /fenced/);
		db.close();
	} finally {
		await hs.cleanup();
	}
});

test("env tunables: parsed by main.ts; PI_TEAM_CLAIM_MS drives fast claim-expiry redelivery in a real controller process", { timeout: 30_000 }, async () => {
	assert.deepEqual(tunablesFromEnv({ PI_TEAM_CLAIM_MS: "150", PI_TEAM_HEARTBEAT_LEASE_MS: "2000", PI_TEAM_TICK_MS: "50", PI_TEAM_MAX_RESTARTS: "5", PI_TEAM_HUNG_MS: "nope" }), { claimMs: 150, leaseMs: 2000, tickMs: 50, maxRestarts: 5 });
	const dir = shortStateDir();
	const main = fileURLToPath(new URL("../../src/controller/main.ts", import.meta.url));
	const p = spawn(process.execPath, [main], { env: { ...process.env, PI_TEAM_STATE_DIR: dir, PI_TEAM_CLAIM_MS: "150", PI_TEAM_IDLE_MS: "600000" }, stdio: "ignore" });
	const sock = join(dir, "c.sock");
	try {
		await waitFor(async () => (await api(sock, "GET", "/health").catch(() => null))?.body?.ok, "health", 15_000);
		const op = readFileSync(join(dir, "operator.token"), "utf8").trim();
		const run = (await api(sock, "POST", "/runs", { token: op, body: { root: { role: "root", cwd: dir } } })).body;
		const m = (await api(sock, "POST", "/messages", { token: run.token, body: { to: run.root_agent_id, type: "system.notice", payload: {} } })).body;
		const first = (await api(sock, "GET", "/inbox", { token: run.token })).body.messages.map((x: any) => x.message_id);
		assert.ok(first.includes(m.message_id));
		assert.equal((await api(sock, "GET", "/inbox", { token: run.token })).body.messages.length, 0);
		await new Promise((r) => setTimeout(r, 250));
		assert.ok((await api(sock, "GET", "/inbox", { token: run.token })).body.messages.some((x: any) => x.message_id === m.message_id), "redelivered after 150ms claim lease");
	} finally {
		p.kill("SIGTERM");
		await new Promise((r) => p.on("exit", r));
		rmSync(dir, { recursive: true, force: true });
	}
});
