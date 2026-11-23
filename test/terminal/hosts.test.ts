import { test } from "node:test";
import assert from "node:assert/strict";
import { currentHost, describeHost, detectHost, detectHostFromMarkers, refreshHost, NoSessionHostError, type HostProbe } from "../../src/terminal/hosts.ts";
import { BACKENDS, backendFacts, isBackend } from "../../src/terminal/backends.ts";
import { nativeHostSupport } from "../../src/terminal/native/client.ts";

const REX = { REX_SERVER: "unix:///tmp/rex.sock", REX_BLOCK: "block:01a1fc1c-2d5d-74ab-97fe-f900d30e3203" };
const TMUX = { TMUX: "/tmp/mux,1,0", TMUX_PANE: "%3" };
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
		...over,
	};
}

test("hosts are tried richest first: bb, Rex, tmux, then the built-in host, then detached", async () => {
	const all = { BB_THREAD_ID: "thr_1", ...REX, ...TMUX };
	const d = await detectHost(all, probe());
	assert.equal(d.host, "rex", "bb is detected but has no member backend yet, so Rex wins over tmux");
	assert.deepEqual(d.candidates.map((c) => [c.host, c.detected, c.usable]), [["bb", true, false], ["rex", true, true], ["tmux", true, undefined], ["native", true, undefined], ["detached", true, undefined]]);
	assert.match(d.candidates[0].reason!, /bb member threads are not implemented/);
	assert.deepEqual({ backend: d.backend, leader: d.leader, sessions: d.sessions, beside: d.beside, decoration: d.decoration, verified: d.verified }, { backend: "rex", leader: REX.REX_BLOCK, sessions: true, beside: true, decoration: "label", verified: true });
	assert.equal((await detectHost(TMUX, probe())).host, "tmux");
	assert.equal((await detectHost({ ...TMUX, ...REX }, probe())).host, "rex", "tmux inside Rex: the richer host wins");
	const plain = await detectHost({}, probe());
	assert.equal(plain.host, fallback);
	assert.equal(plain.beside, false);
	assert.equal(plain.decoration, "self", "nothing on screen labels a member, so it draws its own header");
	assert.match(describeHost(d), /bb: skipped: bb member threads[\s\S]*→ Rex: selected[\s\S]*tmux: detected, not needed[\s\S]*detached workers: fallback/);
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
	// A Pi without a terminal (bb's RPC threads) never takes over a multiplexer it was started from.
	const bb = await detectHost({ BB_THREAD_ID: "thr_1", ...TMUX, ...REX }, probe({ tty: async () => undefined }));
	assert.equal(bb.host, fallback);
	assert.deepEqual(bb.candidates.filter((c) => c.reason).map((c) => c.host), ["bb", "rex", "tmux"]);
	assert.ok(bb.candidates.every((c) => !c.reason || /not implemented|no terminal of its own/.test(c.reason)));
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
	assert.deepEqual(Object.values(BACKENDS).map((b) => [b.id, b.noun, b.beside, b.decoration, b.debugPane]), [["tmux", "pane", true, "label", true], ["rex", "block", true, "label", false], ["native", "terminal", false, "self", false]]);
	assert.ok(BACKENDS.tmux.validLocation({ window: "@1", leader: "%2" }) && !BACKENDS.tmux.validLocation({ window: "window:1", leader: "block:2" }));
	assert.ok(BACKENDS.rex.validLocation({ window: "window:0abc", leader: "block:0def" }));
	assert.deepEqual(BACKENDS.native.fixedLocation, { window: "native", leader: "native" });
	const err = new NoSessionHostError({ ...detectHostFromMarkers({}), unavailable: "no prebuilt terminal support, so members run detached" });
	assert.match(err.message, /members run detached/);
});
