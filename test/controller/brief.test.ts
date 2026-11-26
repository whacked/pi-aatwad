import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, waitFor } from "./helpers.ts";
import { formatBrief } from "../../src/extension/format.ts";

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
