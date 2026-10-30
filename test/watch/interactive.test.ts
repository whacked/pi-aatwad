import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { harness, newRun, waitFor, sql } from "../controller/helpers.ts";
import { startFakeOpenAI } from "../fixtures/fake-openai.ts";
import { PiExecutor } from "../../src/executor/pi.ts";
import { TmuxWatch } from "../../src/watch/tmux.ts";

const available = spawnSync("tmux", ["-V"]).status === 0 && spawnSync("pi", ["--version"]).status === 0;
test("real interactive Pi pane accepts keyboard input and leader assignments without respawning", { skip: !available, timeout: 60000 }, async () => {
	const fake = await startFakeOpenAI(() => ({ text: "INTERACTIVE-ANSWER" }));
	const oldDir = process.env.PI_CODING_AGENT_DIR;
	const oldOffline = process.env.PI_OFFLINE;
	const hs = await harness({ executor: new PiExecutor() as any });
	const agentDir = join(hs.dir, "agent-config");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fakeoai: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "fake-1" }] } } }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	let view: TmuxWatch | undefined;
	try {
		const { token, run_id } = await newRun(hs, { limits: { allow_providers: ["fakeoai"] }, models: [{ id: "interactive", provider: "fakeoai", model: "fake-1", capability_tags: ["tools"] }] });
		view = new TmuxWatch({ stateDir: hs.dir, runId: run_id, socket: join(hs.dir, "tmux.sock") });
		const leader = await view.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "existing-session", "-x", "160", "-y", "50", "/bin/sh");
		await view.open(leader);
		const enabled = await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: { socket: view.opts.socket, location: view.opts.location } });
		assert.equal(enabled.status, 200);
		const created = await hs.call("POST", "/members", { token, body: { name: "Adjudicator", responsibility: "Review the proposed changes and remain available", preferred_model_id: "interactive", max_runtime_seconds: 120 } });
		assert.equal(created.status, 200, JSON.stringify(created.body));
		const id = created.body.spawned_agent_ids[0];
		await waitFor(() => sql(hs, "SELECT observed_state FROM agents WHERE id = ?", id)[0]?.observed_state === "LIVE", "interactive enrollment", 15000);
		await waitFor(() => fake.requests.length > 0, "initial model turn", 15000);
		const session = sql(hs, "SELECT s.* FROM sessions s JOIN agents a ON a.current_session_id=s.id WHERE a.id=?", id)[0];
		const pane = (await view.panes()).find((p) => p.agent === id)!;
		assert.ok(pane);
		assert.equal(pane.window, view.opts.location!.window);
		assert.equal((await view.tmux("list-sessions", "-F", "#{session_name}")).trim(), "existing-session");
		const capture = () => view!.tmux("capture-pane", "-p", "-t", pane.id);
		await waitFor(async () => (await capture()).includes("INTERACTIVE-ANSWER"), "visible Pi answer", 15000);
		assert.equal(Number(await view.tmux("display-message", "-p", "-t", pane.id, "#{pane_pid}")), session.pid);
		assert.equal(execFileSync("ps", ["-o", "pgid=", "-p", String(session.pid)], { encoding: "utf8" }).trim(), String(session.pid));
		const count = fake.requests.length;
		await view.tmux("send-keys", "-t", pane.id, "-l", "KEYBOARD-FOLLOWUP");
		await view.tmux("send-keys", "-t", pane.id, "Enter");
		await waitFor(() => fake.requests.slice(count).some((r) => r.messages.some((m) => m.text.includes("KEYBOARD-FOLLOWUP"))), "typed input reaches Pi", 15000);
		await hs.restart({ crash: true });
		await hs.call("POST", "/messages", { token, body: { to: id, type: "question", payload: { text: "LEADER-FOLLOWUP" } } });
		await waitFor(() => fake.requests.some((r) => r.messages.some((m) => m.text.includes("LEADER-FOLLOWUP"))), "leader message starts a new turn", 20000);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM sessions WHERE agent_id=?", id)[0].n, 1);
		assert.equal(await hs.ex.probe({ pid: session.pid, process_started_at: session.process_started_at }), "alive");
		assert.equal(existsSync(join(hs.dir, "enroll", `${session.spawn_intent_id}.1.json.terminal.sh`)), false);
		await view.close();
		assert.equal(await hs.ex.probe({ pid: session.pid, process_started_at: session.process_started_at }), "alive", "detach keeps Pi alive");
		const stopped = await hs.call("POST", `/agents/${id}/lifecycle`, { token, body: { action: "cancel", reason: "test cleanup", children_policy: "cascade" } });
		assert.equal(stopped.status, 200);
		await waitFor(async () => await hs.ex.probe({ pid: session.pid, process_started_at: session.process_started_at }) === "dead", "controller stops interactive Pi", 10000);
	} finally {
		if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
		if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
		try { await view?.tmux("kill-server"); } catch {}
		await hs.cleanup();
		await fake.close();
	}
});
