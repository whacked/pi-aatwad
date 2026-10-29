// Minimal Pi extension used by the PiExecutor smoke test: proves `-e` loads it in the
// worker and that the team env contract reached the worker process (values never logged).
import { appendFileSync } from "node:fs";

export default function (_pi: unknown) {
	const out = process.env.PI_TEAM_FAKE_EXT_OUT ?? `${process.env.PI_TEAM_ENROLL_FILE}.ext-loaded`;
	appendFileSync(out, JSON.stringify({
		pid: process.pid,
		has_enroll_file: Boolean(process.env.PI_TEAM_ENROLL_FILE),
		has_state_dir: Boolean(process.env.PI_TEAM_STATE_DIR),
		has_launch_token: Boolean(process.env.PI_TEAM_LAUNCH_TOKEN),
		resume: process.env.PI_TEAM_RESUME,
	}) + "\n");
}
