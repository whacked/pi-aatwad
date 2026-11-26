import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTeamCommand, summarizerStartNotice } from "../../src/extension/commands.ts";
import { TeamRuntime, __resetProcessStateForTests } from "../../src/extension/runtime.ts";
import { suggestSummarizer } from "../../src/extension/summarizer.ts";
import { availableModels } from "../../src/extension/models.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { harness, sql, waitFor } from "../controller/helpers.ts";

const model = (provider: string, id: string, input: number | null, output: number | null, name = id) => ({ provider, id, name, reasoning: false, ...(input === null ? {} : { cost: { input, output } }) });
const REGISTRY = [model("anthropic", "claude-opus-5-5", 15, 75), model("anthropic", "claude-haiku-5-5", 1, 5), model("openai", "gpt-6.1-sol", 5, 20), model("local", "qwen3-27b", 0, 0)];

function session(hs: Awaited<ReturnType<typeof harness>>, id: string, o: { hasUI?: boolean; select?: (options: string[]) => string | undefined; confirm?: boolean; registry?: unknown[] } = {}) {
	const entries: any[] = [], notes: string[] = [], selects: string[][] = [];
	let command: any;
	const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }), sendMessage: () => {}, getAllTools: () => [], registerCommand: (_n: string, d: unknown) => { command = d; } };
	const ctx = { hasUI: o.hasUI ?? true, mode: "rpc", cwd: hs.dir, isIdle: () => true, hasPendingMessages: () => false,
		modelRegistry: { getAvailable: () => o.registry ?? REGISTRY },
		ui: { notify: (t: string) => notes.push(t), confirm: async () => o.confirm ?? true, setStatus: () => {},
			select: async (_t: string, options: string[]) => { selects.push(options); return o.select ? o.select(options) : options[0]; } },
		sessionManager: { getSessionId: () => id, getSessionFile: () => undefined, getEntries: () => entries } } as any;
	const rt = new TeamRuntime(pi as any, { paths: statePaths(hs.dir), env: {}, heartbeatMs: 60000 });
	registerTeamCommand(pi as any, rt);
	return { rt, ctx, notes, selects, run: (args: string) => command.handler(args, ctx) };
}

test("the suggested summarizer is a small model, cheapest first, else the cheapest priced one", () => {
	const ctx = { modelRegistry: { getAvailable: () => REGISTRY } } as any;
	assert.equal(suggestSummarizer(availableModels(ctx))!.model.id, "anthropic/claude-haiku-5-5");
	const noSmall = { modelRegistry: { getAvailable: () => [model("anthropic", "claude-opus-5-5", 15, 75), model("openai", "gpt-6.1-sol", 5, 20)] } } as any;
	assert.equal(suggestSummarizer(availableModels(noSmall))!.model.id, "openai/gpt-6.1-sol");
	const local = { modelRegistry: { getAvailable: () => [model("local", "llama-8b", 0, 0), model("anthropic", "claude-haiku-5-5", 1, 5)] } } as any;
	assert.match(suggestSummarizer(availableModels(local))!.reason, /free to run/);
	assert.equal(suggestSummarizer([]), undefined);
});

test("setup detects a model the human accepts; picking, declining and the start-up reminder work per project", async () => {
	__resetProcessStateForTests();
	const hs = await harness();
	try {
		const a = session(hs, "sum-a");
		await a.rt.start(a.ctx);
		await a.run("init");
		assert.ok(a.notes.some((n) => /Team summaries \(recommended\) are off .*\/team summarizer setup/.test(n)), "offered after init");

		await a.run("summarizer setup"); // first option: detect; confirm: yes
		assert.deepEqual(a.selects[0], ["Detect a suitable model (recommended)", "Choose a model myself", "Don't summarize this project's teams"]);
		assert.match(a.notes.at(-1)!, /on for .* written by anthropic\/claude-haiku-5-5/);
		assert.deepEqual(JSON.parse(sql(hs, "SELECT settings_json FROM project_settings")[0].settings_json), { summarizer: { state: "enabled", model: "anthropic/claude-haiku-5-5" } });

		const b = session(hs, "sum-b", { confirm: false, select: (opts) => opts.find((o) => o.startsWith("openai/")) ?? opts[0] });
		await b.rt.start(b.ctx);
		await b.run("summarizer setup"); // detect, reject the suggestion, pick another
		assert.match(b.notes.at(-1)!, /written by openai\/gpt-6\.1-sol/);
		assert.ok(b.selects[1].includes("local/qwen3-27b (free to run)"), JSON.stringify(b.selects[1]));

		await summarizerStartNotice(b.rt, b.ctx);
		assert.match(b.notes.at(-1)!, /Team summaries are on in .*, written by openai\/gpt-6\.1-sol/);

		await b.run("summarizer off");
		const c = session(hs, "sum-c");
		await c.rt.start(c.ctx);
		await summarizerStartNotice(c.rt, c.ctx);
		assert.match(c.notes.at(-1)!, /Team summaries were declined in .*\/team summarizer setup turns them on/, "a declined project says so at start");

		const headless = session(hs, "sum-d", { hasUI: false });
		await headless.rt.start(headless.ctx);
		const errWrite = process.stderr.write.bind(process.stderr);
		let printed = "";
		(process.stderr as any).write = (c: string) => { printed += c; return true; };
		try { await headless.run("summarizer setup"); } finally { (process.stderr as any).write = errWrite; }
		assert.match(printed, /Suggested: anthropic\/claude-haiku-5-5 .*To use it, run: \/team summarizer use anthropic\/claude-haiku-5-5[\s\S]*To decline summaries in this project, run: \/team summarizer off/);
		await headless.run("summarizer use haiku-nonexistent").catch(() => {});
		await headless.run("summarizer use local/qwen3-27b");
		assert.equal(JSON.parse(sql(hs, "SELECT settings_json FROM project_settings")[0].settings_json).summarizer.model, "local/qwen3-27b");
		for (const s of [a, b, c, headless]) s.rt.stop();
	} finally { await hs.cleanup(); }
});

test("/team history shows one member's stream and the searchable summaries", async () => {
	__resetProcessStateForTests();
	const hs = await harness({ summarize: async () => ({ text: "## Window\n- Scanner read pages 1-9\n## Overview\n- Scanning the 93-page document", cost_usd: 0 }) });
	try {
		const s = session(hs, "hist");
		await s.rt.start(s.ctx);
		await s.run("init");
		const token = (s.rt.identity as any).token;
		const member = (await hs.call("POST", "/members", { token, body: { name: "Scanner", responsibility: "Scan" } })).body.spawned_agent_ids[0];
		await waitFor(() => hs.ex.tokens.has(member));
		await hs.call("POST", "/messages", { token: hs.ex.tokens.get(member)!, body: { to: s.rt.identity!.agent_id, type: "question", payload: { text: "Page 7 is blank, skip it?" } } });
		await s.run("history Scanner");
		assert.match(s.notes.at(-1)!, /Scanner \[.*\], oldest first:[\s\S]*Scanner · question: Page 7 is blank, skip it\?/);

		await s.run("history summaries");
		assert.match(s.notes.at(-1)!, /Team summaries \(recommended\) are off/);
		await s.run("summarizer use local/qwen3-27b");
		for (let i = 0; i < 9; i++) {
			const t = (await hs.call("POST", "/tasks", { token, body: { owner_id: member, title: `Page ${i}` } })).body;
			await hs.call("POST", `/tasks/${t.task_id}/complete`, { token: hs.ex.tokens.get(member)!, body: { summary: "read" } });
		}
		await s.run("brief");
		await waitFor(() => sql(hs, "SELECT COUNT(*) AS n FROM summaries")[0].n === 1, "summary made");
		await s.run("brief");
		assert.match(s.notes.at(-1)!, /Overview \(written by local\/qwen3-27b, .*\):\n  - Scanning the 93-page document/);
		await s.run("history summaries pages");
		assert.match(s.notes.at(-1)!, /events \d+–\d+ · local\/qwen3-27b\n  - Scanner read pages 1-9/);
		await s.run("history summaries unicorns");
		assert.match(s.notes.at(-1)!, /No summaries mention "unicorns"/);
		s.rt.stop();
	} finally { await hs.cleanup(); }
});
