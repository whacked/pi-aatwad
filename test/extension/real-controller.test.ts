// Real Pi + REAL controller (src/controller/main.ts), auto-started by the extension via ensureController().
// Isolated PI_CODING_AGENT_DIR + PI_TEAM_STATE_DIR; --offline --no-session; no LLM needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_ENROLL_FILE } from "../../src/shared/protocol.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { ping } from "../../src/shared/client.ts";
import { shortTmp } from "./helpers.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = join(ROOT, "src", "extension", "index.ts");
const havePi = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;
const haveController = existsSync(join(ROOT, "src", "controller", "main.ts"));
const skip = !havePi ? "pi not on PATH" : !haveController ? "controller not present" : false;

test("real Pi + real controller: /team init auto-starts the controller; status/tree/budget/events/proposals work", { skip, timeout: 60_000 }, async () => {
	const root = shortTmp("prc-");
	const stateDir = join(root, "s");
	const agentDir = join(root, "a");
	mkdirSync(agentDir, { recursive: true });
	const child = spawn("pi", ["--mode", "rpc", "--offline", "--no-session", "-ne", "-e", EXT], {
		cwd: ROOT,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TEAM_STATE_DIR: stateDir, PI_OFFLINE: "1", [ENV_ENROLL_FILE]: undefined },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const notes: { message: string; notifyType?: string }[] = [];
	let buf = "";
	let stderr = "";
	child.stdout.on("data", (d: Buffer) => {
		buf += d.toString("utf8");
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			try {
				const r = JSON.parse(line);
				if (r.type === "extension_ui_request" && r.method === "notify") notes.push(r);
			} catch {}
		}
	});
	child.stderr.on("data", (d: Buffer) => (stderr += d));
	const waitNote = async (re: RegExp, ms = 20_000) => {
		const end = Date.now() + ms;
		for (;;) {
			const n = notes.find((x) => re.test(x.message));
			if (n) return n;
			if (Date.now() > end) throw new Error(`timeout waiting for ${re}; notes=${JSON.stringify(notes)} stderr=${stderr}`);
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	const cmd = async (c: string, re: RegExp) => {
		child.stdin.write(JSON.stringify({ type: "prompt", message: `/team ${c}` }) + "\n");
		return waitNote(re);
	};
	let controllerPid: number | undefined;
	try {
		const init = await cmd("init", /team run \S+ created|\/team init:/);
		assert.match(init.message, /created \(controller started\); you are root agent/, init.message);
		const runId = /team run (\S+) created/.exec(init.message)![1];
		const agentId = /root agent (\S+)\./.exec(init.message)![1];
		const h = await ping(statePaths(stateDir));
		controllerPid = h.pid;
		assert.notEqual(h.pid, child.pid, "controller is a separate process");

		const st = await cmd("status", /^controller:/);
		assert.match(st.message, /controller: up .*schema 3/);
		assert.match(st.message, new RegExp(`identity: root ${agentId} · run ${runId}`));
		assert.match((await cmd("tree", /topology v\d+/)).message, new RegExp(`root \\[${agentId}\\].*← you`));
		assert.match((await cmd("budget", /^budget for/)).message, /available \$/);
		assert.match((await cmd("events", /run\.created/)).message, /agent\.created/);
		assert.match((await cmd("proposals", /to review \(0\)/)).message, /mine \(0\)/);
		assert.match((await cmd(`inspect ${agentId}`, /parent: \(root\)|\/team inspect:/)).message, /sessions \(\d+\)/);
		assert.match((await cmd("inspect nobody", /\/team inspect: NOT_FOUND/)).message, /NOT_FOUND/);
		assert.ok(!notes.some((n) => n.notifyType === "error" && !/NOT_FOUND/.test(n.message)), JSON.stringify(notes.filter((n) => n.notifyType === "error")));
		assert.ok(existsSync(join(stateDir, "operator.token")));
	} finally {
		child.stdin.end();
		const k = setTimeout(() => child.kill("SIGTERM"), 3_000);
		await new Promise((r) => child.on("exit", r));
		clearTimeout(k);
		// Root Pi exiting must not take the controller down.
		if (controllerPid) {
			let alive = true;
			try {
				process.kill(controllerPid, 0);
			} catch {
				alive = false;
			}
			assert.ok(alive, "controller survives root Pi exit");
			process.kill(controllerPid, "SIGTERM");
			for (let i = 0; i < 50; i++) {
				try {
					process.kill(controllerPid, 0);
				} catch {
					break;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		if (!process.env.KEEP_TMP) rmSync(root, { recursive: true, force: true });
		else console.log("state kept at", root, readFileSync(join(stateDir, "controller.log"), "utf8").slice(-500));
	}
});
