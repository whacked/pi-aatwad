// Runs against the real Rex server when this test runs inside Rex; skipped elsewhere.
// Every block lives in a throwaway session that is destroyed afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RexView, rexExecutable } from "../../src/terminal/rex.ts";
import { launchTerminal } from "../../src/executor/terminal.ts";
import type { LaunchSpec } from "../../src/executor/types.ts";
import { waitFor } from "../controller/helpers.ts";

const bin = rexExecutable();
const server = process.env.REX_SERVER;
const available = !!bin && !!server && (() => { try { execFileSync(bin, ["-S", server, "--autostart=false", "whoami", "--json"], { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; } })();
// Like the backend, never let this terminal's session scope the lookups.
const cliEnv = () => { const env = { ...process.env }; delete env.REX_SESSION; delete env.REX_BLOCK; return env; };
const rex = (...args: string[]) => execFileSync(bin!, ["-S", server!, "--autostart=false", ...args], { encoding: "utf8", timeout: 10000, env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();

test("Rex member blocks split beside the leader, carry labels and tags, respawn in place and stay owned", { skip: !available, timeout: 60000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pt-rex-"));
	const created = JSON.parse(rex("new", `pi-team-test-${process.pid}`, "--json", "--shell=none", "--", "/bin/sleep", "600"));
	const session: string = created.session_id;
	const leader: string = created.initial_windows[0].block_ids[0];
	const window: string = created.initial_windows[0].window_id;
	try {
		const view = new RexView({ stateDir: dir, runId: "run-a", socket: server });
		assert.equal(await view.exists(), false);
		await view.open(leader);
		assert.deepEqual(view.opts.location, { window, leader });
		assert.equal(await view.exists(), true);
		assert.deepEqual((await view.panes()).map((p) => p.agent), ["leader"]);

		const alpha = await view.launchAgent("alpha-1", "Alpha", ["/bin/sleep", "600"], dir);
		const beta = await view.launchAgent("beta-2", "Beta", ["/bin/sleep", "600"], dir);
		const panes = await view.panes();
		assert.deepEqual(panes.map((p) => p.agent).sort(), ["alpha-1", "beta-2", "leader"]);
		assert.ok(panes.every((p) => p.window === window && !p.dead), "members share the leader's window");
		const info = (block: string) => JSON.parse(rex("block", "inspect", block, "--json")).block;
		assert.equal(info(alpha).label, "Alpha [alpha-1]", "native label from the decoration plan");
		assert.ok(await view.paneProcess(alpha) > 0);

		// A dead member keeps its block (keep-open) until the executor replaces it in place.
		process.kill(await view.paneProcess(alpha), "SIGKILL");
		await waitFor(async () => (await view.panes()).find((p) => p.agent === "alpha-1")?.dead === true, "dead member block retained", 10000);
		const replaced = await view.launchAgent("alpha-1", "Alpha", ["/bin/sleep", "600"], dir);
		assert.notEqual(replaced, alpha);
		assert.throws(() => rex("block", "inspect", alpha, "--json"), /not found/);
		assert.equal((await view.panes()).length, 3);
		assert.deepEqual(await view.readTag(alpha), {}, "replaced block's tag is cleared");

		await view.sync([{ agent_id: "alpha-1", role: "Alpha Renamed", children: [] } as any]);
		assert.equal(info(replaced).label, "Alpha Renamed [alpha-1]");

		const other = new RexView({ stateDir: dir, runId: "run-b", socket: server });
		await assert.rejects(other.open(leader), /another team/);
		other.opts.location = { window, leader };
		await assert.rejects(other.panes(), /not owned/);
		await assert.rejects(new RexView({ stateDir: dir, runId: "run-a", socket: server, debug: true }).open(leader), /tmux-only/);

		await view.focus("alpha-1");
		await view.removeMember("beta-2");
		assert.throws(() => rex("block", "inspect", beta, "--json"), /not found/);
		assert.deepEqual((await view.panes()).map((p) => p.agent).sort(), ["alpha-1", "leader"]);
		await view.close();
		assert.equal(await view.exists(), true, "closing never closes the user's or members' blocks");
		await view.releaseLeaderPane(leader);
		assert.deepEqual(await view.readTag(leader), {});
	} finally {
		try { rex("kill", session); } catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("executor launches a gated member into a Rex block that knows its own host terminal", { skip: !available, timeout: 60000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pt-rex-launch-"));
	const created = JSON.parse(rex("new", `pi-team-test-${process.pid}-launch`, "--json", "--shell=none", "--", "/bin/sleep", "600"));
	const session: string = created.session_id;
	const leader: string = created.initial_windows[0].block_ids[0];
	try {
		const view = new RexView({ stateDir: dir, runId: "run", socket: server });
		await view.open(leader);
		const spec: LaunchSpec = {
			run_id: "run", agent_id: "worker-1", session_id: "session", spawn_intent_id: "intent", role: "Worker",
			provider: "default", model: "default", cwd: dir, pi_session_path: join(dir, "transcript"),
			enroll_file: join(dir, "enroll.json"), state_dir: dir, log_path: join(dir, "log"), bootstrap_prompt: "work", resume: false,
			terminal: { backend: "rex", socket: server, location: view.opts.location },
		};
		writeFileSync(spec.enroll_file, "credential");
		const report = join(dir, "env.txt");
		const fakePi = join(dir, "fake-pi.sh");
		writeFileSync(fakePi, `env > ${JSON.stringify(report)}\nexec /bin/sleep 600\n`);
		const identity = await launchTerminal(spec, "/bin/sh", [fakePi]);
		await waitFor(() => existsSync(report) && readFileSync(report, "utf8").includes("REX_BLOCK="), "member started after its gate opened", 10000);
		const env = Object.fromEntries(readFileSync(report, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
		const member = (await view.panes()).find((p) => p.agent === "worker-1")!;
		assert.ok(member, "member block is tagged");
		assert.equal(env.REX_BLOCK, member.id, "the member sees its own block, so its host detection is Rex");
		assert.equal(env.REX_SERVER, server);
		assert.equal(env.TMUX, undefined, "no inherited tmux markers");
		assert.equal(identity.pid, await view.paneProcess(member.id));
	} finally {
		try { rex("kill", session); } catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the leader in Rex opens member blocks through the controller and takes over stale tags only from inside its block", { skip: !available, timeout: 60000 }, async () => {
	const { harness, newRun } = await import("../controller/helpers.ts");
	const { openTerminals } = await import("../../src/extension/terminals.ts");
	const { TeamClient } = await import("../../src/shared/client.ts");
	const { statePaths } = await import("../../src/shared/paths.ts");
	const hs = await harness();
	const created = JSON.parse(rex("new", `pi-team-test-${process.pid}-open`, "--json", "--shell=none", "--", "/bin/sleep", "600"));
	const session: string = created.session_id;
	const leader: string = created.initial_windows[0].block_ids[0];
	const keys = ["TMUX", "TMUX_PANE", "HERDR_ENV", "REX_BLOCK", "REX_SESSION"] as const;
	const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	try {
		for (const k of keys) delete process.env[k];
		process.env.REX_BLOCK = leader; process.env.REX_SESSION = session;
		const old = await newRun(hs, { models: [] }), current = await newRun(hs);
		const rt = { paths: statePaths(hs.dir), commandToken: async () => hs.op, client: new TeamClient({ paths: statePaths(hs.dir), noReconnect: true }) } as any;
		const first = await openTerminals(rt, old.run_id);
		assert.equal(first.backend, "rex");
		const saved = (await hs.call("GET", `/runs/${old.run_id}/terminal`, { token: hs.op })).body;
		assert.deepEqual({ backend: saved.backend, socket: saved.socket, location: saved.location }, { backend: "rex", socket: server, location: first.opts.location });
		await hs.call("POST", "/members", { token: old.token, body: { name: "Active", responsibility: "Keep working" } });
		// An inherited REX_BLOCK alone proves nothing: the other team stays protected.
		await assert.rejects(openTerminals(rt, current.run_id), /not running inside it \(inherited REX_BLOCK\)/);
		const fresh = await openTerminals(rt, current.run_id, { occupiesPane: async () => true });
		assert.match(fresh.reclaimedFrom!, new RegExp(`${old.run_id}.*1 active member`));
		assert.equal((await fresh.readTag(leader)).owner, fresh.owner);
		assert.equal(await first.exists(), true);
		await assert.rejects(first.assertOwned(), /not owned/, "the previous team's saved location is no longer owned, so the controller falls back");
	} finally {
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		try { rex("kill", session); } catch {}
		await hs.cleanup();
	}
});
