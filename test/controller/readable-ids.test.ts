import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { FRESH_ID_ATTEMPTS, freshId, newId } from "../../src/controller/db.ts";
import { ID_DATE_FORMAT, ID_WORDS, idDate, idRandom, projectAbbr, projectKeyword, teamStamp } from "../../src/shared/readable-id.ts";
import { harness, newRun, ownTask, recruit, sql } from "./helpers.ts";

const vocabulary = new Set(ID_WORDS);
const STAMP = /^[0-9]{8}\.[1-9][0-9]*$/;
const stampOf = (agentId: string) => agentId.split("-").pop()!;

test("run IDs are run-<project abbr>-<four random words>; internal IDs stay opaque", () => {
	assert.equal(vocabulary.size, 2048);
	assert.equal(createHash("sha256").update(ID_WORDS.join("\n") + "\n").digest("hex"), "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda", "vocabulary matches the attributed upstream source");
	assert.equal(Math.log2(vocabulary.size) * 4, 44);
	const ids = new Set(Array.from({ length: 1000 }, () => newId("run", "/work/standard-cell-generator")));
	assert.equal(ids.size, 1000);
	for (const id of ids) {
		const [actual, abbr, ...words] = id.split("-");
		assert.equal(actual, "run");
		assert.equal(abbr, "scg");
		assert.equal(words.length, 4);
		assert.ok(words.every((word) => vocabulary.has(word)));
		assert.ok(/^[a-z-]+$/.test(id));
	}
	for (const prefix of ["task", "evt", "ses", "rsv"]) assert.match(newId(prefix), new RegExp(`^${prefix}-[0-9a-f]{16}$`));
});

test("project abbreviations take each basename token's first character, capped, with a fallback", () => {
	assert.equal(projectAbbr("/work/standard-cell-generator"), "scg");
	assert.equal(projectAbbr("/work/pi-aatwad"), "pa");
	assert.equal(projectAbbr("/work/The Project Useful_Thing_extra/"), "ute", "generic tokens are skipped like the keyword");
	assert.equal(projectAbbr("/work/Café App"), "ca");
	assert.equal(projectAbbr("/work/123-test"), "1t");
	assert.equal(projectAbbr("/work/v2.0-beta"), "v0b");
	assert.equal(projectAbbr("/work/a-b-c-d-e-f-g-h"), "bcdefg", "at most six characters (a is generic)");
	assert.equal(projectAbbr("/work/project"), "p", "only generic tokens: keep them");
	for (const cwd of ["/", "/work/!!!", "/work/中文"]) assert.equal(projectAbbr(cwd), "p");
	assert.match(newId("run", "/"), /^run-p(?:-[a-z]+){4}$/);
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

test("team stamps use the single date-format constant and local time", () => {
	assert.equal(ID_DATE_FORMAT, "yyyyMMdd");
	assert.equal(idDate(new Date(2026, 10, 23, 23, 59)), "20261123");
	assert.equal(idDate(new Date(2026, 0, 5)), "20260105");
	assert.equal(idDate(new Date(2026, 0, 5), "yyyyMM"), "202601", "changing the format is a one-constant change");
	assert.equal(teamStamp("20261123", 2), "20261123.2");
});

test("agent IDs have a CWD keyword, four independent words and the team stamp", () => {
	assert.ok(ID_WORDS.every((word) => word.length <= 8), "length bound assumes at most eight letters per word");
	for (const cwd of ["/work/pi-aatwad", "/work/abcdefghijklmnopqrstuvwxyz-extra", "/"]) {
		const ids = new Set(Array.from({ length: 1000 }, () => newId("agent", cwd, "20261123.1")));
		assert.equal(ids.size, 1000);
		for (const id of ids) {
			assert.ok(id.length <= 66);
			const parts = id.split("-");
			assert.equal(parts.pop(), "20261123.1");
			assert.ok(parts.slice(-4).every((word) => vocabulary.has(word)));
			assert.equal(parts.slice(0, -4).join("-"), projectKeyword(cwd));
		}
	}
	assert.match(newId("agent", "/work/pi-aatwad"), /^pi-aatwad(?:-[a-z]+){4}-[1-9][0-9]{6}$/, "no stamp: legacy random suffix");
});

test("the day counter is per project: a second team today is .2, another project today is .1; members share their team's stamp", async () => {
	const hs = await harness();
	try {
		const today = idDate();
		const a = await newRun(hs);
		assert.match(a.run_id, new RegExp(`^run-${projectAbbr(hs.dir)}(?:-[a-z]+){4}$`));
		assert.ok(a.root.startsWith(`${projectKeyword(hs.dir)}-`));
		assert.equal(stampOf(a.root), `${today}.1`);
		const b = await newRun(hs);
		assert.equal(stampOf(b.root), `${today}.2`);
		const other = await hs.call("POST", "/runs", { token: hs.op, body: { root: { role: "root", cwd: "/elsewhere/standard-cell-generator", provider: "anthropic", model: "claude-x" } } });
		assert.equal(other.status, 200, JSON.stringify(other.body));
		assert.equal(stampOf(other.body.root_agent_id), `${today}.1`, "a different project counts from 1");
		assert.match(other.body.run_id, /^run-scg(?:-[a-z]+){4}$/);
		assert.match(other.body.root_agent_id, /^standard-cell(?:-[a-z]+){4}-[0-9]{8}\.1$/);
		const c = await newRun(hs);
		assert.equal(stampOf(c.root), `${today}.3`);

		const task = await ownTask(hs, b.token, b.root);
		const members = await recruit(hs, b.token, b.token, task, [{ title: "Worker", count: 2 }]);
		assert.equal(members.length, 2);
		for (const id of members) {
			assert.equal(stampOf(id), `${today}.2`, "members carry their team's stamp, not today's next number");
			assert.match(stampOf(id), STAMP);
		}
		const [stored] = sql(hs, "SELECT json_extract(config_json, '$.id_stamp.n') AS n, json_extract(config_json, '$.id_stamp.date') AS d FROM runs WHERE id = ?", b.run_id);
		assert.deepEqual({ ...stored }, { n: 2, d: today });
	} finally { await hs.cleanup(); }
});

test("teams created before stamps keep working; their new members use the legacy suffix", async () => {
	const hs = await harness();
	try {
		const { run_id, root, token } = await newRun(hs);
		sql(hs, "UPDATE runs SET config_json = json_remove(config_json, '$.id_stamp') WHERE id = ?", run_id);
		const task = await ownTask(hs, token, root);
		const [member] = await recruit(hs, token, token, task, [{ title: "Legacy" }]);
		assert.match(member, /(?:-[a-z]+){4}-[1-9][0-9]{6}$/);
		const next = await newRun(hs);
		assert.equal(stampOf(next.root), `${idDate()}.1`, "unstamped teams do not count");
	} finally { await hs.cleanup(); }
});

test("readable IDs are drawn again on collision instead of failing on the primary key", async () => {
	const hs = await harness();
	const real = idRandom.int;
	let calls = 0, forced = Infinity;
	idRandom.int = (max) => (++calls <= forced ? 0 : real(max));
	try {
		const zeros = Array(4).fill(ID_WORDS[0]).join("-");
		const a = await newRun(hs);
		assert.equal(a.run_id, `run-${projectAbbr(hs.dir)}-${zeros}`);
		assert.equal(a.root, `${projectKeyword(hs.dir)}-${zeros}-${idDate()}.1`);

		calls = 0; forced = 4; // the next run ID's first draw repeats team A's
		const b = await newRun(hs);
		assert.notEqual(b.run_id, a.run_id);
		assert.ok(b.run_id.startsWith(`run-${projectAbbr(hs.dir)}-`));
		assert.equal(calls, 12, "run: 4 colliding + 4 fresh draws; root agent: 4 draws");

		calls = 0; forced = 4; // a member's first draw repeats its root (same keyword, words and stamp)
		const task = await ownTask(hs, a.token, a.root);
		const [member] = await recruit(hs, a.token, a.token, task, [{ title: "Retry" }]);
		assert.notEqual(member, a.root);
		assert.equal(stampOf(member), stampOf(a.root));
		assert.equal(calls, 8);
	} finally {
		idRandom.int = real;
		await hs.cleanup();
	}
});

test("ID draws are bounded: an exhausted source fails with CONFLICT", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE runs(id TEXT PRIMARY KEY)");
	db.prepare("INSERT INTO runs(id) VALUES ('run-p-taken')").run();
	let draws = 0;
	assert.equal(freshId(db, "runs", () => (++draws === 1 ? "run-p-taken" : "run-p-free")), "run-p-free");
	assert.equal(draws, 2);
	draws = 0;
	assert.throws(() => freshId(db, "runs", () => (draws++, "run-p-taken")), (e: any) => e.code === "CONFLICT");
	assert.equal(draws, FRESH_ID_ATTEMPTS);
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
		assert.equal(stampOf(child), stampOf(root));
	} finally { await hs.cleanup(); }
});

test("word IDs work through creation, recruitment, exact lookup and controller restart", async () => {
	const hs = await harness();
	try {
		const { run_id, root, token } = await newRun(hs, { workspace_root: "/other/workspace" });
		assert.ok(root.startsWith(`${projectKeyword(hs.dir)}-`), "root uses the supplied CWD, not the controller CWD");
		assert.equal(run_id.split("-").length, 6);
		const result = await hs.call("POST", "/members", { token, body: { name: "WordReviewer", responsibility: "Review identifiers" } });
		assert.equal(result.status, 200, JSON.stringify(result.body));
		const id = result.body.spawned_agent_ids[0];
		assert.ok(id.startsWith(`${projectKeyword(hs.dir)}-`), "members share the root CWD keyword even with a workspace override");
		assert.match(id, /(?:-[a-z]+){4}-[0-9]{8}\.1$/);
		await hs.restart();
		const budget = await hs.call("GET", `/budgets/${id}`, { token });
		assert.equal(budget.status, 200, JSON.stringify(budget.body));
		assert.equal(budget.body.agent_id, id);
	} finally { await hs.cleanup(); }
});
