import { openTerminals } from "./terminals.ts";
import { TmuxWatch } from "../watch/tmux.ts";
// `/team` command with subcommands. Human-facing; uses the operator token unless this is a managed worker.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunConfig, TerminalLocation } from "../shared/protocol.ts";
import { ping, rawRequest, isUnavailable, TeamApiError, ControllerIncompatibleError } from "../shared/client.ts";
import type { RunSummary } from "../shared/protocol.ts";
import { formatBudget, formatEvents, formatInspect, formatProposal, formatTree } from "./format.ts";
import type { TeamRuntime } from "./runtime.ts";
import { TOOL_NAMES } from "./names.ts";

export const SUBCOMMANDS: { name: string; args: string; help: string }[] = [
	{ name: "help", args: "", help: "show this help" },
	{ name: "init", args: "[--unlimited] [config-json-path]", help: "create a new organization with this session as root" },
	{ name: "resume", args: "[run_id] [agent_id]", help: "choose a resumable team or attach to one directly; init is not required" },
	{ name: "tree", args: "[run_id] [--all]", help: "live logical hierarchy" },
	{ name: "status", args: "", help: "controller, run, agent and pending work" },
	{ name: "budget", args: "[agent_id]", help: "limits, reservations and usage" },
	{ name: "inbox", args: "", help: "deliver pending team messages into this session" },
	{ name: "proposals", args: "", help: "expansion proposals to review / mine" },
	{ name: "events", args: "[run_id]", help: "recent audit events" },
	{ name: "inspect", args: "<agent_id>", help: "tasks, sessions, history, budget of an agent" },
	{ name: "list", args: "[all]", help: "list active teams, or include historical teams with all" },
	{ name: "admin", args: "[status|unlimited|bounded] [run_id]", help: "human operator resource policy" },
	{ name: "stop", args: "[agent_id|run_id]", help: "controlled cancellation (cascades to subtree)" },
	{ name: "watch", args: "[open|status|close|debug|focus <agent_id>] [run_id]", help: "manage live Pi team terminals in tmux" },
	{ name: "send", args: "<agent_id> <message>", help: "send directions to a team member" },
];

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
	const id = rt.identity;
	lines.push(id ? `identity: ${id.role ?? "agent"} ${id.agent_id} in run ${id.run_id}${id.managed ? " (managed worker)" : ""}` : `identity: not enrolled${rt.notice ? ` — ${rt.notice}` : ""}`);
	return lines.join("\n");
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
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
	return `${run.run_id} · ${run.active_members ?? Math.max(0, run.agents - 1)} active members · ${run.live_members ?? "?"} running · ${run.created_at}`;
}

export function registerTeamCommand(pi: ExtensionAPI, rt: TeamRuntime): void {
	const out = (ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info") => {
		rt.ctx = rt.ctx ?? ctx;
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else process.stderr.write(`${text}\n`);
	};

	const runId = (arg?: string): string => {
		const r = arg ?? rt.identity?.run_id;
		if (!r) throw new Error(`no run: pass a run_id or ${"enroll first (/team init | /team resume <run_id>)"}`);
		return r;
	};

	let initializedRunId: string | undefined;
	const handlers: Record<string, (a: string[], ctx: ExtensionCommandContext) => Promise<void>> = {
		help: async (_a, ctx) => out(ctx, helpText(pi, rt)),

		watch: async (a, ctx) => {
			await rt.ready;
			if (rt.managed) throw new Error("managed workers cannot manage tmux views; use the leader session");
			const action = a[0] ?? "open";
			if (!["open", "status", "close", "focus", "debug"].includes(action)) throw new Error("usage: /team watch [open|status|close|debug|focus <agent_id>] [run_id]");
			if (action === "focus" && !a[1]) throw new Error("usage: /team watch focus <agent_id> [run_id]");
			const explicitRun = a[action === "focus" ? 2 : 1];
			if (!explicitRun && !rt.identity && (action === "open" || action === "focus" || action === "debug")) {
				await handlers.resume([], ctx);
				if (!rt.identity) return;
			}
			const id = runId(explicitRun);
			const terminal = await rt.client.get<{ socket?: string; location?: TerminalLocation; debug?: boolean }>(`/runs/${encodeURIComponent(id)}/terminal`, { token: await rt.commandToken() });
			const opening = action === "open" || action === "focus" || action === "debug";
			let view = new TmuxWatch({ stateDir: rt.paths.dir, runId: id,
				socket: opening ? undefined : terminal.socket, location: opening ? undefined : terminal.location });
			if (action === "close") {
				if (terminal.debug) await rt.client.post(`/runs/${encodeURIComponent(id)}/terminal`, { socket: terminal.socket, location: terminal.location, debug: false }, { token: await rt.commandToken() });
				await view.close();
				out(ctx, `Team terminals left running for ${id}; your current tmux session is unchanged`);
				return;
			}
			if (action === "status") {
				out(ctx, await view.exists() ? `${view.opts.location?.window ?? view.name}: ${(await view.panes()).length} team panes` : `no tmux monitor for ${id}; use /team watch`);
				return;
			}
			// Validate access and run existence before creating terminal resources.
			await rt.client.tree(id, { token: await rt.commandToken() });
			view = await openTerminals(rt, id, { debug: action === "debug" });
			if (action === "focus") await view.focus(a[1]);
			else await view.focus();
			out(ctx, view.opts.location ? `Team panes opened beside Pi in the current tmux window; interactive members appear automatically` : `tmux team terminal ${view.name} opened; interactive Pi members appear automatically. Attach from a terminal: tmux attach-session -t ${view.name}`);
		},

		send: async (a, ctx) => {
			await rt.requireIdentity();
			if (!a[0] || !a[1]) throw new Error("usage: /team send <agent_id> <message>");
			const sent = await rt.agentCall(() => rt.client.sendMessage({ to: a[0], type: "question", payload: { text: a.slice(1).join(" ") } }));
			out(ctx, `message ${sent.message_id} sent to ${a[0]}`);
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
			out(ctx, runs.length ? runs.map((r) => `${runLabel(r)} · ${r.status}${r.run_id === rt.identity?.run_id ? " · current" : ""}`).join("\n") : "No active teams. /team init creates one; /team list all shows history.");
		},

		admin: async (a, ctx) => {
			if (rt.managed) throw new Error("only the human operator can change resource limits");
			const action = a[0] ?? "status";
			if (!["status", "unlimited", "bounded"].includes(action)) throw new Error("usage: /team admin [status|unlimited|bounded] [run_id]");
			const id = runId(a[1]);
			const token = await rt.commandToken();
			const policy = action === "status" ? await rt.client.get<{ mode: string }>(`/runs/${id}/admin`, { token })
				: await rt.client.post<{ mode: string }>(`/runs/${id}/admin`, { mode: action }, { token });
			out(ctx, `Human operator policy for ${id}: ${policy.mode.toUpperCase()}${action === "unlimited" ? " — spend, runtime, member-count and recursion-depth caps are removed; accounting remains enabled" : ""}`);
		},

		resume: async (a, ctx) => {
			await rt.ready;
			if (rt.managed) throw new Error("managed workers cannot resume a different team; use the leader Pi");
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
			const run = runs.find((r) => r.run_id === target);
			if (!run) throw new Error(`team ${target} not found; /team resume lists resumable teams`);
			if (!a[1] && !resumable(run)) throw new Error(`team ${target} cannot be resumed (${run.root_status ?? run.status}); /team resume lists active teams`);
			if (rt.identity?.run_id === target && (!a[1] || a[1] === rt.identity.agent_id)) {
				out(ctx, `Already attached to ${runLabel(run)}. Use /team watch to open its members.`);
				return;
			}
			let emptyNewRoot: string | undefined;
			if (rt.identity && rt.identity.run_id === initializedRunId) {
				const me = await rt.client.me();
				if (me.is_root && runs.find((r) => r.run_id === initializedRunId)?.agents === 1 && !me.children.length && !me.tasks.length && !me.inbox_pending && !me.pending_proposals_to_review) emptyNewRoot = me.agent_id;
			}
			// Attach first: a failed resume must leave the current team intact.
			await rt.attach(target, a[1]);
			if (emptyNewRoot) {
				try { await rt.client.lifecycle(emptyNewRoot, { action: "cancel", reason: "unused init replaced by resume", children_policy: "cascade" }, { token: op }); }
				catch (e) { out(ctx, `Attached, but could not retire the unused empty team: ${errText(e)}`, "warning"); }
			}
			initializedRunId = undefined;
			out(ctx, `Resumed ${runLabel(run)}. Use /team tree to inspect members, then /team watch to open their Pi panes.`);
		},

		tree: async (a, ctx) => {
			const t = await rt.client.tree(runId(a.find((arg) => arg !== "--all")), { token: await rt.commandToken() }, !a.includes("--all"));
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
			out(ctx, lines.join("\n"));
		},

		budget: async (a, ctx) => {
			const target = a[0] ?? rt.identity?.agent_id;
			if (!target) throw new Error("usage: /team budget <agent_id> (or enroll first)");
			const tok = rt.identity && !a[0] ? rt.identity.token : await rt.commandToken();
			out(ctx, formatBudget(await rt.client.budget(target, { token: tok })));
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
			const r = await rt.client.events({ run_id: runId(a[0]), limit: 500 }, { token: await rt.commandToken() });
			out(ctx, formatEvents(r.events));
		},

		inspect: async (a, ctx) => {
			if (!a[0]) throw new Error("usage: /team inspect <agent_id>");
			out(ctx, formatInspect(await rt.client.inspect(a[0], { token: await rt.commandToken() })));
		},

		stop: async (a, ctx) => {
			const target = a[0] ?? rt.identity?.run_id;
			if (!target) { await handlers.list([], ctx); out(ctx, "Use /team stop <run_id> to choose a team."); return; }
			const tok = await rt.commandToken();
			let agentId = target;
			let stoppedRun: RunSummary | undefined;
			let what = `agent ${target}`;
			// Protocol has no run-level stop: a run is stopped by cancelling its root with cascade.
			if (!rt.managed) {
				try {
					const runs = await rt.client.listRuns({ token: tok });
					const run = runs.runs.find((r) => r.run_id === target || r.root_agent_id === target);
					stoppedRun = run;
					if (run) {
						agentId = run.root_agent_id;
						what = `run ${run.run_id} (root ${run.root_agent_id} + whole subtree)`;
					}
				} catch {
					/* fall back to treating the id as an agent */
				}
			}
			if (ctx.hasUI && !(await ctx.ui.confirm("Stop team members?", `Cancel ${what}? Workers are stopped by the controller.`))) {
				out(ctx, "stop cancelled");
				return;
			}
			const r = await rt.client.lifecycle(agentId, { action: "cancel", reason: "operator /team stop", children_policy: "cascade" }, { token: tok });
			if (stoppedRun && r.status === "CANCELLED") {
				try {
					const cfg = await rt.client.get<{ enabled?: boolean; socket?: string; location?: TerminalLocation }>(`/runs/${stoppedRun.run_id}/terminal`, { token: tok });
					if (cfg.enabled) await new TmuxWatch({ stateDir: rt.paths.dir, runId: stoppedRun.run_id, ...cfg }).releaseLayout();
				} catch (e) { out(ctx, `Team stopped; pane cleanup could not finish: ${errText(e)}`, "warning"); }
			}
			if (rt.identity && (r.affected_agent_ids.includes(rt.identity.agent_id) || (rt.identity.agent_id === r.agent_id && r.status === "CANCELLED"))) rt.releaseStoppedIdentity("CANCELLED");
			out(ctx, `${r.affected_agent_ids.length ? "stopped" : "already stopped"} ${what}: ${r.status}; affected ${r.affected_agent_ids.length} agent(s)`);
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

	pi.registerCommand("team", {
		description: "Recursive agent team: init, resume, tree, status, budget, inbox, proposals, events, inspect, stop, watch, send (see /team help)",
		getArgumentCompletions: async (prefix: string) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const items = SUBCOMMANDS.filter((s) => s.name.startsWith(parts[0] ?? "")).map((s) => ({ value: s.name, label: s.name, description: `${s.args} ${s.help}`.trim() }));
				return items.length ? items : null;
			}
			const [sub, partial = ""] = parts;
			if (sub === "resume" || sub === "tree" || sub === "events" || (sub === "stop" && parts.length === 2)) {
				if (parts.length > 2) return null;
				const runs = await runCompletions();
				const items = runs.filter((r) => r.run_id.startsWith(partial) &&
					((sub !== "stop" && sub !== "resume") || resumable(r))).map((r) => ({ value: `${sub} ${r.run_id}`, label: r.run_id, description: `${r.status} · ${runLabel(r)}` }));
				return items.length ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			rt.ctx = rt.ctx ?? ctx;
			const [sub = "help", ...rest] = splitArgs(args);
			const h = handlers[sub];
			if (!h) {
				out(ctx, `unknown subcommand '${sub}'.\n${helpText(pi, rt)}`, "warning");
				return;
			}
			try {
				await h(rest, ctx);
			} catch (e) {
				out(ctx, `/team ${sub}: ${errText(e)}`, "error");
			}
		},
	});
}
