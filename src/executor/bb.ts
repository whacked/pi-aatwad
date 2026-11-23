// Launch a member as a bb child thread of the leader's thread.
//
// bb starts the member's Pi itself, with bb's env, so the worker env cannot be passed directly. Instead:
//   1. fresh member: `bb thread spawn --parent-thread <leader> --environment <cwd> --machine <leader's machine>`
//      with the bootstrap prompt; resumed member with a live thread: `bb thread stop`, then `bb thread tell`
//      with the resume prompt, so the bb transcript and the Pi session stay one.
//   2. the worker env (PI_TEAM_ENROLL_FILE, agent/run IDs, launch token) goes into the thread's storage dir as
//      a one-time claim (BB_CLAIM_FILE); the extension consumes it like an enrollment file. Fresh threads get
//      it right after spawn returns; the extension waits for it when its first prompt is our bootstrap prompt.
//   3. a small supervisor (bb-member.ts) owns the thread and is the process the controller tracks.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BB_CLAIM_FILE, ENV_ENROLL_FILE } from "../shared/protocol.ts";
import { nodeArgsFor, resolveNode } from "../shared/client.ts";
import { bb, bbJson, showThread, threadUsable, type BbControl, type BbThread } from "../terminal/bb-cli.ts";
import { BB_THREAD, readMemberThread, writeMemberThread } from "../terminal/bb.ts";
import { teamOwner } from "../terminal/view.ts";
import { buildWorkerEnv, ENV_AGENT_ID, ENV_LAUNCH_TOKEN, ENV_RESUME, ENV_RUN_ID } from "./env.ts";
import { logLaunchFailure, newLaunchToken } from "./launch.ts";
import { processStartTimeSync } from "./proc.ts";
import type { LaunchSpec, ProcessIdentity } from "./types.ts";

export const BB_SUPERVISOR = fileURLToPath(new URL("./bb-member.ts", import.meta.url));
const CLAIM_KEYS = [ENV_ENROLL_FILE, ENV_AGENT_ID, ENV_RUN_ID, ENV_LAUNCH_TOKEN, ENV_RESUME] as const;

export interface BbClaim { env: Partial<Record<(typeof CLAIM_KEYS)[number], string>> }

/** bb's per-thread storage dir, the same path bb gives the thread's Pi as BB_THREAD_STORAGE. */
export function threadStorage(control: BbControl, thread: string): string {
	if (!control.BB_DATA_DIR) throw new Error("the bb data dir is unknown (BB_DATA_DIR); reopen member threads from the leader Pi in bb");
	if (!BB_THREAD.test(thread)) throw new Error(`invalid bb thread id ${thread}`);
	return join(control.BB_DATA_DIR, "thread-storage", thread);
}

function writeClaim(control: BbControl, thread: string, claim: BbClaim): void {
	const dir = threadStorage(control, thread);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, BB_CLAIM_FILE), temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(claim), { mode: 0o600 });
	renameSync(temp, file);
}

/** bb names models <provider>/<model>; "default" lets bb use the project's remembered model. */
export function bbModel(spec: Pick<LaunchSpec, "provider" | "model">): string | undefined {
	if (!spec.model || spec.model === "default") return undefined;
	return spec.provider && spec.provider !== "default" ? `${spec.provider}/${spec.model}` : spec.model;
}

export async function launchBbMember(spec: LaunchSpec, prompt: string): Promise<ProcessIdentity> {
	const terminal = spec.terminal;
	const control: BbControl = terminal?.env ?? {};
	const leader = terminal?.location?.leader, project = terminal?.location?.window;
	const fail = (message: string): never => { logLaunchFailure(spec, message); throw new Error(message); };
	if (!leader || !project) fail("bb member threads need the leader's thread; run /team watch from the leader Pi in bb");
	const owner = teamOwner(spec.state_dir, spec.run_id);
	const token = newLaunchToken();
	const workerEnv = buildWorkerEnv(spec, token);
	const claim: BbClaim = { env: Object.fromEntries(CLAIM_KEYS.filter((k) => workerEnv[k]).map((k) => [k, workerEnv[k]])) };
	const promptFile = `${spec.enroll_file}.prompt`;
	writeFileSync(promptFile, prompt, { mode: 0o600 });
	let thread = readMemberThread(spec.state_dir, owner, spec.agent_id);
	try {
		if (thread && spec.resume && threadUsable(await showThread(control, thread))) {
			// Same thread, fresh credential: the restarted Pi (same session file) takes the new claim.
			writeClaim(control, thread, claim);
			await bb(control, ["thread", "stop", thread]).catch(() => {});
			await bb(control, ["thread", "tell", thread, "--mode", "auto", "--message-file", promptFile]);
		} else {
			const parent = await showThread(control, leader!);
			if (!threadUsable(parent)) fail(`the leader's bb thread ${leader} is missing or archived`);
			// A path environment needs an explicit machine: the leader's.
			const machine = parent!.environment?.hostId;
			if (!machine) fail(`bb thread ${leader} has no machine to run members on`);
			const model = bbModel(spec);
			const created = await bbJson<BbThread & { thread?: BbThread }>(control, ["thread", "spawn",
				"--project", project!, "--provider", "pi", ...(model ? ["--model", model] : []),
				"--environment", spec.cwd, "--machine", machine!,
				"--parent-thread", leader!, "--parent-notifications", "off", "--lifecycle-owner-thread", leader!,
				"--title", spec.role, "--prompt-file", promptFile]);
			thread = created.id ?? created.thread?.id;
			if (!thread || !BB_THREAD.test(thread)) fail(`bb thread spawn returned no thread id`);
			writeMemberThread(spec.state_dir, owner, spec.agent_id, thread!);
			writeClaim(control, thread!, claim);
		}
	} catch (e) {
		logLaunchFailure(spec, (e as Error).message);
		throw e;
	} finally {
		try { unlinkSync(promptFile); } catch { /* already gone */ }
	}
	return startSupervisor(spec, control, thread!, token);
}

async function startSupervisor(spec: LaunchSpec, control: BbControl, thread: string, token: string): Promise<ProcessIdentity> {
	mkdirSync(dirname(spec.log_path), { recursive: true, mode: 0o700 });
	const fd = openSync(spec.log_path, "a", 0o600);
	try {
		const child = spawn(resolveNode(), [...nodeArgsFor(BB_SUPERVISOR), thread], {
			cwd: spec.state_dir,
			env: { ...process.env, ...control },
			detached: true,
			stdio: ["ignore", fd, fd],
			windowsHide: true,
		});
		await new Promise<void>((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); });
		child.unref();
		const pid = child.pid;
		if (!pid) throw new Error("could not start the bb member supervisor");
		const identity = { pid, process_started_at: processStartTimeSync(pid) ?? "", launch_token: token };
		// Until it handles SIGTERM, stopping the supervisor would not stop the thread: wait for it.
		const ready = `"event":"watching","thread":"${thread}"`;
		const deadline = Date.now() + 10_000;
		while (!readFileSync(spec.log_path, "utf8").includes(ready)) {
			if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the bb member supervisor for ${thread} did not start; see ${spec.log_path}`);
			await new Promise((r) => setTimeout(r, 25));
		}
		return identity;
	} finally {
		closeSync(fd);
	}
}
