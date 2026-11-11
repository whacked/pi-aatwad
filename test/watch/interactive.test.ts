import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { harness, newRun, waitFor, sql } from "../controller/helpers.ts";
import { startFakeOpenAI } from "../fixtures/fake-openai.ts";
import { PiExecutor } from "../../src/executor/pi.ts";
import { registerTools } from "../../src/extension/tools.ts";
import { TeamClient } from "../../src/shared/client.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { TmuxWatch } from "../../src/watch/tmux.ts";

const available = spawnSync("tmux", ["-V"]).status === 0 && spawnSync("pi", ["--version"]).status === 0;
for (const inPlace of [true, false]) test(`real Pi ${inPlace ? "in-place" : "dedicated"} panes support names, input, close and replacement`, { skip: !available, timeout: 60000 }, async () => {
	const completed = new Set<string>();
	const fake = await startFakeOpenAI((req) => {
		const task = req.messages.map((m) => m.text).join("\n").match(/Your assigned task id: ([^.\s]+)\./)?.[1];
		if (task && !completed.has(task)) {
			completed.add(task);
			return { tool_calls: [{ name: "team_complete_task", arguments: { task_id: task, summary: "Work finished; waiting for another assignment" } }] };
		}
		return { text: "INTERACTIVE-ANSWER" };
	});
	const oldDir = process.env.PI_CODING_AGENT_DIR;
	const oldOffline = process.env.PI_OFFLINE;
	const hs = await harness({ executor: new PiExecutor() as any });
	const agentDir = join(hs.dir, "agent-config");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fakeoai: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "fake-1" }, { id: "fake-2" }] } } }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	let view: TmuxWatch | undefined;
	try {
		const { token, run_id } = await newRun(hs, { limits: { allow_providers: ["fakeoai"] }, models: [{ id: "interactive", provider: "fakeoai", model: "fake-1", capability_tags: ["tools"] }] });
		view = new TmuxWatch({ stateDir: hs.dir, runId: run_id, socket: join(hs.dir, "tmux.sock") });
		if (inPlace) {
			const leader = await view.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "existing-session", "-x", "160", "-y", "50", "/bin/sh");
			await view.open(leader);
		} else await view.open();
		const enabled = await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: { socket: view.opts.socket, location: view.opts.location } });
		assert.equal(enabled.status, 200);
		const created = await hs.call("POST", "/members", { token, body: { name: "Adjudicator", responsibility: "Review the proposed changes and remain available", preferred_model_id: "interactive" } });
		assert.equal(created.status, 200, JSON.stringify(created.body));
		const id = created.body.spawned_agent_ids[0];
		await waitFor(() => sql(hs, "SELECT observed_state FROM agents WHERE id = ?", id)[0]?.observed_state === "LIVE", "interactive enrollment", 15000);
		await waitFor(() => fake.requests.length > 0, "initial model turn", 15000);
		const session = sql(hs, "SELECT s.* FROM sessions s JOIN agents a ON a.current_session_id=s.id WHERE a.id=?", id)[0];
		const pane = (await view.panes()).find((p) => p.agent === id)!;
		assert.ok(pane);
		assert.equal((await view.panes()).length, inPlace ? 2 : 1, "only live harnesses, no control UI");
		if (inPlace) assert.equal(pane.window, view.opts.location!.window);
		assert.equal((await view.tmux("list-sessions", "-F", "#{session_name}")).trim(), inPlace ? "existing-session" : view.name);
		const capture = () => view!.tmux("capture-pane", "-p", "-t", pane.id);
		await waitFor(async () => (await capture()).includes("INTERACTIVE-ANSWER"), "visible Pi answer", 15000);
		await waitFor(() => sql(hs, "SELECT status FROM tasks WHERE owner_id=?", id)[0]?.status === "DONE", "worker really completes its assigned task");
		// Simulate more idle time than the removed 600/3600s defaults without waiting an hour.
		hs.h.db.prepare("UPDATE sessions SET started_at=? WHERE id=?").run(new Date(Date.now() - 7200_000).toISOString(), session.id);
		await hs.h.reconciler.enforceDeadlines();
		assert.equal((await view.panes()).find((p) => p.agent === id)?.dead, false, "completion leaves a live Pi prompt");
		assert.equal(Number(await view.tmux("display-message", "-p", "-t", pane.id, "#{pane_pid}")), session.pid);
		assert.equal(execFileSync("ps", ["-o", "pgid=", "-p", String(session.pid)], { encoding: "utf8" }).trim(), String(session.pid));
		await waitFor(async () => (await view!.tmux("display-message", "-p", "-t", pane.id, "#{pane_title}")).includes("Adjudicator"), "member pane uses assigned name", 5000);
		assert.ok(fake.requests[0].tools.includes("team_close_member"), "real Pi exposes the close tool to models");
		const count = fake.requests.length;
		await view.tmux("send-keys", "-t", pane.id, "-l", "KEYBOARD-FOLLOWUP");
		await view.tmux("send-keys", "-t", pane.id, "Enter");
		await waitFor(() => fake.requests.slice(count).some((r) => r.messages.some((m) => m.text.includes("KEYBOARD-FOLLOWUP"))), "typed input reaches Pi", 15000);
		if (inPlace) {
			const requested = await hs.call("POST", `/agents/${id}/model`, { token, body: { model: { id: "fakeoai/fake-2", provider: "fakeoai", model: "fake-2", capability_tags: ["tools"] } } });
			assert.equal(requested.status, 200, JSON.stringify(requested.body));
			await waitFor(() => !JSON.parse(sql(hs, "SELECT metadata_json FROM agents WHERE id=?", id)[0].metadata_json).model_change, "leader model switch applied in Pi", 20000).catch(async (e) => { throw new Error(`${e.message}\n${await capture()}\n${JSON.stringify(sql(hs, "SELECT metadata_json, last_heartbeat_at FROM agents WHERE id=?", id))}`); });
			await view.tmux("send-keys", "-t", pane.id, "-l", "SWITCHED-MODEL-FOLLOWUP");
			await view.tmux("send-keys", "-t", pane.id, "Enter");
			await waitFor(() => fake.requests.some((r) => r.model === "fake-2" && r.messages.some((m) => m.text.includes("SWITCHED-MODEL-FOLLOWUP")) && r.messages.some((m) => m.text.includes("KEYBOARD-FOLLOWUP"))), "new model retains transcript", 10000);
			await waitFor(async () => /SWITCHED-MODEL-FOLLOWUP[\s\S]*INTERACTIVE-ANSWER/.test(await capture()), "new answer", 5000);
			await view.tmux("send-keys", "-t", pane.id, "-l", "/model fakeoai/fake-1");
			await waitFor(async () => (await capture()).includes("/model fakeoai/fake-1"), "model command rendered");
			await view.tmux("send-keys", "-t", pane.id, "Escape");
			await view.tmux("send-keys", "-t", pane.id, "Enter");
			await waitFor(() => sql(hs, "SELECT model FROM agents WHERE id=?", id)[0].model === "fake-1", "pane /model persisted", 10000).catch(async (e) => { throw new Error(`${e.message}\n${await capture()}`); });
			assert.equal(Number(await view.tmux("display-message", "-p", "-t", pane.id, "#{pane_pid}")), session.pid, "switches retain Pi process");
		}
		await hs.restart({ crash: true });
		await hs.call("POST", "/messages", { token, body: { to: id, type: "question", payload: { text: "LEADER-FOLLOWUP" } } });
		await waitFor(() => fake.requests.some((r) => r.messages.some((m) => m.text.includes("LEADER-FOLLOWUP"))), "leader message starts a new turn", 20000);
		assert.equal(sql(hs, "SELECT COUNT(*) n FROM sessions WHERE agent_id=?", id)[0].n, 1);
		assert.equal(await hs.ex.probe({ pid: session.pid, process_started_at: session.process_started_at }), "alive");
		assert.equal(existsSync(join(hs.dir, "enroll", `${session.spawn_intent_id}.1.json.terminal.sh`)), false);
		// Unexpected death must be noticed and repaired, not left as a dead pane.
		process.kill(session.pid, "SIGTERM");
		await waitFor(() => sql(hs, "SELECT id FROM messages WHERE json_extract(payload_json,\'$.kind\')=\'worker_exited\' AND json_extract(payload_json,\'$.agent_id\')=?", id).length > 0, "leader receives worker death notice", 15000);
		await waitFor(() => sql(hs, "SELECT s.pid FROM sessions s JOIN agents a ON a.current_session_id=s.id WHERE a.id=? AND a.observed_state=\'LIVE\'", id)[0]?.pid !== undefined && sql(hs, "SELECT s.pid FROM sessions s JOIN agents a ON a.current_session_id=s.id WHERE a.id=?", id)[0].pid !== session.pid, "worker respawned on saved transcript", 15000);
		await hs.call("POST", "/messages", { token, body: { to: id, type: "question", payload: { text: "AFTER-CRASH-FOLLOWUP" } } });
		await waitFor(() => fake.requests.some((r) => r.messages.some((m) => m.text.includes("AFTER-CRASH-FOLLOWUP")) && r.messages.some((m) => m.text.includes("LEADER-FOLLOWUP"))), "restarted worker is communicable and retains transcript", 20000);
		const liveSession = sql(hs, "SELECT s.* FROM sessions s JOIN agents a ON a.current_session_id=s.id WHERE a.id=?", id)[0];
		await view.close();
		assert.equal(await hs.ex.probe({ pid: liveSession.pid, process_started_at: liveSession.process_started_at }), "alive", "detach keeps Pi alive");
		const tools = new Map<string, any>();
		const rootClient = new TeamClient({ paths: statePaths(hs.dir), token: () => token, noReconnect: true });
		const runtime = { identity: { agent_id: "root", run_id }, client: rootClient, agentCall: (fn: () => unknown) => fn() };
		registerTools({ registerTool: (t: any) => tools.set(t.name, t) } as any, runtime as any);
		const close = (agent_id: string) => tools.get("team_close_member").execute(`close-${agent_id}`, { agent_id }, undefined, undefined, {});
		const stopped = await close(id);
		assert.equal(stopped.details.status, "CANCELLED");
		assert.equal(stopped.details.processes_stopped, true, "tool confirms actual shutdown");
		await waitFor(async () => await hs.ex.probe({ pid: session.pid, process_started_at: session.process_started_at }) === "dead", "controller stops interactive Pi", 10000);
		await waitFor(async () => !(await view!.panes()).some((p) => p.agent === id), "closed member pane removed", 10000);
		assert.equal((await rootClient.tree(run_id, undefined, true)).root.children.length, 0);
		assert.equal((await rootClient.me()).children.length, 0, "active report count excludes closed members");
		assert.equal((await rootClient.tree(run_id)).root.children[0].status, "CANCELLED", "history retained");
		assert.equal((await close(id)).details.status, "CANCELLED", "repeat close is harmless");
		const replacements = await Promise.all(["Alpha", "Beta"].map((name) => rootClient.post<any>("/members", { name, responsibility: "Declare readiness and wait", preferred_model_id: "interactive", max_runtime_seconds: 120 })));
		await waitFor(async () => {
			const panes = await view!.panes();
			return replacements.every((r) => panes.some((p) => p.agent === r.spawned_agent_ids[0]));
		}, "two replacement Pis", 15000);
		assert.equal((await view.panes()).length, inPlace ? 3 : 2, "only leader/members; no controls");
		assert.ok(!(await view.panes()).some((p) => p.agent === "dashboard"));
		for (const replacement of replacements) await close(replacement.spawned_agent_ids[0]);

	} finally {
		if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
		if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
		try { await view?.tmux("kill-server"); } catch {}
		await hs.cleanup();
		await fake.close();
	}
});
