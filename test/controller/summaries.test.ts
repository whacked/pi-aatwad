import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, sql, waitFor } from "./helpers.ts";
import { splitSections, type SummarizeRequest } from "../../src/controller/summaries.ts";

const ok = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test("summaries are opt-in per project, made on demand when enough happened, charged to the team, and searchable", async () => {
	const calls: SummarizeRequest[] = [];
	let fail = false;
	const h = await harness({ summarize: async (req) => {
		calls.push(req);
		if (fail) throw new Error("model unavailable");
		return { text: `## Window\n- Parser finished page ${calls.length}\n## Overview\n- Parsing the 93-page scan; ${calls.length} window(s) so far`, cost_usd: 0.01 };
	} });
	try {
		const lead = await newRun(h);
		const member = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Parser", responsibility: "Parse" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member));
		const mtoken = h.ex.tokens.get(member)!;
		const activity = async (n: number) => {
			for (let i = 0; i < n; i++) {
				const t = ok(await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: member, title: `Page ${i}` } }));
				ok(await h.call("POST", `/tasks/${t.task_id}/complete`, { token: mtoken, body: { summary: `page ${i} parsed` } }));
			}
		};
		const brief = () => h.call("GET", `/agents/${lead.root}/brief`, { token: lead.token }).then(ok);
		await activity(5);
		await brief();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(calls.length, 0, "not enabled for this project: no model call");

		assert.equal((await h.call("POST", "/projects/settings", { token: lead.token, body: { project: h.dir, summarizer: { state: "declined" } } })).status, 403, "operator only");
		ok(await h.call("POST", "/projects/settings", { token: h.op, body: { project: h.dir, summarizer: { state: "enabled", model: "local/small-1" } } }));
		assert.deepEqual(ok(await h.call("GET", `/projects/settings?project=${encodeURIComponent(h.dir + "/sub")}`, { token: h.op })).settings, { summarizer: { state: "enabled", model: "local/small-1" } }, "a subdirectory uses its project's settings");
		await brief();
		await waitFor(() => sql(h, "SELECT COUNT(*) AS n FROM summaries WHERE run_id = ?", lead.run_id)[0].n === 1, "first summary");
		assert.equal(calls[0].model, "local/small-1");
		assert.match(calls[0].input, /Parser: finished "Page 0" \(DONE\): page 0 parsed/);
		assert.equal((await brief()).summary.overview, "- Parsing the 93-page scan; 1 window(s) so far");
		const spent = sql(h, "SELECT consumed_usd FROM allocations WHERE agent_id = ?", lead.root)[0].consumed_usd;
		assert.ok(Math.abs(spent - 0.01) < 1e-9, "charged to the team's leader");

		await brief();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(calls.length, 1, "nothing new: no second call");
		await activity(4);
		await brief();
		await waitFor(() => calls.length === 2, "second summary");
		assert.match(calls[1].input, /^Previous overview:\n- Parsing the 93-page scan; 1 window/, "the rolling overview is carried forward");
		await waitFor(() => sql(h, "SELECT COUNT(*) AS n FROM summaries WHERE run_id = ?", lead.run_id)[0].n === 2);
		const list = ok(await h.call("GET", `/runs/${lead.run_id}/summaries`, { token: lead.token }));
		assert.deepEqual(list.summaries.map((s: any) => s.window), ["- Parser finished page 2", "- Parser finished page 1"]);
		assert.equal(list.summaries[1].to_seq, list.summaries[0].from_seq, "windows are contiguous");
		assert.deepEqual(ok(await h.call("GET", `/runs/${lead.run_id}/summaries?q=page%202`, { token: lead.token })).summaries.length, 1);
		assert.equal((await h.call("GET", `/runs/${lead.run_id}/summaries`, { token: (await newRun(h)).token })).status, 403);

		fail = true;
		await activity(4);
		await brief();
		await waitFor(() => sql(h, "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'summary.failed'", lead.run_id)[0].n === 1, "failure recorded");
		await brief();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(calls.length, 3, "a failure is not retried at once");
	} finally { await h.cleanup(); }
});

test("a member's thread pulls one conversation out of the leader's stream", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h);
		const a = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Alpha", responsibility: "A" } })).spawned_agent_ids[0];
		const b = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Beta", responsibility: "B" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(a) && h.ex.tokens.has(b));
		ok(await h.call("POST", "/messages", { token: lead.token, body: { to: a, type: "question", payload: { text: "Alpha, status?" } } }));
		ok(await h.call("POST", "/messages", { token: h.ex.tokens.get(b)!, body: { to: lead.root, type: "question", payload: { text: "Beta here, unrelated" } } }));
		ok(await h.call("POST", "/messages", { token: h.ex.tokens.get(a)!, body: { to: lead.root, type: "answer", payload: { text: "Alpha: half done" } } }));
		const t = ok(await h.call("GET", `/agents/${lead.root}/thread/${a}`, { token: lead.token }));
		assert.equal(t.member_role, "Alpha");
		const texts = t.items.map((i: any) => `${i.from}:${i.kind}:${i.text}`);
		assert.ok(texts.includes("root:question:Alpha, status?") || texts.some((x: string) => /question:Alpha, status\?/.test(x)), texts.join("|"));
		assert.ok(texts.some((x: string) => /Alpha:answer:Alpha: half done/.test(x)));
		assert.ok(!texts.some((x: string) => /Beta here/.test(x)), "other members stay out");
		assert.equal((await h.call("GET", `/agents/${lead.root}/thread/${lead.root}`, { token: lead.token })).status, 400);
	} finally { await h.cleanup(); }
});

test("summary sections are split even when the model is sloppy", () => {
	assert.deepEqual(splitSections("## Window\n- a\n\n## Overview\n- b"), { window: "- a", overview: "- b" });
	assert.deepEqual(splitSections("just text"), { window: "just text", overview: "just text" });
});

test("a busy stretch larger than one model call is split into consecutive summaries; no record is dropped", async () => {
	const inputs: string[] = [];
	const h = await harness({ summarize: async (req) => { inputs.push(req.input); return { text: `## Window\n- part ${inputs.length}\n## Overview\n- so far ${inputs.length}`, cost_usd: 0 }; } });
	try {
		const lead = await newRun(h);
		ok(await h.call("POST", "/projects/settings", { token: h.op, body: { project: h.dir, summarizer: { state: "enabled", model: "local/small-1" } } }));
		const member = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Writer", responsibility: "Write" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member));
		for (let i = 0; i < 40; i++) {
			const t = ok(await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: member, title: `Chapter ${i}` } }));
			ok(await h.call("POST", `/tasks/${t.task_id}/complete`, { token: h.ex.tokens.get(member)!, body: { summary: `chapter ${i} ` + "x".repeat(2000) } }));
		}
		ok(await h.call("GET", `/agents/${lead.root}/brief`, { token: lead.token }));
		await waitFor(() => sql(h, "SELECT COUNT(*) AS n FROM summaries WHERE run_id = ?", lead.run_id)[0].n >= 2, "split into two or more", 5000);
		assert.ok(inputs.every((i) => i.length < 26_000), "each call fits");
		const all = inputs.join("\n");
		for (let i = 0; i < 40; i++) assert.ok(all.includes(`"Chapter ${i}"`), `chapter ${i} was summarized`);
		const rows = sql(h, "SELECT from_seq, to_seq FROM summaries WHERE run_id = ? ORDER BY to_seq", lead.run_id);
		for (let i = 1; i < rows.length; i++) assert.equal(rows[i].from_seq, rows[i - 1].to_seq, "contiguous windows");
		assert.match(inputs[1], /^Previous overview:\n- so far 1/);
	} finally { await h.cleanup(); }
});

test("a lead's summary reads the overview of each team linked under it, not that team's raw events", async () => {
	const inputs: { model: string; input: string }[] = [];
	const h = await harness({ summarize: async (req) => { inputs.push(req); return { text: `## Window\n- w\n## Overview\n- overview of call ${inputs.length}`, cost_usd: 0 }; } });
	try {
		const lead = await newRun(h), sub = await newRun(h);
		ok(await h.call("POST", `/runs/${sub.run_id}/settings`, { token: sub.token, body: { name: "EasyCard" } }));
		ok(await h.call("POST", `/runs/${sub.run_id}/reporting`, { token: sub.token, body: { action: "connect", parent_run_id: lead.run_id } }));
		ok(await h.call("POST", "/projects/settings", { token: h.op, body: { project: h.dir, summarizer: { state: "enabled", model: "local/small-1" } } }));
		const busy = async (t: { token: string; root: string }, prefix: string) => {
			const m = ok(await h.call("POST", "/members", { token: t.token, body: { name: `${prefix}Worker`, responsibility: "Work" } })).spawned_agent_ids[0];
			await waitFor(() => h.ex.tokens.has(m));
			for (let i = 0; i < 5; i++) {
				const task = ok(await h.call("POST", "/tasks", { token: t.token, body: { owner_id: m, title: `${prefix} task ${i}` } }));
				ok(await h.call("POST", `/tasks/${task.task_id}/complete`, { token: h.ex.tokens.get(m)!, body: { summary: "done" } }));
			}
		};
		await busy(sub, "Sub");
		ok(await h.call("GET", `/agents/${sub.root}/brief`, { token: sub.token }));
		await waitFor(() => inputs.length === 1, "sub-team summarized");
		await busy(lead, "Lead");
		ok(await h.call("GET", `/agents/${lead.root}/brief`, { token: lead.token }));
		await waitFor(() => inputs.length === 2, "lead summarized");
		assert.match(inputs[1].input, /Team "EasyCard" \(linked under this team\), its own overview as of \d\d:\d\d UTC:\n- overview of call 1/);
		assert.ok(!inputs[1].input.includes("Sub task"), "the sub-team's raw records stay in its own summary");
		assert.ok(inputs[1].input.includes("Lead task 0"));
	} finally { await h.cleanup(); }
});
