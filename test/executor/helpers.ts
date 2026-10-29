import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchSpec } from "../../src/executor/types.ts";

export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

export function tmp(prefix = "pt-exec-"): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function makeSpec(dir: string, over: Partial<LaunchSpec> = {}): LaunchSpec {
	const enroll_file = join(dir, "enroll.json");
	writeFileSync(enroll_file, JSON.stringify({ version: 1, token: "ENROLL-SECRET-abc123" }), { mode: 0o600 });
	return {
		run_id: "run1",
		agent_id: "agent1",
		session_id: "sess1",
		spawn_intent_id: "intent1",
		role: "Worker",
		provider: "fakeoai",
		model: "fake-1",
		cwd: dir,
		pi_session_path: join(dir, "pi-sessions", "agent1.jsonl"),
		enroll_file,
		state_dir: dir,
		log_path: join(dir, "logs", "agent1.log"),
		bootstrap_prompt: "You are a managed worker. Say hello.",
		resume: false,
		...over,
	};
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean | Promise<boolean>, ms = 10_000, step = 50): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await cond()) return;
		await sleep(step);
	}
	throw new Error("timed out waiting for condition");
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
