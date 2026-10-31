// REAL Pi smoke tests (pinned Pi 1.4.0 on PATH). Each run uses an isolated PI_CODING_AGENT_DIR,
// an isolated PI_TEAM_STATE_DIR, --offline and --no-session. Never touches ~/.pi/agent.
//
// Driver: `pi --mode rpc --offline --no-session [-ne -e ./src/extension/index.ts]`
//   stdin : {"type":"get_commands"} and {"type":"prompt","message":"/team ..."}  (extension commands run via prompt)
//   stdout: responses + extension_ui_request records (ctx.ui.notify / setStatus are forwarded in RPC mode)
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES } from "../../src/extension/names.ts";
import { IDENTITY_ENTRY } from "../../src/extension/runtime.ts";
import { ENV_ENROLL_FILE } from "../../src/shared/protocol.ts";
import { makeState, shortTmp, startMock } from "./helpers.ts";
import { startFakeOpenAI } from "../fixtures/fake-openai.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = join(ROOT, "src", "extension", "index.ts");
const havePi = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;
const skip = havePi ? false : "pi not on PATH";

interface RpcRun {
	records: any[];
	stderr: string;
	send: (cmd: object) => void;
	waitFor: (pred: (r: any) => boolean, ms?: number, what?: string) => Promise<any>;
	close: () => Promise<number | null>;
}

function startRpc(args: string[], env: Record<string, string | undefined>): RpcRun {
	const child = spawn("pi", ["--mode", "rpc", "--offline", "--no-session", ...args], {
		cwd: ROOT,
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const records: any[] = [];
	let buf = "";
	let stderr = "";
	const waiters: (() => void)[] = [];
	child.stdout.on("data", (d: Buffer) => {
		buf += d.toString("utf8");
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, "");
			buf = buf.slice(i + 1);
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line));
			} catch {
				records.push({ type: "__unparsed", line });
			}
			for (const w of [...waiters]) w();
		}
	});
	child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
	const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
	return {
		records,
		get stderr() {
			return stderr;
		},
		send: (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n"),
		waitFor: (pred, ms = 20_000, what = "record") =>
			new Promise((res, rej) => {
				const check = () => {
					const hit = records.find(pred);
					if (hit) {
						clearTimeout(t);
						waiters.splice(waiters.indexOf(check), 1);
						res(hit);
					}
				};
				const t = setTimeout(() => {
					waiters.splice(waiters.indexOf(check), 1);
					rej(new Error(`timeout waiting for ${what}; got ${JSON.stringify(records).slice(0, 2000)}; stderr=${stderr.slice(0, 2000)}`));
				}, ms);
				waiters.push(check);
				check();
			}),
		close: async () => {
			child.stdin.end();
			const k = setTimeout(() => child.kill("SIGTERM"), 3_000);
			const code = await exited;
			clearTimeout(k);
			return code;
		},
	};
}

const notify = (re: RegExp) => (r: any) => r.type === "extension_ui_request" && r.method === "notify" && re.test(r.message);
const status = (re: RegExp) => (r: any) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "team" && re.test(r.statusText ?? "");
const response = (id: string) => (r: any) => r.type === "response" && r.id === id;

const tmpRoots: string[] = [];
after(() => {
	for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});
function isolatedAgentDir(): string {
	const root = shortTmp("pia-");
	tmpRoots.push(root);
	const d = join(root, "agent");
	mkdirSync(d, { recursive: true });
	return d;
}

function assertNoExtensionErrors(run: RpcRun) {
	assert.doesNotMatch(run.stderr, /pi-aatwad|pi-recursive-team|src\/extension/i, `extension errors on stderr:\n${run.stderr}`);
	assert.ok(!run.records.some((r) => r.type === "extension_error"), "extension_error record");
}

describe("real Pi smoke", { skip }, () => {
	test("pi -e loads the extension: /team command + all team tools register, plain session stays unenrolled", async () => {
		const { paths, cleanup } = makeState();
		const run = startRpc(["-ne", "-e", EXT], { PI_CODING_AGENT_DIR: isolatedAgentDir(), PI_TEAM_STATE_DIR: paths.dir, [ENV_ENROLL_FILE]: undefined });
		try {
			run.send({ id: "cmds", type: "get_commands" });
			const cmds = await run.waitFor(response("cmds"), 30_000, "get_commands");
			const team = cmds.data.commands.find((c: any) => c.name === "team");
			assert.ok(team, "team command registered");
			assert.equal(team.source, "extension");

			run.send({ id: "help", type: "prompt", message: "/team help" });
			const help = await run.waitFor(notify(/pi-recursive-team/), 10_000, "/team help notify");
			assert.match(help.message, /tools \(14\/14\)/);
			for (const t of TOOL_NAMES) assert.ok(help.message.includes(t), `tool ${t} registered`);
			assert.match(help.message, /identity: not enrolled/);
			const disp = await run.waitFor(response("help"));
			assert.equal(disp.data.disposition, "handled");

			run.send({ id: "st", type: "prompt", message: "/team status" });
			const st = await run.waitFor(notify(/^controller:/), 10_000, "/team status");
			assert.match(st.message, /controller: not running/);

			run.send({ id: "w", type: "prompt", message: "/team watch" });
			await run.waitFor(notify(/No resumable teams/), 10_000, "/team watch");

			// unenrolled: nothing created in the state dir (no controller, socket, db)
			assert.deepEqual(readdirSync(paths.dir).filter((f) => !["enroll", "workers"].includes(f)), []);
			assertNoExtensionErrors(run);
		} finally {
			await run.close();
			cleanup();
		}
	});

	test("pi -p (print mode) runs /team subcommands without a model and writes to stderr", () => {
		const { paths, cleanup } = makeState();
		try {
			const r = spawnSync("pi", ["-p", "--offline", "--no-session", "-ne", "-e", EXT, "/team watch"], {
				cwd: ROOT,
				encoding: "utf8",
				timeout: 30_000,
				env: { ...process.env, PI_CODING_AGENT_DIR: isolatedAgentDir(), PI_TEAM_STATE_DIR: paths.dir, PI_OFFLINE: "1" },
			});
			assert.equal(r.status, 0, r.stderr);
			assert.match(r.stderr, /No resumable teams/);
		} finally {
			cleanup();
		}
	});

	test("/team init through real Pi against a mock controller enrolls the root and sets status", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths, { operatorToken: "op-xyz" });
		m.route("POST", "/runs", () => ({
			body: {
				run_id: "run-A",
				root_agent_id: "ag-root",
				session_id: "ses-1",
				token: "root-token",
				envelope: { max_subtree_slots: 4, max_subtree_usd: 10, max_session_seconds: 3600, max_grant_slots: 2, max_grant_usd: 5, allowed_providers: [], allowed_capabilities: [] },
			},
		}));
		m.route("GET", "/me", () => ({
			body: { run_id: "run-A", agent_id: "ag-root", session_id: "ses-1", role: "root", is_root: true, parent: null, children: [], tasks: [], pending_proposals_to_review: 0, inbox_pending: 0, desired_state: "RUNNING", topology_version: 1 },
		}));
		m.route("POST", "/sessions/heartbeat", () => ({ body: { lease_until: "x", inbox_pending: 0, desired_state: "RUNNING" } }));
		const run = startRpc(["-ne", "-e", EXT], { PI_CODING_AGENT_DIR: isolatedAgentDir(), PI_TEAM_STATE_DIR: paths.dir, [ENV_ENROLL_FILE]: undefined });
		try {
			run.send({ id: "init", type: "prompt", message: "/team init" });
			const n = await run.waitFor(notify(/team run run-A created/), 20_000, "init notify");
			assert.match(n.message, /root agent ag-root/);
			await run.waitFor(status(/team root ag-root · run run-A/), 10_000, "status line");
			const create = m.requests.find((r) => r.method === "POST" && r.path === "/runs")!;
			assert.equal(create.headers.authorization, "Bearer op-xyz");
			assert.ok(create.headers["idempotency-key"]);
			assert.equal(create.body.root.role, "root");
			assert.ok(create.body.root.pi_session_id, "pi session id sent");
			// heartbeat uses the agent session token, not the operator token
			await new Promise((r) => setTimeout(r, 300));
			const hb = m.requests.find((r) => r.path === "/sessions/heartbeat");
			assert.equal(hb?.headers.authorization, "Bearer root-token");
			run.send({ id: "entries", type: "get_entries" });
			const ents = await run.waitFor(response("entries"), 10_000, "get_entries");
			const flat = JSON.stringify(ents.data);
			assert.ok(flat.includes(IDENTITY_ENTRY), "identity entry persisted via appendEntry");
			assert.ok(!flat.includes("root-token"), "token never persisted");
			assertNoExtensionErrors(run);
		} finally {
			await run.close();
			await m.close();
			cleanup();
		}
	});

	test("managed child: PI_TEAM_ENROLL_FILE is consumed and the worker enrolls on session_start", async () => {
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		m.route("POST", "/enroll", () => ({ body: { run_id: "run-A", agent_id: "ag-kid", session_id: "ses-k", token: "kid-token", parent_id: "ag-root", task_id: "t1" } }));
		m.route("GET", "/me", () => ({
			body: { run_id: "run-A", agent_id: "ag-kid", session_id: "ses-k", role: "tester", is_root: false, parent: { agent_id: "ag-root", role: "root" }, children: [], tasks: [], pending_proposals_to_review: 0, inbox_pending: 0, desired_state: "RUNNING", topology_version: 2 },
		}));
		m.route("POST", "/sessions/heartbeat", () => ({ body: { lease_until: "x", inbox_pending: 0, desired_state: "RUNNING" } }));
		const file = join(paths.enrollDir, "kid.json");
		writeFileSync(file, JSON.stringify({ version: 1, socket_path: paths.socket, run_id: "run-A", agent_id: "ag-kid", spawn_intent_id: "si-1", token: "otp", expires_at: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
		const run = startRpc(["-ne", "-e", EXT], { PI_CODING_AGENT_DIR: isolatedAgentDir(), PI_TEAM_STATE_DIR: paths.dir, [ENV_ENROLL_FILE]: file });
		try {
			await run.waitFor(status(/team tester ag-kid · run run-A · managed/), 20_000, "managed status");
			assert.ok(!existsSync(file), "enrollment file deleted");
			const en = m.requests.find((r) => r.path === "/enroll")!;
			assert.equal(en.body.token, "otp");
			assert.equal(typeof en.body.pid, "number");
			run.send({ id: "init", type: "prompt", message: "/team init" });
			await run.waitFor(notify(/managed workers cannot run \/team init/), 10_000, "init refused in child");
			assertNoExtensionErrors(run);
		} finally {
			await run.close();
			await m.close();
			cleanup();
		}
	});

	test("pi install of the package into an ISOLATED agent dir loads it from the manifest", async () => {
		const realSettings = join(homedir(), ".pi", "agent", "settings.json");
		const hash = () => (existsSync(realSettings) ? createHash("sha256").update(readFileSync(realSettings)).digest("hex") : "absent");
		const before = hash();
		const agentDir = isolatedAgentDir();
		const { paths, cleanup } = makeState();
		try {
			const inst = spawnSync("pi", ["install", ROOT], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
			assert.equal(inst.status, 0, inst.stderr + inst.stdout);
			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
			assert.equal(settings.packages.length, 1);
			const list = spawnSync("pi", ["list"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
			assert.ok(list.stdout.includes(ROOT), list.stdout);
			const run = startRpc([], { PI_CODING_AGENT_DIR: agentDir, PI_TEAM_STATE_DIR: paths.dir, [ENV_ENROLL_FILE]: undefined });
			try {
				run.send({ id: "cmds", type: "get_commands" });
				const cmds = await run.waitFor(response("cmds"), 30_000, "get_commands");
				const team = cmds.data.commands.find((c: any) => c.name === "team");
				assert.ok(team, "team command from installed package");
				assert.equal(team.sourceInfo.origin, "package");
				run.send({ id: "help", type: "prompt", message: "/team help" });
				const help = await run.waitFor(notify(/tools \(14\/14\)/), 10_000, "help");
				assert.ok(help);
				assertNoExtensionErrors(run);
			} finally {
				await run.close();
			}
		} finally {
			cleanup();
			assert.equal(hash(), before, "user's real ~/.pi/agent/settings.json untouched");
		}
	});
	test("managed ONE-SHOT worker (exact executor argv, fake LLM): enrolls, gets org context + start inbox, continues once on new work, then exits", async () => {
		const fake = await startFakeOpenAI();
		const { paths, cleanup } = makeState();
		const m = await startMock(paths);
		const agentDir = isolatedAgentDir();
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { fakeoai: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "fake-1" }] } } }),
		);
		m.route("POST", "/enroll", () => ({ body: { run_id: "run-A", agent_id: "ag-kid", session_id: "ses-k", token: "kid-token", parent_id: "ag-root", task_id: "t1" } }));
		m.route("GET", "/me", () => ({
			body: {
				run_id: "run-A", agent_id: "ag-kid", session_id: "ses-k", role: "tester", is_root: false, parent: { agent_id: "ag-root", role: "root" }, children: [],
				tasks: [{ task_id: "t1", title: "write the tests", status: "IN_PROGRESS", parent_task_id: null }], pending_proposals_to_review: 0, inbox_pending: 0, desired_state: "RUNNING", topology_version: 2,
			},
		}));
		m.route("POST", "/sessions/heartbeat", () => ({ body: { lease_until: "x", inbox_pending: 0, desired_state: "RUNNING" } }));
		const msg = (id: string, text: string) => ({ version: 1, message_id: id, run_id: "run-A", type: "task.assigned", from: "ag-root", to: "ag-kid", payload: { text } });
		let inboxCalls = 0;
		m.route("GET", "/inbox", () => {
			inboxCalls++;
			if (inboxCalls === 1) return { body: { messages: [msg("m-start", "START-WORK-ITEM")] } }; // before_agent_start
			if (inboxCalls === 2) return { body: { messages: [msg("m-late", "LATE-WORK-ITEM")] } }; // first agent_before_settle
			return { body: { messages: [msg("m-late", "LATE-WORK-ITEM")] } }; // redelivery (dup) -> must not loop
		});
		m.route("POST", /^\/messages\/[^/]+\/ack$/, () => ({ body: { acked: true } }));
		const file = join(paths.enrollDir, "w.json");
		writeFileSync(file, JSON.stringify({ version: 1, socket_path: paths.socket, run_id: "run-A", agent_id: "ag-kid", spawn_intent_id: "si-1", token: "otp", expires_at: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
		const fakeHome = shortTmp("pih-");
		tmpRoots.push(fakeHome);
		const session = join(shortTmp("pis-"), "kid.jsonl");
		tmpRoots.push(dirname(session));
		try {
			const r = await new Promise<{ code: number | null; out: string; err: string }>((res) => {
				const c = spawn("pi", ["--mode", "json", "-p", "--session", session, "--provider", "fakeoai", "--model", "fake-1", "-e", EXT, "--", "BOOTSTRAP-PROMPT"], {
					cwd: ROOT,
					env: {
						// Exactly what the executor passes: NO PI_TEAM_STATE_DIR (finding 7); decoy HOME/XDG so a
						// stray statePaths() default would be observable.
						...process.env, PI_TEAM_STATE_DIR: undefined, HOME: fakeHome, XDG_STATE_HOME: join(fakeHome, "xdg"),
						PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", [ENV_ENROLL_FILE]: file,
						PI_TEAM_LAUNCH_TOKEN: "lt-1", PI_TEAM_AGENT_ID: "ag-kid", PI_TEAM_RUN_ID: "run-A", PI_TEAM_RESUME: "0",
					},
					stdio: ["ignore", "pipe", "pipe"],
				});
				let out = "";
				let err = "";
				c.stdout.on("data", (d) => (out += d));
				c.stderr.on("data", (d) => (err += d));
				const t = setTimeout(() => c.kill("SIGKILL"), 45_000);
				c.on("exit", (code) => {
					clearTimeout(t);
					res({ code, out, err });
				});
			});
			assert.equal(r.code, 0, r.err);
			assert.ok(!existsSync(file), "enrollment credential consumed");
			const en = m.requests.find((x) => x.path === "/enroll")!;
			assert.equal(en.body.launch_token, "lt-1");
			assert.equal(fake.requests.length, 2, `exactly one continuation; ctrl=${m.requests.map((x) => x.method + " " + x.path).join(",")} err=${r.err.slice(0, 2000)}`);
			const sys0 = fake.requests[0].messages.filter((x) => x.role === "system").map((x) => x.text).join("\n");
			assert.match(sys0, /team_org_context/);
			assert.match(sys0, /agent ag-kid \(role: tester\)/);
			assert.match(sys0, /t1 IN_PROGRESS: write the tests/);
			const all0 = fake.requests[0].messages.map((x) => x.text).join("\n");
			assert.match(all0, /BOOTSTRAP-PROMPT/);
			assert.match(all0, /START-WORK-ITEM/, "inbox pending at run start rides along with the first run");
			const all1 = fake.requests[1].messages.map((x) => x.text).join("\n");
			assert.match(all1, /LATE-WORK-ITEM/, "new work injected before settling");
			assert.equal(inboxCalls, 3, "claimed at start, at first settle, at second settle (dup -> exit)");
			for (const id of ["m-start", "m-late"]) assert.ok(m.requests.some((x) => x.path === `/messages/${id}/ack`), `ack ${id}`);
			// The worker never located/created the default state dir and never read the operator token.
			assert.ok(!existsSync(join(fakeHome, "Library", "Application Support", "pi-recursive-team")), "no default state dir (macOS)");
			assert.ok(!existsSync(join(fakeHome, "xdg", "pi-recursive-team")), "no default state dir (XDG)");
			assert.ok(!existsSync(paths.operatorToken), "operator token never needed");
			const transcript = readFileSync(session, "utf8");
			assert.ok(transcript.includes("pi-recursive-team/inbox") && !transcript.includes("kid-token"));
		} finally {
			await m.close();
			await fake.close();
			cleanup();
		}
	});
	test("a second physical copy of the extension is ignored (double-load guard)", async () => {
		const copyRoot = shortTmp("pic-");
		tmpRoots.push(copyRoot);
		cpSync(join(ROOT, "src"), join(copyRoot, "src"), { recursive: true });
		const { paths, cleanup } = makeState();
		const run = startRpc(["-ne", "-e", EXT, "-e", join(copyRoot, "src", "extension", "index.ts")], { PI_CODING_AGENT_DIR: isolatedAgentDir(), PI_TEAM_STATE_DIR: paths.dir, [ENV_ENROLL_FILE]: undefined });
		try {
			await run.waitFor(notify(/duplicate copy .* ignored/), 20_000, "duplicate warning");
			run.send({ id: "cmds", type: "get_commands" });
			const cmds = await run.waitFor(response("cmds"), 20_000, "get_commands");
			assert.equal(cmds.data.commands.filter((c: any) => c.name === "team").length, 1);
			run.send({ id: "help", type: "prompt", message: "/team help" });
			await run.waitFor(notify(/tools \(14\/14\)/), 10_000, "help");
		} finally {
			await run.close();
			cleanup();
		}
	});
});
