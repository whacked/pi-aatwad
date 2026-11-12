import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PiExecutor } from "../../src/executor/pi.ts";
import { TmuxWatch } from "../../src/watch/tmux.ts";
import { harness, newRun, waitFor } from "../controller/helpers.ts";
import type { TerminalMember } from "../../src/executor/types.ts";

const haveTmux = spawnSync("tmux", ["-V"]).status === 0;

test("terminal sync removes stopped paused panes without dismissing members or interfering with live/restarting harnesses", { skip: !haveTmux, timeout: 30000 }, async () => {
	const hs = await harness();
	const socket = join(hs.dir, "cleanup.sock");
	let view: TmuxWatch | undefined;
	try {
		const r = await newRun(hs);
		view = new TmuxWatch({ stateDir: hs.dir, runId: r.run_id, socket, debug: true });
		await view.open();
		const main = (await view.panes())[0];
		await view.tmux("resize-window", "-t", main.window, "-x", "200", "-y", "100");
		const members: TerminalMember[] = [];
		for (const [agent, status, pid] of [["paused-dead", "PAUSED", 1], ["paused-live", "PAUSED", 2], ["running-dead", "RUNNING", 3], ["closed-dead", "CANCELLED", 4], ["paused-live-stale-identity", "PAUSED", 5], ["paused-resuming", "PAUSED", 6], ["paused-no-identity", "PAUSED", 7], ["paused-dead-alive-identity", "PAUSED", 8]] as const) {
			const pane = await view.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", main.id, "sleep", "60");
			await view.tag(pane, agent);
			await view.tmux("select-layout", "-t", main.window, "tiled");
			if (!agent.startsWith("paused-live")) {
				await view.tmux("respawn-pane", "-k", "-t", pane, "true");
				await waitFor(async () => await view!.tmux("display-message", "-p", "-t", pane, "#{pane_dead}") === "1", "worker pane exit");
			}
			members.push({ agent_id: agent, role: agent, status, observed_state: "STOPPED", model: null, parent_id: r.root, desired_state: status === "PAUSED" && agent !== "paused-resuming" ? "PAUSED" : "RUNNING", children: [], process: pid === 7 ? undefined : { pid, process_started_at: "test" } } as TerminalMember);
		}
		const executor = new PiExecutor();
		executor.probe = async ({ pid }) => pid === 2 || pid === 8 ? "alive" : "dead";
		await executor.syncTerminal(hs.dir, r.run_id, { socket, debug: true }, members);
		const remaining = new Map((await view.panes()).map((p) => [p.agent, p]));
		assert.equal(remaining.has("paused-dead"), false);
		assert.equal(remaining.has("paused-no-identity"), false);
		assert.equal(remaining.get("paused-dead-alive-identity")?.dead, true, "never remove a pane while the recorded process is alive");
		assert.equal(remaining.has("closed-dead"), false);
		assert.equal(remaining.get("paused-live")?.dead, false, "never kill a process while the pause is still stopping it");
		assert.equal(remaining.get("paused-live-stale-identity")?.dead, false, "a live TUI is retained even when stored process identity is stale");
		assert.equal(remaining.get("paused-resuming")?.dead, true, "a member already set to resume keeps its pane for relaunch");
		assert.equal(remaining.get("running-dead")?.dead, true, "restart belongs to the reconciler, not pane cleanup");
		await executor.syncTerminal(hs.dir, r.run_id, { socket, debug: true }, members);
		assert.equal((await view.panes()).some((p) => p.agent === "paused-dead"), false, "paused panes are not recreated");
	} finally {
		if (view) await view.tmux("kill-server").catch(() => {});
		await hs.cleanup();
	}
});
