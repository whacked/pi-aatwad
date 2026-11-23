import { test } from "node:test";
import assert from "node:assert/strict";
import { currentHost, describeHost, detectHost, detectHostFromMarkers, refreshHost, NoSessionHostError, type HostProbe } from "../../src/terminal/hosts.ts";
import { BACKENDS, backendFacts, isBackend } from "../../src/terminal/backends.ts";
import { nativeHostSupport } from "../../src/terminal/native/client.ts";

const REX = { REX_SERVER: "unix:///tmp/rex.sock", REX_BLOCK: "block:01a1fc1c-2d5d-74ab-97fe-f900d30e3203" };
const TMUX = { TMUX: "/tmp/mux,1,0", TMUX_PANE: "%3" };
const BB = { BB_THREAD_ID: "thr_leader1", BB_CLI: "/opt/bb/bin/bb" };
const BB_THREAD = { thread: { id: "thr_leader1", status: "idle", title: "Leader", projectId: "proj_1" }, environment: { id: "env_1", hostId: "host_1" } };
const fallback = nativeHostSupport() ? "detached" : "native";

/** A probe for a process on tty "ttys009" inside Rex block pid 100 and tmux pane tty /dev/ttys009. */
function probe(over: Partial<HostProbe> = {}): HostProbe & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		tty: async () => { calls.push("tty"); return "ttys009"; },
		contains: async (pid) => { calls.push(`contains:${pid}`); return pid === 100; },
		tmuxPaneTty: async (pane) => { calls.push(`tmux:${pane}`); return "/dev/ttys009"; },
		rexBlockPid: async (block) => { calls.push(`rex:${block}`); return 100; },
		bbThread: async (thread) => { calls.push(`bb:${thread}`); return thread === BB_THREAD.thread.id ? BB_THREAD : undefined; },
		...over,
	};
}

test("hosts are tried richest first: bb, Rex, tmux, then the built-in host, then detached", async () => {
	const all = { ...BB, ...REX, ...TMUX };
	// bb runs its agent Pi headless (no tty).
	const inBb = await detectHost(all, probe({ tty: async () => undefined, contains: async () => true }));
	assert.equal(inBb.host, "bb");
	assert.deepEqual({ backend: inBb.backend, leader: inBb.leader, beside: inBb.beside }, { backend: "bb", leader: "thr_leader1", beside: true });
	// A Pi with a terminal inside a bb thread inherited the marker: the next host down wins.
	const d = await detectHost(all, probe());
	assert.equal(d.host, "rex", "an inherited bb marker fails verification, so Rex wins over tmux");
	assert.deepEqual(d.candidates.map((c) => [c.host, c.detected, c.usable]), [["bb", true, false], ["rex", true, true], ["tmux", true, undefined], ["native", true, undefined], ["detached", true, undefined]]);
	assert.match(d.candidates[0].reason!, /terminal of its own.*inherited BB_THREAD_ID/);
	assert.deepEqual({ backend: d.backend, leader: d.leader, sessions: d.sessions, beside: d.beside, decoration: d.decoration, verified: d.verified }, { backend: "rex", leader: REX.REX_BLOCK, sessions: true, beside: true, decoration: "label", verified: true });
	assert.equal((await detectHost(TMUX, probe())).host, "tmux");
	assert.equal((await detectHost({ ...TMUX, ...REX }, probe())).host, "rex", "tmux inside Rex: the richer host wins");
	const plain = await detectHost({}, probe());
	assert.equal(plain.host, fallback);
	assert.equal(plain.beside, false);
	assert.equal(plain.decoration, "self", "nothing on screen labels a member, so it draws its own header");
	assert.match(describeHost(d), /bb: skipped: this Pi has a terminal[\s\S]*→ Rex: selected[\s\S]*tmux: detected, not needed[\s\S]*detached workers: fallback/);
});

test("markers alone are only claims: incomplete markers are not detected, inherited ones fail verification", async () => {
	for (const env of [{ TMUX_PANE: "%1" }, { REX_BLOCK: REX.REX_BLOCK }, { ...REX, REX_BLOCK: "not-a-block" }]) assert.equal(detectHostFromMarkers(env).host, fallback, JSON.stringify(env));
	// The pane exists but is another terminal (inherited markers, or a multiplexer nested in it).
	const stale = await detectHost(TMUX, probe({ tmuxPaneTty: async () => "/dev/ttys001" }));
	assert.equal(stale.host, fallback);
	assert.match(stale.candidates.find((c) => c.host === "tmux")!.reason!, /not this Pi's terminal \(inherited TMUX_PANE\)/);
	const outside = await detectHost(REX, probe({ contains: async () => false }));
	assert.match(outside.candidates.find((c) => c.host === "rex")!.reason!, /does not contain this Pi \(inherited REX_BLOCK\)/);
	const gone = await detectHost(TMUX, probe({ tmuxPaneTty: async () => { throw new Error("tmux is not installed or is not on PATH"); } }));
	assert.match(gone.candidates.find((c) => c.host === "tmux")!.reason!, /tmux is not installed/);
	// A Pi without a terminal never takes over a multiplexer it was started from.
	const headless = await detectHost({ ...TMUX, ...REX }, probe({ tty: async () => undefined }));
	assert.equal(headless.host, fallback);
	assert.deepEqual(headless.candidates.filter((c) => c.reason).map((c) => c.host), ["rex", "tmux"]);
	assert.ok(headless.candidates.every((c) => !c.reason || /no terminal of its own/.test(c.reason)));
});

test("PI_TEAM_HOST_VERIFY=markers trusts markers the host still answers for", async () => {
	const p = probe({ tty: async () => undefined, contains: async () => false, tmuxPaneTty: async () => "/dev/ttys001" });
	assert.equal((await detectHost({ ...TMUX, PI_TEAM_HOST_VERIFY: "markers" }, p)).host, "tmux");
	assert.equal((await detectHost({ ...REX, PI_TEAM_HOST_VERIFY: "markers" }, p)).host, "rex");
	assert.equal(p.calls.includes("tty"), false, "no process checks");
	const missing = await detectHost({ ...TMUX, PI_TEAM_HOST_VERIFY: "markers" }, probe({ tmuxPaneTty: async () => { throw new Error("tmux cannot find %3"); } }));
	assert.equal(missing.host, fallback, "the multiplexer must still know the terminal");
});

test("the in-memory host answers from markers until detection runs, and markers changing invalidate it", async () => {
	const env = { ...TMUX };
	const before = currentHost(env);
	assert.deepEqual([before.host, before.verified], ["tmux", false]);
	const refreshed = await refreshHost(env, probe({ tmuxPaneTty: async () => "/dev/ttys001" }));
	assert.equal(refreshed.host, fallback);
	assert.equal(currentHost(env), refreshed, "kept in memory");
	assert.equal(currentHost({ ...REX }).verified, false, "other markers are not answered from the cache");
	assert.equal((await refreshHost(env, probe())).host, "tmux", "refresh replaces it");
	assert.equal(currentHost(env).host, "tmux");
});

test("backend facts replace backend-name checks", () => {
	assert.equal(backendFacts(undefined).id, "tmux", "older saved configurations are tmux");
	assert.ok(isBackend("rex") && isBackend("native") && !isBackend("herdr") && !isBackend("toString"));
	assert.deepEqual(Object.values(BACKENDS).map((b) => [b.id, b.noun, b.beside, b.decoration, b.debugPane]), [["tmux", "pane", true, "label", true], ["rex", "block", true, "label", false], ["native", "terminal", false, "self", false], ["bb", "thread", true, "label", false]]);
	assert.ok(BACKENDS.bb.validLocation({ window: "proj_2suem3zvh5", leader: "thr_atjm6mifra" }) && !BACKENDS.bb.validLocation({ window: "native", leader: "native" }));
	assert.ok(BACKENDS.bb.launch && !BACKENDS.tmux.launch, "only bb starts member Pi itself");
	assert.ok(BACKENDS.tmux.validLocation({ window: "@1", leader: "%2" }) && !BACKENDS.tmux.validLocation({ window: "window:1", leader: "block:2" }));
	assert.ok(BACKENDS.rex.validLocation({ window: "window:0abc", leader: "block:0def" }));
	assert.deepEqual(BACKENDS.native.fixedLocation, { window: "native", leader: "native" });
	const err = new NoSessionHostError({ ...detectHostFromMarkers({}), unavailable: "no prebuilt terminal support, so members run detached" });
	assert.match(err.message, /members run detached/);
});

test("bb is verified against bb itself: unknown, archived or machine-less threads are skipped", async () => {
	const headless = { tty: async () => undefined };
	const unknown = await detectHost({ ...BB, BB_THREAD_ID: "thr_gone" }, probe(headless));
	assert.equal(unknown.host, fallback);
	assert.match(unknown.candidates[0].reason!, /bb does not know thread thr_gone/);
	const archived = await detectHost(BB, probe({ ...headless, bbThread: async () => ({ ...BB_THREAD, thread: { ...BB_THREAD.thread, archivedAt: "2026-11-23T00:00:00Z" } }) }));
	assert.match(archived.candidates[0].reason!, /archived/);
	const down = await detectHost(BB, probe({ ...headless, bbThread: async () => { throw new Error("connection refused"); } }));
	assert.match(down.candidates[0].reason!, /bb cannot answer: connection refused/);
	assert.equal(detectHostFromMarkers({ BB_THREAD_ID: "thr_x" }).candidates[0].detected, false, "BB_CLI is required to drive bb");
});
