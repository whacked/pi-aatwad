import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEnvelope, MAX_MESSAGE_CHARS } from "../../src/extension/format.ts";
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
