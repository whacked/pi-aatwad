import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findExecutable } from "../../src/shared/environment.ts";
import { nativeHostSupport } from "../../src/terminal/native/client.ts";
import { PiExecutor } from "../../src/executor/pi.ts";
import { tmp, makeSpec } from "./helpers.ts";

test("executable resolution ignores directories and gives an actionable missing-Pi error", async () => {
 const dir = tmp();
 try {
  mkdirSync(join(dir, "pi"));
  assert.equal(findExecutable("pi", { PATH: dir }), undefined);
  writeFileSync(join(dir, "worker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(findExecutable("worker", { PATH: dir }), join(dir, "worker"));
  await assert.rejects(new PiExecutor({ piBin: join(dir, "missing-pi") }).launch(makeSpec(dir)), /PI_TEAM_PI_BIN.*GUI\/SSH/);
  const env = { ...process.env };
  try {
   process.env.PATH = dir;
   const executor = new PiExecutor({ piBin: process.execPath });
   assert.match((await executor.terminalProblem(dir, "run", {}))!, /detached tmux team sessions are no longer supported/);
   assert.match((await executor.terminalProblem(dir, "run", { location: { window: "@1", leader: "%1" } }))!, /tmux is not installed/);
  } finally { process.env.PATH = env.PATH; }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("detached Pi launch does not need tmux or inherited terminal state", async () => {
 const dir = tmp();
 const previous = process.env.PATH;
 const bin = join(dir, "pi");
 writeFileSync(bin, "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o700 });
 const executor = new PiExecutor({ piBin: bin });
 let id: Awaited<ReturnType<typeof executor.launch>> | undefined;
 try {
  process.env.PATH = dir;
  id = await executor.launch(makeSpec(dir));
  assert.equal(await executor.probe(id), "alive");
 } finally {
  if (id) await executor.stop(id, 500);
  if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
  rmSync(dir, { recursive: true, force: true });
 }
});

test("plain terminals and stale tmux markers open the built-in session host instead of a multiplexer", { skip: !!nativeHostSupport(), timeout: 30000 }, async () => {
 const { openTerminals } = await import("../../src/extension/terminals.ts");
 const { harness, newRun } = await import("../controller/helpers.ts");
 const { TeamClient } = await import("../../src/shared/client.ts");
 const { statePaths } = await import("../../src/shared/paths.ts");
 const { PtydClient } = await import("../../src/terminal/native/client.ts");
 const keys = ["TMUX", "TMUX_PANE", "REX_SERVER", "REX_BLOCK", "PATH"] as const;
 const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
 const hs = await harness();
 try {
  const rt = { paths: statePaths(hs.dir), commandToken: async () => hs.op, client: new TeamClient({ paths: statePaths(hs.dir), noReconnect: true }) } as any;
  for (const env of [{ TMUX: "/outer,1,0", TMUX_PANE: "%2" }, {}]) { // stale markers with no tmux, then a plain terminal
   for (const k of keys) if (k !== "PATH") delete process.env[k];
   Object.assign(process.env, env);
   process.env.PATH = hs.dir; // no tmux or rex can be found or started
   const { run_id } = await newRun(hs);
   const view = await openTerminals(rt, run_id);
   assert.equal(view.backend, "native");
   const saved = (await hs.call("GET", `/runs/${run_id}/terminal`, { token: hs.op })).body;
   assert.equal(saved.backend, "native");
   assert.deepEqual(saved.location, { window: "native", leader: "native" });
   await assert.rejects(view.focus("someone"), /\/team watch focus someone/, "switching needs the leader's terminal");
  }
  assert.equal(await new PtydClient(hs.dir).running(), true);
 } finally {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await new PtydClient(hs.dir).request({ op: "shutdown" }).catch(() => {});
  await hs.cleanup();
 }
});
