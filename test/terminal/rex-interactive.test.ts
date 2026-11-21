// Real Pi members in Rex blocks: requires Rex (this test running in a Rex terminal) and pi on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, newRun, waitFor, sql } from "../controller/helpers.ts";
import { startFakeOpenAI } from "../fixtures/fake-openai.ts";
import { PiExecutor } from "../../src/executor/pi.ts";
import { RexView, rexExecutable } from "../../src/terminal/rex.ts";

const bin = rexExecutable();
const server = process.env.REX_SERVER;
const cliEnv = () => { const env = { ...process.env }; delete env.REX_SESSION; delete env.REX_BLOCK; return env; };
const rex = (...args: string[]) => execFileSync(bin!, ["-S", server!, "--autostart=false", ...args], { encoding: "utf8", timeout: 10000, env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
const available = !!bin && !!server && spawnSync("pi", ["--version"]).status === 0 && (() => { try { rex("whoami", "--json"); return true; } catch { return false; } })();

test("real Pi members run in Rex blocks with a decorated header, keyboard input, crash recovery and close", { skip: !available, timeout: 90000 }, async () => {
	const fake = await startFakeOpenAI((req) => {
		const task = req.messages.map((m) => m.text).join("\n").match(/Your assigned task id: ([^.\s]+)\./)?.[1];
		if (task && !req.messages.some((m) => m.text.includes("team_complete_task"))) return { tool_calls: [{ name: "team_complete_task", arguments: { task_id: task, summary: "Done; waiting" } }] };
		return { text: "REX-INTERACTIVE-ANSWER" };
	});
	const oldDir = process.env.PI_CODING_AGENT_DIR, oldOffline = process.env.PI_OFFLINE;
	const hs = await harness({ executor: new PiExecutor() as any });
	const agentDir = join(hs.dir, "agent-config");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fakeoai: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "fake-1" }] } } }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	const created = JSON.parse(rex("new", `pi-team-test-${process.pid}-pi`, "--json", "--shell=none", "--", "/bin/sleep", "600"));
	const session: string = created.session_id;
	const leader: string = created.initial_windows[0].block_ids[0];
	try {
		const { token, run_id } = await newRun(hs, { limits: { allow_providers: ["fakeoai"] }, models: [{ id: "interactive", provider: "fakeoai", model: "fake-1", capability_tags: ["tools"] }] });
		const view = new RexView({ stateDir: hs.dir, runId: run_id, socket: server });
		await view.open(leader);
		assert.equal((await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: { backend: "rex", socket: server, location: view.opts.location } })).status, 200);
		const made = await hs.call("POST", "/members", { token, body: { name: "Adjudicator", responsibility: "Review and remain available", preferred_model_id: "interactive" } });
		assert.equal(made.status, 200, JSON.stringify(made.body));
		const id = made.body.spawned_agent_ids[0];
		await waitFor(() => sql(hs, "SELECT observed_state FROM agents WHERE id = ?", id)[0]?.observed_state === "LIVE", "interactive enrollment", 20000);
		const block = () => view.panes().then((panes) => panes.find((p) => p.agent === id));
		const member = (await block())!;
		assert.ok(member && !member.dead);
		const capture = async () => rex("capture", "-b", (await block())!.id, "--trim");
		await waitFor(async () => (await capture()).includes("REX-INTERACTIVE-ANSWER"), "visible Pi answer", 20000).catch(async (e) => { throw new Error(`${e.message}\n${await capture()}`); });
		assert.match(await capture(), new RegExp(`Adjudicator\\s+team member · ${id}`), "self-drawn header from the decoration plan");
		assert.equal(JSON.parse(rex("block", "inspect", member.id, "--json")).block.label, `Adjudicator [${id}]`);
		const pid = sql(hs, "SELECT s.pid FROM sessions s JOIN agents a ON a.current_session_id=s.id WHERE a.id=?", id)[0].pid;
		assert.equal(await view.paneProcess(member.id), pid);

		const count = fake.requests.length;
		rex("send", "-b", member.id, "REX-KEYBOARD-FOLLOWUP");
		rex("send-key", "-b", member.id, "enter");
		await waitFor(() => fake.requests.slice(count).some((r) => r.messages.some((m) => m.text.includes("REX-KEYBOARD-FOLLOWUP"))), "typed input reaches Pi", 20000);

		// Unexpected death is repaired in a replacement block on the same transcript.
		process.kill(pid, "SIGTERM");
		await waitFor(async () => {
			const now = await block();
			return !!now && now.id !== member.id && !now.dead;
		}, "member respawned in a replacement block", 20000);
		await hs.call("POST", "/messages", { token, body: { to: id, type: "question", payload: { text: "REX-AFTER-CRASH" } } });
		await waitFor(() => fake.requests.some((r) => r.messages.some((m) => m.text.includes("REX-AFTER-CRASH")) && r.messages.some((m) => m.text.includes("REX-KEYBOARD-FOLLOWUP"))), "restarted member keeps its transcript", 20000);

		await view.focus(id);
		const closed = await hs.call("POST", `/agents/${id}/lifecycle`, { token, body: { action: "cancel", reason: "done", children_policy: "cascade" } });
		assert.equal(closed.status, 200, JSON.stringify(closed.body));
		await waitFor(async () => !(await block()), "closed member block removed", 15000);
		assert.deepEqual((await view.panes()).map((p) => p.agent), ["leader"], "the leader's block is untouched");
	} finally {
		if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
		if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
		try { rex("kill", session); } catch {}
		await hs.cleanup();
		await fake.close();
	}
});
