import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../../src/cli/main.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { harness, newRun, sql, waitFor } from "../controller/helpers.ts";

const ok = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test("pi-team lists every team with folder and leader state, finds orphans, and stops, resumes and removes", async () => {
	const h = await harness();
	try {
		const led = await newRun(h), orphan = await newRun(h);
		ok(await h.call("POST", `/runs/${orphan.run_id}/settings`, { token: orphan.token, body: { name: "Forgotten" } }));
		const member = ok(await h.call("POST", "/members", { token: orphan.token, body: { name: "Worker", responsibility: "Work" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member));
		await h.call("POST", "/sessions/heartbeat", { token: h.ex.tokens.get(member)!, body: { busy: true } });
		await h.call("POST", "/sessions/heartbeat", { token: led.token, body: {} });
		// The orphan's leader session went away.
		h.h.db.prepare("UPDATE agents SET observed_state = 'LOST' WHERE id = ?").run(orphan.root);

		const lines: string[] = [];
		const cli = async (...args: string[]) => { lines.length = 0; const code = await run(args, { paths: statePaths(h.dir), out: (s) => lines.push(s) }); return { code, text: lines.join("\n") }; };
		const teams = await cli("teams");
		assert.equal(teams.code, 0);
		assert.match(teams.text, new RegExp(`${orphan.run_id}\\n    Forgotten \\[running\\] · .+ · 1/1 live .* · no leader session`));
		assert.match(teams.text, new RegExp(`${led.run_id}\\n    .+ · leader open`));

		const orphans = await cli("orphans");
		assert.match(orphans.text, new RegExp(orphan.run_id));
		assert.doesNotMatch(orphans.text, new RegExp(led.run_id));

		assert.match((await cli("stop", orphan.run_id)).text, /: STOPPED|: CLEANING/);
		await waitFor(() => JSON.parse(sql(h, "SELECT config_json FROM runs WHERE id = ?", orphan.run_id)[0].config_json).team_lifecycle?.state === "STOPPED");
		assert.match((await cli("orphans")).text, /No orphaned teams/);
		assert.match((await cli("resume", orphan.run_id)).text, /RESUMED/);
		assert.equal((await cli("remove", orphan.run_id)).code, 1, "remove asks for --yes");
		assert.match((await cli("remove", orphan.run_id, "--yes")).text, /REMOVED/);
		assert.match((await cli("tree", led.run_id)).text, /root \[/);
		assert.equal((await cli("bogus")).code, 2);
	} finally { await h.cleanup(); }
});
