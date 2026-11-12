import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TerminalAllocationError } from "../../src/watch/terminal-error.ts";
import type { LaunchSpec } from "../../src/executor/types.ts";
import { harness, newRun, waitFor, sql } from "./helpers.ts";

for (const reason of ["zoomed window", "full team region", "split race after preflight"]) {
	test(`allocation fallback (${reason}) reuses enrollment and stays detached across restart`, async () => {
		const hs = await harness({ tunables: { maxLaunchAttempts: 1 } });
		try {
			const { token, run_id } = await newRun(hs, { models: [] });
			const launch = hs.ex.launch.bind(hs.ex);
			const rejected: { spec: LaunchSpec; credential: string }[] = [];
			hs.ex.launch = async (spec) => {
				if (spec.terminal) {
					rejected.push({ spec: { ...spec }, credential: readFileSync(spec.enroll_file, "utf8") });
					throw new TerminalAllocationError(reason);
				}
				return launch(spec);
			};
			await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: {} });
			const made = await hs.call("POST", "/members", { token, body: { name: "Worker", responsibility: "Keep working" } });
			const id = made.body.spawned_agent_ids[0];
			await waitFor(() => hs.ex.tokens.has(id));
			await hs.h.reconciler.idle();
			assert.equal(rejected.length, 1);
			const live = hs.ex.launchesFor(id)[0];
			assert.equal(live.spec.terminal, undefined);
			assert.equal(live.spec.session_id, rejected[0].spec.session_id);
			assert.equal(live.spec.enroll_file, rejected[0].spec.enroll_file);
			assert.equal(live.spec.pi_session_path, rejected[0].spec.pi_session_path);
			assert.deepEqual(live.enrollFile, JSON.parse(rejected[0].credential));
			assert.equal(sql(hs, "SELECT attempts FROM spawn_intents WHERE agent_id=?", id)[0].attempts, 1);
			assert.equal(sql(hs, "SELECT COUNT(*) n FROM events WHERE type IN ('spawn.retry','spawn.failed')")[0].n, 0);
			assert.equal(sql(hs, "SELECT COUNT(*) n FROM enrollment_credentials WHERE agent_id=?", id)[0].n, 1);
			assert.equal(sql(hs, "SELECT COUNT(*) n FROM events WHERE type='run.terminal_fallback'")[0].n, 1);
			const marker = sql(hs, "SELECT process_marker FROM sessions WHERE id=?", live.spec.session_id)[0].process_marker;
			assert.equal(JSON.parse(marker).terminal, false);
			const tasks = sql(hs, "SELECT id FROM tasks WHERE owner_id=?", id);
			await hs.restart({ crash: true });
			await hs.h.reconciler.tick();
			assert.equal(hs.ex.launchesFor(id).length, 1);
			assert.equal(hs.ex.stopped.length, 0);
			const cfg = (await hs.call("GET", `/runs/${run_id}/terminal`, { token: hs.op })).body;
			assert.equal(cfg.enabled, false);
			assert.equal(cfg.auto_open, false);
			// Only a subsequent explicit request promotes; it stops the old writer first.
			hs.ex.launch = launch;
			await hs.call("POST", `/runs/${run_id}/terminal`, { token: hs.op, body: {} });
			await waitFor(() => hs.ex.launchesFor(id).length === 2);
			assert.equal(await hs.ex.probe(live.id), "dead");
			assert.equal(hs.ex.stopped.filter((pid) => pid === live.id.pid).length, 1);
			assert.equal(hs.ex.launchesFor(id)[1].spec.resume, true);
			assert.equal(hs.ex.launchesFor(id)[1].spec.pi_session_path, live.spec.pi_session_path);
			assert.deepEqual(sql(hs, "SELECT id FROM tasks WHERE owner_id=?", id), tasks);
		} finally { await hs.cleanup(); }
	});
}

test("model/auth launch errors are not terminal fallback", async () => {
	const hs = await harness({ tunables: { maxLaunchAttempts: 1 } });
	try {
		const { token, run_id } = await newRun(hs, { models: [] });
		hs.ex.launch = async () => { throw new Error("model authentication rejected"); };
		await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: {} });
		const made = await hs.call("POST", "/members", { token, body: { name: "Worker", responsibility: "Work" } });
		const id = made.body.spawned_agent_ids[0];
		await waitFor(() => sql(hs, "SELECT status FROM agents WHERE id=?", id)[0].status === "FAILED");
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM events WHERE type='run.terminal_fallback'")[0].n, 0);
		assert.equal((await hs.call("GET", `/runs/${run_id}/terminal`, { token })).body.enabled, true);
	} finally { await hs.cleanup(); }
});
