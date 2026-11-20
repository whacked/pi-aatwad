import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAttention, parseAttention, parseDuration } from "../../src/extension/commands.ts";
import { DEFAULT_ATTENTION } from "../../src/shared/protocol.ts";

test("/team attention parses durations, policies and reset", () => {
	assert.deepEqual([parseDuration("30s"), parseDuration("5m"), parseDuration("1h"), parseDuration("off"), parseDuration("90")], [30, 300, 3600, 0, 90]);
	assert.throws(() => parseDuration("5 minutes"));
	assert.deepEqual(parseAttention(["on-message", "next-turn", "stall", "off", "tick", "10m", "cap", "6", "reset", "batch", "5s"]),
		{ on_message: "next_turn", stall_seconds: 0, tick_seconds: 600, max_wakes_per_hour: 6, reset: true, batch_seconds: 5 });
	assert.throws(() => parseAttention(["on-message", "maybe"]));
	assert.throws(() => parseAttention(["cap", "lots"]));
	assert.throws(() => parseAttention(["volume", "11"]), /usage/);
	assert.equal(formatAttention({ run_id: "r", configured: {}, effective: DEFAULT_ATTENTION }),
		"attention for team r (inherited defaults)\n  on-message wake · batch 15s · stall 3m · tick off · cap 20/h");
});
