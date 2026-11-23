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

test("terminal mode can be disabled without tmux, preserves work, and stays disabled after restart", async () => {
 const hs = await harness();
 try {
  const { token, run_id } = await newRun(hs, { models: [] });
  const made = await hs.call("POST", "/members", { token, body: { name: "Worker", responsibility: "Continue work" } });
  const id = made.body.spawned_agent_ids[0];
  await waitFor(() => hs.ex.tokens.has(id));
  await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: {} });
  await waitFor(() => hs.ex.launchesFor(id).length === 2 && hs.ex.launchesFor(id)[1].spec.terminal !== undefined);
  await waitFor(() => sql(hs, "SELECT observed_state FROM agents WHERE id=?", id)[0].observed_state === "LIVE");
  await hs.h.reconciler.idle();
  const before = hs.ex.launchesFor(id)[1];
  const taskIds = sql(hs, "SELECT id FROM tasks WHERE owner_id = ?", id);
  assert.equal((await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: { enabled: false } })).status, 200);
  await waitFor(() => hs.ex.launchesFor(id).length === 3, "headless relaunch");
  const after = hs.ex.launchesFor(id)[2];
  assert.equal(after.spec.terminal, undefined);
  assert.equal(after.spec.resume, true);
  assert.equal(after.spec.pi_session_path, before.spec.pi_session_path);
  assert.deepEqual(sql(hs, "SELECT id FROM tasks WHERE owner_id = ?", id), taskIds);
  assert.equal(await hs.ex.probe(before.id), "dead");
  await hs.restart({ crash: true });
  const cfg = (await hs.call("GET", `/runs/${run_id}/terminal`, { token: hs.op })).body;
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.auto_open, false);
  assert.equal((await hs.call("POST", `/runs/${run_id}/terminal`, { token: hs.op, body: { enabled: false, socket: "/bad" } })).status, 400);
 } finally { await hs.cleanup(); }
});

test("saved unavailable tmux falls back before launch attempts and existing interactive workers resume headlessly", async () => {
 const hs = await harness();
 const ex = hs.ex as typeof hs.ex & { terminalProblem?: () => Promise<string | undefined> };
 try {
  const { token, run_id, root } = await newRun(hs, { models: [] });
  let problem: string | undefined;
  ex.terminalProblem = async () => problem;
  await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: {} });
  const made = await hs.call("POST", "/members", { token, body: { name: "Worker", responsibility: "Keep working" } });
  const id = made.body.spawned_agent_ids[0];
  await waitFor(() => hs.ex.tokens.has(id));
  assert.ok(hs.ex.launchesFor(id)[0].spec.terminal);
  problem = "tmux is not installed";
  hs.h.reconciler.kick();
  await waitFor(() => hs.ex.launchesFor(id).length === 2, "automatic headless recovery");
  assert.equal(hs.ex.launchesFor(id)[1].spec.terminal, undefined);
  assert.equal(hs.ex.launchesFor(id)[1].spec.resume, true);
  assert.equal(sql(hs, "SELECT status FROM agents WHERE id = ?", id)[0].status, "RUNNING");
  assert.equal(sql(hs, "SELECT COUNT(*) n FROM events WHERE type = 'run.terminal_fallback'")[0].n, 1);
  assert.equal(sql(hs, "SELECT COUNT(*) n FROM events WHERE type = 'spawn.retry'")[0].n, 0);
  const notices = (await hs.call("GET", "/inbox", { token })).body.messages;
  assert.ok(notices.some((m: any) => m.to === root && m.payload.kind === "terminal_fallback"));
  // A new worker starts headlessly on its first attempt even if a stale terminal setting reappears.
  await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: {} });
  const another = await hs.call("POST", "/members", { token, body: { name: "Another", responsibility: "Work" } });
  const next = another.body.spawned_agent_ids[0];
  await waitFor(() => hs.ex.tokens.has(next));
  assert.equal(hs.ex.launchesFor(next).length, 1);
  assert.equal(hs.ex.launchesFor(next)[0].spec.terminal, undefined);
 } finally { await hs.cleanup(); }
});

test("terminal options validate per backend: Rex IDs for Rex, tmux IDs for tmux, a fixed marker for native, debug only in tmux", async () => {
	const hs = await harness();
	try {
		const { token, run_id } = await newRun(hs, { models: [] });
		const post = (body: unknown) => hs.call("POST", `/runs/${run_id}/terminal`, { token, body });
		const rexLocation = { window: "window:01a1fc1c-2d86-7dbf-9051-408df500a6e0", leader: "block:01a1fc1c-2d5d-74ab-97fe-f900d30e3203" };
		assert.equal((await post({ backend: "rex", socket: "unix:///tmp/rex.sock", location: rexLocation })).status, 200);
		const saved = (await hs.call("GET", `/runs/${run_id}/terminal`, { token: hs.op })).body;
		assert.equal(saved.backend, "rex");
		assert.deepEqual(saved.location, rexLocation);
		assert.match((await post({ backend: "rex", location: { window: "@1", leader: "%1" } })).body.error.message, /Rex window\/block/);
		assert.match((await post({ location: rexLocation })).body.error.message, /tmux window\/pane/);
		assert.match((await post({ backend: "rex", location: rexLocation, debug: true })).body.error.message, /only available on tmux/);
		assert.match((await post({ backend: "screen" })).body.error.message, /backend must be one of tmux, rex, native/);
		assert.match((await post({ backend: "native", location: { window: "@1", leader: "%1" } })).body.error.message, /native marker/);
		assert.match((await post({ backend: "native", debug: true })).body.error.message, /only available on tmux/);
		assert.equal((await post({ backend: "native" })).status, 200);
		assert.deepEqual((await hs.call("GET", `/runs/${run_id}/terminal`, { token: hs.op })).body.location, { window: "native", leader: "native" }, "native gets its fixed marker");
		assert.match((await post({ enabled: false, backend: "rex" })).body.error.message, /cannot include terminal options/);
		assert.equal((await post({ location: { window: "@1", leader: "%1" } })).status, 200);
		assert.equal((await hs.call("GET", `/runs/${run_id}/terminal`, { token: hs.op })).body.backend, undefined, "tmux stays the implicit default");
	} finally { await hs.cleanup(); }
});
