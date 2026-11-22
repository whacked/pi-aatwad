import { resolveAvailableModel } from "./models.ts";
import { leaveToLeader, openTerminals } from "./terminals.ts";
import { terminalView } from "../terminal/view.ts";
import type { NativeView } from "../terminal/native.ts";
import { attachMember } from "./attach.ts";
import { hostCapabilities } from "../terminal/host.ts";
// `/team` command with subcommands. Human-facing; uses the operator token unless this is a managed worker.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReportingRequest, RunConfig, TerminalBackend, TerminalLocation } from "../shared/protocol.ts";
import { ping, rawRequest, isUnavailable, TeamApiError, ControllerIncompatibleError } from "../shared/client.ts";
import type { RunSummary } from "../shared/protocol.ts";
import { formatBudget, formatEvents, formatInspect, formatProposal, formatTree } from "./format.ts";
import type { TeamRuntime } from "./runtime.ts";
import { TOOL_NAMES } from "./names.ts";
import { LOADED_SOURCE, LOADED_VERSION } from "../shared/version.ts";

export const SUBCOMMANDS: { name: string; args: string; help: string }[] = [
	{ name: "join", args: "<run_id|agent_id|none> [--terminatable]", help: "link this team under another team's leader or agent: it can assign you work and dismiss you (only detaching, unless --terminatable); none detaches. In a member: leave its team (leading your own), then join" },
	{ name: "report-to", args: "<run_id|agent_id|none>", help: "alias for join" },
	{ name: "dismiss", args: "<name|agent_id> [--stop|--keep] [reason]", help: "end a team linked under you: it detaches, or stops (resumably) when its link is terminatable; --stop/--keep override" },
	{ name: "roster", args: "", help: "everyone ever linked under you: active, detached, dismissed or closed" },
	{ name: "recall", args: "<name|agent_id>", help: "bring a former member back with its context (a dismissed team resumes and links again)" },
	{ name: "rehire", args: "<name|agent_id>", help: "fill a former member's position with a new agent and a fresh context" },
	{ name: "link", args: "<name|agent_id> terminatable on|off", help: "human operator: whether dismissing this linked team or joined member may stop it" },
	{ name: "reporting", args: "[--all|dismiss|transfer [run_id]|wake on|off]", help: "inspect, dismiss or transfer reporting links (wake on|off = /team attention on-message)" },
	{ name: "attention", args: "[team|name|agent_id] [on-message wake|next-turn] [batch 15s] [stall 3m|off] [tick 10m|off] [cap N] [reset]", help: "when idle leaders/members get automatic turns (message wake, stall alerts, check-ins)" },
	{ name: "help", args: "", help: "show this help" },
	{ name: "init", args: "[--unlimited] [config-json-path]", help: "create a new organization with this session as root" },
	{ name: "resume", args: "[run_id] [name|agent_id]", help: "choose a resumable team or attach to one directly; init is not required" },
	{ name: "tree", args: "[run_id] [--all]", help: "live logical hierarchy" },
	{ name: "status", args: "", help: "controller, run, agent and pending work" },
	{ name: "version", args: "", help: "loaded extension and controller versions, source and state paths" },
	{ name: "budget", args: "[name|agent_id] [total_usd|none] [--resume]", help: "show budget, set a total spend ceiling, or remove it with none" },
	{ name: "inbox", args: "", help: "deliver pending team messages into this session" },
	{ name: "proposals", args: "", help: "expansion proposals to review / mine" },
	{ name: "events", args: "[run_id]", help: "recent audit events" },
	{ name: "model", args: "[name|agent_id] <provider/model>", help: "switch an existing member model when idle" },
	{ name: "inspect", args: "[name|agent_id]", help: "tasks, sessions, history, budget of an agent" },
	{ name: "list", args: "[all]", help: "list active teams, or include historical teams with all" },
	{ name: "admin", args: "[status|limits|clear-limits|clear-deadlines|unlimited|bounded] [run_id]", help: "human operator resource policy: list or remove limits" },
	{ name: "stop", args: "[run_id]", help: "stop a whole team resumably; preserve identities and transcripts" },
	{ name: "remove", args: "[run_id] [--yes]", help: "permanently remove a whole team; preserve Pi and worktrees" },
	{ name: "watch", args: "[open|status|close|off|debug|focus [name|agent_id]] [run_id]", help: "manage live Pi member terminals (tmux panes, Rex blocks, or the built-in session host); focus switches to a member" },
	{ name: "send", args: "[name|agent_id] <message>", help: "send directions to a team member" },
	{ name: "leave", args: "", help: "in a member's terminal: return to the leader; the member keeps running" },
];

export { formatAttention, parseAttention, parseDuration } from "../shared/attention-format.ts";
import { formatAttention, parseAttention } from "../shared/attention-format.ts";

/** Subcommand aliases, resolved before dispatch, completion and --yes handling. */
export const ALIASES: Record<string, string> = { "report-to": "join" };

export function helpText(pi: Pick<ExtensionAPI, "getAllTools">, rt: TeamRuntime): string {
	const w = Math.max(...SUBCOMMANDS.map((s) => `${s.name} ${s.args}`.length));
	const lines = ["pi-recursive-team — /team <subcommand>", ...SUBCOMMANDS.map((s) => `  /team ${`${s.name} ${s.args}`.padEnd(w)}  ${s.help}`)];
	let registered: string[] = [];
	try {
		registered = pi.getAllTools().map((t) => t.name).filter((n) => (TOOL_NAMES as readonly string[]).includes(n));
	} catch {
		registered = [];
	}
	lines.push(`tools (${registered.length}/${TOOL_NAMES.length}): ${registered.join(", ")}`);
	lines.push("Omitted targets use the current team or select the sole viable candidate; multiple candidates prompt. Destructive commands confirm; --yes explicitly authorizes them (required without UI).");
	const id = rt.identity;
	lines.push(id ? `identity: ${id.role ?? "agent"} ${id.agent_id} in run ${id.run_id}${id.managed ? " (managed worker)" : ""}` : `identity: not enrolled${rt.notice ? ` — ${rt.notice}` : ""}`);
	return lines.join("\n");
}

class SelectionCancelled extends Error {}

function splitArgs(args: string): string[] {
	return (args.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? []).map((part) => part.startsWith('"') ? JSON.parse(part) : part.startsWith("'") ? part.slice(1, -1) : part);
}

function errText(e: unknown): string {
	if (e instanceof TeamApiError) return `${e.code}: ${e.message.replace(/^[A-Z_]+: /, "")}`;
	if (e instanceof ControllerIncompatibleError) return e.message;
	return (e as Error)?.message ?? String(e);
}

const TERMINAL_STATUSES = new Set(["CANCELLED", "COMPLETED", "FAILED", "RETIRED"]);
function resumable(run: RunSummary): boolean {
	return !TERMINAL_STATUSES.has(run.status) && !TERMINAL_STATUSES.has(run.root_status ?? "");
}
function runLabel(run: RunSummary): string {
	return `${run.run_id} · ${run.active_members ?? Math.max(0, run.agents - 1)} active members · ${run.live_members ?? "?"} running${run.reporting_teams ? ` · ${run.reporting_teams} reporting teams` : ""}${run.reports_to_run_id ? ` · reports to ${run.reports_to_run_id}` : ""} · ${run.created_at}`;
}

export function registerTeamCommand(pi: ExtensionAPI, rt: TeamRuntime): void {
	const out = (ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info") => {
		rt.ctx = rt.ctx ?? ctx;
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else process.stderr.write(`${text}\n`);
	};

	const choose = async <T,>(ctx: ExtensionCommandContext, title: string, rows: T[], id: (row: T) => string, label: (row: T) => string): Promise<string> => {
		if (!rows.length) throw new Error(`No viable candidates: ${title}`);
		if (rows.length === 1) return id(rows[0]);
		const labels = rows.map(label);
		if (!ctx.hasUI) throw new Error(`${title}: specify a target; candidates:\n${labels.join("\n")}`);
		const selected = await ctx.ui.select(title, labels);
		const index = selected === undefined ? -1 : labels.indexOf(selected);
		if (index < 0) throw new SelectionCancelled();
		return id(rows[index]);
	};
	const confirm = async (ctx: ExtensionCommandContext, yes: boolean | undefined, detail: string): Promise<boolean> => {
		if (yes) return true;
		if (!ctx.hasUI) throw new Error(`Confirmation required: ${detail}. Rerun with --yes to authorize.`);
		if (await ctx.ui.confirm("Confirm team operation?", detail)) return true;
		out(ctx, "Operation cancelled; no changes made.");
		return false;
	};
	const runId = async (ctx: ExtensionCommandContext, arg?: string, foreign = false): Promise<string> => {
		if (arg) return arg; // Invalid explicit references must never select another target.
		if (!foreign && rt.identity) return rt.identity.run_id;
		const runs = (await rt.client.listRuns({ token: await rt.commandToken() })).runs.filter((r) => resumable(r) && (!foreign || r.run_id !== rt.identity?.run_id));
		return choose(ctx, "Choose a team", runs, (r) => r.run_id, runLabel);
	};
	const agent = async (ref: string | undefined, ctx: ExtensionCommandContext, selectedRun = rt.identity?.run_id): Promise<string> => {
		const token = await rt.commandToken();
		if (ref) return rt.client.resolveAgent(ref, selectedRun, { token });
		const tree = await rt.client.tree(selectedRun ?? await runId(ctx), { token });
		const flatten = (n: typeof tree.root): typeof tree.root[] => [n, ...n.children.flatMap(flatten)];
		const nodes = flatten(tree.root);
		const scope = rt.managed ? nodes.find((n) => n.agent_id === rt.identity?.agent_id) ?? tree.root : tree.root;
		const members = flatten(scope).filter((n) => n.agent_id !== scope.agent_id && !TERMINAL_STATUSES.has(n.status));
		return choose(ctx, "Choose a member", members.length ? members : [scope].filter((n) => !TERMINAL_STATUSES.has(n.status)), (n) => n.agent_id, (n) => `${n.role} [${n.agent_id}] · ${n.status}`);
	};
	let initializedRunId: string | undefined;
	const handlers: Record<string, (a: string[], ctx: ExtensionCommandContext, yes?: boolean) => Promise<void>> = {
		help: async (_a, ctx) => out(ctx, helpText(pi, rt)),

		reporting: async (a, ctx, yes) => {
			await rt.requireIdentity();
			const id = await runId(ctx);
			const token = await rt.commandToken();
			if (!a.length || (a.length === 1 && a[0] === "--all")) {
				out(ctx, JSON.stringify(await rt.client.reporting(id, a[0] === "--all", { token }), null, 2));
				return;
			}
			let request: ReportingRequest;
			if (a.length === 1 && a[0] === "dismiss") request = { action: "dismiss" };
			else if (a.length <= 2 && a[0] === "transfer") request = { action: "transfer", parent_run_id: await runId(ctx, a[1], true) };
			else if (a.length === 2 && a[0] === "wake" && ["on", "off"].includes(a[1])) request = { action: "wake", wake_on_message: a[1] === "on" };
			else throw new Error("usage: /team reporting [--all|dismiss|transfer <run_id>|wake on|off]");
			if (request.action !== "wake" && !(await confirm(ctx, yes, `Change reporting links for ${id}: ${JSON.stringify(request)}?`))) return;
			out(ctx, JSON.stringify(await rt.client.setReporting(id, request, { token }), null, 2));
		},

		attention: async (a, ctx) => {
			await rt.requireIdentity();
			const token = await rt.commandToken();
			const keywords = new Set(["on-message", "batch", "stall", "tick", "checkin", "cap", "reset"]);
			const first = a[0] && !keywords.has(a[0]) ? a.shift()! : "team";
			const target = first === "team" ? { run_id: await runId(ctx) } : { agent_id: await agent(first, ctx) };
			const patch = parseAttention(a);
			const view = Object.keys(patch).length ? await rt.client.setAttention(target, patch, { token }) : await rt.client.attention(target, { token });
			out(ctx, formatAttention(view));
		},

		join: async (a, ctx, yes) => {
			await rt.requireIdentity();
			const terminatable = a.includes("--terminatable");
			const args = a.filter((x) => x !== "--terminatable");
			if (args.length !== 1) throw new Error("usage: /team join <run_id|agent_id|none> [--terminatable]");
			let token = await rt.commandToken();
			// A member reroutes by leaving its team (leading its own) and then joining the target.
			const self = await rt.client.me({ token: rt.identity!.token });
			if (!self.is_root) {
				const lead = self.parent ? `${self.parent.role} [${self.parent.agent_id}]` : "its manager";
				if (!(await confirm(ctx, yes, `Leave team ${self.run_id} (manager ${lead}) and lead your own team${args[0] === "none" ? "" : `, then join under ${args[0]}`}? This session and its conversation continue; your member identity there is retired, its open tasks are cancelled and ${lead} is told.`))) return;
				const r = await rt.client.post<{ run_id: string; root_agent_id: string; session_id: string; token: string; previous_agent_id: string }>("/sessions/secede", {}, { token: rt.identity!.token });
				rt.adoptNew({ run_id: r.run_id, agent_id: r.root_agent_id, session_id: r.session_id, token: r.token, managed: rt.identity!.managed, role: self.role, pi_session_id: rt.piSession().id, ...(rt.identity!.socket_path ? { socket_path: rt.identity!.socket_path } : {}) });
				await rt.refreshRole().catch(() => {});
				rt.updateStatus();
				out(ctx, `Left team ${self.run_id}: you now lead team ${r.run_id} as ${r.root_agent_id} (was ${r.previous_agent_id}).`);
				if (args[0] === "none") return;
				token = await rt.commandToken();
			}
			const me = await runId(ctx);
			if (args[0] === "none") {
				if (!(await confirm(ctx, yes, `Detach team ${me} from its lead? Both teams keep running.`))) return;
				out(ctx, JSON.stringify(await rt.client.setReporting(me, { action: "disconnect" }, { token }), null, 2));
				return;
			}
			// A team's run ID links under its leader; an agent ID links under that agent (the controller checks it).
			const target = /^run-/.test(args[0]) ? { parent_run_id: args[0] } : { parent_agent_id: args[0] };
			if (!(await confirm(ctx, yes, `Link team ${me} under ${args[0]}? Its lead can assign work and dismiss it (${terminatable ? "dismissal may stop the team" : "dismissal only detaches"}).`))) return;
			const result = await rt.client.setReporting(me, { action: "connect", ...target, ...(terminatable ? { terminatable } : {}) }, { token });
			out(ctx, JSON.stringify(result, null, 2));
		},

		dismiss: async (a, ctx, yes) => {
			await rt.requireIdentity();
			if (!a.length) throw new Error("usage: /team dismiss <name|agent_id> [--stop|--keep] [reason]");
			const stop = a.includes("--stop") ? true : a.includes("--keep") ? false : undefined;
			const rest = a.filter((x) => x !== "--stop" && x !== "--keep");
			const target = await agent(rest[0], ctx);
			const reason = rest.slice(1).join(" ") || undefined;
			if (!(await confirm(ctx, yes, `Dismiss ${rest[0]}? ${stop === true ? "Its team will be stopped (resumably)." : stop === false ? "It will only be detached." : "It detaches, or stops if its link is terminatable."}`))) return;
			type Dismissed = { severed: boolean; stopped: boolean; stopped_run_ids: string[]; severed_below: string[] };
			const r = await rt.client.post<Dismissed>(`/agents/${encodeURIComponent(target)}/dismiss`, { ...(stop !== undefined ? { stop } : {}), ...(reason ? { reason } : {}) }, { token: await rt.commandToken() });
			out(ctx, r.stopped
				? `Dismissed ${rest[0]}: stopped ${r.stopped_run_ids.join(", ")} (resumable with /team resume)${r.severed_below.length ? `; detached joined teams below: ${r.severed_below.join(", ")}` : ""}.`
				: `Dismissed ${rest[0]}: detached; its team keeps running on its own.`);
		},

		roster: async (_a, ctx) => {
			await rt.requireIdentity();
			type Entry = { agent_id: string; role: string; run_id?: string; origin: string; terminatable: boolean; active: boolean; status: string; team_state?: string; close_reason: string | null };
			const r = await rt.client.get<{ entries: Entry[] }>(`/agents/${encodeURIComponent(rt.identity!.agent_id)}/roster`, { token: rt.managed ? undefined : await rt.commandToken() });
			if (!r.entries.length) { out(ctx, "Roster: nobody has been linked under you yet."); return; }
			out(ctx, ["Roster:", ...r.entries.map((e) => `  ${e.active ? "●" : "○"} ${e.role} [${e.agent_id}] ${e.origin}${e.terminatable ? ", terminatable" : ""}${e.run_id ? `, team ${e.run_id} (${e.team_state})` : `, ${e.status}`}${e.active ? "" : ` — ${e.close_reason ?? "closed"}`}`), "Bring one back: /team recall <name>; fill a position fresh: /team rehire <name>."].join("\n"));
		},

		recall: async (a, ctx) => {
			await rt.requireIdentity();
			if (a.length !== 1) throw new Error("usage: /team recall <name|agent_id>");
			const r = await rt.client.post<{ same_identity: boolean; agent_id?: string; run_id?: string; resumed?: boolean; transcript_restored?: boolean }>("/roster/recall", { agent: a[0], lead_id: rt.identity!.agent_id }, { token: await rt.commandToken() });
			out(ctx, r.same_identity ? `Recalled ${a[0]}: team ${r.run_id} is linked under you again${r.resumed ? " and resumed" : ""}.` : `Recalled ${a[0]} as ${r.agent_id}${r.transcript_restored ? ", continuing its previous transcript" : ""}.`);
		},

		rehire: async (a, ctx) => {
			await rt.requireIdentity();
			if (a.length !== 1) throw new Error("usage: /team rehire <name|agent_id>");
			const r = await rt.client.post<{ agent_id: string }>("/roster/rehire", { agent: a[0], lead_id: rt.identity!.agent_id }, { token: await rt.commandToken() });
			out(ctx, `Rehired ${a[0]}'s position as ${r.agent_id}, with a fresh context.`);
		},

		link: async (a, ctx) => {
			await rt.requireIdentity();
			if (rt.managed) throw new Error("only the human operator can change whether a link is terminatable");
			if (a.length !== 3 || a[1] !== "terminatable" || !["on", "off"].includes(a[2])) throw new Error("usage: /team link <name|agent_id> terminatable on|off");
			const target = await agent(a[0], ctx);
			await rt.client.post(`/agents/${encodeURIComponent(target)}/link`, { terminatable: a[2] === "on" }, { token: await rt.operatorToken(0) });
			out(ctx, `${a[0]}: dismissal ${a[2] === "on" ? "may stop its team" : "only detaches it"}.`);
		},

		watch: async (a, ctx, yes) => {
			await rt.ready;
			if (rt.managed) throw new Error("managed workers cannot manage team terminals; use the leader session");
			const action = a[0] ?? "open";
			if (!["open", "status", "close", "focus", "debug", "off"].includes(action)) throw new Error("usage: /team watch [open|status|close|off|debug|focus <name|agent_id>] [run_id]");
			// Missing focus target is selected from viable members below.
			const explicitRun = a[action === "focus" ? 2 : 1];
			if (!explicitRun && !rt.identity && (action === "open" || action === "focus" || action === "debug")) {
				await handlers.resume([], ctx, yes);
				if (!rt.identity) return;
			}
			const id = await runId(ctx, explicitRun);
			const focusTarget = action === "focus" ? await agent(a[1], ctx, id) : undefined;
			if (action === "off") {
				if (!(await confirm(ctx, yes, `Disable team terminals for ${id}? Existing workers may be interrupted and restarted detached.`))) return;
				await rt.client.post(`/runs/${encodeURIComponent(id)}/terminal`, { enabled: false }, { token: await rt.commandToken() });
				out(ctx, "Detached worker mode selected. Existing workers restart on their saved transcripts; automatic panes stay off until /team watch open.");
				return;
			}
			const terminal = await rt.client.get<{ enabled?: boolean; backend?: TerminalBackend; socket?: string; location?: TerminalLocation; debug?: boolean }>(`/runs/${encodeURIComponent(id)}/terminal`, { token: await rt.commandToken() });
			if (terminal.enabled === false && (action === "status" || action === "close")) {
				out(ctx, "Detached workers; use /team watch open for interactive member panes.");
				return;
			}
			const opening = action === "open" || action === "focus" || action === "debug";
			let view = await terminalView({ stateDir: rt.paths.dir, runId: id, backend: terminal.backend,
				socket: opening ? undefined : terminal.socket, location: opening ? undefined : terminal.location });
			if (action === "close") {
				if (!(await confirm(ctx, yes, `Close the team view for ${id}? Workers remain running.`))) return;
				if (terminal.debug) await rt.client.post(`/runs/${encodeURIComponent(id)}/terminal`, { backend: terminal.backend, socket: terminal.socket, location: terminal.location, debug: false }, { token: await rt.commandToken() });
				await view.close();
				out(ctx, `Member terminals left running for ${id}; your current ${view.backend} session is unchanged`);
				return;
			}
			if (action === "status") {
				out(ctx, await view.exists() ? `${view.backend === "native" ? "built-in session host" : `${view.backend} ${view.opts.location!.window}`}: ${(await view.panes()).length} member terminals` : `No member panes for ${id}. ${hostCapabilities().sessions ? "Use /team watch to open them beside this Pi." : hostCapabilities().unavailable}`);
				return;
			}
			// Validate access and run existence before creating terminal resources.
			await rt.client.tree(id, { token: await rt.commandToken() });
			view = await openTerminals(rt, id, { debug: action === "debug" });
			if (view.reclaimedFrom) out(ctx, `This terminal was still tagged for ${view.reclaimedFrom}. It now hosts ${id}; nothing was stopped or deleted.`);
			const tree = action === "focus" ? await rt.client.tree(id, { token: await rt.commandToken() }) : undefined;
			const target = tree && focusTarget !== tree.root.agent_id ? focusTarget : undefined;
			// A linked team runs in its own session and terminal; there is nothing here to switch to.
			const linkedRun = target ? (await rt.client.me().catch(() => undefined))?.children.find((c) => c.agent_id === target)?.run_id : undefined;
			if (linkedRun) { out(ctx, `${a[1] ?? target} leads its own team ${linkedRun}, linked under you; it runs in its own session, so switch to that terminal or window. Message it with /team send.`); return; }
			if (view.backend === "native") {
				// No on-screen panes: switching means handing this terminal to the member.
				if (target) { out(ctx, await attachMember(ctx, view as NativeView, target)); return; }
				out(ctx, "Members run in the built-in session host and keep running when you leave. /team watch focus <name> switches this terminal to one; type /team leave there to come back. From another terminal: pi-team-attach <name>.");
				return;
			}
			await view.focus(target ?? "leader");
			out(ctx, `Member ${view.backend === "rex" ? "blocks" : "panes"} open beside Pi in the current ${view.backend} window; interactive members appear automatically. /team watch focus <name> switches to one; /team leave in a member returns here.`);
		},

		leave: async (_a, ctx) => {
			await rt.ready;
			if (!rt.managed || !rt.identity) throw new Error("/team leave runs in a member's terminal and returns you to the leader; you are already in the leader");
			out(ctx, await leaveToLeader(rt));
		},

		send: async (a, ctx) => {
			await rt.requireIdentity();
			if (!a.length) throw new Error("usage: /team send [name|agent_id] <message>; use -- before multiword text to omit the target");
			const omitted = a.length === 1 || a[0] === "--";
			const to = await agent(omitted ? undefined : a[0], ctx);
			const text = omitted && a[0] !== "--" ? a[0] : a.slice(1).join(" ");
			if (!text) throw new Error("message is required");
			const sent = await rt.agentCall(async () => rt.client.sendMessage({ to, type: "question", payload: { text } }));
			out(ctx, `message ${sent.message_id} sent to ${omitted ? to : a[0]}`);
		},

		init: async (a, ctx) => {
			await rt.ready;
			if (rt.managed) throw new Error("managed workers cannot run /team init; they are enrolled by the controller");
			if (rt.identity) throw new Error(`already enrolled as ${rt.identity.agent_id} in run ${rt.identity.run_id}`);
			let config: Partial<RunConfig> | undefined;
			const configPath = a.find((value) => value !== "--unlimited");
			if (configPath) {
				const p = resolve(ctx.cwd, configPath);
				config = JSON.parse(readFileSync(p, "utf8")) as Partial<RunConfig>;
			}
			if (a.includes("--unlimited")) config = { ...config, operator_unlimited: true };
			const { spawned } = await rt.ensure();
			const op = await rt.operatorToken();
			const pis = rt.piSession();
			const r = await rt.client.createRun(
				{
					config,
					root: { role: "root", pi_session_id: pis.id, pi_session_path: pis.path, cwd: ctx.cwd, provider: ctx.model?.provider, model: ctx.model?.id },
				},
				{ token: op, idempotencyKey: `init:${pis.id}:${randomUUID()}` },
			);
			initializedRunId = r.run_id;
			rt.adoptNew({ run_id: r.run_id, agent_id: r.root_agent_id, session_id: r.session_id, token: r.token, managed: false, role: "root", pi_session_id: pis.id });
			await rt.refreshRole();
			const e = r.envelope;
			out(
				ctx,
				`team run ${r.run_id} created${spawned ? " (controller started)" : ""}; you are root agent ${r.root_agent_id}.\n` +
					(config?.operator_unlimited ? "policy: UNLIMITED, authorized by the human operator (no numeric resource caps)\n" : `budget: ≤$${e.max_subtree_usd} subtree spend, ≤${e.max_subtree_slots} live descendants, single grant ≤${e.max_grant_slots} slots/$${e.max_grant_usd}\n`) +
					"This is a new empty team. Ask the leader to create members, or use /team resume to choose an existing team.",
			);
		},

		list: async (a, ctx) => {
			if (rt.managed) throw new Error("managed workers can inspect their own team with /team tree");
			const runs = (await rt.client.listRuns({ token: await rt.commandToken() })).runs.filter((r) => a[0] === "all" || resumable(r));
			out(ctx, runs.length ? runs.map((r) => `${runLabel(r)} · ${r.stopped ? "STOPPED (resumable)" : r.status}${r.run_id === rt.identity?.run_id ? " · current" : ""}`).join("\n") : "No active teams. /team init creates one; /team list all shows history.");
		},

		admin: async (a, ctx, yes) => {
			if (rt.managed) throw new Error("only the human operator can change resource limits");
			const action = a[0] ?? "status";
			if (!["status", "limits", "unlimited", "bounded", "clear-deadlines", "clear-limits", "member-default"].includes(action)) throw new Error("usage: /team admin [status|limits|clear-limits|clear-deadlines|unlimited|bounded|member-default <usd|none>] [run_id]");
			if (action === "member-default") {
				if (!a[1] || (a[1] !== "none" && !(Number(a[1]) >= 0))) throw new Error("usage: /team admin member-default <usd|none> [run_id]");
				const id = await runId(ctx, a[2]);
				const usd = a[1] === "none" ? null : Number(a[1]);
				await rt.client.post(`/runs/${id}/admin`, { mode: "member-default", usd }, { token: await rt.commandToken() });
				out(ctx, usd === null ? `${id}: no default member budget.` : `${id}: teams that join get $${usd} added to their budget.`);
				return;
			}
			const id = await runId(ctx, a[1]);
			const token = await rt.commandToken();
			const read = action === "status" || action === "limits";
			if (!read && !(await confirm(ctx, yes, action === "clear-limits"
				? `Remove every spend, member-count, depth and time limit from ${id}, and resume members those limits paused?`
				: `Apply resource policy ${action} to ${id}? Existing limits may be removed or re-enforced.`))) return;
			type Policy = { mode: string; limits?: string[]; resumed?: string[]; still_paused?: string[] };
			const policy = read ? await rt.client.get<Policy>(`/runs/${id}/admin`, { token })
				: await rt.client.post<Policy>(`/runs/${id}/admin`, { mode: action }, { token });
			const limits = policy.limits === undefined ? [] // older controller
				: policy.limits.length ? [`Limits in force (${policy.limits.length}):`, ...policy.limits.map((l) => `  ${l}`), "Remove all with /team admin clear-limits, or one member's ceiling with /team budget <member> none."]
				: ["No limits in force: spend, member count, depth and run time are unbounded. Set one with /team budget <member> <usd>."];
			const cleared = action === "clear-limits" ? [
				`Resumed ${policy.resumed?.length ?? 0} member(s) that a limit had paused.`,
				...(policy.still_paused?.length ? [`Still paused (no limit-caused pause recorded; resume with /team budget <member> none --resume): ${policy.still_paused.join(", ")}`] : []),
			] : [];
			out(ctx, [`Human operator policy for ${id}: ${policy.mode.toUpperCase()}${action === "clear-deadlines" ? " — saved session/runtime deadlines cleared for all members; budgets unchanged; paused members remain paused" : action === "unlimited" ? " — global spend, member-count and recursion-depth caps are bypassed; explicit worker budgets and deadlines remain enforced" : ""}`, ...cleared, ...limits].join("\n"));
		},

		resume: async (a, ctx, yes) => {
			await rt.ready;
			if (rt.managed) throw new Error("managed workers cannot resume a different team; use the leader Pi");
			if (a.length > 2) throw new Error("usage: /team resume [run_id] [name|agent_id] [--yes]");
			if (!a[0] && !rt.identity) {
				try { await rt.operatorToken(0); }
				catch { out(ctx, "No resumable teams. Use /team init to create a new team, then ask the leader to add members."); return; }
			}
			const op = await rt.commandToken();
			const runs = (await rt.client.listRuns({ token: op })).runs;
			let target = a[0];
			if (!target) {
				const choices = runs.filter(resumable).sort((x, y) => (y.active_members ?? y.agents - 1) - (x.active_members ?? x.agents - 1) || y.created_at.localeCompare(x.created_at));
				if (!choices.length) { out(ctx, "No resumable teams. Use /team init to create a new team, then ask the leader to add members."); return; }
				if (choices.length === 1) target = choices[0].run_id;
				else {
					if (!ctx.hasUI) {
						out(ctx, `Resumable teams:\n${choices.map(runLabel).join("\n")}\nUse /team resume <run_id> to attach, then /team watch.`);
						return;
					}
					const labels = choices.map((r) => runLabel(r) + (r.run_id === rt.identity?.run_id ? " · current" : ""));
					const selected = await ctx.ui.select("Resume a team", labels);
					if (!selected) return;
					target = choices[labels.indexOf(selected)]?.run_id;
					if (!target) return;
				}
			}
			const run = runs.find((r) => r.run_id === target);
			if (!run) throw new Error(`team ${target} not found; /team resume lists resumable teams`);
			if (!a[1] && !resumable(run)) throw new Error(`team ${target} cannot be resumed (${run.root_status ?? run.status}); /team resume lists active teams`);
			const member = a[1] ? await rt.client.resolveAgent(a[1], target, { token: op }) : undefined;
			// A healthy attached team needs no takeover; a team stopped elsewhere still resumes.
			if (rt.identity?.run_id === target && !run.stopped && (!member || member === rt.identity.agent_id)) {
				out(ctx, `Already attached to ${runLabel(run)}. Use /team watch to open its members.`);
				return;
			}
			let emptyNewRoot: string | undefined;
			if (rt.identity && rt.identity.run_id === initializedRunId && rt.identity.run_id !== target) {
				const me = await rt.client.me();
				if (me.is_root && runs.find((r) => r.run_id === initializedRunId)?.agents === 1 && !me.children.length && !me.tasks.length && !me.inbox_pending && !me.pending_proposals_to_review) emptyNewRoot = me.agent_id;
			}
			if (!(await confirm(ctx, yes, `Attach to ${target} as ${member ?? "its root"}, replacing its existing session${emptyNewRoot ? ` and cancel unused empty team ${initializedRunId}` : ""}?`))) return;
			// Resume and fresh attach share the runtime identity-transition queue.
			await rt.attach(target, member, { resume: true });
			if (emptyNewRoot) {
				try { await rt.client.lifecycle(emptyNewRoot, { action: "cancel", reason: "unused init replaced by resume", children_policy: "cascade" }, { token: op }); }
				catch (e) { out(ctx, `Attached, but could not retire the unused empty team: ${errText(e)}`, "warning"); }
			}
			initializedRunId = undefined;
			// Teams created before limits became opt-in still carry their saved caps: say so up front.
			const saved = await rt.client.get<{ limits?: string[] }>(`/runs/${target}/admin`, { token: op }).then((r) => r.limits ?? [], () => []);
			out(ctx, `Resumed ${runLabel(run)}. Use /team tree to inspect members, then /team watch to open their Pi panes.${saved.length ? `\nThis team has ${saved.length} saved limit(s) that can block or pause members. /team admin limits lists them; /team admin clear-limits removes them all.` : ""}`);
		},

		tree: async (a, ctx) => {
			const t = await rt.client.tree(await runId(ctx, a.find((arg) => arg !== "--all")), { token: await rt.commandToken() }, !a.includes("--all"), true);
			out(ctx, formatTree(t, rt.identity?.agent_id));
		},

		status: async (_a, ctx) => {
			await rt.ready;
			const lines: string[] = [];
			try {
				const h = await ping(rt.paths);
				lines.push(`controller: up pid ${h.pid} id ${h.controller_id} epoch ${h.fencing_epoch} protocol ${h.protocol}/schema ${h.schema} · live workers ${h.live_workers} · state ${h.state_dir}`);
			} catch (e) {
				lines.push(isUnavailable(e) ? `controller: not running (auto-starts on /team init or /team resume) — socket ${rt.paths.socket}` : `controller: ${errText(e)}`);
			}
			const id = rt.identity;
			if (!id) lines.push(`identity: not enrolled${rt.fenced ? " (fenced)" : ""}${rt.notice ? ` — ${rt.notice}` : ""}`);
			else {
				lines.push(`identity: ${id.role ?? "agent"} ${id.agent_id} · run ${id.run_id} · session ${id.session_id}${id.managed ? " · managed worker" : ""}`);
				try {
					const me = await rt.agentCall(() => rt.client.me());
					lines.push(
						`manager: ${me.parent ? `${me.parent.role} [${me.parent.agent_id}]` : "(root)"} · reports ${me.children.length} · tasks ${me.tasks.length} · inbox ${me.inbox_pending} · reviews ${me.pending_proposals_to_review} · desired ${me.desired_state}`,
					);
					if (me.is_root && !me.children.some((c) => !TERMINAL_STATUSES.has(c.status))) lines.push("team: no active members. Ask the leader to create members, or /team resume to choose another team.");
				} catch (e) {
					lines.push(`org context: ${errText(e)}`);
				}
			}
			lines.push(`extension: v${LOADED_VERSION} · source ${LOADED_SOURCE}`);
			out(ctx, lines.join("\n"));
		},

		version: async (_a, ctx) => {
			const lines = [`extension: v${LOADED_VERSION} · source ${LOADED_SOURCE}`];
			try {
				const health = await ping(rt.paths);
				lines.push(`controller: ${health.package_version ? `v${health.package_version}` : "unknown version (older controller; restart to update)"} · pid ${health.pid} · source ${health.source_root ?? "unknown"} · state ${health.state_dir}`);
			} catch { lines.push(`controller: not running · state ${rt.paths.dir}`); }
			out(ctx, lines.join("\n"));
		},

		budget: async (a, ctx, yes) => {
			const resume = a.includes("--resume");
			a = a.filter((arg) => arg !== "--resume");
			const isValue = (s: string | undefined) => s !== undefined && s.trim() !== "" && (s === "none" || Number.isFinite(Number(s)));
			const implicitValue = a.length === 1 && isValue(a[0]);
			const value = implicitValue ? a[0] : a[1];
			if (value !== undefined && !isValue(value)) throw new Error("usage: /team budget [name|agent_id] [total_usd|none] [--resume]");
			const target = implicitValue ? undefined : a[0] ?? rt.identity?.agent_id;
			const tok = await rt.commandToken();
			const id = await agent(target, ctx);
			if (value !== undefined && !(await confirm(ctx, yes, value === "none"
				? `Remove ${id}'s own spend ceiling${resume ? " and resume it" : ""}? It will share its lead's budget (unbounded if the lead is).`
				: `Set ${id} total spend ceiling to $${value}${resume ? " and resume it" : ""}? This is not additional credit.`))) return;
			const budget = value === undefined ? await rt.client.budget(id, { token: tok }) : await rt.client.post<import("../shared/protocol.ts").BudgetView>(`/budgets/${encodeURIComponent(id)}`, { max_cost_usd: value === "none" ? null : Number(value), resume }, { token: tok });
			out(ctx, formatBudget(budget));
		},

		model: async (a, ctx) => {
			if (!a.length) throw new Error("usage: /team model [name|agent_id] <provider/model>");
			const token = await rt.commandToken();
			const omitted = a.length === 1 || a[0] === "--";
			const id = await agent(omitted ? undefined : a[0], ctx);
			const model = omitted && a[0] !== "--" ? a[0] : a.slice(1).join(" ");
			const result = await rt.client.post(`/agents/${encodeURIComponent(id)}/model`, { model: resolveAvailableModel(ctx, model) }, { token });
			out(ctx, JSON.stringify(result, null, 2));
		},

		inbox: async (_a, ctx) => {
			await rt.requireIdentity();
			const got = await rt.deliverInbox({ triggerTurn: false });
			out(ctx, got.length ? `delivered ${got.length} message(s) into this session (next turn will see them)` : "inbox: no new messages");
		},

		proposals: async (_a, ctx) => {
			await rt.requireIdentity();
			const [rev, mine] = await Promise.all([rt.agentCall(() => rt.client.proposals("review")), rt.agentCall(() => rt.client.proposals("mine"))]);
			out(
				ctx,
				[`to review (${rev.proposals.length}):`, ...rev.proposals.map(formatProposal), `mine (${mine.proposals.length}):`, ...mine.proposals.map(formatProposal)].join("\n"),
			);
		},

		events: async (a, ctx) => {
			const r = await rt.client.events({ run_id: await runId(ctx, a[0]), limit: 500 }, { token: await rt.commandToken() });
			out(ctx, formatEvents(r.events));
		},

		inspect: async (a, ctx) => {
			out(ctx, formatInspect(await rt.client.inspect(await agent(a[0], ctx), { token: await rt.commandToken() })));
		},

		stop: async (a, ctx, yes) => {
			await rt.ready;
			if (rt.managed) throw new Error("managed workers cannot stop whole teams; use the operator Pi");
			if (a.length > 1) throw new Error("usage: /team stop [run_id] [--yes]");
			const token = await rt.commandToken();
			const runs = (await rt.client.listRuns({ token })).runs;
			const target = a[0] ?? rt.identity?.run_id ?? await choose(ctx, "Stop a whole team", runs.filter((r) => resumable(r) && !r.stopped), (r) => r.run_id, runLabel);
			// Invalid explicit references must never reach a confirmation prompt.
			if (!runs.some((r) => r.run_id === target)) throw new Error(`team ${target} not found; /team list shows active teams`);
			if (!(await confirm(ctx, yes, `Stop whole team ${target}? Identities, tasks and transcripts are preserved for /team resume.`))) return;
			const result = await rt.client.stopTeam(target, { token });
			rt.suspendTeamIdentity(target);
			out(ctx, `Team ${target}: ${result.state} (operation ${result.operation_id}).${result.error ? ` Cleanup error: ${result.error}` : ""} Resume with /team resume ${target}.`, result.error ? "warning" : "info");
		},
		remove: async (a, ctx, yes) => {
			await rt.ready;
			if (rt.managed) throw new Error("managed workers cannot remove teams; use the operator Pi");
			if (a.length > 1) throw new Error("usage: /team remove [run_id] [--yes]");
			const token = await rt.commandToken();
			const runs = (await rt.client.listRuns({ token })).runs;
			const target = a[0] ?? await choose(ctx, "Permanently remove a whole team", runs, (r) => r.run_id, runLabel);
			if (!runs.some((r) => r.run_id === target)) throw new Error(`team ${target} not found; /team list all shows every team`);
			if (!(await confirm(ctx, yes, `Permanently remove whole team ${target}? This cannot be undone. Your root Pi session and worktrees will not be killed or deleted.`))) return;
			const result = await rt.client.removeTeam(target, { confirm_run_id: target }, { token });
			rt.removeTeamIdentity(target);
			out(ctx, `Team ${target}: ${result.state} (operation ${result.operation_id}).${result.error ? ` Cleanup error: ${result.error}` : ""} Pi and worktrees are preserved.`, result.error ? "warning" : "info");
		},
	};

	const runCompletions = async (): Promise<RunSummary[]> => {
		try {
			if (rt.managed) return [];
			const op = await rt.operatorToken(0);
			const r = await rawRequest<{ runs: RunSummary[] }>(rt.paths.socket, "GET", "/runs", { token: op, timeoutMs: 500 });
			return r.runs;
		} catch {
			return [];
		}
	};

	const agentCompletions = async (sub: string, partial: string, prefix = sub, run = rt.identity?.run_id) => {
		if (!run) return [];
		try {
			const token = rt.managed ? rt.identity?.token : await rt.operatorToken(0);
			const t = await rawRequest<import("../shared/protocol.ts").TreeResponse>(rt.paths.socket, "GET", `/runs/${encodeURIComponent(run)}/tree?active_only=1`, { token, timeoutMs: 500 });
			const flat = (n: typeof t.root): typeof t.root[] => [n, ...n.children.flatMap(flat)];
			const nodes = flat(t.root).slice(1);
			return nodes.filter((n) => n.role.toLowerCase().startsWith(partial.toLowerCase()) || n.agent_id.startsWith(partial)).map((n) => ({
				value: `${prefix} ${JSON.stringify(nodes.filter((x) => x.role.trim().toLowerCase() === n.role.trim().toLowerCase()).length > 1 ? n.agent_id : n.role)}`, label: n.role, description: `${n.agent_id} · ${n.status}`,
			}));
		} catch { return []; }
	};

	pi.registerCommand("team", {
		description: "Recursive agent team: init, resume, join/report-to, dismiss, roster, recall, rehire, link, reporting, attention, tree, status, budget, model, inbox, proposals, events, inspect, stop, remove, watch, send (see /team help)",
		getArgumentCompletions: async (prefix: string) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const items = SUBCOMMANDS.filter((s) => s.name.startsWith(parts[0] ?? "")).map((s) => ({ value: s.name, label: s.name, description: `${s.args} ${s.help}`.trim() }));
				return items.length ? items : null;
			}
			const [typed, partial = ""] = parts;
			const sub = ALIASES[typed] ?? typed;
			if (["budget", "model", "inspect", "send"].includes(sub) && parts.length === 2) return await agentCompletions(sub, partial);
			if (sub === "watch" && partial === "focus" && parts.length === 3) return await agentCompletions(sub, parts[2], "watch focus");
			if (sub === "resume" && parts.length === 3) return await agentCompletions(sub, parts[2], `resume ${partial}`, partial);
			if (sub === "join" || sub === "resume" || sub === "tree" || sub === "events" || (["stop", "remove"].includes(sub) && parts.length === 2)) {
				if (parts.length > 2) return null;
				const runs = await runCompletions();
				const items = runs.filter((r) => r.run_id.startsWith(partial) &&
					((sub !== "stop" && sub !== "resume") || resumable(r)) && (sub !== "stop" || !r.stopped)).map((r) => ({ value: `${typed} ${r.run_id}`, label: r.run_id, description: `${r.status} · ${runLabel(r)}` }));
				return items.length ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			rt.ctx = rt.ctx ?? ctx;
			let sub = "help";
			try {
				const [typed = "help", ...rest] = splitArgs(args);
				const command = ALIASES[typed] ?? typed;
				sub = typed;
				const h = handlers[command];
				if (!h) {
					out(ctx, `unknown subcommand '${sub}'.\n${helpText(pi, rt)}`, "warning");
					return;
				}
				const supportsYes = ["stop", "remove", "admin", "budget", "join", "dismiss", "reporting", "watch", "resume"].includes(command);
				const yes = supportsYes && rest.includes("--yes");
				await h(yes ? rest.filter((arg) => arg !== "--yes") : rest, ctx, yes);
			} catch (e) {
				if (e instanceof SelectionCancelled) return;
				out(ctx, `/team ${sub}: ${errText(e)}`, "error");
			}
		},
	});
}
