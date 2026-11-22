// Real Pi members in the built-in session host: requires pi on PATH and a supported platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import { harness, newRun, waitFor, sql } from "../controller/helpers.ts";
import { startFakeOpenAI } from "../fixtures/fake-openai.ts";
import { PiExecutor } from "../../src/executor/pi.ts";
import { NativeView } from "../../src/terminal/native.ts";
import { nativeHostSupport } from "../../src/terminal/native/client.ts";
import { FRAME_DATA, FRAME_JSON, FrameReader, encodeFrame } from "../../src/terminal/native/protocol.ts";

const available = !nativeHostSupport() && spawnSync("pi", ["--version"]).status === 0;
const plain = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g, "");

async function watch(view: NativeView, handle: string) {
	const { socket } = await view.client.attach(handle, 140, 40);
	const state = { screen: "", events: [] as Array<{ event?: string; reason?: string }>, socket: socket as Socket };
	const reader = new FrameReader((type, payload) => {
		if (type === FRAME_DATA) state.screen += payload.toString();
		else if (type === FRAME_JSON) state.events.push(JSON.parse(payload.toString()));
	});
	socket.on("data", (c: Buffer) => reader.push(c));
	socket.resume();
	return state;
}

test("real Pi members live in the built-in host: header, typing, /team back, crash recovery and close", { skip: !available, timeout: 90000 }, async () => {
	const fake = await startFakeOpenAI((req) => {
		const task = req.messages.map((m) => m.text).join("\n").match(/Your assigned task id: ([^.\s]+)\./)?.[1];
		if (task && !req.messages.some((m) => m.text.includes("team_complete_task"))) return { tool_calls: [{ name: "team_complete_task", arguments: { task_id: task, summary: "Done; waiting" } }] };
		return { text: "NATIVE-INTERACTIVE-ANSWER" };
	});
	const oldDir = process.env.PI_CODING_AGENT_DIR, oldOffline = process.env.PI_OFFLINE;
	const hs = await harness({ executor: new PiExecutor() as any });
	const agentDir = join(hs.dir, "agent-config");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fakeoai: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "fake-1" }] } } }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	let view: NativeView | undefined;
	try {
		const { token, run_id } = await newRun(hs, { limits: { allow_providers: ["fakeoai"] }, models: [{ id: "interactive", provider: "fakeoai", model: "fake-1", capability_tags: ["tools"] }] });
		view = new NativeView({ stateDir: hs.dir, runId: run_id });
		assert.equal((await hs.call("POST", `/runs/${run_id}/terminal`, { token, body: { backend: "native" } })).status, 200);
		const made = await hs.call("POST", "/members", { token, body: { name: "Adjudicator", responsibility: "Review and remain available", preferred_model_id: "interactive" } });
		assert.equal(made.status, 200, JSON.stringify(made.body));
		const id = made.body.spawned_agent_ids[0];
		await waitFor(() => sql(hs, "SELECT observed_state FROM agents WHERE id = ?", id)[0]?.observed_state === "LIVE", "interactive enrollment", 20000);
		const member = (await view.member(id))!;
		assert.ok(member && !member.dead);
		const pid = sql(hs, "SELECT s.pid FROM sessions s JOIN agents a ON a.current_session_id=s.id WHERE a.id=?", id)[0].pid;
		assert.equal(await view.paneProcess(member.id), pid);

		const attached = await watch(view, member.id);
		await waitFor(() => plain(attached.screen).includes("NATIVE-INTERACTIVE-ANSWER"), "visible Pi answer", 20000).catch((e) => { throw new Error(`${e.message}\n${plain(attached.screen).slice(-3000)}`); });
		await waitFor(() => new RegExp(`Adjudicator\\s+team member · ${id}\\s+·\\s+/team back returns to the leader`).test(plain(attached.screen)), "self-drawn header with the way back", 10000)
			.catch((e) => { throw new Error(`${e.message}\n${plain(attached.screen).slice(-3000)}`); });
		const count = fake.requests.length;
		attached.socket.write(encodeFrame(FRAME_DATA, "NATIVE-KEYBOARD-FOLLOWUP"));
		await new Promise((r) => setTimeout(r, 200));
		attached.socket.write(encodeFrame(FRAME_DATA, "\r"));
		await waitFor(() => fake.requests.slice(count).some((r) => r.messages.some((m) => m.text.includes("NATIVE-KEYBOARD-FOLLOWUP"))), "typed input reaches Pi", 20000);
		await waitFor(() => plain(attached.screen).split("NATIVE-KEYBOARD-FOLLOWUP").length > 2 || fake.requests.length > count, "turn finished");
		await new Promise((r) => setTimeout(r, 500));
		attached.socket.write(encodeFrame(FRAME_DATA, "/team back"));
		await new Promise((r) => setTimeout(r, 300));
		attached.socket.write(encodeFrame(FRAME_DATA, "\x1b")); // close slash-command completion
		await new Promise((r) => setTimeout(r, 300));
		attached.socket.write(encodeFrame(FRAME_DATA, "\r"));
		await waitFor(() => attached.events.some((e) => e.event === "detach" && e.reason === "member"), "/team back returns the human to the leader", 15000)
			.catch((e) => { throw new Error(`${e.message}\n${plain(attached.screen).slice(-2000)}`); });
		assert.equal((await view.member(id))?.dead, false, "the member keeps running after the human leaves");

		// Unexpected death is repaired in a replacement terminal on the same transcript.
		process.kill(pid, "SIGTERM");
		await waitFor(async () => { const now = await view!.member(id); return !!now && now.id !== member.id && !now.dead; }, "member respawned in a new terminal", 20000);
		await hs.call("POST", "/messages", { token, body: { to: id, type: "question", payload: { text: "NATIVE-AFTER-CRASH" } } });
		await waitFor(() => fake.requests.some((r) => r.messages.some((m) => m.text.includes("NATIVE-AFTER-CRASH")) && r.messages.some((m) => m.text.includes("NATIVE-KEYBOARD-FOLLOWUP"))), "restarted member keeps its transcript", 20000);

		const closed = await hs.call("POST", `/agents/${id}/lifecycle`, { token, body: { action: "cancel", reason: "done", children_policy: "cascade" } });
		assert.equal(closed.status, 200, JSON.stringify(closed.body));
		await waitFor(async () => !(await view!.member(id)), "closed member terminal removed", 15000);
	} finally {
		if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
		if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
		await view?.client.request({ op: "shutdown" }).catch(() => {});
		await hs.cleanup();
		await fake.close();
	}
});
