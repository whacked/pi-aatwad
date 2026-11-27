#!/usr/bin/env node
// pi-team: the human operator's global view of every team on this machine, outside any agent session.
// Sessions (/team in Pi, the team tools in Claude Code) only act on their own project's teams and the
// teams linked under them; this command sees and manages all of them.
//
//   pi-team teams [--all]              every active team (--all: also closed and old ones)
//   pi-team orphans                    teams with live members and no open leader session
//   pi-team tree <run>                 one team's members, including teams linked under it
//   pi-team stop <run>                 stop a team (resumable); teams linked under it on terminatable links stop too
//   pi-team resume <run>               resume a stopped team (its leader session re-attaches by itself if open)
//   pi-team remove <run> --yes         remove a team permanently (worktrees and transcripts are kept)
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { statePaths, type StatePaths } from "../shared/paths.ts";
import { ensureController, readOperatorToken, TeamApiError, TeamClient } from "../shared/client.ts";
import type { RunSummary } from "../shared/protocol.ts";
import { formatTree, isOrphaned, shortPath, teamLabel } from "../extension/format.ts";

const USAGE = `pi-team: every team on this machine (the human operator's view; agent sessions only see their own project's teams)

  pi-team teams [--all]          active teams with folder, state and whether a leader session is open
  pi-team orphans                teams with live members and no open leader session
  pi-team tree <run>             one team's members, including teams linked under it
  pi-team stop <run>             stop a team, resumably
  pi-team resume <run>           resume a stopped team
  pi-team remove <run> --yes     remove a team permanently (worktrees and transcripts are kept)`;

function line(r: RunSummary): string {
	const leader = r.status === "CANCELLED" ? "" : r.leader_live ? " · leader open" : " · no leader session";
	return `${r.run_id}\n    ${teamLabel(r, Date.now(), { folder: true })}${leader}${r.reports_to_run_id ? ` · linked under ${r.reports_to_run_id}` : ""}`;
}

export async function run(args: string[], o: { paths?: StatePaths; out?: (s: string) => void } = {}): Promise<number> {
	const out = o.out ?? ((s: string) => process.stdout.write(`${s}\n`));
	const paths = o.paths ?? statePaths();
	const [cmd = "help", target, ...rest] = args;
	if (cmd === "help" || cmd === "--help" || cmd === "-h") { out(USAGE); return 0; }
	if (!["teams", "orphans", "tree", "stop", "resume", "remove"].includes(cmd)) { out(`unknown command '${cmd}'\n\n${USAGE}`); return 2; }
	if (["tree", "stop", "resume", "remove"].includes(cmd) && !target) { out(`usage: pi-team ${cmd} <run>${cmd === "remove" ? " --yes" : ""}`); return 2; }
	try { await ensureController(paths, { existingStateDir: true }); }
	catch { out(`No teams on this machine yet (no team state in ${paths.dir}).`); return cmd === "teams" || cmd === "orphans" ? 0 : 1; }
	const token = await readOperatorToken(paths);
	const api = new TeamClient({ paths, token: () => token });
	const runs = (await api.listRuns({ token })).runs;
	try {
		if (cmd === "teams") {
			const all = target === "--all";
			const shown = runs.filter((r) => all || (r.status !== "CANCELLED" && (!r.empty || r.leader_live))).sort((a, b) => (shortPath(a.cwd)).localeCompare(shortPath(b.cwd)) || a.created_at.localeCompare(b.created_at));
			out(shown.length ? shown.map(line).join("\n") : "No teams.");
			if (!all && shown.length < runs.length) out(`(${runs.length - shown.length} closed or empty team(s) hidden; pi-team teams --all shows them)`);
		} else if (cmd === "orphans") {
			const o = runs.filter(isOrphaned);
			out(o.length ? `${o.map(line).join("\n")}\nStop one with: pi-team stop <run>` : "No orphaned teams: every team with live members has an open leader session.");
		} else {
			const r = runs.find((x) => x.run_id === target || x.run_id.startsWith(target!));
			if (!r) { out(`no team ${target}; pi-team teams lists them`); return 1; }
			if (cmd === "tree") out(formatTree(await api.tree(r.run_id, { token }, true, true)));
			else if (cmd === "stop") { const s = await api.stopTeam(r.run_id, { token }); out(`Team ${r.run_id}: ${s.state}. Resume with: pi-team resume ${r.run_id}`); }
			else if (cmd === "resume") { const s = await api.resumeTeam(r.run_id, { token }); out(`Team ${r.run_id}: ${s.state}. An open leader session attaches again by itself; otherwise run /team resume ${r.run_id} in a Pi session in ${shortPath(r.cwd)}.`); }
			else {
				if (!rest.includes("--yes")) { out(`Removing ${r.run_id} (${r.name ?? ""}, ${shortPath(r.cwd)}) is permanent. Repeat with --yes to confirm.`); return 1; }
				const s = await api.removeTeam(r.run_id, { confirm_run_id: r.run_id }, { token });
				out(`Team ${r.run_id}: ${s.state}. Worktrees and transcripts are kept.`);
			}
		}
		return 0;
	} catch (e) {
		out(e instanceof TeamApiError ? `${e.code}: ${e.message.replace(/^[A-Z_]+: /, "")}` : String((e as Error)?.message ?? e));
		return 1;
	}
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
	run(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`pi-team: ${String((e as Error)?.message ?? e)}\n`); process.exit(1); });
}
