import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEnvelope, MAX_MESSAGE_CHARS, openLeaderHints, projectFirst } from "../../src/extension/format.ts";
import type { Envelope } from "../../src/shared/protocol.ts";

const env = (payload: Record<string, unknown>): Envelope => ({ version: 1, message_id: "msg-1", run_id: "run1", type: "question", from: "ag-lead", to: "ag-sub", payload });

test("message bodies are delivered whole: long instructions and task specs are never cut short", () => {
	// A real report: priorities ending "Classify each as (a) not expressible, (…" after 1,500 characters.
	const instructions = `Priorities:\n${Array.from({ length: 60 }, (_, i) => `${i + 1}. Classify each as (a) not expressible, (b) expressible, (c) unknown.`).join("\n")}\nEND-OF-INSTRUCTIONS`;
	assert.ok(instructions.length > 4_000);
	const text = formatEnvelope(env({ text: instructions }));
	assert.ok(text.endsWith("END-OF-INSTRUCTIONS"));
	assert.ok(text.includes(instructions));
	const spec = { task_id: "t1", title: "Phase two", spec: { responsibility: "x".repeat(5_000), steps: ["1. Failure-mode split of the corpus", "2. done"] } };
	assert.ok(formatEnvelope(env(spec)).includes(JSON.stringify(spec)), "structured payloads (task.assigned) too");
});

test("only a pathological message hits the ceiling, and then it says so", () => {
	const huge = "y".repeat(MAX_MESSAGE_CHARS + 10);
	const text = formatEnvelope(env({ text: huge }));
	assert.match(text, new RegExp(`\\[message cut at ${MAX_MESSAGE_CHARS} of ${MAX_MESSAGE_CHARS + 10} characters; ask ag-lead to send the rest in a file\\]$`));
});

test("team choices list this project's teams first, keeping the order within each group", () => {
	const runs = [{ run_id: "a", cwd: "/w/other" }, { run_id: "b", cwd: "/w/easycard" }, { run_id: "c", cwd: null }, { run_id: "d", cwd: "/w/easycard/sub" }];
	assert.deepEqual(projectFirst(runs, "/w/easycard").map((r) => r.run_id), ["b", "d", "a", "c"]);
});

test("a team led by another open session in this project is announced with a command for each option", () => {
	const run = (o: object) => ({ run_id: "run-a", root_agent_id: "lead-a", status: "RUNNING", created_at: "", topology_version: 0, agents: 1, name: "EasyCard", cwd: "/w/easycard", leader_live: true, ...o }) as any;
	assert.equal(openLeaderHints([run({ leader_live: false }), run({ run_id: "run-b", cwd: "/w/other" }), run({ run_id: "run-c", stopped: true })], "/w/easycard"), undefined, "closed sessions, other projects and stopped teams are not warned about");
	const before = openLeaderHints([run({})], "/w/easycard")!;
	assert.match(before, /Team "EasyCard" \(run-a, \/w\/easycard\) is still led by another open session \(lead-a\)/);
	assert.match(before, /lead that team from this session instead .*: \/team resume run-a/);
	assert.match(before, /lead your own team under its leader: \/team init, then \/team join run-a/);
	assert.match(before, /Doing nothing keeps this session as it is\.$/);
	const after = openLeaderHints([run({}), run({ run_id: "run-mine" })], "/w/easycard", "run-mine")!;
	assert.doesNotMatch(after, /run-mine\) is still led/, "never warns about the session's own team");
	assert.match(after, /link your new team under its leader: \/team join run-a/);
	assert.match(after, /in the other session, \/team join run-mine/);
});
