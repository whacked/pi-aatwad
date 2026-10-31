// pi-recursive-team Pi extension entry (default-export factory).
// The factory only registers commands/tools/handlers: no process, socket or timer is created here.
// Long-lived resources start in session_start and are released idempotently in session_shutdown.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENV_ENROLL_FILE } from "../shared/protocol.ts";
import { TeamRuntime } from "./runtime.ts";
import { registerTools } from "./tools.ts";
import { registerTeamCommand } from "./commands.ts";
import { formatOrgContext } from "./format.ts";

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
		const managedLaunch = !!process.env[ENV_ENROLL_FILE]; // read before start() consumes it
		const p = rt.start(ctx);
		// Managed one-shot worker: enroll before the first turn (Pi awaits session_start handlers).
		// Interactive sessions: do not block startup; tools and before_agent_start wait with a bound.
		if (managedLaunch) return waitBounded(p, 15_000).then(() => undefined);
	});

	pi.on("model_select", (event) => {
		if (event.source !== "restore") return rt.reportModel(event.model.provider, event.model.id);
	});

	pi.on("session_shutdown", () => {
		rt.stop();
		releaseLoad(self);
	});

	// Small, fresh org context before each run. Never a cached hierarchy, never the whole tree.
	pi.on("before_agent_start", async (event) => {
		await waitBounded(rt.ready, rt.managed ? 15_000 : 5_000);
		if (!rt.identity) return;
		let text: string;
		try {
			const me = await rt.client.me({ timeoutMs: 3_000 });
			text = formatOrgContext(me);
			if (me.is_root) text += "\nYou are the team leader. Configure the team through conversation; no config file is required. " +
				"For a user task, decide the useful number and responsibilities of members, then use team_create_member once per member. " +
				"Default to the initial leader model when no model is specified. You may briefly offer alternative models using team_get_models(source=available), without blocking work on a model-selection question. " +
				"Honor explicit member names and model choices. Resolve exact models through Pi; ask on ambiguity and never guess or silently substitute. " +
				"Check team_get_budget. With operator unlimited policy, do not invent dollar allocations or runtime caps. Otherwise default member limits are $2 and 600 seconds. If the user requests unlimited mode when it is bounded, tell them to use /team admin unlimited; the human operator can remove those caps. " +
				"To close members when requested, use team_close_member. Completing tasks or zeroing a budget does not terminate a Pi process. Never claim a member is closed without a successful lifecycle result. " +
				"Use team_set_budget and team_set_model to change existing members; agent arguments accept exact names or IDs. Model changes wait until idle and preserve the process/transcript. " +
				"Members get separate worktrees. Report their actual IDs and provisioning state, and integrate results explicitly. " +
				"When the user requests tmux monitoring, use team_watch to open or manage the view; report its attach command when needed. " +
				"Runtime model registrations persist in this run; existing members retain their selected models.";
		} catch (e) {
			if (rt.handleAgentError(e)) return;
			text = `You are agent ${rt.identity.agent_id} in team run ${rt.identity.run_id}; the team controller is currently unreachable (${(e as Error).message.slice(0, 120)}). Team tools may fail until it recovers.`;
		}
		event.systemPromptOptions.sections[CONTEXT_SECTION] = text;
		// Managed worker: messages already waiting (e.g. the reason for a resume launch) ride along with this run.
		const message = await rt.inboxForRunStart();
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
		if (rt.identity && (!rt.identity.managed || rt.ctx?.mode === "tui") && rt.lastInboxPending > 0) void rt.deliverInbox({ triggerTurn: rt.identity.managed });
	});
}
