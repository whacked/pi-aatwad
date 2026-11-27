import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, waitFor } from "./helpers.ts";
import { formatBrief, formatEnvelope, formatRoster } from "../../src/extension/format.ts";

const ok = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test("the brief reports what needs the lead and only what changed since it last looked, per reader", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), stranger = await newRun(h);
		const member = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Parser", responsibility: "Parse" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member));
		const mtoken = h.ex.tokens.get(member)!;
		const brief = (q = "") => h.call("GET", `/agents/${lead.root}/brief${q}`, { token: lead.token }).then(ok);

		const first = await brief();
		assert.equal(first.since_seq, null, "never looked before");
		assert.deepEqual(first.members.map((m: any) => m.role), ["Parser"]);
		ok(await h.call("POST", `/agents/${lead.root}/brief/seen`, { token: lead.token, body: { seq: first.as_of_seq } }));

		const task = ok(await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: member, title: "Parse page 1" } }));
		ok(await h.call("POST", `/tasks/${task.task_id}/progress`, { token: mtoken, body: { note: "half way" } }));
		ok(await h.call("POST", `/tasks/${task.task_id}/complete`, { token: mtoken, body: { summary: "page 1 parsed" } }));
		ok(await h.call("POST", "/messages", { token: mtoken, body: { to: lead.root, type: "question", payload: { text: "Page 2 is a scan; OCR it?" } } }));

		const second = await brief();
		assert.equal(second.since_seq, first.as_of_seq);
		assert.ok(second.changes.some((c: any) => c.type === "task.completed" && /Parser finished "Parse page 1": page 1 parsed/.test(c.text)), JSON.stringify(second.changes));
		assert.equal(second.progress_reports, 1);
		assert.ok(second.needs_you.messages.some((m: any) => m.type === "question" && m.from === "Parser" && /OCR/.test(m.preview)));
		assert.match(formatBrief(second), /Needs you:\n  • question from Parser: Page 2 is a scan/);

		ok(await h.call("POST", `/agents/${lead.root}/brief/seen`, { token: lead.token, body: { seq: second.as_of_seq } }));
		assert.equal((await brief()).changes.length, 0, "nothing new since the last look");
		const human = ok(await h.call("GET", `/agents/${lead.root}/brief?reader=human`, { token: h.op }));
		assert.equal(human.since_seq, null, "the human's marker is separate from the model's");

		assert.equal((await h.call("GET", `/agents/${lead.root}/brief`, { token: stranger.token })).status, 403);
		assert.equal((await h.call("GET", `/agents/${lead.root}/brief`, { token: mtoken })).status, 403, "members do not read their lead's brief");
		ok(await h.call("GET", `/agents/${member}/brief`, { token: lead.token }));
		assert.equal((await h.call("POST", `/agents/${lead.root}/brief/seen`, { token: mtoken, body: {} })).status, 403);
	} finally { await h.cleanup(); }
});

test("members report with a headline; the briefing stays out of the lead's inbox and is read on demand", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h);
		const member = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Scanner", responsibility: "Scan" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member));
		const mtoken = h.ex.tokens.get(member)!;
		ok(await h.call("POST", `/agents/${lead.root}/brief/seen`, { token: lead.token, body: {} }));
		const task = ok(await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: member, title: "Scan the document" } }));
		ok(await h.call("POST", `/tasks/${task.task_id}/progress`, { token: mtoken, body: { note: "pages 1-40 OCRed, 2 unreadable", headline: "40 of 93 pages done" } }));
		assert.equal((await h.call("POST", `/tasks/${task.task_id}/progress`, { token: mtoken, body: { note: "x", headline: "y".repeat(161) } })).status, 400, "headlines are one line");
		ok(await h.call("POST", `/tasks/${task.task_id}/complete`, { token: mtoken, body: { summary: "scanned", headline: "93 pages scanned, 3 need a rescan", briefing: "## Result\nPages 12, 40 and 77 are unreadable.\n## Next\nRescan at 600 dpi." } }));

		const inbox = ok(await h.call("GET", "/inbox", { token: lead.token })).messages.find((m: any) => m.type === "task.completed");
		assert.equal(inbox.payload.headline, "93 pages scanned, 3 need a rescan");
		assert.equal(inbox.payload.has_briefing, true);
		assert.equal(inbox.payload.briefing, undefined, "the briefing is not pushed into the lead's context");

		const b = ok(await h.call("GET", `/agents/${lead.root}/brief`, { token: lead.token }));
		assert.ok(b.changes.some((c: any) => c.text === 'Scanner finished "Scan the document": 93 pages scanned, 3 need a rescan [briefing]'), JSON.stringify(b.changes));
		const t = ok(await h.call("GET", `/agents/${lead.root}/thread/${member}`, { token: lead.token }));
		const done = t.items.find((i: any) => i.kind === "task.completed");
		assert.match(done.text, /^93 pages scanned, 3 need a rescan\nscanned\nBriefing:\n## Result\nPages 12, 40 and 77 are unreadable/);
		assert.ok(t.items.some((i: any) => i.kind === "task.progress" && /^40 of 93 pages done\npages 1-40 OCRed/.test(i.text)));
	} finally { await h.cleanup(); }
});

test("every delivered message names its sender's role, and its team when it is another team", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), sub = await newRun(h);
		ok(await h.call("POST", `/runs/${sub.run_id}/settings`, { token: sub.token, body: { name: "EasyCard" } }));
		ok(await h.call("POST", `/runs/${sub.run_id}/reporting`, { token: sub.token, body: { action: "connect", parent_run_id: lead.run_id } }));
		const member = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Parser", responsibility: "Parse" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member));
		ok(await h.call("GET", "/inbox", { token: lead.token }));
		ok(await h.call("POST", "/messages", { token: sub.token, body: { to: lead.root, type: "question", payload: { text: "From the sub-team" } } }));
		ok(await h.call("POST", "/messages", { token: h.ex.tokens.get(member)!, body: { to: lead.root, type: "question", payload: { text: "From my own member" } } }));
		const msgs = ok(await h.call("GET", "/inbox", { token: lead.token })).messages;
		const cross = msgs.find((m: any) => m.payload.text === "From the sub-team"), own = msgs.find((m: any) => m.payload.text === "From my own member");
		assert.deepEqual([cross.from_role, cross.from_team], ["root", "EasyCard"]);
		assert.deepEqual([own.from_role, own.from_team], ["Parser", undefined]);
		assert.match(formatEnvelope(cross), /^\[question\] from root \[.*\] of team "EasyCard" \(message /);
		assert.match(formatEnvelope(own), /^\[question\] from Parser \[.*\] \(message /);
	} finally { await h.cleanup(); }
});

test("the roster finds a former member by what it worked on, so the lead can recall that experience", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h);
		const ocr = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "OCR", responsibility: "Read scanned receipts" } })).spawned_agent_ids[0];
		const fonts = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Fonts", responsibility: "Match typefaces" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(ocr) && h.ex.tokens.has(fonts));
		const t = ok(await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: ocr, title: "Extract EasyCard transactions" } }));
		ok(await h.call("POST", `/tasks/${t.task_id}/complete`, { token: h.ex.tokens.get(ocr)!, body: { summary: "done", headline: "412 transactions from 93 pages", briefing: "Tesseract at 600 dpi worked best" } }));
		ok(await h.call("POST", `/agents/${ocr}/lifecycle`, { token: lead.token, body: { action: "cancel", reason: "pruned: idle", children_policy: "cascade" } }));

		const found = ok(await h.call("GET", `/agents/${lead.root}/roster?q=${encodeURIComponent("tesseract dpi")}`, { token: lead.token })).entries;
		assert.deepEqual(found.map((e: any) => e.role), ["OCR"], "found by words in its briefing");
		assert.equal(found[0].active, false);
		assert.deepEqual(found[0].missions.recent[0], { title: "Extract EasyCard transactions", status: "DONE", result: "412 transactions from 93 pages" });
		assert.equal(ok(await h.call("GET", `/agents/${lead.root}/roster?q=typefaces`, { token: lead.token })).entries[0].role, "Fonts");
		assert.equal(ok(await h.call("GET", `/agents/${lead.root}/roster?q=unicorn`, { token: lead.token })).entries.length, 0);
		const text = formatRoster(ok(await h.call("GET", `/agents/${lead.root}/roster`, { token: lead.token })).entries);
		assert.match(text, /^Roster: 1 current member\(s\):\n  ● Fonts .*\n1 former member\(s\) not listed: \/team roster all, or \/team roster <words> to search/);
		const all = formatRoster(found, { query: "tesseract dpi" });
		assert.match(all, /○ OCR \[.*\] · closed.* · 2 task\(s\)\n      - Extract EasyCard transactions \(DONE\): 412 transactions from 93 pages/);
	} finally { await h.cleanup(); }
});
