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
