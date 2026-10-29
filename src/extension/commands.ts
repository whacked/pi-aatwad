// `/team` command with subcommands. Human-facing; uses the operator token unless this is a managed worker.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunConfig } from "../shared/protocol.ts";
import { ping, rawRequest, readOperatorToken, ensureController, isUnavailable, TeamApiError, ControllerIncompatibleError } from "../shared/client.ts";
import type { RunSummary } from "../shared/protocol.ts";
import { formatBudget, formatEvents, formatInspect, formatProposal, formatTree } from "./format.ts";
import type { TeamRuntime } from "./runtime.ts";
import { TOOL_NAMES } from "./names.ts";

export const SUBCOMMANDS: { name: string; args: string; help: string }[] = [
	{ name: "help", args: "", help: "show this help" },
	{ name: "init", args: "[config-json-path]", help: "create a new organization with this session as root" },
	{ name: "resume", args: "<run_id> [agent_id]", help: "attach this session to an existing run (default: its root)" },
	{ name: "tree", args: "[run_id]", help: "live logical hierarchy" },
	{ name: "status", args: "", help: "controller, run, agent and pending work" },
	{ name: "budget", args: "[agent_id]", help: "limits, reservations and usage" },
	{ name: "inbox", args: "", help: "deliver pending team messages into this session" },
	{ name: "proposals", args: "", help: "expansion proposals to review / mine" },
	{ name: "events", args: "[run_id]", help: "recent audit events" },
	{ name: "inspect", args: "<agent_id>", help: "tasks, sessions, history, budget of an agent" },
	{ name: "stop", args: "<agent_id|run_id>", help: "controlled cancellation (cascades to subtree)" },
	{ name: "watch", args: "", help: "tmux observer (not implemented in v0.1)" },
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

	const handlers: Record<string, (a: string[], ctx: ExtensionCommandContext) => Promise<void>> = {
		help: async (_a, ctx) => out(ctx, helpText(pi, rt)),

		watch: async (_a, ctx) => out(ctx, "tmux observer not implemented in v0.1"),

		init: async (a, ctx) => {
			await rt.ready;
			if (rt.managed) throw new Error("managed workers cannot run /team init; they are enrolled by the controller");
			if (rt.identity) throw new Error(`already enrolled as ${rt.identity.agent_id} in run ${rt.identity.run_id}`);
			let config: Partial<RunConfig> | undefined;
			if (a[0]) {
				const p = resolve(ctx.cwd, a[0]);
				config = JSON.parse(readFileSync(p, "utf8")) as Partial<RunConfig>;
			}
			const { spawned } = await ensureController(rt.paths, rt.opts.ensure);
			const op = await readOperatorToken(rt.paths);
			const pis = rt.piSession();
			const r = await rt.client.createRun(
				{
					config,
					root: { role: "root", pi_session_id: pis.id, pi_session_path: pis.path, cwd: ctx.cwd, provider: ctx.model?.provider, model: ctx.model?.id },
				},
				{ token: op, idempotencyKey: `init:${pis.id}:${randomUUID()}` },
			);
			rt.adoptNew({ run_id: r.run_id, agent_id: r.root_agent_id, session_id: r.session_id, token: r.token, managed: false, role: "root", pi_session_id: pis.id });
			await rt.refreshRole();
			const e = r.envelope;
			out(
				ctx,
				`team run ${r.run_id} created${spawned ? " (controller started)" : ""}; you are root agent ${r.root_agent_id}.\n` +
					`budget: ≤$${e.max_subtree_usd} subtree spend, ≤${e.max_subtree_slots} live descendants, single grant ≤${e.max_grant_slots} slots/$${e.max_grant_usd}`,
			);
		},

		resume: async (a, ctx) => {
			await rt.ready;
			if (!a[0]) throw new Error("usage: /team resume <run_id> [agent_id]");
			if (rt.identity && rt.identity.run_id === a[0] && (!a[1] || a[1] === rt.identity.agent_id)) {
				out(ctx, `already attached as ${rt.identity.agent_id} in run ${rt.identity.run_id}`);
				return;
			}
			if (rt.identity) throw new Error(`this session already represents ${rt.identity.agent_id} in run ${rt.identity.run_id}`);
			await rt.attach(a[0], a[1]);
		},

		tree: async (a, ctx) => {
			const t = await rt.client.tree(runId(a[0]), { token: await rt.commandToken() });
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
			if (!a[0]) throw new Error("usage: /team stop <agent_id|run_id>");
			const tok = await rt.commandToken();
			let agentId = a[0];
			let what = `agent ${a[0]}`;
			// Protocol has no run-level stop: a run is stopped by cancelling its root with cascade.
			if (!rt.managed) {
				try {
					const runs = await rt.client.listRuns({ token: tok });
					const run = runs.runs.find((r) => r.run_id === a[0]);
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
			out(ctx, `stopped ${what}: ${r.status}; affected ${r.affected_agent_ids.length} agent(s)`);
		},
	};

	const runCompletions = async (): Promise<RunSummary[]> => {
		try {
			const op = await readOperatorToken(rt.paths, 0);
			const r = await rawRequest<{ runs: RunSummary[] }>(rt.paths.socket, "GET", "/runs", { token: op, timeoutMs: 500 });
			return r.runs;
		} catch {
			return [];
		}
	};

	pi.registerCommand("team", {
		description: "Recursive agent team: init, resume, tree, status, budget, inbox, proposals, events, inspect, stop, watch (see /team help)",
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
				const items = runs.filter((r) => r.run_id.startsWith(partial)).map((r) => ({ value: `${sub} ${r.run_id}`, label: r.run_id, description: `${r.status} · ${r.agents} agents · ${r.created_at}` }));
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
