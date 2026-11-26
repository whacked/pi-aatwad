// Pure text renderers for /team output and the bounded org-context prompt section.
import type { BriefResponse, BudgetView, MemberThread, SummaryView, Envelope, EventView, InspectResponse, OrgContext, ProposalView, RunSummary, TreeNode, TreeResponse } from "../shared/protocol.ts";

export const MAX_CONTEXT_CHARS = 2_000;
const MAX_LIST = 8;

function usd(n: number | null | undefined): string {
	return n === null ? "unbounded" : typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}` : "?";
}

function clip(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

export function formatBudget(b: BudgetView): string {
	return [
		...(b.unlimited ? ["  policy: UNLIMITED run policy; explicit worker budgets/lifetimes still apply"] : []),
		`budget for ${b.agent_id}:`,
		...(b.own_budget_usd != null ? [`  spend ceiling: ${usd(b.own_budget_usd)} (pool ${b.budget_pool_id ?? b.agent_id}; consumed ${usd(b.pool_consumed_usd ?? b.consumed_usd)}; shared with inheriting members)`] : []),
		`  usd: consumed ${usd(b.consumed_usd)}, reserved ${usd(b.reserved_usd)}, available ${usd(b.available_usd)} (subtree ceiling ${usd(b.limits?.max_subtree_usd)})`,
		`  slots: live descendants ${b.subtree_live_agents}, reserved ${b.reserved_slots}, available ${b.available_slots ?? "unbounded"} (ceiling ${b.limits?.max_subtree_slots ?? "unbounded"})`,
		`  single-decision grant: ≤${b.limits?.max_grant_slots ?? "unbounded"} slots, ≤${usd(b.limits?.max_grant_usd)}`,
		...(b.own_budget_usd != null || b.limits?.max_subtree_usd != null || b.limits?.max_subtree_slots != null
			? ["  limits are optional: the human operator can list them with /team admin limits and remove them with /team admin clear-limits"] : []),
	].join("\n");
}

/** A linked team as a lead sees it: name, run and project directory. */
function linkedLabel(n: { run_id?: string; team_name?: string; project?: string }): string {
	return [n.team_name && n.team_name !== n.run_id ? `"${n.team_name}"` : "", n.run_id, n.project ? `in ${shortPath(n.project)}` : ""].filter(Boolean).join(" ");
}

function nodeLine(n: TreeNode, me?: string): string {
	const mark = n.agent_id === me ? " ← you" : "";
	// Agents of other teams linked under their lead are shown with their team.
	const team = n.run_id ? ` ⇢ team ${linkedLabel(n)}` : "";
	return `${n.role} [${n.agent_id}]${team} ${n.status}/${n.observed_state}${n.desired_state !== "RUNNING" ? ` (desired ${n.desired_state})` : ""}${n.model ? ` · ${n.model}` : ""}${n.pending_model ? ` → ${n.pending_model} (pending)` : ""}${mark}`;
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

/**
 * Safety ceiling only. Messages are acknowledged once delivered and cannot be fetched again, so a body
 * must reach the agent whole: instructions and task specs routinely run to several thousand characters.
 */
export const MAX_MESSAGE_CHARS = 100_000;

export function formatEnvelope(m: Envelope, maxPayload = MAX_MESSAGE_CHARS): string {
	let payload: string;
	const text = (m.payload as { text?: unknown })?.text;
	if (typeof text === "string" && Object.keys(m.payload).length === 1) payload = text;
	else payload = JSON.stringify(m.payload);
	const body = payload.length <= maxPayload ? payload
		: `${payload.slice(0, maxPayload)}\n[message cut at ${maxPayload} of ${payload.length} characters; ask ${m.from} to send the rest in a file]`;
	return `[${m.type}] from ${senderOf(m)} (message ${m.message_id}${m.correlation_id ? `, correlation ${m.correlation_id}` : ""})\n${body}`;
}

/** "Parser [agent-id]" or "Parser [agent-id] of team EasyCard"; just the ID when the controller sent no label. */
export function senderOf(m: Pick<Envelope, "from" | "from_role" | "from_team">): string {
	if (!m.from_role) return m.from;
	return `${m.from_role} [${m.from}]${m.from_team ? ` of team "${m.from_team}"` : ""}`;
}

/** Bounded org-context section injected before each agent run. Fresh facts only. */
export function formatOrgContext(c: OrgContext, maxChars = MAX_CONTEXT_CHARS): string {
	const lines: string[] = [];
	lines.push(`You are agent ${c.agent_id} (role: ${c.role}) in team run ${c.run_id}${c.is_root ? " — you are the ROOT of this organization" : ""}.`);
	lines.push(c.parent ? (c.parent.run_id
		? `Lead: ${c.parent.role} [${c.parent.agent_id}] in team ${c.parent.run_id}. Your team is linked under it: it can assign you tasks and message you; report progress and completion to it.`
		: `Manager: ${c.parent.role} [${c.parent.agent_id}]`) : "Manager: none (root; you report to the human operator)");
	const limits = c.budget?.limits;
	lines.push(`Authority: manage descendants (budgets, models, close; resume via budget update); ${c.is_root ? "create members directly" : "request expansion; approval by your manager"}. Runs never expire. Omitted member limits inherit yours; set a spend or time limit only when the human asks for one.`);
	if (c.budget?.own_budget_usd != null) lines.push(`Spend ceiling: ${usd(c.budget.own_budget_usd)}; pool consumed ${usd(c.budget.pool_consumed_usd ?? c.budget.consumed_usd)}. Inheriting members share this pool.`);
	if (limits) lines.push(`Single-decision grant: ${limits.max_grant_slots ?? "unbounded"} slots / ${usd(limits.max_grant_usd)}; session limit: ${limits.max_session_seconds || "unbounded"} seconds. Configured ancestor limits still apply; escalate when exceeded.`);
	if (c.reporting) {
		const r = c.reporting;
		lines.push(`Cross-team reporting relationships. Automatic inbox turns: ${r.wake_on_message ? "on" : "off"}.`);
		for (const link of r.links.slice(0, MAX_LIST)) lines.push(link.child_run_id === c.run_id
			? `Report to team leader ${link.parent_agent_id} (run ${link.parent_run_id}); send initial status and meaningful progress with team_send_message.`
			: `Reporting team ${link.child_run_id}: leader ${link.child_agent_id}; request reports with team_send_message.`);
		if (r.links.length) lines.push("Links between teams: a lead can assign tasks (team_delegate_task) and send messages one step down to the agent linked directly under it; that agent reports up with progress, completion, questions and answers; peers under the same lead can exchange questions, answers and progress. Leads never reach deeper than one step, and each team keeps its own recruitment, approvals and budget. Use exact agent IDs. Maintain consolidated status for teams linked under you, follow up on blockers and decisions, and avoid acknowledgement loops. A linked team that stopped (for example while its leader was away) can be resumed with team_resume_team. team_reporting manages links and history.");
	}
	if (c.children.length) {
		const shown = c.children.slice(0, MAX_LIST).map((k) => `${k.role} [${k.agent_id}] ${k.status}/${k.observed_state}${k.run_id ? ` (linked team ${linkedLabel(k)})` : ""}`);
		lines.push(`Direct reports (${c.children.length}): ${shown.join("; ")}${c.children.length > MAX_LIST ? "; …" : ""}`);
	} else lines.push("Direct reports: none");
	const peers = c.peers ?? [];
	if (peers.length) {
		const shown = peers.slice(0, MAX_LIST).map((k) => `${k.role} [${k.agent_id}]${k.run_id ? ` (team ${linkedLabel(k)})` : ""}`);
		lines.push(`Teammates (same manager; message them directly with team_send_message): ${shown.join("; ")}${peers.length > MAX_LIST ? "; …" : ""}`);
	}
	if (c.tasks.length) {
		const shown = c.tasks.slice(0, MAX_LIST).map((t) => `${t.task_id} ${t.status}: ${clip(t.title, 80)}`);
		lines.push(`Your tasks: ${shown.join("; ")}${c.tasks.length > MAX_LIST ? "; …" : ""}`);
	} else lines.push("Your tasks: none assigned");
	const b = c.budget;
	if (b?.unlimited) lines.push("Budget: UNLIMITED run policy; explicit worker budgets/lifetimes still apply. Accounting and identity permissions remain active.");
	else if (b) lines.push(`Budget: ${usd(b.available_usd)} available of ${usd(b.limits?.max_subtree_usd)} subtree ceiling; ${b.available_slots ?? "unbounded"} spawn slot(s) available.`);
	if (c.pending_proposals_to_review > 0) lines.push(`Pending expansion proposals awaiting YOUR review: ${c.pending_proposals_to_review} (use team_review_expansion).`);
	if (c.inbox_pending > 0) lines.push(`Unread team messages: ${c.inbox_pending} (they will be delivered; or call team_get_inbox).`);
	if (c.desired_state !== "RUNNING") lines.push(`Controller desired state for you: ${c.desired_state} — stop starting new work.`);
	lines.push(
		"Use the team_* tools to coordinate. Your identity comes from your session credential; the controller authorizes every action. Expansion proposals are requests, not guarantees.",
	);
	return clip(lines.join("\n"), maxChars);
}

// ---------------------------------------------------------------------------------------------
// Team listing: recognizable names, scoped to the current project, quiet about old and empty teams.

const STALE_MS = 7 * 86_400_000;

function ago(iso: string | null | undefined, now: number): string {
	if (!iso) return "no activity";
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
}

export function shortPath(path: string | null | undefined, home = process.env.HOME): string {
	if (!path) return "";
	return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** One-line description of a team for lists and pickers. */
export function teamLabel(r: RunSummary, now = Date.now()): string {
	const state = r.status === "CANCELLED" ? "closed" : r.stopped ? "stopped" : (r.live_members ?? 0) > 0 ? "running" : "idle";
	const members = `${r.live_members ?? 0}/${r.active_members ?? Math.max(0, r.agents - 1)} live`;
	const bits = [`${r.name ?? r.run_id} [${state}]`, members, `${r.open_tasks ?? 0} open tasks`, `active ${ago(r.last_activity_at ?? r.created_at, now)}`];
	if (r.reporting_teams) bits.push(`${r.reporting_teams} linked teams`);
	if (r.reports_to_run_id) bits.push(`linked under ${r.reports_to_run_id}`);
	if (r.model) bits.push(r.model);
	return bits.join(" · ");
}

/** A team belongs to the project when either directory contains the other. */
export function sameProject(teamCwd: string | null | undefined, project: string): boolean {
	if (!teamCwd) return false;
	const a = teamCwd.replace(/\/+$/, ""), b = project.replace(/\/+$/, "");
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Teams of this project first (same directory, or one inside the other); otherwise the given order is kept. */
export function projectFirst<T extends { cwd?: string | null }>(runs: T[], project: string): T[] {
	return [...runs.filter((r) => sameProject(r.cwd, project)), ...runs.filter((r) => !sameProject(r.cwd, project))];
}

/**
 * Another open session already leads a team in this project. Warn, and list what the human can do,
 * each with its full command. Nothing happens unless they run one. `own` is this session's new team, if any.
 */
export function openLeaderHints(runs: RunSummary[], project: string, own?: string): string | undefined {
	const open = runs.filter((r) => r.leader_live && r.run_id !== own && r.status !== "CANCELLED" && !r.stopped && sameProject(r.cwd, project));
	if (!open.length) return undefined;
	const lines: string[] = [];
	for (const r of open.slice(0, 3)) {
		const id = r.run_id;
		lines.push(
			`Team "${r.name ?? id}" (${id}${r.cwd ? `, ${shortPath(r.cwd)}` : ""}) is still led by another open session (${r.root_agent_id}).`,
			`  To lead that team from this session instead (the other session loses it): /team resume ${id}`,
			own
				? `  To link your new team under its leader: /team join ${id}`
				: `  To lead your own team under its leader: /team init, then /team join ${id}`,
			own
				? `  To put that team under yours (you become its leader's lead): in the other session, /team join ${own}`
				: `  To put that team under yours (you become its leader's lead): /team init, then in the other session /team join <your new run_id>`,
		);
	}
	if (open.length > 3) lines.push(`…and ${open.length - 3} more; /team list shows them.`);
	lines.push(own ? "Doing nothing keeps your new team separate." : "Doing nothing keeps this session as it is.");
	return lines.join("\n");
}

export function listTeams(runs: RunSummary[], opts: { project?: string; all?: boolean; current?: string; now?: number }): { lines: string[]; shown: RunSummary[]; hidden: number } {
	const now = opts.now ?? Date.now();
	const visible = (r: RunSummary) => {
		if (opts.all || r.run_id === opts.current) return true;
		if (r.status === "CANCELLED") return false;
		if (opts.project && !sameProject(r.cwd, opts.project)) return false;
		if (r.empty && !r.open_tasks && r.run_id !== opts.current) return false;
		if (r.stopped && now - Date.parse(r.last_activity_at ?? r.created_at) > STALE_MS) return false;
		return true;
	};
	const shown = runs.filter(visible).sort((x, y) => Date.parse(y.last_activity_at ?? y.created_at) - Date.parse(x.last_activity_at ?? x.created_at));
	const lines = shown.flatMap((r) => [
		`${r.run_id === opts.current ? "▶" : "•"} ${teamLabel(r, now)}`,
		`    ${r.run_id}${r.cwd ? ` · ${shortPath(r.cwd)}` : ""}${r.summary ? ` · ${r.summary}` : ""}`,
	]);
	return { lines, shown, hidden: runs.length - shown.length };
}

export interface AwaySummary {
	since: string;
	completed: { task_id: string; title: string; by: string; status: string; summary: string }[];
	progress_reports: number;
	messages_waiting: number;
	auto_paused_at: string | null;
}

/** "While you were away": empty when nothing happened. */
export function formatAway(a: AwaySummary): string {
	if (!a.completed.length && !a.progress_reports && !a.messages_waiting && !a.auto_paused_at) return "";
	const lines = [`While you were away (since ${a.since.slice(0, 16).replace("T", " ")} UTC):`];
	for (const c of a.completed.slice(0, 8)) lines.push(`  ✓ ${c.title} — ${c.by}${c.status !== "DONE" ? ` (${c.status})` : ""}${c.summary ? `: ${clip(c.summary, 120)}` : ""}`);
	if (a.completed.length > 8) lines.push(`  … ${a.completed.length - 8} more completed`);
	if (a.progress_reports) lines.push(`  ${a.progress_reports} progress report(s)`);
	if (a.messages_waiting) lines.push(`  ${a.messages_waiting} message(s) waiting for you; they arrive with your next turn (or /team inbox)`);
	if (a.auto_paused_at) lines.push(`  The team was paused at ${a.auto_paused_at.slice(11, 16)} UTC because you were gone and everyone was idle; resuming brought it back.`);
	return lines.join("\n");
}

/** Beyond this many direct reports, the brief suggests sub-leads. */
export const MAX_DIRECT_REPORTS = 8;

/** The team brief as text: what needs the reader, who is doing what, and what changed since it last looked. */
export function formatBrief(b: BriefResponse): string {
	const hhmm = (iso: string) => iso.slice(11, 16);
	const lines: string[] = [];
	if (b.summary) lines.push(`Overview (written by ${b.summary.model}, ${hhmm(b.summary.created_at)} UTC; /team history summaries for earlier ones):`, ...b.summary.overview.split("\n").map((l) => `  ${l}`));
	const needs: string[] = [];
	for (const m of b.needs_you.messages.slice(0, 5)) needs.push(`${m.type} from ${m.from}${m.preview ? `: ${clip(m.preview, 100)}` : ""}`);
	if (b.needs_you.messages.length > 5) needs.push(`${b.needs_you.messages.length - 5} more message(s)`);
	if (b.needs_you.proposals_to_review) needs.push(`${b.needs_you.proposals_to_review} expansion proposal(s) to review`);
	for (const r of b.needs_you.stopped_linked_teams) needs.push(`linked team ${r} is stopped (team_resume_team resumes it)`);
	lines.push(needs.length ? "Needs you:" : "Needs you: nothing.", ...needs.map((n) => `  • ${n}`));
	if (b.needs_you.other_unread) lines.push(`  (${b.needs_you.other_unread} other unread message(s), such as progress and notices; they arrive with the next turn)`);
	if (b.members.length) {
		lines.push("Members:");
		for (const m of b.members) {
			const state = m.state === "idle" && m.idle_ms !== null ? `idle ${Math.round(m.idle_ms / 60_000)}m` : m.state;
			const work = m.tasks.length ? m.tasks.map((t) => `"${clip(t.title, 60)}" ${t.status}${t.picked_up ? "" : " (not picked up yet)"}`).join("; ") : "no open tasks";
			lines.push(`  • ${m.role}${m.linked_run_id ? ` (linked team ${m.linked_run_id})` : ""}: ${state} · ${work}`);
		}
		if (b.members.length > MAX_DIRECT_REPORTS) lines.push(`  (${b.members.length} direct reports is more than one lead tracks well: consider grouping related members under a sub-lead, who gets its own brief and summaries and reports one headline up.)`);
	} else lines.push("Members: none.");
	if (b.deeper_open_tasks) lines.push(`  + ${b.deeper_open_tasks} open task(s) further down`);
	if (b.since_seq === null) lines.push("Changes: (first look; from now on, only what changed since the last look)");
	else if (!b.changes.length && !b.progress_reports) lines.push("Changes since you last looked: none.");
	else {
		lines.push("Changes since you last looked:");
		if (b.changes_omitted) lines.push(`  … ${b.changes_omitted} earlier change(s)`);
		for (const c of b.changes) lines.push(`  • ${hhmm(c.at)} ${c.text}`);
		if (b.progress_reports) lines.push(`  + ${b.progress_reports} progress report(s)`);
	}
	return lines.join("\n");
}

/** Summaries, newest first: each window's events range, when, and what happened. */
export function formatSummaries(list: SummaryView[]): string {
	const lines: string[] = [];
	for (const s of list) {
		lines.push(`— ${s.created_at.slice(0, 16).replace("T", " ")} UTC · events ${s.from_seq + 1}–${s.to_seq} · ${s.model}`);
		lines.push(...s.window.split("\n").map((l) => `  ${l}`));
	}
	lines.push(`Latest overview:`, ...list[0].overview.split("\n").map((l) => `  ${l}`));
	return lines.join("\n");
}

/** One member's stream with the reader, oldest first. */
export function formatThread(t: MemberThread): string {
	if (!t.items.length) return `Nothing between you and ${t.member_role} yet.`;
	const lines = [`${t.member_role} [${t.member_id}], oldest first:`];
	if (t.more_before) lines.push(`  (earlier: /team history ${t.member_role} --before ${t.more_before})`);
	for (const i of t.items) lines.push(`  ${i.at.slice(5, 16).replace("T", " ")} ${i.from} · ${i.kind}: ${clip(i.text.replace(/\s+/g, " "), 300)}`);
	return lines.join("\n");
}

/**
 * A batch of team messages as one structured delivery instead of one interleaved stream: grouped by
 * sender (senders with questions first), questions and answers in full, each task's progress reduced
 * to its latest report (earlier ones stay readable with team_history), everything else in full.
 */
export function formatInbox(messages: Envelope[], forAgent: string | undefined): string {
	const groups = new Map<string, Envelope[]>();
	for (const m of messages) groups.set(m.from, [...(groups.get(m.from) ?? []), m]);
	const asks = (ms: Envelope[]) => ms.some((m) => m.type === "question" || m.type === "answer");
	const ordered = [...groups.values()].sort((a, b) => Number(asks(b)) - Number(asks(a)));
	const head = `Team inbox: ${messages.length} new message(s) for ${forAgent}${groups.size > 1 ? ` from ${groups.size} senders, grouped by sender` : ""}. They are durable org messages delivered by the controller, which verifies each sender.`;
	if (groups.size <= 1 && !messages.some((m) => m.type === "task.progress")) return `${head}\n\n${messages.map((m) => formatEnvelope(m)).join("\n\n---\n\n")}`;
	const parts = [head];
	for (const ms of ordered) {
		const latestProgress = new Map<string, Envelope>();
		for (const m of ms) if (m.type === "task.progress") latestProgress.set(String(m.payload.task_id ?? m.message_id), m);
		const shown = ms.filter((m) => m.type !== "task.progress" || latestProgress.get(String(m.payload.task_id ?? m.message_id)) === m);
		const hidden = ms.length - shown.length;
		const role = ms[0].from_role ?? ms[0].from;
		parts.push([
			`== ${senderOf(ms[0])}: ${ms.length} message(s)${hidden ? `; ${hidden} earlier progress report(s) not repeated here (team_history member "${role}" shows them)` : ""}`,
			...shown.map((m) => formatEnvelope(m)),
		].join("\n\n"));
	}
	return parts.join("\n\n");
}
