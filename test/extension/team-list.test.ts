import { test } from "node:test";
import assert from "node:assert/strict";
import { listTeams, sameProject, teamLabel } from "../../src/extension/format.ts";
import type { RunSummary } from "../../src/shared/protocol.ts";

const now = Date.parse("2026-11-22T12:00:00Z");
const run = (over: Partial<RunSummary>): RunSummary => ({ run_id: "run-x", status: "RUNNING", root_agent_id: "a", created_at: "2026-11-22T10:00:00Z", topology_version: 1, agents: 3,
	active_members: 2, live_members: 1, name: "proj", cwd: "/w/proj", model: "anthropic/opus", last_activity_at: "2026-11-22T11:50:00Z", open_tasks: 2, summary: "working on: parser", empty: false, ...over });

test("team labels say what a team is, its state, size, work and recency", () => {
	assert.equal(teamLabel(run({}), now), "proj [running] · 1/2 live · 2 open tasks · active 10m ago · anthropic/opus");
	assert.match(teamLabel(run({ stopped: true, live_members: 0 }), now), /^proj \[stopped\]/);
	assert.match(teamLabel(run({ live_members: 0, reporting_teams: 2 }), now), /\[idle\].*2 linked teams/);
});

test("lists are scoped to the project and hide empty, closed and long-stopped teams unless all", () => {
	const runs = [
		run({ run_id: "run-here", name: "here" }),
		run({ run_id: "run-sub", name: "sub", cwd: "/w/proj/packages/api" }),
		run({ run_id: "run-other", name: "other", cwd: "/w/elsewhere" }),
		run({ run_id: "run-empty", name: "empty", empty: true, open_tasks: 0 }),
		run({ run_id: "run-old", name: "old", stopped: true, last_activity_at: "2026-11-01T00:00:00Z" }),
		run({ run_id: "run-closed", name: "closed", status: "CANCELLED" }),
	];
	const scoped = listTeams(runs, { project: "/w/proj", now });
	assert.deepEqual(scoped.shown.map((r) => r.run_id).sort(), ["run-here", "run-sub"]);
	assert.equal(scoped.hidden, 4);
	assert.match(scoped.lines.join("\n"), /• here \[running\][\s\S]*run-here · \/w\/proj · working on: parser/);
	assert.equal(listTeams(runs, { project: "/w/proj", all: true, now }).shown.length, 6);
	assert.ok(listTeams(runs, { project: "/w/proj", current: "run-empty", now }).shown.some((r) => r.run_id === "run-empty"), "the current team always shows");
	assert.ok(sameProject("/w/proj", "/w/proj/src") && sameProject("/w/proj/src", "/w/proj") && !sameProject("/w/project2", "/w/proj"));
});
