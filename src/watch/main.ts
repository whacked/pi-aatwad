#!/usr/bin/env node
// Runs only in observer panes. Controller IPC is read-only and never auto-started.
import type { EventView, TerminalLocation } from "../shared/protocol.ts";
import { readFileSync } from "node:fs";
import { TeamClient } from "../shared/client.ts";
import { statePaths } from "../shared/paths.ts";
import { formatTree, formatBudget, formatEvents } from "../extension/format.ts";
import { TmuxWatch, flatten } from "./tmux.ts";
import { recentOutput, screen } from "./render.ts";

const [stateDir, runId, agent, socket, location] = process.argv.slice(2);
if (!stateDir || !runId || !agent) throw new Error("watch requires state directory, run ID and pane role");
const paths = statePaths(stateDir);
const client = new TeamClient({ paths, noReconnect: true, token: () => readFileSync(paths.operatorToken, "utf8").trim() });
const watch = new TmuxWatch({ stateDir, runId, socket: socket || undefined, location: location ? JSON.parse(location) as TerminalLocation : undefined, debug: agent === "dashboard" });
let eventCursor = 0;
let recentEvents: EventView[] = [];
while (true) {
	let text: string;
	try {
		if (agent === "placeholder") {
			text = "Team terminals are ready.\nMembers appear here when recruited.\nContinue interacting with your leader Pi.";
		} else if (agent === "dashboard") {
			const tree = await client.tree(runId, { timeoutMs: 2000 });
			const terminal = await client.get<{ enabled: boolean; socket?: string; location?: TerminalLocation; debug?: boolean }>(`/runs/${encodeURIComponent(runId)}/terminal`, { timeoutMs: 2000 });
			if (terminal.enabled && !terminal.debug) process.exit(0);
			if (terminal.enabled) {
				if (terminal.socket) watch.opts.socket = terminal.socket;
				watch.opts.location = terminal.location;
			}
			await watch.sync(flatten(tree.root).slice(1), terminal.enabled);
			const [budget, events] = await Promise.all([client.budget(tree.root.agent_id, { timeoutMs: 2000 }), client.events({ run_id: runId, after: eventCursor, limit: 1000 }, { timeoutMs: 2000 })]);
			recentEvents = [...recentEvents, ...events.events].slice(-10);
			if (events.events.length) eventCursor = events.events[events.events.length - 1].seq;
			text = `TEAM CONTROL • ${watch.name}\n${runId} • ${new Date().toLocaleTimeString()}\n` +
				"Leader and members share this window. Choose pane (prefix arrows); zoom (prefix z).\n" +
				"Member panes run interactive Pi. Type directly or use /team send <agent_id> <message>.\n" +
				"Detach: prefix d or /team watch close. Stop agents through /team stop.\n\n" +
				formatTree(tree) + "\n\n" + formatBudget(budget) + "\n\n" + formatEvents(recentEvents, 10);
		} else {
			const r = await client.inspect(agent, { timeoutMs: 2000 });
			const a = r.agent;
			text = `${a.role} [${agent}]\n${a.status}/${a.observed_state} • desired ${a.desired_state} • ${a.model ?? "default model"}\n` +
				`Tasks: ${r.tasks.map((t) => `${t.status}: ${t.title}`).join("; ") || "none"}\n` +
				`Sessions: ${r.sessions.length} • ${new Date().toLocaleTimeString()}\nLegacy headless output; /team watch enables interactive Pi.\n\n` + recentOutput(paths.workerLogs, agent);
		}
	} catch (e) {
		text = `Team monitor • ${runId}\n${agent}\n${(e as Error).message}\nRetrying; workers are managed independently of this view.`;
	}
	process.stdout.write(screen(text, Math.max(5, (process.stdout.rows || 40) - 1), process.stdout.columns || 120));
	await new Promise((resolve) => setTimeout(resolve, 2000));
}
