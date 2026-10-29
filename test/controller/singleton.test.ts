// Real processes: `node src/controller/main.ts` contenders, kill -9, restart, SIGTERM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, shortStateDir, waitFor } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../../src/controller/main.ts", import.meta.url));

function startProc(dir: string): { p: ChildProcess; exit: Promise<number | null> } {
	const p = spawn(process.execPath, [MAIN], {
		env: { ...process.env, PI_TEAM_STATE_DIR: dir, PI_TEAM_IDLE_MS: "600000", PI_TEAM_EXECUTOR: join(dir, "no-such-worker.mjs") },
		stdio: ["ignore", "ignore", "pipe"],
	});
	const exit = new Promise<number | null>((r) => p.on("exit", (code) => r(code)));
	return { p, exit };
}

test("concurrent starts yield exactly one listener; kill -9 + restart recovers stale lock, keeps state, bumps epoch", { timeout: 60_000 }, async () => {
	const dir = shortStateDir();
	const sock = join(dir, "c.sock");
	const procs: ChildProcess[] = [];
	try {
		const contenders = [startProc(dir), startProc(dir), startProc(dir)];
		procs.push(...contenders.map((c) => c.p));
		const health = await waitFor(async () => (await api(sock, "GET", "/health").catch(() => null))?.body, "health", 15_000);
		// Losers exit 0 quietly; exactly one survives and it is the one answering.
		const exited = await waitFor(async () => {
			const codes = contenders.map((c) => c.p.exitCode);
			return codes.filter((c) => c !== null).length === 2 ? codes : null;
		}, "losers to exit", 15_000);
		assert.deepEqual(exited.filter((c) => c !== null), [0, 0]);
		const owner = contenders.find((c) => c.p.exitCode === null)!;
		assert.equal(health.pid, owner.p.pid);
		assert.equal(health.fencing_epoch, 1);
		const lock = JSON.parse(readFileSync(join(dir, "controller.lock"), "utf8"));
		assert.equal(lock.pid, owner.p.pid);
		const { statSync } = await import("node:fs");
		assert.equal(statSync(sock).mode & 0o777, 0o600);
		assert.equal(statSync(join(dir, "operator.token")).mode & 0o777, 0o600);

		const op = readFileSync(join(dir, "operator.token"), "utf8").trim();
		const run = await api(sock, "POST", "/runs", { token: op, body: { root: { role: "root", cwd: dir } } });
		assert.equal(run.status, 200);

		// Hard crash: stale lock + stale socket remain.
		owner.p.kill("SIGKILL");
		await owner.exit;
		assert.ok(existsSync(join(dir, "controller.lock")));
		const again = startProc(dir);
		procs.push(again.p);
		const h2 = await waitFor(async () => {
			const r = await api(sock, "GET", "/health").catch(() => null);
			return r && r.body.pid === again.p.pid ? r.body : null;
		}, "restarted health", 15_000);
		assert.equal(h2.fencing_epoch, 2);
		const runs = await api(sock, "GET", "/runs", { token: op });
		assert.deepEqual(runs.body.runs.map((r: any) => r.run_id), [run.body.run_id]);
		// Tokens survive restart.
		assert.equal((await api(sock, "GET", "/me", { token: run.body.token })).status, 200);

		// Graceful stop via SIGTERM: exit 0, lock + socket removed.
		again.p.kill("SIGTERM");
		assert.equal(await again.exit, 0);
		assert.ok(!existsSync(join(dir, "controller.lock")));
		assert.ok(!existsSync(sock));
	} finally {
		for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("idle controller shuts itself down", { timeout: 30_000 }, async () => {
	const dir = shortStateDir();
	const p = spawn(process.execPath, [MAIN], { env: { ...process.env, PI_TEAM_STATE_DIR: dir, PI_TEAM_IDLE_MS: "400" }, stdio: "ignore" });
	try {
		const code = await new Promise<number | null>((r) => p.on("exit", r));
		assert.equal(code, 0);
		assert.match(readFileSync(join(dir, "controller.log"), "utf8"), /"reason":"idle"/);
	} finally {
		if (p.exitCode === null) p.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});
