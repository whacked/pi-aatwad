import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/controller/log.ts";
import { logged } from "../../src/controller/server.ts";

test("the controller log rolls over to .1 instead of growing without bound", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-team-log-"));
	try {
		const path = join(dir, "controller.log");
		const log = createLogger(path, {}, 1_000);
		for (let i = 0; i < 40; i++) log("info", "event", { i, pad: "x".repeat(50) });
		assert.ok(existsSync(`${path}.1`), "rolled over");
		assert.ok(statSync(path).size <= 1_000 + 200, "current log stays near the cap");
		assert.match(readFileSync(path, "utf8"), /"i":39/, "the newest line is in the current log");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("routine polling is not logged; writes and failures are", () => {
	assert.equal(logged("POST", "/sessions/heartbeat", 200), false);
	assert.equal(logged("GET", "/inbox", 200), false);
	assert.equal(logged("GET", "/health", 500), false);
	assert.equal(logged("POST", "/sessions/heartbeat", 409), true);
	assert.equal(logged("GET", "/me", 401), true);
	assert.equal(logged("POST", "/messages", 200), true);
});
