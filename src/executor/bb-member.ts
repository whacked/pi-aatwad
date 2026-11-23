#!/usr/bin/env node
// Supervisor for one bb member thread: `node bb-member.ts <thread>` with the bb control env.
// bb runs the member's Pi and never exposes its pid, so the controller tracks this process instead:
//   alive   while the thread exists and is not archived (polled; exits 0 once it is gone)
//   SIGTERM stops the thread's Pi (`bb thread stop`) and exits; the thread and transcript stay.
// Crashes of the member's Pi itself surface through its heartbeat lease, as for every member.
import { bb, bbControlFrom, showThread, threadUsable } from "../terminal/bb-cli.ts";

const thread = process.argv[2];
if (!thread) { process.stderr.write("usage: bb-member.ts <thread>\n"); process.exit(2); }
const control = bbControlFrom(process.env);
const pollMs = Math.max(200, Number(process.env.PI_TEAM_BB_POLL_MS) || 3000);
const log = (event: string, extra: Record<string, unknown> = {}) =>
	process.stdout.write(`[pi-team-bb] ${JSON.stringify({ ts: new Date().toISOString(), event, thread, ...extra })}\n`);

let stopping = false;
async function stop(signal: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	log("stop", { signal });
	try { await bb(control, ["thread", "stop", thread], 15_000); }
	catch (e) { log("stop_failed", { error: (e as Error).message.slice(0, 300) }); }
	process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

log("watching", { poll_ms: pollMs });
let failures = 0;
for (;;) {
	await new Promise((r) => setTimeout(r, pollMs));
	if (stopping) continue;
	try {
		const d = await showThread(control, thread);
		failures = 0;
		if (!threadUsable(d)) { log("thread_gone", { known: !!d }); process.exit(0); }
	} catch (e) {
		// bb restarting or briefly unreachable: keep the member; say so once in a while.
		if (++failures % 20 === 1) log("poll_failed", { failures, error: (e as Error).message.slice(0, 300) });
	}
}
