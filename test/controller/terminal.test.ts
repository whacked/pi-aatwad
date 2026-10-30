import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, waitFor, sql } from "./helpers.ts";

test("terminal promotion preserves identity and tasks, stops old process once, and survives controller restart", async () => {
	const hs = await harness();
	try {
		const { token, run_id } = await newRun(hs, { models: [] });
		const made = await hs.call("POST", "/members", { token, body: { name: "Adjudicator", responsibility: "Review the solution" } });
		const id = made.body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(id));
		const old = hs.ex.launchesFor(id)[0];
		const tasks = sql(hs, "SELECT id FROM tasks WHERE owner_id=?", id).map((t) => t.id);
		assert.equal((await hs.call("POST", `/runs/${run_id}/terminal`, { token: hs.ex.tokens.get(id), body: {} })).body.error.code, "FORBIDDEN");
		assert.equal((await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: {} })).status, 200);
		await waitFor(() => hs.ex.launchesFor(id).length === 2 && hs.ex.launchesFor(id)[1].spec.terminal !== undefined, "interactive relaunch");
		assert.equal(await hs.ex.probe(old.id), "dead");
		assert.equal(hs.ex.stopped.filter((pid) => pid === old.id.pid).length, 1);
		assert.equal(hs.ex.launchesFor(id)[1].spec.resume, true);
		assert.equal(hs.ex.launchesFor(id)[1].spec.pi_session_path, old.spec.pi_session_path);
		assert.deepEqual(sql(hs, "SELECT id FROM tasks WHERE owner_id=?", id).map((t) => t.id), tasks);
		await waitFor(() => sql(hs, "SELECT observed_state FROM agents WHERE id=?", id)[0].observed_state === "LIVE");
		await hs.restart({ crash: true });
		assert.equal((await hs.call("GET", `/runs/${run_id}/terminal`, { token: hs.op })).body.enabled, true);
		await hs.h.reconciler.idle();
		assert.equal(hs.ex.launchesFor(id).length, 2, "no duplicate after restart");
	} finally { await hs.cleanup(); }
});
