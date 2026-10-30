// Contract between controller (reconciler) and executor (process launcher).
// Controller decides WHAT to run (inside SQL transactions); executor does the OS work (outside them).

export interface LaunchSpec {
	terminal?: { socket?: string };
	run_id: string;
	agent_id: string;
	session_id: string;
	spawn_intent_id: string;
	role: string;
	provider: string;
	model: string;
	cwd: string; // worker workspace (isolated dir / worktree), already validated under workspace_root
	pi_session_path: string; // Pi transcript file for this agent (reused across restarts -> resume)
	enroll_file: string; // 0600 file already written by controller, contents = EnrollmentFile
	state_dir: string;
	log_path: string; // stdout+stderr of worker
	bootstrap_prompt: string; // first user message for the worker
	resume: boolean; // true when restarting an existing agent (same pi_session_path)
	/** Optional (additive): prompt used instead of the executor's default when resume=true. */
	resume_prompt?: string;
}

export interface ProcessIdentity {
	pid: number;
	process_started_at: string; // OS-reported process start time, opaque but stable for one process
	launch_token: string; // random; also stored in env PI_TEAM_LAUNCH_TOKEN of the worker
}

export type ProbeResult = "alive" | "dead";

export interface Executor {
	/** Start a detached worker that outlives controller and parent Pi. Must not block on worker completion. */
	launch(spec: LaunchSpec): Promise<ProcessIdentity>;
	/** Alive iff pid exists AND its start time matches (guards against pid reuse). */
	probe(id: Pick<ProcessIdentity, "pid" | "process_started_at">): Promise<ProbeResult>;
	/** SIGTERM, then SIGKILL after graceMs. Only if probe() still matches. Idempotent. */
	stop(id: Pick<ProcessIdentity, "pid" | "process_started_at">, graceMs?: number): Promise<void>;
}
