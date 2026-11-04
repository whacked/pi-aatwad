import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentTmuxPane, terminalHost, findExecutable } from "../../src/shared/environment.ts";
import { PiExecutor } from "../../src/executor/pi.ts";
import { tmp, makeSpec } from "./helpers.ts";

test("terminal hosting distinguishes plain SSH, tmux, incomplete markers and Herdr inside outer tmux", () => {
 assert.equal(terminalHost({ SSH_TTY: "/dev/pts/0" }), "plain");
 assert.equal(terminalHost({ TMUX_PANE: "%1" }), "plain");
 assert.equal(terminalHost({ TMUX: "/tmp/mux,1,0", TMUX_PANE: "%1" }), "tmux");
 assert.equal(currentTmuxPane({ HERDR_ENV: "1", TMUX: "/tmp/outer,1,0", TMUX_PANE: "%1" }), undefined);
 assert.equal(terminalHost({ HERDR_ENV: "1", TMUX_PANE: "%1" }), "herdr");
});

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
   assert.match((await executor.terminalProblem(dir, "run", {}))!, /tmux is not installed/);
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

test("an explicit tmux view inside Herdr neither queries outer dimensions nor switches the outer client", async () => {
 const { TmuxWatch } = await import("../../src/watch/tmux.ts");
 const previous = { HERDR_ENV: process.env.HERDR_ENV, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
 const calls: string[][] = [];
 class View extends TmuxWatch {
  async exists() { return false; }
  async tmux(...args: string[]) { calls.push(args); return args[0] === "new-session" ? "%10" : ""; }
  async panes() { return [{ id: "%10", window: "@1", agent: "placeholder", dead: false }]; }
 }
 try {
  process.env.HERDR_ENV = "1"; process.env.TMUX = "/outer,1,0"; process.env.TMUX_PANE = "%2";
  const view = new View({ stateDir: "/tmp", runId: "test-herdr-host" });
  await view.open();
  await view.focus();
  assert.ok(calls.some((c) => c[0] === "new-session"));
  assert.ok(!calls.some((c) => c[0] === "display-message" || c[0] === "switch-client"));
 } finally {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
 }
});
