// bb backend against a fake bb CLI: member threads, claims, the supervisor, resume, cleanup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBbMember, bbModel, threadStorage } from "../../src/executor/bb.ts";
import { probeIdentity, stopIdentity } from "../../src/executor/proc.ts";
import { BbView, readMemberThread } from "../../src/terminal/bb.ts";
import { teamOwner } from "../../src/terminal/view.ts";
import { BB_CLAIM_FILE, type TerminalOptions } from "../../src/shared/protocol.ts";
import { TeamRuntime } from "../../src/extension/runtime.ts";
import { FIXTURES, makeSpec, tmp, until } from "./helpers.ts";

const CLI = join(FIXTURES, "fake-bb.mjs");
const LEADER = "thr_leader1", PROJECT = "proj_test1";

function setup() {
	const dir = tmp("pt-bb-");
	const data = join(dir, "bbdata");
	const stateFile = join(dir, "fake-bb.json");
	writeFileSync(stateFile, JSON.stringify({ dataDir: data, calls: [], threads: { [LEADER]: { id: LEADER, status: "idle", title: "Leader", projectId: PROJECT, hostId: "host_1", prompts: [], archivedAt: null, deletedAt: null } } }));
	process.env.FAKE_BB_STATE = stateFile;
	process.env.PI_TEAM_BB_POLL_MS = "200";
	const terminal: TerminalOptions = { backend: "bb", socket: "http://127.0.0.1:1", location: { window: PROJECT, leader: LEADER }, env: { BB_CLI: CLI, BB_SERVER_URL: "http://127.0.0.1:1", BB_DATA_DIR: data } };
	const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
	return { dir, data, terminal, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a member becomes a child thread of the leader; its worker env arrives as a one-time claim", { timeout: 30_000 }, async () => {
	const s = setup();
	let pid = 0;
	try {
		const spec = makeSpec(s.dir, { terminal: s.terminal, role: "Census", bootstrap_prompt: "BOOT" });
		const id = await launchBbMember(spec, "BOOT");
		pid = id.pid;
		const st = s.state();
		const spawn = st.calls.find((c: string[]) => c[1] === "spawn");
		const arg = (n: string) => spawn[spawn.indexOf(n) + 1];
		assert.deepEqual([arg("--project"), arg("--parent-thread"), arg("--machine"), arg("--environment"), arg("--parent-notifications"), arg("--lifecycle-owner-thread"), arg("--title"), arg("--provider"), arg("--model")],
			[PROJECT, LEADER, "host_1", s.dir, "off", LEADER, "Census", "pi", "fakeoai/fake-1"]);
		const thread = readMemberThread(s.dir, teamOwner(s.dir, "run1"), "agent1")!;
		assert.equal(st.threads[thread].prompts[0], "BOOT", "bootstrap prompt is sent with --prompt-file");
		assert.ok(!existsSync(`${spec.enroll_file}.prompt`), "the prompt file is removed");
		const claim = JSON.parse(readFileSync(join(threadStorage(s.terminal.env!, thread), BB_CLAIM_FILE), "utf8"));
		assert.deepEqual(Object.keys(claim.env).sort(), ["PI_TEAM_AGENT_ID", "PI_TEAM_ENROLL_FILE", "PI_TEAM_LAUNCH_TOKEN", "PI_TEAM_RESUME", "PI_TEAM_RUN_ID"]);
		assert.equal(claim.env.PI_TEAM_ENROLL_FILE, spec.enroll_file);
		assert.equal(claim.env.PI_TEAM_LAUNCH_TOKEN, id.launch_token);
		assert.equal(await probeIdentity(id), "alive", "the supervisor stands in for the member's Pi");

		// The view sees the member; closing it archives the thread and the supervisor exits.
		const view = new BbView({ stateDir: s.dir, runId: "run1", ...s.terminal });
		assert.deepEqual((await view.panes()).map((p) => [p.agent, p.id, p.dead]), [["agent1", thread, false]]);
		await view.removeMember("agent1");
		assert.ok(s.state().threads[thread].archivedAt);
		assert.equal(readMemberThread(s.dir, teamOwner(s.dir, "run1"), "agent1"), undefined);
		await until(async () => await probeIdentity(id) === "dead", 10_000);
	} finally {
		if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
		s.cleanup();
	}
});

test("restart reuses the member's thread: stop, fresh claim, tell; SIGTERM to the supervisor stops the thread", { timeout: 30_000 }, async () => {
	const s = setup();
	const pids: number[] = [];
	try {
		const first = await launchBbMember(makeSpec(s.dir, { terminal: s.terminal }), "BOOT");
		pids.push(first.pid);
		const thread = readMemberThread(s.dir, teamOwner(s.dir, "run1"), "agent1")!;
		const claimFile = join(threadStorage(s.terminal.env!, thread), BB_CLAIM_FILE);
		rmSync(claimFile); // the member took it
		await stopIdentity(first, 5_000);
		assert.equal(s.state().threads[thread].stopped, 1, "controller stop -> bb thread stop");

		const again = await launchBbMember(makeSpec(s.dir, { terminal: s.terminal, resume: true }), "RESUME");
		pids.push(again.pid);
		const st = s.state();
		assert.equal(st.calls.filter((c: string[]) => c[1] === "spawn").length, 1, "no second thread");
		assert.deepEqual(st.threads[thread].prompts, ["BOOT", "RESUME"]);
		assert.equal(st.threads[thread].stopped, 2, "the old runtime is stopped before the resume prompt");
		assert.equal(JSON.parse(readFileSync(claimFile, "utf8")).env.PI_TEAM_RESUME, "1");

		// An archived thread cannot be resumed: a new thread is spawned.
		st.threads[thread].archivedAt = "2026-11-23T00:00:00Z";
		writeFileSync(process.env.FAKE_BB_STATE!, JSON.stringify(st));
		const fresh = await launchBbMember(makeSpec(s.dir, { terminal: s.terminal, resume: true }), "RESUME");
		pids.push(fresh.pid);
		assert.notEqual(readMemberThread(s.dir, teamOwner(s.dir, "run1"), "agent1"), thread);
	} finally {
		for (const p of pids) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
		s.cleanup();
	}
});

test("launch failures are reported, not retried silently", { timeout: 30_000 }, async () => {
	const s = setup();
	try {
		const st = s.state(); st.failSpawn = "HTTP 404: Host not found"; writeFileSync(process.env.FAKE_BB_STATE!, JSON.stringify(st));
		const spec = makeSpec(s.dir, { terminal: s.terminal });
		await assert.rejects(launchBbMember(spec, "BOOT"), /Host not found/);
		assert.match(readFileSync(spec.log_path, "utf8"), /launch_failed.*Host not found/);
		await assert.rejects(launchBbMember(makeSpec(s.dir, { terminal: { ...s.terminal, location: undefined } }), "BOOT"), /leader's thread/);
		assert.equal(bbModel({ provider: "default", model: "default" }), undefined, "bb uses the project's remembered model");
	} finally {
		s.cleanup();
	}
});

test("the extension takes a bb claim once and treats it as its enrollment env", () => {
	const dir = tmp("pt-bbclaim-");
	try {
		const env: NodeJS.ProcessEnv = { BB_THREAD_STORAGE: dir };
		const rt = new TeamRuntime({ on() {}, registerCommand() {}, registerTool() {} } as never, { env });
		assert.equal(rt.takeHostClaim(), false, "no claim yet");
		writeFileSync(join(dir, BB_CLAIM_FILE), JSON.stringify({ env: { PI_TEAM_ENROLL_FILE: "/x/enroll.json", PI_TEAM_AGENT_ID: "a1", HOME: "/evil" } }));
		assert.equal(rt.takeHostClaim(), true);
		assert.equal(env.PI_TEAM_ENROLL_FILE, "/x/enroll.json");
		assert.equal(env.HOME, undefined, "only PI_TEAM_* keys are taken");
		assert.ok(!existsSync(join(dir, BB_CLAIM_FILE)), "the claim is consumed");
		assert.equal(rt.managed, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
