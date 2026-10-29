// Runs the full demo scenario (scripts/demo.ts) under node --test: real controller process,
// fake workers, real SIGKILL of the controller. Every step is an assertion inside runDemo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDemo } from "../../scripts/demo.ts";

test("demo scenario: 9 steps pass, outputs written, no stray processes", { timeout: 180_000 }, async () => {
	const outDir = mkdtempSync(join(tmpdir(), "pt-demo-out-"));
	try {
		const lines: string[] = [];
		const r = await runDemo({ outDir, log: (l) => lines.push(l) });
		const failed = r.steps.filter((s) => !s.ok);
		assert.equal(failed.length, 0, failed.map((s) => `${s.n}. ${s.name}: ${s.error}`).join("\n") + "\n" + lines.join("\n"));
		assert.equal(r.steps.length, 9);
		assert.deepEqual(r.strayPids, []);
		assert.ok(r.ok);
		for (const f of ["tree.json", "events.jsonl", "budget.json", "test-report.txt"]) assert.ok(existsSync(join(outDir, f)), f);
		assert.match(readFileSync(join(outDir, "test-report.txt"), "utf8"), /result: PASS/);
		assert.ok(!existsSync(r.stateDir), "temp state dir removed");
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});
