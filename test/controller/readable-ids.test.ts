import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { newId } from "../../src/controller/db.ts";
import { ID_WORDS } from "../../src/shared/readable-id.ts";
import { harness, newRun } from "./helpers.ts";

const vocabulary = new Set(ID_WORDS);

test("agent and run IDs use six independently random English words; internal IDs stay opaque", () => {
	assert.equal(vocabulary.size, 2048);
	assert.equal(createHash("sha256").update(ID_WORDS.join("\n") + "\n").digest("hex"), "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda", "vocabulary matches the attributed upstream source");
	assert.ok(Math.log2(vocabulary.size) * 6 >= 64);
	for (const prefix of ["agent", "run"]) {
		const ids = new Set(Array.from({ length: 1000 }, () => newId(prefix)));
		assert.equal(ids.size, 1000);
		for (const id of ids) {
			const [actual, ...words] = id.split("-");
			assert.equal(actual, prefix);
			assert.equal(words.length, 6);
			assert.ok(words.every((word) => vocabulary.has(word)));
			assert.ok(/^[a-z-]+$/.test(id));
		}
	}
	for (const prefix of ["task", "evt", "ses", "rsv"]) assert.match(newId(prefix), new RegExp(`^${prefix}-[0-9a-f]{16}$`));
});

test("word IDs work through creation, recruitment, exact lookup and controller restart", async () => {
	const hs = await harness();
	try {
		const { run_id, token } = await newRun(hs);
		assert.equal(run_id.split("-").length, 7);
		const result = await hs.call("POST", "/members", { token, body: { name: "WordReviewer", responsibility: "Review identifiers" } });
		assert.equal(result.status, 200, JSON.stringify(result.body));
		const id = result.body.spawned_agent_ids[0];
		assert.equal(id.split("-").length, 7);
		await hs.restart();
		const budget = await hs.call("GET", `/budgets/${id}`, { token });
		assert.equal(budget.status, 200, JSON.stringify(budget.body));
		assert.equal(budget.body.agent_id, id);
	} finally { await hs.cleanup(); }
});
