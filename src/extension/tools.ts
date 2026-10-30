import { TmuxWatch } from "../watch/tmux.ts";
import { availableModels, resolveAvailableModel } from "./models.ts";
// Organization tools. Identical set for every agent; the controller authorizes each action.
// No tool accepts the caller's own identity: actor = the session credential held by the extension.
import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MESSAGE_TYPES } from "../shared/protocol.ts";
import type { CreateExpansionRequest, DecisionRequest, ExpansionRole, MessageType } from "../shared/protocol.ts";
import type { TeamRuntime } from "./runtime.ts";
import { TOOL_NAMES } from "./names.ts";
import type { ToolName } from "./names.ts";
import { formatBudget, formatEnvelope, formatProposal, formatTree } from "./format.ts";

export { TOOL_NAMES };

/** Provider-friendly string enum ({type:"string", enum}) instead of anyOf-of-literals. */
function StringEnum<T extends readonly string[]>(values: T, opts: { description?: string } = {}) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...opts });
}

const FreeObject = (description: string) => Type.Record(Type.String(), Type.Unknown(), { description });

const RoleSchema = Type.Object({
	title: Type.String({ description: "Role title, e.g. 'test writer'" }),
	responsibility: Type.String({ description: "What this role is responsible for" }),
	count: Type.Integer({ minimum: 1, description: "How many agents of this role" }),
	capabilities: Type.Array(Type.String(), { description: "Capability tags required (see team_get_models)" }),
	preferred_model_id: Type.Optional(Type.String({ description: "Catalog model id from team_get_models" })),
	max_cost_usd: Type.Number({ minimum: 0, description: "Per-agent spend ceiling in USD" }),
	max_runtime_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
});

const PROPOSAL_WARNING =
	"IMPORTANT: an expansion proposal is only a REQUEST. It does not guarantee approval, may be rejected, amended or escalated by your manager, " +
	"and no agent exists until it is approved and the controller provisions it. Keep working on your task meanwhile and do not assume new agents will appear.";

function text(s: string, details?: unknown) {
	return { content: [{ type: "text" as const, text: s }], details };
}
function json(label: string, v: unknown) {
	return text(`${label}\n${JSON.stringify(v, null, 2)}`, v);
}

export function registerTools(pi: ExtensionAPI, rt: TeamRuntime): void {
	/** Stable per tool call, so Pi-level retries of the same call are deduplicated by the controller. */
	const key = (tool: string, toolCallId: string) => `tool:${rt.identity?.agent_id ?? "?"}:${tool}:${toolCallId}`;

	const reg = <P extends TSchema>(
		name: ToolName,
		label: string,
		description: string,
		parameters: P,
		run: (params: any, toolCallId: string, ctx: ExtensionContext) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>,
		snippet?: string,
	) => {
		pi.registerTool({
			name,
			label,
			description,
			promptSnippet: snippet,
			parameters,
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				rt.ctx = ctx;
				return rt.agentCall(() => run(params, toolCallId, ctx));
			},
		});
	};

	reg(
		"team_send_message",
		"Team: send message",
		"Send a typed, durable message to another agent in your team organization : your manager, a teammate (same manager), or anyone in your own subtree. " +
			"The sender is always you (taken from your session credential). Use type 'question'/'answer' for conversation, 'task.progress' for updates. " +
			"For new agents use team_request_expansion instead.",
		Type.Object({
			to: Type.String({ description: "Recipient agent_id (or 'controller')" }),
			type: StringEnum(MESSAGE_TYPES, { description: "Message type" }),
			text: Type.Optional(Type.String({ description: "Plain-text body (stored as payload.text)" })),
			payload: Type.Optional(FreeObject("Structured payload; merged with text")),
			correlation_id: Type.Optional(Type.String()),
			causation_id: Type.Optional(Type.String()),
			deadline: Type.Optional(Type.String({ description: "ISO timestamp" })),
		}),
		async (p, id) => {
			const payload: Record<string, unknown> = { ...(p.payload ?? {}) };
			if (p.text !== undefined) payload.text = p.text;
			const r = await rt.client.sendMessage(
				{ to: p.to, type: p.type as MessageType, payload, correlation_id: p.correlation_id, causation_id: p.causation_id, deadline: p.deadline },
				{ idempotencyKey: key("team_send_message", id) },
			);
			return text(`sent ${p.type} to ${p.to} (message ${r.message_id})`, r);
		},
		"Send a durable message to another team agent",
	);

	reg(
		"team_delegate_task",
		"Team: delegate task",
		"Assign a task to one of your direct reports (or a subtask to yourself under your own task). The controller rejects owners outside your authority.",
		Type.Object({
			owner_id: Type.String({ description: "agent_id of the direct report who will own the task" }),
			title: Type.String(),
			spec: Type.Optional(FreeObject("Task specification: goals, acceptance criteria, file paths")),
			parent_task_id: Type.Optional(Type.String({ description: "Your task this one is a subtask of" })),
		}),
		async (p, id) => {
			const r = await rt.client.delegateTask(
				{ owner_id: p.owner_id, title: p.title, spec: p.spec, parent_task_id: p.parent_task_id },
				{ idempotencyKey: key("team_delegate_task", id) },
			);
			return text(`task ${r.task_id} assigned to ${p.owner_id} (message ${r.message_id})`, r);
		},
		"Delegate a task to a direct report",
	);

	reg(
		"team_request_expansion",
		"Team: request expansion",
		"Propose recruiting new subordinate agents for one of your tasks. The proposal goes to your manager (or escalates further) for review against budgets and limits. " +
			PROPOSAL_WARNING,
		Type.Object({
			task_id: Type.String({ description: "Your task that needs more agents" }),
			reason: Type.String({ description: "Why the expansion is needed" }),
			alternatives: Type.String({ description: "Alternatives considered (e.g. doing it yourself) and why they are worse" }),
			estimated_cost_usd: Type.Number({ minimum: 0 }),
			max_runtime_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
			roles: Type.Array(RoleSchema, { minItems: 1 }),
		}),
		async (p, id) => {
			const req: CreateExpansionRequest = {
				version: 1,
				task_id: p.task_id,
				reason: p.reason,
				alternatives: p.alternatives,
				estimated_cost_usd: p.estimated_cost_usd,
				max_runtime_seconds: p.max_runtime_seconds,
				roles: p.roles as ExpansionRole[],
			};
			const r = await rt.client.requestExpansion(req, { idempotencyKey: key("team_request_expansion", id) });
			return text(
				`proposal ${r.proposal_id} is ${r.status}, awaiting review by ${r.reviewer_id}. This is NOT an approval; you will receive a team.expand.decision message.`,
				r,
			);
		},
		"Propose recruiting subordinate agents (not guaranteed to be approved)",
	);

	reg(
		"team_review_expansion",
		"Team: review expansion",
		"Review expansion proposals routed to you. Call without 'decision' to list proposals awaiting your review. " +
			"With proposal_id + decision: APPROVE (provisions agents within your delegated budget), REJECT, AMEND (send back revised roles), or ESCALATE (to your manager). " +
			"Only the current reviewer may decide; the controller re-validates budgets and topology. Approval of a proposal you cannot afford is rejected.",
		Type.Object({
			proposal_id: Type.Optional(Type.String()),
			decision: Type.Optional(StringEnum(["APPROVE", "REJECT", "AMEND", "ESCALATE"] as const)),
			reason: Type.Optional(Type.String({ description: "Required when deciding" })),
			amended_roles: Type.Optional(Type.Array(RoleSchema, { description: "AMEND only: replacement roles" })),
			expected_topology_version: Type.Optional(Type.Integer()),
		}),
		async (p, id) => {
			if (!p.decision) {
				const r = await rt.client.proposals("review");
				if (!r.proposals.length) return text("no proposals awaiting your review", r);
				return text(r.proposals.map(formatProposal).join("\n"), r);
			}
			if (!p.proposal_id) throw new Error("proposal_id is required when deciding");
			if (!p.reason) throw new Error("reason is required when deciding");
			const req: DecisionRequest = {
				decision: p.decision,
				reason: p.reason,
				amended_roles: p.amended_roles as ExpansionRole[] | undefined,
				expected_topology_version: p.expected_topology_version,
			};
			const r = await rt.client.decideExpansion(p.proposal_id, req, { idempotencyKey: key("team_review_expansion", id) });
			return json(`proposal ${r.proposal_id} → ${r.status}`, r);
		},
		"List or decide expansion proposals routed to you",
	);

	reg(
		"team_get_tree",
		"Team: org tree",
		"Show the current organization tree of your run (roles, status, models). Fetched fresh from the controller.",
		Type.Object({}),
		async () => {
			const id = rt.identity!;
			const t = await rt.client.tree(id.run_id);
			return text(formatTree(t, id.agent_id), t);
		},
	);

	reg(
		"team_get_inbox",
		"Team: inbox",
		"Fetch pending durable messages addressed to you (also delivered automatically when idle). Messages returned here are acknowledged.",
		Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
		async (p) => {
			const r = await rt.client.inbox(p.limit ?? 20);
			const seen = rt.seen();
			for (const m of r.messages) {
				seen.add(m.message_id);
				try {
					await rt.client.ack(m.message_id);
				} catch {
					/* redelivered later, deduped */
				}
			}
			if (!r.messages.length) return text("inbox empty", r);
			return text(r.messages.map((m) => formatEnvelope(m)).join("\n\n---\n\n"), r);
		},
	);

	reg(
		"team_report_progress",
		"Team: report progress",
		"Record a progress note on one of your tasks; your manager is notified.",
		Type.Object({ task_id: Type.String(), note: Type.String() }),
		async (p, id) => {
			const r = await rt.client.reportProgress(p.task_id, p.note, { idempotencyKey: key("team_report_progress", id) });
			return text(`progress recorded on ${p.task_id}`, r);
		},
	);

	reg(
		"team_complete_task",
		"Team: complete task",
		"Finish one of your tasks with a summary (status DONE by default, or FAILED/BLOCKED) and optional artifact references. Your manager receives task.completed.",
		Type.Object({
			task_id: Type.String(),
			summary: Type.String(),
			status: Type.Optional(StringEnum(["DONE", "FAILED", "BLOCKED"] as const)),
			artifacts: Type.Optional(
				Type.Array(Type.Object({ kind: Type.String(), uri: Type.String(), sha256: Type.Optional(Type.String()) }), {
					description: "References (paths, commits, URLs) — not file contents",
				}),
			),
		}),
		async (p, id) => {
			const r = await rt.client.completeTask(p.task_id, { summary: p.summary, status: p.status, artifacts: p.artifacts }, { idempotencyKey: key("team_complete_task", id) });
			return text(`task ${p.task_id} marked ${p.status ?? "DONE"}`, r);
		},
	);

	reg(
		"team_get_models",
		"Team: models",
		"List the run catalog (default), or authenticated models discovered from Pi with source=available. Discovery does not change the run or spend credits. Use exact qualified IDs when registering models. Credentials are never returned. Availability is configured authentication, not a successful live API check.",
		Type.Object({ source: Type.Optional(StringEnum(["catalog", "available"] as const)) }),
		async (p, _id, ctx) => {
			if (p.source === "available") {
				return json("Available Pi models", { models: availableModels(ctx) });
			}
			const r = await rt.client.models();
			const lines = r.models.map(
				(m) =>
					`${m.id} (${m.provider}/${m.model}) tags=[${m.capability_tags.join(",")}] in=$${m.cost_per_m_input_usd ?? "?"}/M out=$${m.cost_per_m_output_usd ?? "?"}/M ${m.eligible ? "eligible" : `INELIGIBLE: ${m.ineligible_reason ?? ""}`}`,
			);
			return text(lines.join("\n") || "no models configured", r);
		},
	);

	reg(
		"team_register_model", "Team: register model",
		"Root only: resolve an authenticated Pi model by exact provider/model ID, model ID or unique display name and add it to this run. Also permits its provider globally; delegated provider restrictions still apply. Existing members keep their models. Ask the user when a name is ambiguous; never silently substitute. No config file or reload needed.",
		Type.Object({ model: Type.String({ description: "Exact qualified Pi model ID or unique model name" }) }),
		async (p, id, ctx) => {
			const model = resolveAvailableModel(ctx, p.model);
			return json("Registered model", await rt.client.post("/models", model, { idempotencyKey: key("team_register_model", id) }));
		},
	);

	reg(
		"team_create_member", "Team: create member",
		"Root only: create one named member and assign its responsibility in one operation, with normal budget and governance checks. Omit model to use the initial leader model. Supply model to resolve and register an authenticated Pi model on the fly, or preferred_model_id for an existing catalog entry. Returns provisioned agent IDs; workers start asynchronously. Defaults: $2 and 600 seconds. Subordinate managers use team_request_expansion instead.",
		Type.Object({
			name: Type.String(), responsibility: Type.String({ description: "Concrete task, context and acceptance criteria for this member" }),
			model: Type.Optional(Type.String()), preferred_model_id: Type.Optional(Type.String()),
			max_cost_usd: Type.Optional(Type.Number({ minimum: 0 })), max_runtime_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
		async (p, id, ctx) => {
			if (p.model && p.preferred_model_id) throw new Error("Specify model or preferred_model_id, not both");
			const body = { ...p, model: p.model ? resolveAvailableModel(ctx, p.model) : undefined };
			return json("Member provisioned", await rt.client.post("/members", body, { idempotencyKey: key("team_create_member", id) }));
		},
	);

	reg(
		"team_watch", "Team: tmux monitor",
		"Root only: open, inspect, focus or close the team's tmux monitoring session when the user requests it. Member panes appear automatically as members are recruited. Closing the view leaves workers running. Panes show status, tasks and output; send directions using team_send_message. Outside tmux, return the attach command to the user. Requires tmux and Node on PATH.",
		Type.Object({ action: StringEnum(["open", "status", "focus", "close"] as const), agent_id: Type.Optional(Type.String({ description: "Required for focus" })) }),
		async (p) => {
			if (rt.managed || !(await rt.client.me()).is_root) throw new Error("Only the leader may manage the tmux monitor");
			const view = new TmuxWatch({ stateDir: rt.paths.dir, runId: rt.identity!.run_id });
			if (p.action === "close") {
				await view.close();
				return text("Tmux monitor closed; workers continue running", { open: false });
			}
			if (p.action === "focus" && !p.agent_id) throw new Error("agent_id is required for focus");
			if (p.action === "open" || p.action === "focus") {
				await view.open();
				await view.focus(p.action === "focus" ? p.agent_id : undefined);
			}
			const open = await view.exists();
			return json("Tmux monitor", { open, session: view.name, panes: open ? await view.panes() : [], attach_command: `tmux attach-session -t ${view.name}` });
		},
	);

	reg(
		"team_get_budget",
		"Team: budget",
		"Show budget allocation, reservations and usage for yourself (default) or an agent in your subtree.",
		Type.Object({ agent_id: Type.Optional(Type.String({ description: "Agent in your subtree; omit for yourself" })) }),
		async (p) => {
			const target = p.agent_id ?? rt.identity!.agent_id;
			const b = await rt.client.budget(target);
			return text(formatBudget(b), b);
		},
	);
}
