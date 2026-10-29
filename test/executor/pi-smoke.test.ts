// PiExecutor smoke test against the real `pi` binary (1.4.0) WITHOUT any paid LLM:
// * PI_CODING_AGENT_DIR -> temp dir (never touches ~/.pi/agent/settings.json or auth.json)
// * models.json in that dir defines provider "fakeoai" -> local fake OpenAI server (test/fixtures/fake-openai.ts)
// Verifies: flags accepted, detached launch, -e extension loaded with team env, session file
// created, and resume=true reloads the transcript from the same --session path.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiExecutor, buildPiArgs, DEFAULT_RESUME_PROMPT } from "../../src/executor/index.ts";
import { startFakeOpenAI } from "../fixtures/fake-openai.ts";
import type { FakeOpenAI } from "../fixtures/fake-openai.ts";
import { FIXTURES, makeSpec, tmp, until } from "./helpers.ts";

let piVersion = "";
try {
	piVersion = execFileSync("pi", ["--version"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {}
const skip = piVersion ? false : "pi not on PATH";

let fake: FakeOpenAI;
let agentDir = "";
const savedEnv = { ...process.env };

before(async () => {
	if (skip) return;
	fake = await startFakeOpenAI();
	agentDir = tmp("pt-piagent-");
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { fakeoai: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "fake-1" }] } } }),
	);
	// Both are on the worker env allowlist, so they reach the detached pi.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
});
after(async () => {
	process.env = savedEnv;
	await fake?.close();
});

test("buildPiArgs: fresh vs resume", () => {
	const spec = makeSpec(tmp());
	const fresh = buildPiArgs(spec, "/pkg/src/extension/index.ts");
	assert.deepEqual(fresh, [
		"--mode", "json", "-p", "--session", spec.pi_session_path, "--provider", "fakeoai", "--model", "fake-1",
		"-e", "/pkg/src/extension/index.ts", "--", spec.bootstrap_prompt,
	]);
	const resumed = buildPiArgs({ ...spec, resume: true }, "/e.ts");
	assert.equal(resumed.at(-1), DEFAULT_RESUME_PROMPT);
	assert.equal(buildPiArgs({ ...spec, resume: true, resume_prompt: "go on" }, "/e.ts").at(-1), "go on");
	assert.deepEqual(resumed.slice(0, -1), [...fresh.slice(0, 9), "-e", "/e.ts", "--"]);
});

test("real pi 1.4.0 accepts the worker command line; fresh launch then resume", { skip, timeout: 60_000 }, async () => {
	assert.match(piVersion, /^1\.4\./, `expected pi 1.4.x, got ${piVersion}`);
	const dir = tmp("pt-pismoke-");
	const cwd = join(dir, "ws");
	mkdirSync(cwd);
	const extOut = join(dir, "ext.jsonl");
	process.env.PI_TEAM_FAKE_EXT_OUT = extOut; // not allowlisted for PiExecutor -> extension falls back
	const ex = new PiExecutor({ extensionPath: join(FIXTURES, "pi-probe-extension.ts") });
	const spec = makeSpec(dir, { cwd, bootstrap_prompt: "-starts with a dash: first prompt" });

	const id1 = await ex.launch(spec);
	assert.ok(id1.pid > 0 && id1.process_started_at);
	await until(async () => (await ex.probe(id1)) === "dead", 30_000, 100);
	const log1 = readFileSync(spec.log_path, "utf8");
	assert.doesNotMatch(log1, /Unknown option|Failed to load extension|No API key/, log1);
	assert.match(log1, /^\{"type":"session","version":3,"id":"[^"]+"/m, log1);
	assert.match(log1, /"type":"agent_settled"/, log1);
	assert.ok(existsSync(spec.pi_session_path), "session file created at --session path");
	assert.equal(fake.requests.length, 1);
	assert.deepEqual(fake.requests[0].filter((m) => m.role !== "system").map((m) => m.text), ["-starts with a dash: first prompt"]);
	// -e extension was loaded in the worker and saw the env contract (PI_TEAM_FAKE_EXT_OUT is not passed to pi workers).
	const extFile = `${spec.enroll_file}.ext-loaded`;
	assert.ok(!existsSync(extOut));
	const ext1 = JSON.parse(readFileSync(extFile, "utf8").trim().split("\n")[0]);
	assert.deepEqual(ext1, { pid: id1.pid, has_enroll_file: true, has_state_dir: true, has_launch_token: true, resume: "0" });

	// Resume: same --session path -> transcript reloaded, same session id.
	const sessionId = /"type":"session","version":3,"id":"([^"]+)"/.exec(log1)![1];
	const id2 = await ex.launch({ ...spec, resume: true });
	await until(async () => (await ex.probe(id2)) === "dead", 30_000, 100);
	assert.equal(fake.requests.length, 2);
	assert.deepEqual(
		fake.requests[1].filter((m) => m.role !== "system").map((m) => `${m.role}:${m.text}`),
		["user:-starts with a dash: first prompt", "assistant:ACK", `user:${DEFAULT_RESUME_PROMPT}`],
	);
	const log2 = readFileSync(spec.log_path, "utf8");
	const ids = [...log2.matchAll(/"type":"session","version":3,"id":"([^"]+)"/g)].map((m) => m[1]);
	assert.deepEqual(ids, [sessionId, sessionId]);
	assert.match(readFileSync(extFile, "utf8"), /"resume":"1"/);
});

test("pi rejects an unknown flag (so the smoke test would catch bad flags)", { skip }, () => {
	let out = "";
	let status = 0;
	try {
		execFileSync("pi", ["--mode", "json", "-p", "--definitely-not-a-flag-zz", "--no-session", "x"], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 20_000,
		});
	} catch (e) {
		const err = e as { status?: number; stderr?: Buffer; stdout?: Buffer };
		status = err.status ?? -1;
		out = String(err.stderr ?? "") + String(err.stdout ?? "");
	}
	assert.notEqual(status, 0);
	assert.match(out, /Unknown option: --definitely-not-a-flag-zz/);
});
