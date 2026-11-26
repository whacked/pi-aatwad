// The real summarizer runner: a one-shot, tool-free Pi in JSON mode against a fake OpenAI-compatible
// model. Isolated PI_CODING_AGENT_DIR; no real credentials or tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeOpenAI, type FakeRequest } from "../fixtures/fake-openai.ts";
import { piSummarize, SUMMARY_SYSTEM } from "../../src/controller/summaries.ts";
import { packageRoot } from "../../src/shared/paths.ts";

test("piSummarize runs Pi once with no tools or extensions and returns the answer and its cost", async () => {
	const seen: FakeRequest[] = [];
	const fake = await startFakeOpenAI((req) => { seen.push(req); return { text: "## Window\n- Parser finished page 1\n## Overview\n- Parsing a scan" }; });
	const root = mkdtempSync(join(tmpdir(), "pts-"));
	const saved = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
	try {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fakeoai: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, api: "openai-completions", apiKey: "dummy",
			models: [{ id: "fake-1", cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 } }] } } }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_OFFLINE = "1";
		const r = await piSummarize(join(packageRoot(), "node_modules", ".bin", "pi"))({ model: "fakeoai/fake-1", system: SUMMARY_SYSTEM, input: "10:00 Parser: finished \"Page 1\"" });
		assert.equal(r.text, "## Window\n- Parser finished page 1\n## Overview\n- Parsing a scan");
		assert.ok(r.cost_usd > 0, `cost reported: ${r.cost_usd}`);
		assert.equal(seen.length, 1, "one model call");
		assert.equal(seen[0].tools.length, 0, "no tools offered");
		assert.match(seen[0].messages.map((m) => m.text).join("\n"), /You summarize the activity of an AI agent team[\s\S]*Parser: finished "Page 1"/);
	} finally {
		process.env.PI_CODING_AGENT_DIR = saved.dir; if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		process.env.PI_OFFLINE = saved.offline; if (saved.offline === undefined) delete process.env.PI_OFFLINE;
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("piSummarize reports a model error instead of an empty summary", async () => {
	const root = mkdtempSync(join(tmpdir(), "pts-"));
	const saved = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fakeoai: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "dummy", models: [{ id: "fake-1" }] } } }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await assert.rejects(piSummarize(join(packageRoot(), "node_modules", ".bin", "pi"), 60_000)({ model: "fakeoai/fake-1", system: "s", input: "x" }), /summarizer/);
	} finally {
		process.env.PI_CODING_AGENT_DIR = saved; if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});
