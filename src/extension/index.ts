// pi-recursive-team Pi extension entry (default-export factory).
// The factory only registers commands/tools/handlers: no process, socket or timer is created here.
// Long-lived resources start in session_start and are released idempotently in session_shutdown.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TeamRuntime } from "./runtime.ts";
import { registerTools } from "./tools.ts";
import { projectTeamsNotice, summarizerStartNotice, registerTeamCommand } from "./commands.ts";
import { formatOrgContext } from "./format.ts";
import { agentDisplayName, installAgentLabel, installMemberHeader } from "./agent-label.ts";
import { memberDecor } from "../terminal/decor.ts";
import { ENV_PTY_HANDLE } from "../terminal/native/protocol.ts";
import { currentHost } from "../terminal/hosts.ts";

export const CONTEXT_SECTION = "team_org_context";

/**
 * One copy per process. Pi dedupes by canonical path, but two physical copies (e.g. an npm install and
 * a git checkout) would register the same tools twice and run two heartbeats. The first copy to load
 * wins; the same path loading again (/reload re-runs the factory) is always allowed.
 */
interface LoadRecord {
	url: string;
	active: boolean;
}
const LOAD_KEY = Symbol.for("pi-recursive-team.loaded");
function claimLoad(url: string): { ok: true } | { ok: false; owner: string } {
	const g = globalThis as unknown as Record<symbol, LoadRecord | undefined>;
	const cur = g[LOAD_KEY];
	if (cur && cur.active && cur.url !== url) return { ok: false, owner: cur.url };
	g[LOAD_KEY] = { url, active: true };
	return { ok: true };
}
function releaseLoad(url: string): void {
	const g = globalThis as unknown as Record<symbol, LoadRecord | undefined>;
	const cur = g[LOAD_KEY];
	if (cur && cur.url === url) cur.active = false;
}

const waitBounded = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref?.())]);

export default function piRecursiveTeam(pi: ExtensionAPI): void {
	const self = import.meta.url;
	const claim = claimLoad(self);
	if (!claim.ok) {
		const owner = claim.owner;
		pi.on("session_start", (_e, ctx) => {
			const msg = `pi-recursive-team: duplicate copy ${self} ignored; already loaded from ${owner}. Remove one of the installs.`;
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
			else process.stderr.write(`${msg}\n`);
		});
		return;
	}

	const rt = new TeamRuntime(pi);

	registerTeamCommand(pi, rt);
	registerTools(pi, rt);

	pi.on("session_start", (_event, ctx) => {
		// Read before start() consumes it. A bb member thread gets its worker env from a claim instead.
		const managedLaunch = rt.takeHostClaim();
		const p = rt.start(ctx);
		if (ctx.mode === "tui") {
			installAgentLabel(ctx.ui, () => rt.identity ? agentDisplayName(rt.identity.role) : undefined, {
				check: () => rt.exitCheck(),
				confirm: (title, detail) => ctx.ui.confirm(title, detail),
				quit: () => ctx.shutdown(),
				notify: (text) => ctx.ui.notify(text, "info"),
			});
			// Member terminals get a decoration from the host's dispatch plan; the leader keeps its editor label.
			// Members the human can switch into say how to get back.
			const switchable = !!process.env[ENV_PTY_HANDLE] || currentHost().beside;
			installMemberHeader(ctx.ui, () => rt.identity && rt.managed ? { ...memberDecor(rt.identity.agent_id, agentDisplayName(rt.identity.role)), ...(switchable ? { hint: "/team back returns to the leader" } : {}) } : undefined);
		}
		// Managed one-shot worker: enroll before the first turn (Pi awaits session_start handlers).
		// Interactive sessions: do not block startup; tools and before_agent_start wait with a bound.
		if (managedLaunch) return waitBounded(p, 15_000).then(() => undefined);
		if (ctx.mode === "tui") void p.then(() => projectTeamsNotice(rt, ctx)).then(() => summarizerStartNotice(rt, ctx));
	});

	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role === "assistant") await rt.reportUsage(message.usage.cost.total, `assistant:${message.timestamp}`);
		else if (message.role === "toolResult" && message.usage) await rt.reportUsage(message.usage.cost.total, `tool:${message.toolCallId}`);
	});

	pi.on("model_select", (event) => {
		if (event.source !== "restore") return rt.reportModel(event.model.provider, event.model.id);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// Quitting the harness applies the team's exit policy: stop it (resumable) unless it is set to keep running.
		// One-shot print runs (pi -p) quit after every prompt; only interactive sessions apply the policy.
		if (event?.reason === "quit" && (ctx?.mode === "tui" || ctx?.mode === "rpc")) {
			const write = (text: string) => { (ctx.mode === "tui" ? process.stdout : process.stderr).write(text); };
			await waitBounded(rt.onQuit(write), 6_000);
		}
		rt.stop();
		releaseLoad(self);
	});

	// Small, fresh org context before each run. Never a cached hierarchy, never the whole tree.
	pi.on("before_agent_start", async (event) => {
		if (event.messageType === "user") await rt.awaitHostClaim(event.prompt);
		await waitBounded(rt.ready, rt.managed ? 15_000 : 5_000);
		const identity = rt.identity;
		if (!identity) return;
		let text: string;
		try {
			const me = await rt.client.me({ timeoutMs: 3_000 });
			if (rt.identity !== identity) return;
			text = formatOrgContext(me);
			if (me.is_root) text += "\nYou are the team leader. Configure the team through conversation; no config file is required. " +
				"For a user task, decide the useful number and responsibilities of members, then use team_create_member once per member. " +
				"Stay available to the human: dispatching is a handoff. Once team_create_member, team_delegate_task or team_send_message succeeds, the work is durably queued; do not poll team_get_tree or team_get_inbox, sleep, or wait for results. Summarize what you handed off and end your turn. Member reports wake you automatically (team_set_attention controls when). " +
				"Default to the leader session's current model when no model is specified, including after session resume or model changes. You may briefly offer alternative models using team_get_models(source=available), without blocking work on a model-selection question. " +
				"Honor explicit member names and model choices. Resolve exact models through Pi; ask on ambiguity and never guess or silently substitute. " +
				"Check team_get_budget for your effective limits and grant authority. Runs never expire. No numeric limits are imposed by default; omitted member budgets and lifetimes inherit yours. Leave max_cost_usd and max_runtime_seconds out unless the human explicitly asks for a spend or time limit: never invent a default such as a few dollars or minutes, because an exhausted limit pauses or stops the member mid-work. You may change descendant budgets/models, remove a ceiling (team_set_budget with max_cost_usd null), resume through budget updates, or close members within your delegated authority. If a limit blocks you, do not work around it: report the exact limit and tell the human that /team admin limits lists them and /team admin clear-limits removes them. " +
				"To close members when requested, use team_close_member. Completing tasks or zeroing a budget does not terminate a Pi process. Never claim a member is closed without a successful lifecycle result. " +
				"Use team_set_budget and team_set_model to change existing members; agent arguments accept exact names, full IDs, or unique whole ID words (such as maple or river maple). Ambiguous short references require more words or a full ID; short references are scoped to this team. Model changes wait until idle and preserve the process/transcript. " +
				"Members get separate worktrees. Report their actual IDs and provisioning state, and integrate results explicitly. " +
				"When the user requests member panes, use team_watch to open or manage them; if the terminal cannot host them, relay the reason team_watch gives. To switch the human into a member, tell them to run /team watch focus <name> (and /team back there to come back). " +
				"Runtime model registrations persist in this run; existing members retain their selected models. Lifecycle notices report process loss, restart scheduling or failure: update your understanding of the team and use team_get_tree to verify current state; a completed task is not a closed worker.";
			else text += "\nCompleting a task does not end your membership. Remain available for leader messages and new assignments. Do not exit Pi, kill your pane or retire yourself after finishing; your manager or the human decides when to close you.";
		} catch (e) {
			if (rt.identity !== identity || rt.handleAgentError(e, identity)) return;
			text = `You are agent ${identity.agent_id} in team run ${identity.run_id}; the team controller is currently unreachable (${(e as Error).message.slice(0, 120)}). Team tools may fail until it recovers.`;
		}
		// Managed worker: messages already waiting (e.g. the reason for a resume launch) ride along with this run.
		const message = await rt.inboxForRunStart();
		if (rt.identity !== identity) return;
		event.systemPromptOptions.sections[CONTEXT_SECTION] = text;
		if (message) return { message };
	});

	// Managed one-shot worker: before Pi settles (and the process exits), fetch the inbox once and,
	// if new work arrived, inject it and request ONE continuation (loop-guarded in the runtime).
	pi.on("agent_before_settle", async (event) => {
		return rt.onBeforeSettle(event);
	});

	// Interactive sessions: deliver pending messages as soon as Pi settles instead of waiting for the next heartbeat.
	pi.on("agent_settled", () => {
		rt.updateStatus();
		void rt.refreshMemberStrip();
		rt.onSettled();
	});
}
