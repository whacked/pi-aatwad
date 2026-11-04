// Pure text renderers for /team output and the bounded org-context prompt section.
import type { BudgetView, Envelope, EventView, InspectResponse, OrgContext, ProposalView, TreeNode, TreeResponse } from "../shared/protocol.ts";

export const MAX_CONTEXT_CHARS = 2_000;
const MAX_LIST = 8;

function usd(n: number | null | undefined): string {
	return typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}` : "?";
}

function clip(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

export function formatBudget(b: BudgetView): string {
	if (b.unlimited) return `budget for ${b.agent_id}:\n  policy: UNLIMITED (human operator); no spend, runtime, member-count or depth caps\n  consumed ${usd(b.consumed_usd)}, reserved ${usd(b.reserved_usd)}; ${b.subtree_live_agents} active descendants`;
	return [
		`budget for ${b.agent_id}:`,
		...(b.own_budget_usd != null ? [`  own spend ceiling: ${usd(b.own_budget_usd)} (includes consumed spend)`] : []),
		`  usd: consumed ${usd(b.consumed_usd)}, reserved ${usd(b.reserved_usd)}, available ${usd(b.available_usd)} (subtree ceiling ${usd(b.limits?.max_subtree_usd)})`,
		`  slots: live descendants ${b.subtree_live_agents}, reserved ${b.reserved_slots}, available ${b.available_slots} (ceiling ${b.limits?.max_subtree_slots ?? "?"})`,
		`  single-decision grant: ≤${b.limits?.max_grant_slots ?? "?"} slots, ≤${usd(b.limits?.max_grant_usd)}`,
	].join("\n");
}

function nodeLine(n: TreeNode, me?: string): string {
	const mark = n.agent_id === me ? " ← you" : "";
	return `${n.role} [${n.agent_id}] ${n.status}/${n.observed_state}${n.desired_state !== "RUNNING" ? ` (desired ${n.desired_state})` : ""}${n.model ? ` · ${n.model}` : ""}${n.pending_model ? ` → ${n.pending_model} (pending)` : ""}${mark}`;
}

export function formatTree(t: TreeResponse, me?: string, maxLines = 200): string {
	const lines: string[] = [`run ${t.run_id} · topology v${t.topology_version}`];
	const walk = (n: TreeNode, prefix: string, last: boolean, root: boolean) => {
		if (lines.length >= maxLines) return;
		lines.push(root ? nodeLine(n, me) : `${prefix}${last ? "└─ " : "├─ "}${nodeLine(n, me)}`);
		const kids = n.children ?? [];
		kids.forEach((c, i) => walk(c, root ? "" : prefix + (last ? "   " : "│  "), i === kids.length - 1, false));
	};
	walk(t.root, "", true, true);
	if (lines.length >= maxLines) lines.push("… (truncated)");
	return lines.join("\n");
}

export function formatInspect(r: InspectResponse): string {
	const a = r.agent;
	const lines = [
		nodeLine(a),
		`  parent: ${a.parent_id ?? "(root)"} · created ${a.created_at} · last heartbeat ${a.last_heartbeat_at ?? "never"}`,
		`  sessions (${r.sessions.length}):`,
		...r.sessions.slice(-5).map((s) => `    ${s.session_id} ${s.status} ${s.provider}/${s.model} pid=${s.pid ?? "-"} ${s.started_at ?? ""}${s.pi_session_path ? ` ${s.pi_session_path}` : ""}`),
		`  tasks (${r.tasks.length}):`,
		...r.tasks.slice(0, 10).map((t) => `    ${t.task_id} ${t.status} ${clip(t.title, 80)}`),
		`  reporting history:`,
		...r.reporting_history.slice(-5).map((h) => `    → ${h.parent_id} from ${h.valid_from}${h.valid_to ? ` to ${h.valid_to}` : " (current)"}`),
		formatBudget(r.budget).replace(/^/gm, "  "),
	];
	return lines.join("\n");
}

export function formatProposal(p: ProposalView): string {
	const roles = (p.request?.roles ?? []).map((r) => `${r.count}× ${r.title} (≤${usd(r.max_cost_usd)})`).join(", ");
	return `${p.proposal_id} ${p.status} r${p.revision} from ${p.requester_id} → reviewer ${p.reviewer_id ?? "-"}: ${clip(p.request?.reason ?? "", 120)} [${roles}] est ${usd(p.request?.estimated_cost_usd)}`;
}

export function formatEvents(events: EventView[], tail = 20): string {
	const ev = events.slice(-tail);
	if (!ev.length) return "no events";
	return ev.map((e) => `#${e.seq} ${e.created_at} ${e.type}${e.entity_id ? ` ${e.entity_id}` : ""}${e.actor_id ? ` by ${e.actor_id}` : ""}`).join("\n");
}

export function formatEnvelope(m: Envelope, maxPayload = 1_500): string {
	let payload: string;
	const text = (m.payload as { text?: unknown })?.text;
	if (typeof text === "string" && Object.keys(m.payload).length === 1) payload = text;
	else payload = JSON.stringify(m.payload);
	return `[${m.type}] from ${m.from} (message ${m.message_id}${m.correlation_id ? `, correlation ${m.correlation_id}` : ""})\n${clip(payload, maxPayload)}`;
}

/** Bounded org-context section injected before each agent run. Fresh facts only. */
export function formatOrgContext(c: OrgContext, maxChars = MAX_CONTEXT_CHARS): string {
	const lines: string[] = [];
	lines.push(`You are agent ${c.agent_id} (role: ${c.role}) in team run ${c.run_id}${c.is_root ? " — you are the ROOT of this organization" : ""}.`);
	lines.push(c.parent ? `Manager: ${c.parent.role} [${c.parent.agent_id}]` : "Manager: none (root; you report to the human operator)");
	if (c.reporting) {
		const r = c.reporting;
		lines.push(`Cross-team reporting relationships. Automatic inbox turns: ${r.wake_on_message ? "on" : "off"}.`);
		for (const link of r.links.slice(0, MAX_LIST)) lines.push(link.child_run_id === c.run_id
			? `Report to team leader ${link.parent_agent_id} (run ${link.parent_run_id}); send initial status and meaningful progress with team_send_message.`
			: `Reporting team ${link.child_run_id}: leader ${link.child_agent_id}; request reports with team_send_message.`);
		if (r.links.length) lines.push("Reporting links permit coordination messages (question, answer, task.progress). Each team retains its own delegation, approvals, budgets and control. Use exact linked leader IDs. Maintain consolidated status for teams reporting to you, follow up on blockers and decisions, and avoid acknowledgement loops. team_reporting manages relationships and history.");
	}
	if (c.children.length) {
		const shown = c.children.slice(0, MAX_LIST).map((k) => `${k.role} [${k.agent_id}] ${k.status}/${k.observed_state}`);
		lines.push(`Direct reports (${c.children.length}): ${shown.join("; ")}${c.children.length > MAX_LIST ? "; …" : ""}`);
	} else lines.push("Direct reports: none");
	const peers = c.peers ?? [];
	if (peers.length) {
		const shown = peers.slice(0, MAX_LIST).map((k) => `${k.role} [${k.agent_id}]`);
		lines.push(`Teammates (same manager; message them directly with team_send_message): ${shown.join("; ")}${peers.length > MAX_LIST ? "; …" : ""}`);
	}
	if (c.tasks.length) {
		const shown = c.tasks.slice(0, MAX_LIST).map((t) => `${t.task_id} ${t.status}: ${clip(t.title, 80)}`);
		lines.push(`Your tasks: ${shown.join("; ")}${c.tasks.length > MAX_LIST ? "; …" : ""}`);
	} else lines.push("Your tasks: none assigned");
	const b = c.budget;
	if (b?.unlimited) lines.push("Budget: UNLIMITED, authorized by the human operator. No spend, runtime, slot or depth caps apply; do not invent finite allocations. Accounting and identity permissions remain active.");
	else if (b) lines.push(`Budget: ${usd(b.available_usd)} available of ${usd(b.limits?.max_subtree_usd)} subtree ceiling; ${b.available_slots} spawn slot(s) available.`);
	if (c.pending_proposals_to_review > 0) lines.push(`Pending expansion proposals awaiting YOUR review: ${c.pending_proposals_to_review} (use team_review_expansion).`);
	if (c.inbox_pending > 0) lines.push(`Unread team messages: ${c.inbox_pending} (they will be delivered; or call team_get_inbox).`);
	if (c.desired_state !== "RUNNING") lines.push(`Controller desired state for you: ${c.desired_state} — stop starting new work.`);
	lines.push(
		"Use the team_* tools to coordinate. Your identity comes from your session credential; the controller authorizes every action. Expansion proposals are requests, not guarantees.",
	);
	return clip(lines.join("\n"), maxChars);
}
