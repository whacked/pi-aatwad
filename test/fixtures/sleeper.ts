// Test worker for ScriptExecutor tests (no protocol). Behaviour via env:
//   PI_TEAM_FAKE_OUT          file to write {pid, grandchild, env_keys} JSON into
//   PI_TEAM_FAKE_IGNORE_TERM  "1" -> ignore SIGTERM (forces SIGKILL path)
// Spawns one grandchild (`sleep 600`, same process group) and then idles.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.env.PI_TEAM_FAKE_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
const gc = spawn("sleep", ["600"], { stdio: "ignore" });
const out = process.env.PI_TEAM_FAKE_OUT;
if (out) writeFileSync(out, JSON.stringify({ pid: process.pid, grandchild: gc.pid, env_keys: Object.keys(process.env).sort() }));
console.log(`sleeper ${process.pid} up`);
setInterval(() => {}, 1 << 30);
