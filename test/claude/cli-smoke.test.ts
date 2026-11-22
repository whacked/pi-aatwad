import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { ENV_STATE_DIR } from "../../src/shared/protocol.ts";
import { packageRoot } from "../../src/shared/paths.ts";
import { harness, newRun, sql } from "../controller/helpers.ts";

const cli = join(packageRoot(), "src", "claude", "cli.ts");

test("cli: stdio MCP server speaks JSON-RPC and joins a team; hook commands read Claude Code hook JSON", async () => {
	const h = await harness();
	const env = { ...process.env, [ENV_STATE_DIR]: h.dir, PI_TEAM_CLAUDE_PID: "4000003" };
	const child = spawn(process.execPath, [cli, "mcp"], { env, cwd: h.dir, stdio: ["pipe", "pipe", "inherit"] });
	try {
		const team = await newRun(h);
		// Async: the test's controller runs in this process, so a synchronous spawn would deadlock it.
		const hook = (event: string, input: unknown) => new Promise<{ stdout: string }>((resolve) => {
			const p = spawn(process.execPath, [cli, "hook", event], { env, stdio: ["pipe", "pipe", "inherit"] });
			let stdout = "";
			p.stdout!.on("data", (c) => (stdout += c));
			p.on("exit", () => resolve({ stdout }));
			p.stdin!.end(JSON.stringify(input));
		});
		assert.equal((await hook("SessionStart", { session_id: "cli-s", cwd: h.dir, hook_event_name: "SessionStart" })).stdout, "");
		const lines = createInterface({ input: child.stdout! });
		const replies: any[] = [];
		const waiting: ((v: any) => void)[] = [];
		lines.on("line", (l) => { const m = JSON.parse(l); const w = waiting.shift(); if (w) w(m); else replies.push(m); });
		const rpc = (id: number, method: string, params?: unknown) => new Promise<any>((resolve) => { waiting.push(resolve); child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
		assert.equal((await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } })).result.capabilities.tools !== undefined, true);
		child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		const joined = await rpc(2, "tools/call", { name: "team_join", arguments: { mode: "member", run_id: team.run_id, model: "anthropic/claude-opus-5-5" } });
		assert.match(joined.result.content[0].text, /Joined under/);
		assert.equal((await rpc(3, "nope")).error.code, -32601);
		const member = sql(h, "SELECT child_id FROM reporting_edges WHERE parent_id = ? AND parent_run_id = ? AND valid_to IS NULL", team.root, team.run_id)[0].child_id;
		assert.equal((await h.call("POST", "/messages", { token: team.token, body: { to: member, type: "question", payload: { text: "hello from pi" } } })).status, 200);
		const prompt = JSON.parse((await hook("UserPromptSubmit", { session_id: "cli-s", hook_event_name: "UserPromptSubmit", prompt: "hi" })).stdout);
		assert.match(prompt.hookSpecificOutput.additionalContext, /hello from pi/);
	} finally { child.kill(); await h.cleanup(); }
});
