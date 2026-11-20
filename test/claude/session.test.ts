import { test } from "node:test";
import assert from "node:assert/strict";
import { isClaudeCommand } from "../../src/claude/session.ts";

test("claude process detection: native and npm launches, never the adapter itself", () => {
	for (const yes of ["claude", "claude --resume abc", "/Users/x/.local/bin/claude", "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "/opt/homebrew/bin/claude -c"]) assert.ok(isClaudeCommand(yes), yes);
	for (const no of ["node /Users/x/pi-aatwad/src/claude/cli.ts mcp", "/bin/sh -c node \"/p/src/claude/cli.ts\" hook Stop", "zsh", "node /x/claude-tools/run.js", "pi"]) assert.ok(!isClaudeCommand(no), no);
});
