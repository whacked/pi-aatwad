#!/usr/bin/env node
// Claude Code adapter entry point.
//   cli.ts mcp                 MCP stdio server (team tools + liveness heartbeat)
//   cli.ts hook <event>        SessionStart | UserPromptSubmit | Stop hook (reads hook JSON on stdin)
//   cli.ts wait                background waiter: exits when the controller wakes this idle session
//   cli.ts takeover <run> [agent]  the human, inside Claude Code (! prefix): this session takes over that team's leader or agent
import { fileURLToPath } from "node:url";
import { serveStdio } from "./mcp.ts";
import { sessionStart, stop, userPromptSubmit, wait, type HookInput } from "./hooks.ts";
import { takeover } from "./takeover.ts";

const self = fileURLToPath(import.meta.url);
const waiterCommand = `node ${JSON.stringify(self)} wait`;
const waiter = process.env.PI_TEAM_CLAUDE_WAITER !== "0";

async function readStdin(): Promise<HookInput> {
	let s = "";
	for await (const c of process.stdin) s += c;
	try { return JSON.parse(s) as HookInput; } catch { return {}; }
}

async function main(argv: string[]): Promise<void> {
	const [cmd, event] = argv;
	if (cmd === "mcp") return serveStdio();
	if (cmd === "wait") {
		const text = await wait({ waiterCommand });
		if (text) process.stdout.write(`${text}\n`);
		return;
	}
	if (cmd === "takeover") {
		const r = await takeover(argv.slice(1));
		process.stdout.write(`${r.text}\n`);
		process.exitCode = r.code;
		return;
	}
	if (cmd === "hook") {
		const input = await readStdin();
		const handler = { SessionStart: sessionStart, UserPromptSubmit: userPromptSubmit, Stop: stop }[event ?? input.hook_event_name ?? ""];
		if (!handler) return;
		const out = await handler(input, { waiterCommand, waiter }).catch(() => undefined);
		if (out) process.stdout.write(JSON.stringify(out));
		return;
	}
	process.stderr.write("usage: cli.ts mcp | hook <SessionStart|UserPromptSubmit|Stop> | wait | takeover <run_id> [agent]\n");
	process.exitCode = 2;
}

void main(process.argv.slice(2));
