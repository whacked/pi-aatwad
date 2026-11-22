// A real leader Pi in a plain terminal (a PTY with no multiplexer): recruiting starts members
// in the built-in session host, /team watch focus switches this terminal into a member, and
// /team back typed there returns to the leader, which redraws itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeOpenAI } from "../fixtures/fake-openai.ts";
import { nativeHostSupport, PtydClient } from "../../src/terminal/native/client.ts";
import { defaultExtensionPath } from "../../src/executor/pi.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { waitFor } from "../controller/helpers.ts";

const require = createRequire(import.meta.url);
let piBin = "";
try { piBin = execFileSync("which", ["pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
const skip = !piBin ? "pi not on PATH" : nativeHostSupport() ?? false;
const plain = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g, "");

test("leader in a plain terminal switches into a native member and back", { skip, timeout: 120_000 }, async () => {
	const pty = require("@lydell/node-pty") as typeof import("@lydell/node-pty");
	const fake = await startFakeOpenAI((req) => {
		const all = req.messages.map((m) => m.text).join("\n");
		// A member's first turn carries its bootstrap prompt or, when the inbox wins the race, its task assignment.
		if (/Your assigned task id|\[task\.assigned\]/.test(all)) return { text: "MEMBER-SCREEN-READY" };
		if (all.includes("RECRUIT-ALPHA") && !req.messages.some((m) => m.role === "tool")) return { tool_calls: [{ name: "team_create_member", arguments: { name: "Alpha", responsibility: "Wait for directions" } }] };
		return { text: "LEADER-OK" };
	});
	const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "pt-nla-")));
	const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ptn-")));
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "pt-nlw-")));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fakeoai: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "fake-1" }] } } }));
	const git = (...a: string[]) => execFileSync("git", ["-C", workspace, ...a], { stdio: ["ignore", "pipe", "pipe"] });
	git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
	writeFileSync(join(workspace, "README.md"), "native leader e2e\n"); git("add", "."); git("commit", "-q", "-m", "init");
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(TMUX|TMUX_PANE|HERDR_ENV|REX_.*|PI_TEAM_.*|TERM_PROGRAM.*)$/.test(k)) env[k] = v;
	Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TEAM_STATE_DIR: stateDir, PI_TEAM_EXECUTOR: "pi", PI_TEAM_PI_BIN: piBin, TERM: "xterm-256color" });
	const leader = pty.spawn(piBin, ["--provider", "fakeoai", "--model", "fake-1", "-e", defaultExtensionPath()], { cols: 140, rows: 40, cwd: workspace, env });
	let out = "";
	leader.onData((d) => { out += d; });
	const type = async (text: string, submit = true) => {
		leader.write(text);
		await new Promise((r) => setTimeout(r, 300));
		if (text.startsWith("/")) { leader.write("\x1b"); await new Promise((r) => setTimeout(r, 300)); }
		if (submit) leader.write("\r");
	};
	const host = new PtydClient(stateDir);
	try {
		await waitFor(() => plain(out).length > 0, "leader started", 20000);
		await new Promise((r) => setTimeout(r, 1500));
		await type("/team init");
		await waitFor(() => /new empty team/.test(plain(out)), "team created", 20000).catch((e) => { throw new Error(`${e.message}\n${plain(out).slice(-2000)}`); });
		await type("RECRUIT-ALPHA");
		await waitFor(async () => (await host.running()) && (await host.list()).some((p) => p.alive && /Alpha/.test(p.label)), "member hosted by the built-in host", 30000)
			.catch((e) => { throw new Error(`${e.message}\n${plain(out).slice(-2000)}`); });
		await waitFor(() => fake.requests.some((r) => r.messages.some((m) => /Your assigned task id|\[task\.assigned\]/.test(m.text))), "member's first turn", 30000);
		await waitFor(() => /LEADER-OK/.test(plain(out)), "leader turn settled", 20000);
		await waitFor(() => /team: ● Alpha\s+· \/team watch focus <name> switches/.test(plain(out)), "leader shows its running members", 25000)
			.catch((e) => { throw new Error(`${e.message}\n${plain(out).slice(-2000)}`); });

		const before = out.length;
		await type("/team watch focus Alpha");
		await waitFor(() => out.slice(before).includes("\x1b[?1049h"), "leader handed its terminal to the member (alternate screen)", 15000)
			.catch((e) => { throw new Error(`${e.message}\n${plain(out.slice(before)).slice(-2000)}`); });
		await waitFor(() => /MEMBER-SCREEN-READY/.test(plain(out.slice(before))) && /team member ·/.test(plain(out.slice(before))), "member screen and header visible in the leader's terminal", 15000)
			.catch((e) => { throw new Error(`${e.message}\n${plain(out.slice(before)).slice(-2000)}`); });

		const inMember = out.length;
		await type("/team back");
		await waitFor(() => out.slice(inMember).includes("\x1b[?1049l"), "returned from the member", 15000)
			.catch((e) => { throw new Error(`${e.message}\n${plain(out.slice(inMember)).slice(-2000)}`); });
		await waitFor(() => /Back in the leader from/.test(plain(out.slice(inMember))), "leader redrew and reported the return", 15000)
			.catch((e) => { throw new Error(`${e.message}\n${plain(out.slice(inMember)).slice(-2000)}`); });
		assert.ok((await host.list()).some((p) => p.alive && /Alpha/.test(p.label)), "the member keeps running");

		// The leader is still interactive after the handoff.
		const back = out.length;
		await type("STILL-HERE");
		await waitFor(() => fake.requests.some((r) => r.messages.some((m) => m.text.includes("STILL-HERE"))), "leader accepts input again", 15000)
			.catch((e) => { throw new Error(`${e.message}\n${plain(out.slice(back)).slice(-2000)}`); });
	} finally {
		try { leader.kill(); } catch {}
		await host.request({ op: "shutdown" }).catch(() => {});
		const p = statePaths(stateDir);
		if (existsSync(p.controllerInfo)) { try { process.kill(JSON.parse(readFileSync(p.controllerInfo, "utf8")).pid, "SIGKILL"); } catch {} }
		await fake.close();
		for (const d of [stateDir, workspace, agentDir]) rmSync(d, { recursive: true, force: true });
	}
});
