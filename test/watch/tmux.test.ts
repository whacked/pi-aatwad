import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TmuxWatch } from "../../src/watch/tmux.ts";
import { clean, renderLog, recentOutput } from "../../src/watch/render.ts";
import { harness, newRun, waitFor } from "../controller/helpers.ts";

const haveTmux = spawnSync("tmux", ["-V"]).status === 0;

test("tmux watcher discovers members, repairs closed panes, survives restart and closes without stopping workers", { skip: !haveTmux, timeout: 30000 }, async () => {
	const hs = await harness();
	const socket = join(hs.dir, "tmux.sock");
	let view: TmuxWatch | undefined;
	try {
		const { token, run_id } = await newRun(hs, { models: [] });
		view = new TmuxWatch({ stateDir: hs.dir, runId: run_id, socket });
		assert.equal(await view.exists(), false);
		await view.open();
		await view.open(); // idempotent, no duplicate dashboard
		assert.equal((await view.panes()).length, 1);
		const result = await hs.call("POST", "/members", { token, body: { name: "Adjudicator", responsibility: "Review the proposed solution" } });
		assert.equal(result.status, 200, JSON.stringify(result.body));
		const id = result.body.spawned_agent_ids[0];
		await waitFor(async () => (await view!.panes()).some((p) => p.agent === id), "automatic member pane", 10000);
		await waitFor(() => hs.ex.tokens.has(id));
		const logDir = join(hs.dir, "workers");
		mkdirSync(logDir, { recursive: true });
		writeFileSync(join(logDir, `${id}.1.log`), JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: "REVIEW-OUTPUT-ONE" }] } }) + "\n");
		let pane = (await view.panes()).find((p) => p.agent === id)!;
		const capture = () => view!.tmux("capture-pane", "-p", "-t", pane.id);
		await waitFor(async () => (await capture()).includes("REVIEW-OUTPUT-ONE"), "rendered worker output", 10000);
		writeFileSync(join(logDir, `${id}.2.log`), JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: "REVIEW-OUTPUT-TWO" }] } }) + "\n");
		await hs.restart({ crash: true });
		await waitFor(async () => (await capture()).includes("REVIEW-OUTPUT-TWO"), "latest log after restart", 10000);
		await view.tmux("kill-pane", "-t", pane.id);
		await waitFor(async () => {
			const found = (await view!.panes()).find((p) => p.agent === id);
			if (found && found.id !== pane.id) { pane = found; return true; }
			return false;
		}, "repaired pane", 10000);
		for (let i = 0; i < 4; i++) {
			const extra = await hs.call("POST", "/members", { token, body: { name: `Extra ${i}`, responsibility: "Review an independent component", max_cost_usd: 0.1 } });
			assert.equal(extra.status, 200, JSON.stringify(extra.body));
		}
		await waitFor(async () => (await view!.panes()).length === 6, "five members and dashboard", 10000);
		const memberWindows = new Set((await view.panes()).filter((p) => p.agent !== "dashboard").map((p) => p.window));
		assert.equal(memberWindows.size, 2, "paginate at four members per window");
		const dashboard = (await view.panes()).find((p) => p.agent === "dashboard")!;
		await view.tmux("respawn-pane", "-k", "-t", dashboard.id, "/usr/bin/true");
		await waitFor(async () => (await view!.panes()).find((p) => p.agent === "dashboard")?.dead, "dead dashboard");
		await view.open();
		await waitFor(async () => !(await view!.panes()).find((p) => p.agent === "dashboard")?.dead, "dashboard reopened");
		await view.focus(id);
		const identity = hs.ex.launchesFor(id).at(-1)!.id;
		await view.close();
		assert.equal(await view.exists(), false);
		assert.equal(await hs.ex.probe(identity), "alive");
		await view.close(); // idempotent
	} finally {
		try { await view?.tmux("kill-server"); } catch {}
		await hs.cleanup();
	}
});

test("tmux refuses to change an unowned session", { skip: !haveTmux }, async () => {
	const hs = await harness();
	const view = new TmuxWatch({ stateDir: hs.dir, runId: "test", socket: join(hs.dir, "tmux.sock") });
	try {
		await view.tmux("new-session", "-d", "-s", view.name);
		await assert.rejects(view.close(), /not owned/);
		assert.equal(await view.exists(), true);
	} finally {
		try { await view.tmux("kill-server"); } catch {}
		await hs.cleanup();
	}
});

test("observer renders bounded logs and removes terminal escapes", () => {
	assert.equal(clean("hello\x1b[2J\x07world"), "helloworld");
	assert.match(renderLog(JSON.stringify({ type: "tool_execution_start", toolName: "read" })), /tool started: read/);
	assert.equal(recentOutput("/nonexistent", "agent_1"), "Waiting for worker log…");
	assert.throws(() => recentOutput("/tmp", "../bad"), /invalid agent/);
});
