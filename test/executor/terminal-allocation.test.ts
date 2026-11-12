import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTerminal } from "../../src/executor/terminal.ts";
import type { LaunchSpec } from "../../src/executor/types.ts";
import { TmuxWatch } from "../../src/watch/tmux.ts";
import { TerminalAllocationError } from "../../src/watch/terminal-error.ts";

for (const failure of ["lost split reply", "post-launch tagging", "identity query"]) {
	test(`startup gate prevents a second writer after ${failure}, even if pane cleanup fails`, async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "pt-gate-"));
		let child: ChildProcess | undefined;
		let exited: Promise<unknown> | undefined;
		let script: string;
		const spec: LaunchSpec = {
			run_id: "run", agent_id: "worker", session_id: "session", spawn_intent_id: "intent", role: "Worker",
			provider: "default", model: "default", cwd: dir, pi_session_path: join(dir, "transcript"),
			enroll_file: join(dir, "enroll.json"), state_dir: dir, log_path: join(dir, "log"), bootstrap_prompt: "work", resume: false, terminal: {},
		};
		writeFileSync(spec.enroll_file, "credential");
		const program = join(dir, "fake-pi.sh");
		writeFileSync(program, 'printf "writer\\n" >> "$1"\n/bin/rm -- "$2"\n');
		let fail = true;
		t.mock.method(TmuxWatch.prototype, "launchAgent", async (_agent: string, _role: string, command: string[], cwd: string) => {
			script = command.at(-1)!;
			child = spawn(command[0], command.slice(1), { cwd, stdio: "ignore" });
			exited = once(child, "exit");
			if (fail && failure !== "identity query") throw new TerminalAllocationError(failure);
			return "%2";
		});
		t.mock.method(TmuxWatch.prototype, "tmux", async (...args: string[]) => {
			if (args[0] === "kill-pane") throw new Error("tmux unavailable during cleanup");
			if (fail) throw new Error("tmux identity query failed");
			return String(child!.pid);
		});
		try {
			await assert.rejects(launchTerminal(spec, "/bin/sh", [program, spec.pi_session_path, spec.enroll_file]), TerminalAllocationError);
			await exited;
			assert.equal(existsSync(spec.pi_session_path), false, "failed pane never starts Pi or writes the transcript");
			assert.equal(readFileSync(spec.enroll_file, "utf8"), "credential", "enrollment is not consumed");
			assert.equal(existsSync(script!), false);
			assert.equal(existsSync(`${script!}.ready`), false);
			const cancelledScript = script!;
			// Reusing the same enrollment and transcript starts exactly one writer.
			fail = false;
			const identity = await launchTerminal(spec, "/bin/sh", [program, spec.pi_session_path, spec.enroll_file]);
			assert.equal(identity.pid, child!.pid);
			assert.notEqual(script!, cancelledScript, "later attempts cannot reopen an orphan's gate");
			await exited;
			assert.equal(readFileSync(spec.pi_session_path, "utf8"), "writer\n");
			assert.equal(existsSync(spec.enroll_file), false);
			assert.equal(existsSync(script!), false);
			assert.equal(existsSync(`${script!}.ready`), false);
		} finally {
			child?.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
