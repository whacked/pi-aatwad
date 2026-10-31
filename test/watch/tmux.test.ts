import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TmuxWatch } from "../../src/watch/tmux.ts";
import { parseLayout, encodeLayout } from "../../src/watch/layout.ts";
import { clean, renderLog, recentOutput } from "../../src/watch/render.ts";
import { harness, newRun, waitFor } from "../controller/helpers.ts";

const haveTmux = spawnSync("tmux", ["-V"]).status === 0;

test("tmux watcher discovers members, repairs closed panes, survives restart and closes without stopping workers", { skip: !haveTmux, timeout: 30000 }, async () => {
	const hs = await harness();
	const socket = join(hs.dir, "tmux.sock");
	let view: TmuxWatch | undefined;
	try {
		const { token, run_id } = await newRun(hs, { models: [] });
		view = new TmuxWatch({ stateDir: hs.dir, runId: run_id, socket, debug: true });
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
		assert.equal(memberWindows.size, 1, "all members share the leader window");
		assert.equal((await view.tmux("list-windows", "-t", view.name, "-F", "#{window_id}")).split("\n").length, 1);
		const dimensions = async () => (await view!.tmux("list-panes", "-s", "-t", view!.name, "-F", "#{@pi_team_agent} #{pane_width} #{pane_height}")).split("\n").map((line) => {
			const [agent, w, h] = line.split(" "); return { agent, area: Number(w) * Number(h) };
		});
		await waitFor(async () => {
			const measured = await dimensions();
			const main = measured.find((p) => p.agent === "dashboard")!.area;
			return measured.filter((p) => p.agent !== "dashboard").every((p) => p.area < main);
		}, "manager allocation after final pane is tagged", 10000);
		const areas = await dimensions();
		const managerArea = areas.find((p) => p.agent === "dashboard")!.area;
		assert.ok(areas.filter((p) => p.agent !== "dashboard").every((p) => p.area < managerArea));
		await view.tmux("break-pane", "-d", "-s", pane.id, "-n", "legacy-members");
		await waitFor(async () => new Set((await view!.panes()).map((p) => p.window)).size === 1, "legacy member window consolidated", 10000);
		const initialLayout = await view.tmux("display-message", "-p", "-t", (await view.panes())[0].window, "#{window_layout}");
		await view.tmux("resize-window", "-t", (await view.panes())[0].window, "-x", "70", "-y", "70");
		await waitFor(async () => {
			const layout = await view!.tmux("display-message", "-p", "-t", (await view!.panes())[0].window, "#{window_layout}");
			const newAreas = await dimensions();
			return layout !== initialLayout && newAreas.find((p) => p.agent === "dashboard")!.area > 70 * 70 * 0.5;
		}, "adaptive leader allocation after terminal resize", 10000);
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


test("inside tmux, team panes stay beside the leader without taking over unrelated panes or sessions", { skip: !haveTmux }, async () => {
	const hs = await harness();
	const { run_id } = await newRun(hs);
	const view = new TmuxWatch({ stateDir: hs.dir, runId: run_id, socket: join(hs.dir, "tmux.sock") });
	try {
		const leader = await view.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "original-session", "-x", "200", "-y", "60", "/bin/sh");
		const unrelated = await view.tmux("split-window", "-d", "-h", "-l", "50", "-P", "-F", "#{pane_id}", "-t", leader, "/bin/sh");
		await view.tmux("new-window", "-d", "-t", "original-session:", "-n", "unrelated-window", "/bin/sh");
		const context = () => view.tmux("display-message", "-p", "-t", "original-session", "#{session_id} #{window_id} #{pane_id}");
		const geometry = () => view.tmux("display-message", "-p", "-t", unrelated, "#{pane_pid} #{pane_left} #{pane_top} #{pane_width} #{pane_height}");
		const beforeContext = await context(), beforeGeometry = await geometry();
		const leaderPid = await view.tmux("display-message", "-p", "-t", leader, "#{pane_pid}");
		await view.open(leader);
		await view.open(leader);
		assert.equal((await view.panes()).length, 1, "only the existing leader; no control pane");
		const live = await view.launchAgent("live-agent", "Live member", ["/bin/sh"], hs.dir);
		assert.equal((await view.panes()).length, 2);
		assert.equal(await geometry(), beforeGeometry, "unrelated pane geometry and process stay unchanged");
		assert.equal(await context(), beforeContext, "leader session, window and selection stay unchanged");
		assert.equal(await view.tmux("display-message", "-p", "-t", leader, "#{pane_pid}"), leaderPid);
		assert.equal((await view.tmux("list-sessions", "-F", "#{session_name}")).trim(), "original-session");
		assert.equal((await view.tmux("list-windows", "-t", "original-session", "-F", "#{window_id}")).split("\n").length, 2);
		const workerPid = await view.tmux("display-message", "-p", "-t", live, "#{pane_pid}");
		await view.close();
		assert.equal(await geometry(), beforeGeometry);
		assert.equal(await context(), beforeContext);
		assert.equal(await view.tmux("display-message", "-p", "-t", live, "#{pane_pid}"), workerPid);
		// Reconstructing from the persisted location (as the executor does) uses this same group.
		const recovered = new TmuxWatch({ ...view.opts });
		await recovered.open();
		assert.equal((await recovered.panes()).length, 2);
	} finally {
		try { await view.tmux("kill-server"); } catch {}
		await hs.cleanup();
	}
});


test("watch handles JSON layout responses end-to-end while preserving unrelated panes", { skip: !haveTmux }, async () => {
	const hs = await harness();
	const { run_id } = await newRun(hs);
	const view = new TmuxWatch({ stateDir: hs.dir, runId: run_id, socket: join(hs.dir, "tmux.sock") });
	const native = view.tmux.bind(view);
	try {
		const leader = await native("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "json-host", "-x", "180", "-y", "50", "/bin/sh");
		const other = await native("split-window", "-d", "-h", "-l", "40", "-P", "-F", "#{pane_id}", "-t", leader, "/bin/sh");
		const geometry = () => native("display-message", "-p", "-t", other, "#{pane_pid} #{pane_left} #{pane_top} #{pane_width} #{pane_height}");
		const before = await geometry();
		// This host has tmux 3.7. Translate the wire format only, exercising the
		// complete watcher against 3.8-style JSON (with whitespace) and live panes.
		view.tmux = async (...args: string[]) => {
			if (args[0] === "select-layout") {
				const root = parseLayout(args[args.length - 1]);
				delete root.document;
				return native(...args.slice(0, -1), encodeLayout(root));
			}
			const result = await native(...args);
			if (args[0] === "display-message" && args.at(-1)?.includes("#{window_layout}")) {
				const [raw, zoom] = result.split("\t");
				const root = parseLayout(raw); root.document = { V: 2 };
				const json = JSON.stringify(JSON.parse(encodeLayout(root)), null, 1);
				return zoom === undefined ? json : `${json}\t${zoom}`;
			}
			return result;
		};
		await view.open(leader);
		await view.launchAgent("json-member", "Member", ["/bin/sh"], hs.dir);
		assert.equal((await view.panes()).length, 2);
		assert.equal(await geometry(), before);
	} finally {
		try { await native("kill-server"); } catch {}
		await hs.cleanup();
	}
});


test("normal view removes duplicate legacy controls; explicit debug has just one", { skip: !haveTmux }, async () => {
	const hs = await harness();
	const { run_id } = await newRun(hs);
	const view = new TmuxWatch({ stateDir: hs.dir, runId: run_id, socket: join(hs.dir, "tmux.sock") });
	try {
		const leader = await view.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "normal-view", "-x", "180", "-y", "50", "/bin/sh");
		await Promise.all([view.open(leader), view.open(leader)]);
		assert.equal((await view.panes()).length, 1, "overlapping normal opens never create controls");
		for (let i = 0; i < 2; i++) {
			const pane = await view.tmux("split-window", "-d", "-h", "-P", "-F", "#{pane_id}", "-t", leader, "/bin/sh");
			await view.tag(pane, "dashboard");
		}
		const legacyWindow = await view.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "normal-view:", "-n", "old-control", "/bin/sh");
		await view.tag(legacyWindow, "dashboard");
		await view.open(leader);
		assert.equal((await view.panes()).length, 1);
		assert.equal((await view.tmux("list-windows", "-t", "normal-view", "-F", "#{window_id}")).split("\n").length, 1, "old owned control window removed");
		view.opts.debug = true;
		await view.open(leader); await view.open(leader);
		assert.equal((await view.panes()).filter((p) => p.agent === "dashboard").length, 1);
		view.opts.debug = false;
		await view.open(leader);
		assert.equal((await view.panes()).length, 1);
	} finally { try { await view.tmux("kill-server"); } catch {} await hs.cleanup(); }
});
