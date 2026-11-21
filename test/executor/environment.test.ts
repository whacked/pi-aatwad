import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentTmuxPane, currentRexBlock, terminalHost, findExecutable } from "../../src/shared/environment.ts";
import { hostCapabilities, NoSessionHostError } from "../../src/terminal/host.ts";
import { PiExecutor } from "../../src/executor/pi.ts";
import { tmp, makeSpec } from "./helpers.ts";

test("terminal hosting distinguishes plain SSH, tmux, incomplete markers and Herdr inside outer tmux", () => {
 assert.equal(terminalHost({ SSH_TTY: "/dev/pts/0" }), "plain");
 assert.equal(terminalHost({ TMUX_PANE: "%1" }), "plain");
 assert.equal(terminalHost({ TMUX: "/tmp/mux,1,0", TMUX_PANE: "%1" }), "tmux");
 assert.equal(currentTmuxPane({ HERDR_ENV: "1", TMUX: "/tmp/outer,1,0", TMUX_PANE: "%1" }), undefined);
 assert.equal(terminalHost({ HERDR_ENV: "1", TMUX_PANE: "%1" }), "herdr");
});

test("Rex is detected from its markers, tmux inside Rex stays tmux, and tmux and Rex host member sessions", () => {
 const rex = { REX_SERVER: "unix:///tmp/rex.sock", REX_BLOCK: "block:01a1fc1c-2d5d-74ab-97fe-f900d30e3203", REX_SESSION: "session:01" };
 assert.equal(terminalHost(rex), "rex");
 assert.deepEqual(currentRexBlock(rex), { server: rex.REX_SERVER, block: rex.REX_BLOCK, session: "session:01" });
 assert.equal(terminalHost({ REX_BLOCK: rex.REX_BLOCK }), "plain", "a block ID without a server is not a usable host");
 assert.equal(terminalHost({ ...rex, REX_BLOCK: "not-a-block" }), "plain");
 assert.equal(terminalHost({ ...rex, TMUX: "/tmp/mux,1,0", TMUX_PANE: "%3" }), "tmux", "innermost multiplexer wins");
 assert.equal(currentRexBlock({ ...rex, TMUX: "/tmp/mux,1,0", TMUX_PANE: "%3" }), undefined);
 assert.equal(terminalHost({ ...rex, HERDR_ENV: "1" }), "herdr");
 assert.equal(hostCapabilities("tmux").sessions, true);
 assert.equal(hostCapabilities("rex").sessions, true);
 assert.equal(hostCapabilities("rex").decoration, "label", "block labels until Rex ships components");
 for (const kind of ["herdr", "plain"] as const) {
  const caps = hostCapabilities(kind);
  assert.equal(caps.sessions, false, kind);
  assert.match(new NoSessionHostError(caps).message, /members run detached/);
 }
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

test("explicit member panes outside tmux and Rex fail with the host's reason and never start a multiplexer", async () => {
 const { openTerminals } = await import("../../src/extension/terminals.ts");
 const keys = ["HERDR_ENV", "TMUX", "TMUX_PANE", "REX_SERVER", "REX_BLOCK"] as const;
 const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
 let contacted = false;
 const rt = { paths: { dir: "/tmp" }, commandToken: async () => { contacted = true; return "t"; }, client: {} } as any;
 const cases: Array<[Partial<Record<typeof keys[number], string>>, RegExp]> = [
  [{ HERDR_ENV: "1", TMUX: "/outer,1,0", TMUX_PANE: "%2" }, /Herdr/],
  [{}, /no multiplexer/],
 ];
 try {
  for (const [env, reason] of cases) {
   for (const k of keys) delete process.env[k];
   Object.assign(process.env, env);
   await assert.rejects(openTerminals(rt, "run"), (e: Error) => e instanceof NoSessionHostError && reason.test(e.message));
  }
  assert.equal(contacted, false, "rejected before contacting the controller or tmux");
 } finally {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
 }
});
