import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createExecutor,
	PiExecutor,
	ScriptExecutor,
	buildWorkerEnv,
	probeIdentity,
	processStartTimeSync,
} from "../../src/executor/index.ts";
import type { ProcessIdentity } from "../../src/executor/index.ts";
import { FIXTURES, alive, makeSpec, tmp, until } from "./helpers.ts";

const SLEEPER = join(FIXTURES, "sleeper.ts");
const started: ProcessIdentity[] = [];
after(() => {
	for (const id of started) {
		try {
			process.kill(-id.pid, "SIGKILL");
		} catch {}
	}
});

async function launchSleeper(extraEnv: Record<string, string> = {}) {
	const dir = tmp();
	const out = join(dir, "out.json");
	const prev = { ...process.env };
	Object.assign(process.env, { PI_TEAM_FAKE_OUT: out }, extraEnv);
	try {
		const spec = makeSpec(dir);
		const id = await new ScriptExecutor(SLEEPER).launch(spec);
		started.push(id);
		await until(() => existsSync(out));
		await until(() => readFileSync(out, "utf8").length > 0);
		const info = JSON.parse(readFileSync(out, "utf8")) as { pid: number; grandchild: number; env_keys: string[] };
		return { dir, spec, id, info };
	} finally {
		for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
		Object.assign(process.env, prev);
	}
}

test("createExecutor selects by PI_TEAM_EXECUTOR", () => {
	assert.ok(createExecutor({}) instanceof PiExecutor);
	assert.ok(createExecutor({ PI_TEAM_EXECUTOR: "pi" }) instanceof PiExecutor);
	const s = createExecutor({ PI_TEAM_EXECUTOR: SLEEPER });
	assert.ok(s instanceof ScriptExecutor);
	assert.equal((s as ScriptExecutor).script, SLEEPER);
});

test("buildWorkerEnv passes only the allowlist + team contract", () => {
	const spec = makeSpec(tmp());
	const env = buildWorkerEnv(spec, "LT", {
		PATH: "/bin",
		HOME: "/h",
		ANTHROPIC_API_KEY: "sk-ant-x",
		AWS_SECRET_ACCESS_KEY: "aws",
		MY_RANDOM_SECRET: "nope",
		GITHUB_TOKEN: "nope",
		PI_SESSION_FILE: "/parent/session.jsonl",
		PI_SESSION_ID: "parent",
		PI_TEAM_ENROLL_FILE: "/parent/enroll",
		PI_TEAM_STATE_DIR: "/parent/state",
		PI_TEAM_EXECUTOR: "/x.ts",
		PI_TEAM_FAKE_SCRIPT: "/s.json",
	});
	assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-x");
	assert.equal(env.AWS_SECRET_ACCESS_KEY, "aws");
	assert.equal(env.PATH, "/bin");
	for (const k of ["MY_RANDOM_SECRET", "GITHUB_TOKEN", "PI_SESSION_FILE", "PI_SESSION_ID", "PI_TEAM_EXECUTOR", "PI_TEAM_FAKE_SCRIPT"]) {
		assert.equal(env[k], undefined, k);
	}
	assert.equal(env.PI_TEAM_ENROLL_FILE, spec.enroll_file);
	assert.equal(env.PI_TEAM_STATE_DIR, undefined, "state dir never reaches workers (finding 7)");
	assert.equal(env.PI_TEAM_LAUNCH_TOKEN, "LT");
	// ScriptExecutor's extra prefix
	assert.equal(buildWorkerEnv(spec, "LT", { PI_TEAM_FAKE_SCRIPT: "/s.json" }, ["PI_TEAM_FAKE_"]).PI_TEAM_FAKE_SCRIPT, "/s.json");
});

test("launch returns identity; probe alive; pid-reuse guard; stop kills the whole group", async () => {
	const { id, info } = await launchSleeper();
	assert.equal(info.pid, id.pid);
	assert.ok(id.launch_token.length >= 20);
	assert.match(id.process_started_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
	assert.equal(processStartTimeSync(id.pid), id.process_started_at);
	assert.equal(await probeIdentity(id), "alive");
	// Same pid, different start time (= pid reused by another process) -> dead, and stop is a no-op.
	const forged = { pid: id.pid, process_started_at: "2001-01-01T00:00:00.000Z" };
	assert.equal(await probeIdentity(forged), "dead");
	const ex = new ScriptExecutor(SLEEPER);
	await ex.stop(forged, 100);
	assert.ok(alive(id.pid), "stop with mismatched identity must not kill");
	// Detached => own process group led by the worker; grandchild is in it.
	const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(info.grandchild)]).toString().trim());
	assert.equal(pgid, id.pid);
	await ex.stop(id, 2000);
	assert.equal(await ex.probe(id), "dead");
	await until(() => !alive(info.grandchild), 3000);
	await ex.stop(id); // idempotent
});

test("stop escalates to SIGKILL when SIGTERM is ignored", async () => {
	const { id, info } = await launchSleeper({ PI_TEAM_FAKE_IGNORE_TERM: "1" });
	const ex = new ScriptExecutor(SLEEPER);
	const t0 = Date.now();
	await ex.stop(id, 300);
	assert.ok(Date.now() - t0 >= 300);
	assert.equal(await ex.probe(id), "dead");
	await until(() => !alive(info.grandchild), 3000);
});

test("probe of a nonexistent pid is dead", async () => {
	assert.equal(await probeIdentity({ pid: 999_999, process_started_at: "x" }), "dead");
	assert.equal(await probeIdentity({ pid: 0, process_started_at: "x" }), "dead");
	assert.equal(await probeIdentity({ pid: process.pid, process_started_at: "" }), "dead");
});

test("worker survives the launching process being SIGKILLed", async () => {
	const dir = tmp();
	const out = join(dir, "out.json");
	const spec = makeSpec(dir);
	// A separate "controller" process launches the worker, prints the identity, then hangs until killed.
	const code = `
		import { ScriptExecutor } from ${JSON.stringify(new URL("../../src/executor/index.ts", import.meta.url).href)};
		const id = await new ScriptExecutor(${JSON.stringify(SLEEPER)}).launch(${JSON.stringify(spec)});
		process.stdout.write(JSON.stringify(id) + "\\n");
		setInterval(() => {}, 1 << 30);`;
	const launcher = spawn(process.execPath, ["--input-type=module", "-e", code], {
		env: { ...process.env, PI_TEAM_FAKE_OUT: out },
		stdio: ["ignore", "pipe", "inherit"],
	});
	let stdout = "";
	launcher.stdout.on("data", (c) => (stdout += c));
	await until(() => stdout.includes("\n"), 10_000);
	const id = JSON.parse(stdout) as ProcessIdentity;
	started.push(id);
	launcher.kill("SIGKILL");
	await until(() => launcher.exitCode !== null || launcher.signalCode !== null);
	await until(() => existsSync(out));
	assert.equal(await probeIdentity(id), "alive", "worker must outlive its launcher");
	const ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(id.pid)]).toString().trim());
	assert.notEqual(ppid, launcher.pid);
	await new ScriptExecutor(SLEEPER).stop(id, 1000);
	assert.equal(await probeIdentity(id), "dead");
});

test("launch log has a launch record but no env secrets or enrollment token", async () => {
	const secret = "sk-ant-TEST-SECRET-9f8e7d";
	const { spec, id, info } = await launchSleeper({ ANTHROPIC_API_KEY: secret });
	// The secret reached the worker via env...
	assert.ok(info.env_keys.includes("ANTHROPIC_API_KEY"));
	assert.ok(info.env_keys.includes("PI_TEAM_LAUNCH_TOKEN"));
	await new ScriptExecutor(SLEEPER).stop(id, 1000);
	const log = readFileSync(spec.log_path, "utf8");
	assert.match(log, /"event":"launch"/);
	assert.match(log, /"event":"launched"/);
	assert.match(log, /ANTHROPIC_API_KEY/); // key name is fine
	assert.ok(!log.includes(secret), "log must not contain secret value");
	assert.ok(!log.includes("ENROLL-SECRET"), "log must not contain enrollment token");
	assert.ok(!log.includes(id.launch_token), "log must not contain launch token");
});

test("launch rejects when the binary does not exist", async () => {
	const spec = makeSpec(tmp());
	await assert.rejects(new PiExecutor({ piBin: "/nonexistent/pi-binary" }).launch(spec), /ENOENT/);
	assert.match(readFileSync(spec.log_path, "utf8"), /launch_failed/);
});
