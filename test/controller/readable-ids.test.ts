import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { newId } from "../../src/controller/db.ts";
import { ID_WORDS, projectKeyword } from "../../src/shared/readable-id.ts";
import { harness, newRun, ownTask, recruit, sql } from "./helpers.ts";

const vocabulary = new Set(ID_WORDS);

test("run IDs retain six random words; internal IDs stay opaque", () => {
	assert.equal(vocabulary.size, 2048);
	assert.equal(createHash("sha256").update(ID_WORDS.join("\n") + "\n").digest("hex"), "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda", "vocabulary matches the attributed upstream source");
	assert.ok(Math.log2(vocabulary.size) * 6 >= 64);
	for (const prefix of ["run"]) {
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

test("project keywords normalize CWD tokens and truncate only the keyword", () => {
	assert.equal(projectKeyword("/work/pi-aatwad"), "pi-aatwad");
	assert.equal(projectKeyword("/work/The Project Useful_Thing_extra/"), "useful-thing");
	assert.equal(projectKeyword("/work/Café App"), "cafe-app");
	assert.equal(projectKeyword("/work/123-test"), "123-test");
	assert.equal(projectKeyword("/work/abcdefghijklmnopqr-next"), "abcdefghijklmnopqr");
	assert.equal(projectKeyword("/work/abcdefghijklmnopqrstuvwxyz"), "abcdefghijklmnopqrs");
	for (const cwd of ["/", "/work/!!!", "/work/中文"]) assert.equal(projectKeyword(cwd), "project");
});

test("agent IDs have a CWD keyword, four independent words and seven random digits", () => {
	assert.ok(Math.log2(vocabulary.size) * 4 + Math.log2(9_000_000) >= 66);
	assert.ok(ID_WORDS.every((word) => word.length <= 8), "63-character bound assumes at most eight letters per word");
	for (const cwd of ["/work/pi-aatwad", "/work/abcdefghijklmnopqrstuvwxyz-extra", "/"]) {
		const ids = new Set(Array.from({ length: 1000 }, () => newId("agent", cwd)));
		assert.equal(ids.size, 1000);
		for (const id of ids) {
			assert.ok(id.startsWith(`${projectKeyword(cwd)}-`));
			assert.ok(id.length <= 63);
			const parts = id.split("-");
			assert.match(parts.pop()!, /^[1-9][0-9]{6}$/);
			assert.ok(parts.slice(-4).every((word) => vocabulary.has(word)));
			assert.equal(parts.slice(0, -4).join("-"), projectKeyword(cwd));
		}
	}
});

test("nested recruitment uses the root CWD, not the requester's worktree", async () => {
	const hs = await harness();
	try {
		const { root, token } = await newRun(hs);
		const task = await ownTask(hs, token, root);
		const [parent] = await recruit(hs, token, token, task, [{ title: "Manager" }]);
		sql(hs, "UPDATE agents SET cwd = ? WHERE id = ?", "/different/member-worktree", parent);
		const memberToken = hs.ex.tokens.get(parent)!;
		const subtask = await ownTask(hs, memberToken, parent);
		const [child] = await recruit(hs, memberToken, token, subtask, [{ title: "Nested" }]);
		assert.ok(child.startsWith(`${projectKeyword(hs.dir)}-`));
	} finally { await hs.cleanup(); }
});

test("word IDs work through creation, recruitment, exact lookup and controller restart", async () => {
	const hs = await harness();
	try {
		const { run_id, root, token } = await newRun(hs, { workspace_root: "/other/workspace" });
		assert.ok(root.startsWith(`${projectKeyword(hs.dir)}-`), "root uses the supplied CWD, not the controller CWD");
		assert.equal(run_id.split("-").length, 7);
		const result = await hs.call("POST", "/members", { token, body: { name: "WordReviewer", responsibility: "Review identifiers" } });
		assert.equal(result.status, 200, JSON.stringify(result.body));
		const id = result.body.spawned_agent_ids[0];
		assert.ok(id.startsWith(`${projectKeyword(hs.dir)}-`), "members share the root CWD keyword even with a workspace override");
		assert.match(id, /(?:-[a-z]+){4}-[1-9][0-9]{6}$/);
		await hs.restart();
		const budget = await hs.call("GET", `/budgets/${id}`, { token });
		assert.equal(budget.status, 200, JSON.stringify(budget.body));
		assert.equal(budget.body.agent_id, id);
	} finally { await hs.cleanup(); }
});
