import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtydClient, nativeHostSupport } from "../../src/terminal/native/client.ts";
import { DETACH_SEQUENCE, FRAME_DATA, FRAME_JSON, FrameReader, encodeFrame } from "../../src/terminal/native/protocol.ts";
import { NativeView, NATIVE_LOCATION } from "../../src/terminal/native.ts";
import { launchTerminal } from "../../src/executor/terminal.ts";
import type { LaunchSpec } from "../../src/executor/types.ts";
import { packageRoot } from "../../src/shared/paths.ts";
import { waitFor } from "../controller/helpers.ts";

const supported = !nativeHostSupport();
const require = createRequire(import.meta.url);
const detach = DETACH_SEQUENCE.replace("\x1b", "\\033").replace("\x07", "\\007");

async function withHost(fn: (client: PtydClient, dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pt-native-"));
	const client = new PtydClient(dir);
	try { await fn(client, dir); }
	finally {
		if (await client.running()) await client.request({ op: "shutdown" }).catch(() => {});
		await waitFor(async () => !await client.running(), "host stopped", 5000).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
}

test("ptyd hosts terminals that outlive their clients, repaints on attach, relays input and detaches on request", { skip: !supported, timeout: 30000 }, async () => {
	await withHost(async (client) => {
		await client.ensure();
		await client.ensure(); // idempotent; one daemon per state directory
		const spawned = await client.request<{ handle: string; pid: number }>({ op: "spawn", owner: "team", agent: "alpha", label: "Alpha [alpha]",
			command: ["/bin/sh", "-c", `echo "READY:$PI_TEAM_PTY"; read line; echo "GOT:$line"; read again; printf '${detach}'; sleep 30`], cwd: tmpdir() });
		assert.match(spawned.handle, /^pty:[0-9a-f]+$/);
		await waitFor(async () => (await client.info(spawned.handle)).alive, "spawned");
		await new Promise((r) => setTimeout(r, 300)); // output arrives with no client attached
		const { socket } = await client.attach(spawned.handle, 100, 30);
		let screen = "";
		const events: Array<{ event?: string; reason?: string }> = [];
		const reader = new FrameReader((type, payload) => { if (type === FRAME_DATA) screen += payload.toString(); else if (type === FRAME_JSON) events.push(JSON.parse(payload.toString())); });
		socket.on("data", (c: Buffer) => reader.push(c));
		socket.resume();
		await waitFor(() => screen.includes(`READY:${spawned.handle}`), "repainted screen includes output produced before attaching");
		assert.deepEqual([(await client.info(spawned.handle)).cols, (await client.info(spawned.handle)).rows], [100, 30], "attach sizes the terminal");
		socket.write(encodeFrame(FRAME_DATA, "hello\r"));
		await waitFor(() => screen.includes("GOT:hello"), "input relayed");
		socket.write(encodeFrame(FRAME_DATA, "go\r"));
		await waitFor(() => events.some((e) => e.event === "detach" && e.reason === "member"), "member-requested detach");
		const after = await client.info(spawned.handle);
		assert.equal(after.alive, true, "detaching never stops the member");
		assert.equal((await client.list("team")).length, 1);
		assert.equal((await client.list("other")).length, 0, "listing is scoped by team owner");

		const quick = await client.request<{ handle: string }>({ op: "spawn", owner: "team", agent: "beta", label: "Beta", command: ["/bin/sh", "-c", "exit 7"], cwd: tmpdir() });
		await waitFor(async () => !(await client.info(quick.handle)).alive, "exit recorded");
		assert.equal((await client.info(quick.handle)).exit_code, 7);
		await assert.rejects(client.attach(quick.handle, 80, 24), /has exited/);
		await client.request({ op: "kill", handle: quick.handle });
		await assert.rejects(client.info(quick.handle), /not found/);
	});
});

test("ptyd exits once nothing is hosted and nobody is connected", { skip: !supported, timeout: 30000 }, async () => {
	const previous = process.env.PI_TEAM_PTYD_IDLE_MS;
	process.env.PI_TEAM_PTYD_IDLE_MS = "300";
	try {
		await withHost(async (client, dir) => {
			await client.ensure();
			const { handle } = await client.request<{ handle: string }>({ op: "spawn", owner: "t", agent: "a", label: "A", command: ["/bin/sleep", "30"], cwd: tmpdir() });
			await new Promise((r) => setTimeout(r, 800));
			assert.equal(await client.running(), true, "a hosted member keeps the host alive");
			await client.request({ op: "kill", handle });
			await waitFor(async () => !await client.running(), "idle exit", 10000);
			assert.equal(existsSync(join(dir, "ptyd.lock")), false);
		});
	} finally { if (previous === undefined) delete process.env.PI_TEAM_PTYD_IDLE_MS; else process.env.PI_TEAM_PTYD_IDLE_MS = previous; }
});

test("executor launches a gated member into the built-in host and the member knows its terminal", { skip: !supported, timeout: 30000 }, async () => {
	await withHost(async (client, dir) => {
		const view = new NativeView({ stateDir: dir, runId: "run" });
		await view.open();
		const spec: LaunchSpec = {
			run_id: "run", agent_id: "worker-1", session_id: "session", spawn_intent_id: "intent", role: "Worker",
			provider: "default", model: "default", cwd: dir, pi_session_path: join(dir, "transcript"),
			enroll_file: join(dir, "enroll.json"), state_dir: dir, log_path: join(dir, "log"), bootstrap_prompt: "work", resume: false,
			terminal: { backend: "native", location: NATIVE_LOCATION },
		};
		writeFileSync(spec.enroll_file, "credential");
		const report = join(dir, "env.txt");
		writeFileSync(join(dir, "fake-pi.sh"), `env > ${JSON.stringify(report)}\nexec /bin/sleep 30\n`);
		const identity = await launchTerminal(spec, "/bin/sh", [join(dir, "fake-pi.sh")]);
		await waitFor(() => existsSync(report) && readFileSync(report, "utf8").includes("PI_TEAM_PTY="), "member started after its gate opened");
		const env = Object.fromEntries(readFileSync(report, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
		const member = (await view.member("worker-1"))!;
		assert.equal(env.PI_TEAM_PTY, member.id);
		assert.equal(env.PI_TEAM_PTYD, client.socketPath);
		assert.equal(env.TMUX, undefined);
		assert.equal(identity.pid, await view.paneProcess(member.id));
		// A relaunch replaces the member's terminal instead of adding a second one.
		const replaced = await view.launchAgent("worker-1", "Worker", ["/bin/sleep", "30"], dir);
		assert.notEqual(replaced, member.id);
		assert.deepEqual((await view.panes()).map((p) => p.id), [replaced]);
		await view.sync([{ agent_id: "worker-1", role: "Renamed", children: [] } as any]);
		assert.equal((await client.info(replaced)).label, "Renamed [worker-1]");
		await view.removeMember("worker-1");
		assert.deepEqual(await view.panes(), []);
		await assert.rejects(view.focus("worker-1"), /\/team watch focus worker-1/);
	});
});

test("pi-team-attach takes over a real terminal, shows the member, relays typing and returns on /team back or exit", { skip: !supported, timeout: 30000 }, async () => {
	const pty = require("@lydell/node-pty") as typeof import("@lydell/node-pty");
	await withHost(async (client, dir) => {
		await client.ensure();
		await client.request({ op: "spawn", owner: "team", agent: "alpha-1", label: "Alpha [alpha-1]",
			command: ["/bin/sh", "-c", `echo MEMBER-SCREEN; read line; echo "TYPED:$line"; read again; printf '${detach}'; sleep 30`], cwd: tmpdir() });
		const run = (target: string) => new Promise<{ code: number; output: string }>((resolve) => {
			const term = pty.spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(packageRoot(), "src/terminal/native/attach.ts"), "--state-dir", dir, target], { cols: 90, rows: 25, cwd: tmpdir(), env: { ...process.env } as Record<string, string> });
			let output = "", typed = false, second = false;
			term.onData((d) => {
				output += d;
				if (!typed && output.includes("MEMBER-SCREEN")) { typed = true; setTimeout(() => term.write("hi there\r"), 100); }
				if (!second && output.includes("TYPED:hi there")) { second = true; term.write("x\r"); }
			});
			term.onExit(({ exitCode }) => resolve({ code: exitCode, output }));
		});
		const first = await run("Alpha");
		assert.equal(first.code, 0, first.output);
		assert.match(first.output, /\x1b\[\?1049h[\s\S]*MEMBER-SCREEN[\s\S]*TYPED:hi there[\s\S]*\x1b\[\?1049l/, "alternate screen in, member output, alternate screen out");
		assert.equal((await client.list("team"))[0].alive, true, "member keeps running after the human leaves");

		await client.request({ op: "spawn", owner: "team", agent: "short-2", label: "Short [short-2]", command: ["/bin/sh", "-c", "echo SHORT; read x; exit 0"], cwd: tmpdir() });
		const second = await new Promise<{ code: number; output: string }>((resolve) => {
			const term = pty.spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(packageRoot(), "src/terminal/native/attach.ts"), "--state-dir", dir, "short-2"], { cols: 90, rows: 25, cwd: tmpdir(), env: { ...process.env } as Record<string, string> });
			let output = "", sent = false;
			term.onData((d) => { output += d; if (!sent && output.includes("SHORT")) { sent = true; setTimeout(() => term.write("bye\r"), 100); } });
			term.onExit(({ exitCode }) => resolve({ code: exitCode, output }));
		});
		assert.equal(second.code, 3, second.output);
		assert.match(second.output, /member terminal exited/);
	});
});
