// Session-scoped team runtime: identity (enrollment / re-attach / fork detection),
// heartbeat, inbox delivery, and token selection. No typebox import so plain
// `node --test` can exercise it with a fake ExtensionAPI.
import { refreshHost, type HostDetection } from "../terminal/hosts.ts";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BB_CLAIM_FILE, ENV_ENROLL_FILE, HEARTBEAT_INTERVAL_MS, MEMBER_BOOTSTRAP_PREFIX, MEMBER_RESUME_PREFIX } from "../shared/protocol.ts";
import type { EnrollRequest, EnrollmentFile, Envelope, OrgContext } from "../shared/protocol.ts";

export const ENV_LAUNCH_TOKEN = "PI_TEAM_LAUNCH_TOKEN";
import { statePaths } from "../shared/paths.ts";
import type { StatePaths } from "../shared/paths.ts";
import { TeamApiError, TeamClient, ensureController, readOperatorToken, isUnavailable } from "../shared/client.ts";
import type { CallOptions, EnsureOptions, EnsureResult } from "../shared/client.ts";
import { formatEnvelope } from "./format.ts";
import { installMemberStrip, MEMBER_STRIP_WIDGET, type StripMember } from "./agent-label.ts";

interface TeamActivityView {
	on_leader_exit: "stop" | "keep";
	members: { agent_id: string; role: string; run_id: string; live: boolean; busy: boolean; open_tasks: number }[];
	live: number;
	busy: number;
}

export const IDENTITY_ENTRY = "pi-recursive-team/identity";
export const INBOX_MESSAGE = "pi-recursive-team/inbox";
export const ATTENTION_MESSAGE = "pi-recursive-team/attention";
export const STATUS_KEY = "team";
export const MAX_SETTLE_CONTINUATIONS = 20;
export const NOT_ENROLLED = "not enrolled: run /team init (new organization) or /team resume <run_id> (attach to an existing one)";

/** Persisted via pi.appendEntry. Never contains a token. */
export interface IdentityEntry {
	suspended?: boolean;
	ended?: string;
	version: 1;
	run_id: string;
	agent_id: string;
	pi_session_id: string;
	pi_session_path?: string;
	managed: boolean;
	role?: string;
}

export interface Identity {
	run_id: string;
	agent_id: string;
	session_id: string;
	token: string;
	managed: boolean;
	role?: string;
	parent_id?: string | null;
	task_id?: string | null;
	pi_session_id: string;
	/** Managed workers: controller socket from the enrollment file (the only way they find it). */
	socket_path?: string;
}

type PiLike = Pick<ExtensionAPI, "sendMessage" | "appendEntry"> & Partial<Pick<ExtensionAPI, "setModel">>;
type CtxLike = Pick<ExtensionContext, "ui" | "hasUI" | "mode" | "isIdle" | "hasPendingMessages" | "sessionManager" | "cwd"> & Partial<Pick<ExtensionContext, "modelRegistry" | "model" | "abort">>;

function g<T>(name: string, init: () => T): T {
	const k = Symbol.for(`pi-recursive-team.${name}`);
	const o = globalThis as unknown as Record<symbol, T | undefined>;
	let v = o[k];
	if (v === undefined) {
		v = init();
		o[k] = v;
	}
	return v;
}
/** In-memory identity per Pi session id; survives /reload (same process), never written to disk. */
const identityCache = () => g("identityCache", () => new Map<string, Identity>());
/** Message IDs already injected, per agent. Survives /reload. */
const seenCache = () => g("seenMessages", () => new Map<string, Set<string>>());

export interface RuntimeOptions {
	paths?: StatePaths;
	ensure?: EnsureOptions;
	heartbeatMs?: number;
	env?: NodeJS.ProcessEnv;
	/** Managed-worker reconnect backoff (tests shorten it). */
	retryDelaysMs?: number[];
}

/** Process-wide: once this process consumed an enrollment credential it stays a managed worker (survives /reload). */
const managedProcess = () => g("managedProcess", () => ({ value: false }));

/** Tests only: forget process-wide state (managed flag, cached identities, dedupe sets). */
export function __resetProcessStateForTests(): void {
	managedProcess().value = false;
	identityCache().clear();
	seenCache().clear();
}

export const MANAGED_NO_STATE_DIR =
	"managed workers never use the team state dir (no statePaths(), operator.token or controller start); the socket comes only from the enrollment file";

/** Socket-only paths for a managed worker. Every state-dir field is empty on purpose. */
function managedPaths(socket: string): StatePaths {
	return { dir: "", socket, db: "", lock: "", controllerInfo: "", operatorToken: "", log: "", enrollDir: "", workerLogs: "" };
}

export class TeamRuntime {
	pi: PiLike;
	opts: RuntimeOptions;
	identity: Identity | undefined;
	ctx: CtxLike | undefined;
	/** Shown to the user when identity was deliberately NOT adopted (fork/clone, consumed credential...). */
	notice: string | undefined;
	ready: Promise<void> = Promise.resolve();
	lastInboxPending = 0;
	fenced = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	/** While this session's team is stopped: checks whether someone (its lead, the human) resumed it. */
	private resumeWatch: ReturnType<typeof setInterval> | undefined;
	/** Latest host detection not yet accepted by the controller. */
	private unreportedHost: HostDetection | undefined;
	private delivering = false;
	private stopped = false;
	private attachQueue: Promise<void> = Promise.resolve();
	/** Explicit local transitions invalidate both pending and queued attaches. */
	private attachEpoch = 0;
	private usageAgent: string | undefined;
	private pendingUsage = new Map<string, number>();
	private usageFlushing: Promise<void> | undefined;

	constructor(pi: PiLike, opts: RuntimeOptions = {}) {
		this.pi = pi;
		this.opts = opts;
		// Nothing is resolved here: paths/client are lazy so a managed worker never computes the state dir.
	}

	private _paths: StatePaths | undefined;
	private _client: TeamClient | undefined;

	/**
	 * Interactive: the per-user state dir. Managed worker: socket-only paths from the enrollment
	 * file; asking for them before enrollment (or ever touching the state dir) throws.
	 */
	get paths(): StatePaths {
		if (this._paths) return this._paths;
		if (this.managed) throw new Error(MANAGED_NO_STATE_DIR);
		this._paths = this.opts.paths ?? statePaths();
		return this._paths;
	}

	get client(): TeamClient {
		if (!this._client) {
			const managed = this.managed;
			this._client = new TeamClient({
				paths: this.paths,
				token: () => this.identity?.token,
				ensure: this.opts.ensure,
				shouldReconnect: () => !this.stopped,
				// The controller launched this worker: never spawn one; just back off and retry.
				reconnect: managed ? "retry" : "ensure",
				retryDelaysMs: this.opts.retryDelaysMs,
			});
		}
		return this._client;
	}

	private useManagedSocket(socket: string): void {
		this._paths = managedPaths(socket);
		this._client = undefined;
	}

	/** Guard for every state-dir operation (ensureController, operator token). */
	private assertInteractive(op: string): void {
		if (this.managed) throw new Error(`${op}: ${MANAGED_NO_STATE_DIR}`);
	}

	async ensure(): Promise<EnsureResult> {
		this.assertInteractive("ensureController");
		return ensureController(this.paths, this.opts.ensure);
	}

	async operatorToken(waitMs?: number): Promise<string> {
		this.assertInteractive("operator token");
		return readOperatorToken(this.paths, waitMs);
	}

	get env(): NodeJS.ProcessEnv {
		return this.opts.env ?? process.env;
	}

	/**
	 * bb starts member Pi itself, so the controller cannot set the worker env. It drops a one-time claim with
	 * that env into the thread's storage dir instead. Taking it makes this process a managed launch, exactly
	 * as if the env had been set. Returns whether this process now has an enrollment file to consume.
	 */
	takeHostClaim(): boolean {
		if (this.env[ENV_ENROLL_FILE]) return true;
		const dir = this.env.BB_THREAD_STORAGE;
		if (!dir || this.identity) return false;
		const file = join(dir, BB_CLAIM_FILE);
		let claim: { env?: Record<string, unknown> };
		try { claim = JSON.parse(readFileSync(file, "utf8")); } catch { return false; }
		try { unlinkSync(file); } catch { /* another process took it */ return false; }
		for (const [k, v] of Object.entries(claim.env ?? {})) if (k.startsWith("PI_TEAM_") && typeof v === "string") this.env[k] = v;
		return !!this.env[ENV_ENROLL_FILE];
	}

	/**
	 * A bb member's first prompt can arrive before the controller has written its claim (it is written right
	 * after bb returns the new thread's ID). When the prompt is one of the controller's member prompts, wait
	 * for the claim and enroll before the turn runs.
	 */
	async awaitHostClaim(prompt: string, timeoutMs = 15_000): Promise<void> {
		if (this.identity || !this.env.BB_THREAD_STORAGE) return;
		if (!prompt.startsWith(MEMBER_BOOTSTRAP_PREFIX) && !prompt.startsWith(MEMBER_RESUME_PREFIX)) return;
		const deadline = Date.now() + timeoutMs;
		while (!this.takeHostClaim()) {
			if (Date.now() > deadline) { this.say("team: this looks like a team member thread, but its enrollment claim never arrived", "warning"); return; }
			await new Promise((r) => setTimeout(r, 100));
		}
		this.ready = this.resolveIdentity().catch((e) => { this.say(`team: could not enroll: ${(e as Error).message}`, "warning"); });
		await this.ready;
		this.updateStatus();
	}

	/** True when this Pi process was launched by the controller as a managed worker. */
	get managed(): boolean {
		return this.identity?.managed === true || !!this.env[ENV_ENROLL_FILE] || managedProcess().value;
	}

	piSession(): { id: string; path?: string } {
		const sm = this.ctx?.sessionManager;
		return { id: sm?.getSessionId() ?? "unknown", path: sm?.getSessionFile() ?? undefined };
	}

	// ------------------------------------------------------------------ output
	say(text: string, level: "info" | "warning" | "error" = "info"): void {
		const ctx = this.ctx;
		if (ctx?.hasUI) ctx.ui.notify(text, level);
		else process.stderr.write(`[team] ${text}\n`);
	}

	updateStatus(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		try {
			const id = this.identity;
			if (id?.role && ctx.mode === "tui") ctx.ui.setTitle?.((id.role === "root" ? "Team leader" : id.role).replace(/[\x00-\x1f\x7f-\x9f]/g, " "));
			if (id) {
				const raw = (id.role ?? "agent").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
				const name = ctx.mode === "tui" && ctx.ui.theme ? ctx.ui.theme.style(raw, { fg: "accent", bold: true }) : raw;
				ctx.ui.setStatus(STATUS_KEY, `team ${name} ${id.agent_id} · run ${id.run_id}${id.managed ? " · managed" : ""}`);
			}
			else if (this.fenced) ctx.ui.setStatus(STATUS_KEY, "team: fenced (run /team resume)");
			else if (this.notice) ctx.ui.setStatus(STATUS_KEY, "team: not attached (/team resume)");
			else ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* ctx invalidated */
		}
	}

	// ------------------------------------------------------------------ exit
	/** The team this session leads, if it is a leader; never throws. */
	private async ledTeam(): Promise<{ runId: string; activity: TeamActivityView } | undefined> {
		const id = this.identity;
		if (!id || this.managed) return undefined;
		try {
			if (!(await this.client.me({ timeoutMs: 2_000 })).is_root) return undefined;
			return { runId: id.run_id, activity: await this.client.get<TeamActivityView>(`/runs/${encodeURIComponent(id.run_id)}/activity`, { timeoutMs: 2_000 }) };
		} catch { return undefined; }
	}

	/** For the exit guard: block only while someone in the team tree is working. */
	async exitCheck(): Promise<{ busy: number; title: string; detail: string } | undefined> {
		const led = await this.ledTeam();
		if (!led) return undefined;
		const act = led.activity;
		const working = act.members.filter((m) => m.busy);
		if (!working.length) return { busy: 0, title: "", detail: "" };
		const names = working.slice(0, 5).map((m) => m.role).join(", ") + (working.length > 5 ? ", …" : "");
		return {
			busy: working.length,
			title: "Team members are still working. Quit Pi?",
			detail: `${working.length} of ${act.live} live member(s) are working: ${names}.\n\n` + (act.on_leader_exit === "keep"
				? "Exit policy is keep: they continue in the background. /team resume returns to them with a summary of what happened."
				: "Quitting stops the team now (resumable): their transcripts and tasks are kept, and /team resume continues them."),
		};
	}

	/** On quit: apply the team's exit policy and leave a one-paragraph note. Never throws. */
	async onQuit(write: (text: string) => void): Promise<void> {
		// bb keeps the thread and starts Pi again for it (restarts, idle eviction): that is not the human leaving.
		if (this.env.BB_THREAD_ID) return;
		const led = await this.ledTeam();
		if (!led) return;
		const act = led.activity;
		if (!act.members.length) return; // Nothing was ever under this leader.
		const working = act.members.filter((m) => m.busy).length;
		const resume = `/team resume ${led.runId}`;
		if (act.on_leader_exit === "keep") {
			write(`Team ${led.runId} keeps running in the background: ${act.live} live member(s), ${working} working. ${resume} returns to it with a summary; /team exit-policy stop changes this.\n`);
			return;
		}
		try {
			await this.client.post(`/runs/${encodeURIComponent(led.runId)}/stop`, {}, { token: await this.operatorToken(1_000), timeoutMs: 4_000 });
			write(`Team ${led.runId} stopped (resumable): ${act.members.length} member(s) paused${working ? `, ${working} mid-task` : ""}. ${resume} continues it.\n`);
		} catch (e) {
			write(`Could not stop team ${led.runId} (${(e as Error).message}); it may still be running. /team stop ${led.runId} stops it.\n`);
		}
	}

	private stripKey = "";
	/** Leaders see which members are running, wherever they are hosted, and how to switch. */
	async refreshMemberStrip(identity = this.identity): Promise<void> {
		const ctx = this.ctx;
		if (!ctx || ctx.mode !== "tui" || !identity || this.managed) return;
		try {
			const me = await this.client.me({ timeoutMs: 3_000 });
			if (this.identity !== identity || this.ctx !== ctx) return;
			const members: StripMember[] = me.children
				.filter((c) => !["CANCELLED", "COMPLETED", "FAILED", "RETIRED"].includes(c.status))
				.map((c) => ({ agent_id: c.agent_id, role: c.role, live: c.observed_state === "LIVE", ...(c.run_id ? { linked: true } : {}) }));
			const key = JSON.stringify(members);
			if (key === this.stripKey) return;
			this.stripKey = key;
			if (members.length) installMemberStrip(ctx.ui, () => members);
			else ctx.ui.setWidget(MEMBER_STRIP_WIDGET, undefined);
		} catch {
			/* best effort; the footer reports controller problems */
		}
	}

	// ------------------------------------------------------------------ lifecycle
	/** session_start. Resolves identity in the background; `ready` settles when done. */
	start(ctx: CtxLike): Promise<void> {
		this.ctx = ctx;
		this.stopped = false;
		// Detect the host once at startup; /team host refresh or the controller can ask again.
		void this.detectHost().catch(() => {});
		this.ready = this.resolveIdentity().catch((e) => {
			this.say(`team: could not restore organization identity: ${(e as Error).message}`, "warning");
		});
		void this.ready.then(() => { setTimeout(() => this.updateStatus(), 0).unref?.(); });
		return this.ready;
	}

	/** session_shutdown. Idempotent; never kills the controller or org members. */
	stop(): void {
		this.attachEpoch++;
		this.stopped = true;
		this.ctx = undefined;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.unwatchResume();
	}

	/**
	 * This session led (or was) an agent of a team that is now stopped. When the team is resumed from
	 * elsewhere (its lead, or /team resume in another terminal), attach again, but only if no other
	 * session has taken the agent over meanwhile.
	 */
	private watchForResume(runId: string, agentId: string): void {
		if (this.managed) return; // the controller restarts managed members itself
		this.unwatchResume();
		const check = async () => {
			if (this.stopped || this.identity) return this.unwatchResume();
			try {
				const op = await this.operatorToken(0);
				const run = (await this.client.listRuns({ token: op })).runs.find((r) => r.run_id === runId);
				if (!run || run.status === "CANCELLED") return this.unwatchResume();
				if (run.stopped) return;
				const latest = (await this.client.inspect(agentId, { token: op })).sessions.at(-1);
				if (latest?.pi_session_id && latest.pi_session_id !== this.piSession().id) {
					this.unwatchResume();
					this.notice = `Team ${runId} was resumed and is led from another session now.`;
					this.updateStatus();
					return;
				}
				this.unwatchResume();
				if (this.identity || this.stopped) return;
				await this.attach(runId, agentId, { quiet: true });
				this.say(`Team ${runId} was resumed; this session is ${agentId} again.`);
			} catch {
				/* the controller may be restarting; try again on the next check */
			}
		};
		this.resumeWatch = setInterval(() => void check(), this.opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
		this.resumeWatch.unref?.();
	}

	private unwatchResume(): void {
		if (this.resumeWatch) clearInterval(this.resumeWatch);
		this.resumeWatch = undefined;
	}

	private async resolveIdentity(): Promise<void> {
		const pis = this.piSession();
		this.seedSeenFromTranscript();
		// (0) same process, same Pi session (e.g. /reload): reuse the in-memory credential.
		const cached = identityCache().get(pis.id);
		if (cached) {
			this.adopt(cached);
			return;
		}
		// (a) managed child: consume the one-time enrollment file.
		const enrollPath = this.env[ENV_ENROLL_FILE];
		if (enrollPath) {
			delete this.env[ENV_ENROLL_FILE]; // never leak to nested processes (bash tool, sub-pi)
			managedProcess().value = true;
			await this.enrollFromFile(enrollPath, pis);
			return;
		}
		// (b) persisted mapping in this Pi session.
		const entry = this.latestIdentityEntry();
		if (entry) {
			if (entry.suspended) {
				this.notice = `Team ${entry.run_id} is stopped; run /team resume ${entry.run_id} ${entry.agent_id} to continue with fresh credentials.`;
				if (!entry.managed) this.watchForResume(entry.run_id, entry.agent_id);
				this.updateStatus();
				return;
			}
			if (entry.ended) {
				this.notice = `Previous team agent ${entry.agent_id} is ${entry.ended}; start a new team or resume a different active run.`;
				this.updateStatus();
				return;
			}
			if (entry.pi_session_id !== pis.id) {
				this.notice =
					`This Pi session was forked/cloned from team agent ${entry.agent_id} (run ${entry.run_id}). ` +
					`The identity was NOT adopted to avoid two sessions acting as one agent. ` +
					`Run /team resume ${entry.run_id} ${entry.agent_id} to deliberately take over (fences the other session), or keep working unenrolled.`;
				this.say(this.notice, "warning");
				this.updateStatus();
				return;
			}
			if (entry.managed) {
				this.notice = `This session belongs to managed worker ${entry.agent_id} (run ${entry.run_id}); not re-attaching automatically. Use /team resume ${entry.run_id} ${entry.agent_id} to take over.`;
				this.say(this.notice, "warning");
				this.updateStatus();
				return;
			}
			try {
				await this.attach(entry.run_id, entry.agent_id, { quiet: true });
			} catch (e) {
				const reason = e instanceof TeamApiError ? (e.details as { reason?: string } | undefined)?.reason : undefined;
				if (reason !== "team_stopped") throw e;
				this.notice = `Team ${entry.run_id} was stopped while this session was away; run /team resume ${entry.run_id} ${entry.agent_id} to continue it.`;
				this.say(this.notice, "warning");
				this.watchForResume(entry.run_id, entry.agent_id);
				this.updateStatus();
			}
			return;
		}
		// (c) unenrolled standalone: nothing is started or created.
	}

	private async enrollFromFile(path: string, pis: { id: string; path?: string }): Promise<void> {
		if (!existsSync(path)) {
			this.notice = `enrollment credential ${path} is missing (already used or expired); this managed worker cannot join its team`;
			this.say(this.notice, "error");
			return;
		}
		let file: EnrollmentFile;
		try {
			file = JSON.parse(readFileSync(path, "utf8")) as EnrollmentFile;
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* already gone */
			}
		}
		const envAgent = this.env.PI_TEAM_AGENT_ID;
		const envRun = this.env.PI_TEAM_RUN_ID;
		if ((envAgent && envAgent !== file.agent_id) || (envRun && envRun !== file.run_id)) {
			throw new Error(`enrollment file is for ${file.run_id}/${file.agent_id} but the worker env says ${envRun}/${envAgent}; refusing to enroll`);
		}
		if (typeof file.socket_path !== "string" || !isAbsolute(file.socket_path)) {
			throw new Error("enrollment file has no absolute socket_path; refusing to guess the controller location");
		}
		// Hard rule: the socket comes ONLY from the enrollment file. No statePaths(), no ensureController().
		this.useManagedSocket(file.socket_path);
		const r = await this.client.enroll(
			{
				token: file.token,
				agent_id: file.agent_id,
				spawn_intent_id: file.spawn_intent_id,
				pi_session_id: pis.id,
				pi_session_path: pis.path,
				pid: process.pid,
				// Executor-provided marker binding this process to its launch.
				...(this.env[ENV_LAUNCH_TOKEN] ? { launch_token: this.env[ENV_LAUNCH_TOKEN] } : {}),
			} satisfies EnrollRequest,
			{ idempotencyKey: `enroll:${file.spawn_intent_id}:${file.token.slice(0, 8)}` },
		);
		const id: Identity = {
			run_id: r.run_id,
			agent_id: r.agent_id,
			session_id: r.session_id,
			token: r.token,
			managed: true,
			socket_path: file.socket_path,
			parent_id: r.parent_id,
			task_id: r.task_id,
			pi_session_id: pis.id,
		};
		this.persist(id);
		this.adopt(id);
		await this.refreshRole();
	}

	/** Operator attach: POST /runs/:id/attach (used by /team resume and same-session restart). */
	async attach(runId: string, agentId?: string, o: { quiet?: boolean; resume?: boolean } = {}): Promise<Identity> {
		if (this.managed) throw new Error("managed workers cannot attach to another identity");
		const epoch = this.attachEpoch;
		const previous = this.attachQueue;
		let release!: () => void;
		this.attachQueue = new Promise<void>((resolve) => { release = resolve; });
		const checkCurrent = () => {
			if (this.attachEpoch !== epoch) throw new Error("team identity changed while attach was pending");
		};
		// Serialize the server requests, not just adoption: a later server-side attach
		// invalidates the earlier credential even if its response arrives first.
		await previous;
		try {
			checkCurrent();
			await this.ensure();
			checkCurrent();
			const op = await this.operatorToken();
			checkCurrent();
			const pis = this.piSession();
			if (o.resume) {
				const lifecycle = await this.client.resumeTeam(runId, { token: op });
				checkCurrent();
				if (lifecycle.error || lifecycle.state !== "RESUMED") throw new Error(lifecycle.error ?? `Team ${runId} is ${lifecycle.state}; cleanup is still pending. Retry /team resume ${runId}.`);
			}
			const r = await this.client.attach(
				runId,
				{ agent_id: agentId, pi_session_id: pis.id, pi_session_path: pis.path, mode: "attach" },
				{ token: op, idempotencyKey: `attach:${pis.id}:${randomUUID()}` },
			);
			checkCurrent();
			const id: Identity = { run_id: r.run_id, agent_id: r.agent_id, session_id: r.session_id, token: r.token, managed: false, pi_session_id: pis.id };
			this.notice = undefined;
			this.persist(id);
			// An attach's own adoption must not invalidate later queued attaches.
			this.adoptIdentity(id);
			await this.refreshRole();
			checkCurrent();
			if (this.identity !== id) throw new Error("team identity changed while attach was pending");
			if (!o.quiet) this.say(`attached to run ${id.run_id} as ${id.role ?? "agent"} ${id.agent_id} (session ${id.session_id})`);
			return id;
		} finally {
			release();
		}
	}

	/** Called by /team init after POST /runs. */
	adoptNew(id: Identity): void {
		this.notice = undefined;
		this.persist(id);
		this.adopt(id);
	}

	private persist(id: Identity): void {
		const pis = this.piSession();
		const entry: IdentityEntry = {
			version: 1,
			run_id: id.run_id,
			agent_id: id.agent_id,
			pi_session_id: pis.id,
			pi_session_path: pis.path,
			managed: id.managed,
			role: id.role,
		};
		this.pi.appendEntry(IDENTITY_ENTRY, entry);
	}

	adopt(id: Identity): void {
		this.attachEpoch++;
		this.adoptIdentity(id);
	}

	private adoptIdentity(id: Identity): void {
		if (id.managed) {
			if (!id.socket_path) throw new Error(MANAGED_NO_STATE_DIR);
			if (this._paths?.socket !== id.socket_path) this.useManagedSocket(id.socket_path);
		}
		if (this.identity?.agent_id !== id.agent_id) { this.localModel = undefined; this.observedModel = undefined; }
		this.identity = id;
		this.fenced = false;
		identityCache().set(id.pi_session_id, id);
		this.updateStatus();
		this.startHeartbeat();
	}

	async refreshRole(): Promise<OrgContext | undefined> {
		const identity = this.identity;
		if (!identity) return undefined;
		try {
			const me = await this.client.me({ timeoutMs: 5_000 });
			if (this.identity !== identity) return undefined;
			identity.role = me.role;
			identity.parent_id = me.parent?.agent_id ?? null;
			this.updateStatus();
			return me;
		} catch (e) {
			this.handleAgentError(e, identity);
			return undefined;
		}
	}

	latestIdentityEntry(): IdentityEntry | undefined {
		const sm = this.ctx?.sessionManager;
		if (!sm) return undefined;
		const entries = sm.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type: string; customType?: string; data?: unknown };
			if (e.type === "custom" && e.customType === IDENTITY_ENTRY && e.data && typeof e.data === "object") {
				const d = e.data as IdentityEntry;
				if (d.version === 1 && d.run_id && d.agent_id) return d;
			}
		}
		return undefined;
	}

	// ------------------------------------------------------------------ errors
	/** Discard revoked credentials, but retain the logical identity/transcript for resume. */
	suspendTeamIdentity(runId: string): void {
		const id = this.identity;
		if (!id || id.run_id !== runId) return;
		this.attachEpoch++;
		identityCache().delete(id.pi_session_id);
		this.identity = undefined;
		this.fenced = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.notice = `Team ${runId} is stopped, not removed. Run /team resume ${runId} ${id.agent_id} to continue; if its lead resumes it, this session attaches again by itself.`;
		this.pi.appendEntry(IDENTITY_ENTRY, { version: 1, run_id: runId, agent_id: id.agent_id, pi_session_id: id.pi_session_id, managed: id.managed, role: id.role, suspended: true } satisfies IdentityEntry);
		if (!id.managed) this.watchForResume(runId, id.agent_id);
		this.updateStatus();
	}

	removeTeamIdentity(runId: string): void {
		if (this.identity?.run_id === runId) {
			this.releaseStoppedIdentity("REMOVED");
		} else if (!this.identity) {
			const entry = this.latestIdentityEntry();
			if (entry?.run_id !== runId) return;
			this.attachEpoch++;
			this.pi.appendEntry(IDENTITY_ENTRY, { ...entry, suspended: false, ended: "REMOVED" } satisfies IdentityEntry);
			this.notice = `Team ${runId} was permanently removed. Your Pi session and worktrees are unchanged.`;
			this.updateStatus();
		}
	}

	/** End the local association without disabling operator commands for other runs. */
	releaseStoppedIdentity(status: string): void {
		this.attachEpoch++;
		const id = this.identity;
		if (!id) return;
		identityCache().delete(id.pi_session_id);
		this.identity = undefined;
		this.fenced = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.notice = `Team agent ${id.agent_id} in run ${id.run_id} is ${status}; start a new team or resume a different active run.`;
		this.pi.appendEntry(IDENTITY_ENTRY, { version: 1, run_id: id.run_id, agent_id: id.agent_id, pi_session_id: id.pi_session_id, managed: id.managed, role: id.role, ended: status } satisfies IdentityEntry);
		this.updateStatus();
	}

	/** Map fencing/auth errors to local state. Stale originating identities are ignored. */
	handleAgentError(e: unknown, identity: Identity | undefined = this.identity): boolean {
		if (this.identity !== identity) return false;
		if (e instanceof TeamApiError && (e.code === "STALE_SESSION" || e.code === "UNAUTHENTICATED") && this.identity) {
			const id = this.identity;
			const details = e.details as { reason?: string; agent_status?: string } | undefined;
			if (details?.reason === "team_stopped") {
				this.suspendTeamIdentity(id.run_id);
				this.say(this.notice!, "info");
				return true;
			}
			// Older controllers only supplied the revocation reason in the message.
			const ended = details?.reason === "agent_terminal" ? details.agent_status : /agent is (CANCELLED|COMPLETED|FAILED|RETIRED)|session token revoked \((cancelled|completed|failed|retired)\)/i.exec(e.message)?.slice(1).find(Boolean)?.toUpperCase();
			if (ended) {
				this.releaseStoppedIdentity(ended);
				this.say(`team: agent ${id.agent_id} is ${ended}; this session has left that team. You can still use /team stop for other runs.`, "info");
				return true;
			}
			identityCache().delete(id.pi_session_id);
			this.identity = undefined;
			this.fenced = true;
			if (this.timer) clearInterval(this.timer);
			this.timer = undefined;
			this.say(
				e.code === "STALE_SESSION" && (details?.reason === "superseded" || /superseded|generation fenced/i.test(e.message))
					? `team: this session was FENCED — a newer session attempt now represents agent ${id.agent_id}. Tools are disabled here. Run /team resume ${id.run_id} ${id.agent_id} to take it back.`
					: `team: session credential for ${id.agent_id} was rejected (${e.message}). Run /team resume ${id.run_id} ${id.agent_id}.`,
				"error",
			);
			this.updateStatus();
			return true;
		}
		return false;
	}

	/** Wait (bounded) for startup identity resolution, then require an identity. */
	async requireIdentity(waitMs = 10_000): Promise<Identity> {
		await Promise.race([this.ready, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
		if (!this.identity) {
			if (this.fenced) throw new Error(`session fenced: another session attempt represents this agent now. ${NOT_ENROLLED}`);
			// The notice says why this session has no identity (a stopped team, a fork), which the model must relay.
			throw new Error(this.notice ? `not enrolled: ${this.notice}` : NOT_ENROLLED);
		}
		return this.identity;
	}

	/** Run an agent-authenticated call; maps STALE_SESSION to a clear error. */
	async agentCall<T>(fn: (o: CallOptions) => Promise<T>, o: CallOptions = {}): Promise<T> {
		const identity = await this.requireIdentity();
		try {
			const result = await fn({ ...o, token: o.token ?? identity.token });
			if (this.identity !== identity) throw new Error("team identity changed while request was pending");
			return result;
		} catch (e) {
			if (this.identity !== identity) throw e;
			if (this.handleAgentError(e, identity)) {
				if (!this.fenced) throw new Error(this.notice ?? NOT_ENROLLED);
				throw new Error(`session fenced (${(e as TeamApiError).code}): this Pi session no longer represents the agent. Run /team resume.`);
			}
			if (isUnavailable(e)) throw new Error(`team controller unreachable: ${(e as Error).message}`);
			throw e;
		}
	}

	/** Bearer for human /team commands: operator token unless this is a managed worker. */
	async commandToken(): Promise<string | undefined> {
		if (this.managed) return this.identity?.token;
		await this.ensure();
		return this.operatorToken();
	}

	// ------------------------------------------------------------------ host detection
	/** Re-run host detection, replace the in-memory host, and report it to the controller. */
	async detectHost(): Promise<HostDetection> {
		const detection = await refreshHost();
		this.unreportedHost = detection;
		void this.reportHost();
		return detection;
	}

	private async reportHost(): Promise<void> {
		const report = this.unreportedHost;
		if (!report || !this.identity || this.stopped) return;
		try {
			await this.client.post("/sessions/host", report, { timeoutMs: 5_000 });
			if (this.unreportedHost === report) this.unreportedHost = undefined;
		} catch (e) {
			// An older controller has no host route; the report is informational, so stop trying.
			if (/404|NOT_FOUND|no route/i.test((e as Error).message)) this.unreportedHost = undefined;
		}
	}

	// ------------------------------------------------------------------ heartbeat + inbox
	private startHeartbeat(): void {
		if (this.timer) clearInterval(this.timer);
		const t = setInterval(() => void this.heartbeat(), this.opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
		t.unref?.();
		this.timer = t;
		void this.heartbeat();
	}

	private idle(): boolean {
		try {
			return !!this.ctx && this.ctx.isIdle() && !this.ctx.hasPendingMessages();
		} catch {
			return false;
		}
	}

	private applyingModel = false;

	private localModel?: { provider: string; model: string };
	private modelWarning?: string;
	private modelSelectionVersion = 0;
	/** provider/model last reported as what this session actually runs. */
	private observedModel?: string;

	async reportModel(provider: string, model: string): Promise<void> {
		if (!this.identity || this.applyingModel) return;
		this.modelSelectionVersion++;
		this.localModel = { provider, model };
		await this.flushLocalModel();
	}

	/**
	 * Report the model this session really runs when it differs from the last report. The controller only
	 * hears about explicit selections otherwise, so a model restored from a transcript or chosen by Pi at
	 * startup would leave the recruitment-time model in the record (and in what leads see).
	 */
	private async reportObservedModel(identity: NonNullable<TeamRuntime["identity"]>): Promise<void> {
		const m = this.ctx?.model;
		if (!m || this.applyingModel || this.localModel || this.identity !== identity) return;
		const key = `${m.provider}/${m.id}`;
		if (key === this.observedModel) return;
		try { await this.client.post("/sessions/model", { provider: m.provider, model: m.id, observed: true }); }
		catch (e) { if (this.identity !== identity || !/INVALID|observed/i.test((e as Error).message)) return; } // older controller: give up quietly
		if (this.identity === identity) this.observedModel = key;
	}

	private async flushLocalModel(): Promise<void> {
		const selected = this.localModel;
		const identity = this.identity;
		if (!selected || !identity) return;
		try {
			await this.client.post("/sessions/model", selected);
			if (this.identity !== identity) return;
			if (this.localModel === selected) this.localModel = undefined;
		}
		catch (e) {
			if (this.identity !== identity) return;
			if (!this.handleAgentError(e, identity)) this.say(`team: model switched locally, but controller persistence failed: ${(e as Error).message}`, "warning");
		}
	}

	private async applyModel(change: import("../shared/protocol.ts").ModelChange): Promise<void> {
		const identity = this.identity;
		if (!identity || this.applyingModel || this.localModel) return;
		if (this.ctx?.model?.provider === change.provider && this.ctx.model.id === change.model) {
			await this.client.post("/sessions/model", { provider: change.provider, model: change.model, request_id: change.request_id });
			return;
		}
		if (!this.idle()) return;
		const model = this.ctx?.modelRegistry?.find(change.provider, change.model);
		if (!model || !this.pi.setModel) throw new Error(`requested model ${change.provider}/${change.model} is unavailable in this Pi`);
		this.applyingModel = true;
		try {
			const applied = await this.pi.setModel(model);
			if (this.identity !== identity) return;
			if (!applied) throw new Error("Pi has no authentication for this model");
			await this.client.post("/sessions/model", { provider: model.provider, model: model.id, request_id: change.request_id });
		} finally { this.applyingModel = false; }
	}

	private restoreUsage(): void {
		const id = this.identity;
		if (!id || this.usageAgent === id.agent_id) return;
		this.usageAgent = id.agent_id;
		this.pendingUsage.clear();
		for (const entry of this.ctx?.sessionManager.getEntries() ?? []) {
			if (entry.type !== "custom" || entry.customType !== "pi-recursive-team/usage") continue;
			const data = entry.data as { agent: string; key: string; cost?: number; ack?: boolean };
			if (data?.agent !== id.agent_id) continue;
			if (data.ack) this.pendingUsage.delete(data.key);
			else if (typeof data.cost === "number") this.pendingUsage.set(data.key, data.cost);
		}
	}

	/** Persist new reports before sending; retries keep the original idempotency key. */
	async reportUsage(cost: number, messageKey: string): Promise<void> {
		if (!this.identity || !Number.isFinite(cost) || cost < 0) return;
		this.restoreUsage();
		const key = `usage:${this.identity.session_id}:${messageKey}`;
		this.pendingUsage.set(key, cost);
		this.pi.appendEntry("pi-recursive-team/usage", { agent: this.identity.agent_id, key, cost });
		await this.flushUsage();
	}

	private async flushUsage(): Promise<void> {
		if (this.usageFlushing) return this.usageFlushing;
		this.restoreUsage();
		const identity = this.identity;
		if (!identity) return;
		this.usageFlushing = (async () => {
			for (const [key, cost] of this.pendingUsage) {
				try {
					const result = await this.client.post<{ budget_exhausted: boolean }>("/sessions/usage", { cost_usd: cost }, { idempotencyKey: key });
					if (this.identity !== identity) return;
					this.pendingUsage.delete(key);
					this.pi.appendEntry("pi-recursive-team/usage", { agent: identity.agent_id, key, ack: true });
					if (result.budget_exhausted) this.ctx?.abort?.();
				} catch (e) {
					if (this.identity !== identity) return;
					if (!this.handleAgentError(e, identity)) this.say(`team: usage report queued for retry: ${(e as Error).message}`, "warning");
					return;
				}
			}
		})();
		try { await this.usageFlushing; } finally { this.usageFlushing = undefined; }
	}

	async heartbeat(): Promise<void> {
		if (!this.identity || this.stopped) return;
		const identity = this.identity;
		const pis = this.piSession();
		const selectionVersion = this.modelSelectionVersion;
		try {
			const r = await this.client.heartbeat(
				{ busy: !this.idle(), pi_session_id: pis.id, pi_session_path: pis.path },
				{ idempotencyKey: `hb:${this.identity.session_id}:${randomUUID()}`, timeoutMs: 5_000 },
			);
			if (this.identity !== identity) return;
			if (r.host_refresh) void this.detectHost().catch(() => {});
			else if (this.unreportedHost) void this.reportHost();
			await this.flushUsage();
			if (this.identity !== identity) return;
			this.updateStatus();
			void this.refreshMemberStrip(identity);
			const hadLocalSelection = !!this.localModel;
			await this.flushLocalModel();
			if (this.identity !== identity) return;
			if (!r.model_change) await this.reportObservedModel(identity);
			if (this.identity !== identity) return;
			if (r.model_change && !hadLocalSelection && selectionVersion === this.modelSelectionVersion) {
				try {
					await this.applyModel(r.model_change);
					if (this.identity !== identity) return;
					this.modelWarning = undefined;
				} catch (e) {
					if (this.identity !== identity || this.handleAgentError(e, identity)) return;
					if (this.modelWarning !== r.model_change.request_id) this.say(`team: model switch remains pending: ${(e as Error).message}`, "warning");
					this.modelWarning = r.model_change.request_id;
				}
			}
			if (r.desired_state !== "RUNNING") this.ctx?.abort?.();
			this.lastInboxPending = r.inbox_pending;
			this.onMessage = r.attention?.on_message;
			// Managed one-shot workers pick messages up at run start / before settling instead.
			if (!this.interactive() || !this.idle()) return;
			if (r.wake && r.desired_state === "RUNNING") await this.wakeTurn(r.wake);
			else if (r.inbox_pending > 0) {
				if (!r.attention) await this.deliverInbox({ triggerTurn: r.desired_state === "RUNNING" && (r.reporting_wake || this.managedTui()) }); // older controller
				else if (this.managedTui()) await this.deliverInbox({ triggerTurn: r.desired_state === "RUNNING" && r.attention.on_message === "wake" });
				else if (r.attention.on_message === "next_turn") await this.deliverInbox({ triggerTurn: false });
				// on_message=wake: leave messages pending; the controller wakes this session once the batch window passes,
				// and a human-started turn picks them up in before_agent_start.
			}
		} catch (e) {
			if (this.identity !== identity) return;
			if (this.handleAgentError(e, identity)) return;
			try {
				this.ctx?.ui.setStatus(STATUS_KEY, `team: controller unreachable (${(e as Error).message.slice(0, 60)})`);
			} catch {
				/* ignore */
			}
		}
	}

	/** Last effective on_message policy from the controller (undefined: older controller). */
	onMessage: "wake" | "next_turn" | undefined;
	private interactive(): boolean {
		return !!this.identity && (!this.identity.managed || this.persistentSession());
	}
	/** Pi keeps running between turns: a terminal (tui), or bb driving it over RPC. */
	private persistentSession(): boolean {
		return this.ctx?.mode === "tui" || (this.ctx?.mode === "rpc" && !!this.env.BB_THREAD_ID);
	}
	private managedTui(): boolean {
		return !!this.identity?.managed && this.persistentSession();
	}

	/**
	 * Controller-requested turn. Inbox messages ride along; a stall/tick digest is its own message.
	 * Nothing is sent to the model unless there is something new (the controller suppresses unchanged digests).
	 */
	async wakeTurn(wake: import("../shared/protocol.ts").Wake): Promise<void> {
		const identity = this.identity;
		if (this.lastInboxPending > 0) await this.deliverInbox({ triggerTurn: !wake.text });
		if (this.identity !== identity || !wake.text) return;
		this.pi.sendMessage({ customType: ATTENTION_MESSAGE, content: `Team ${wake.reason === "stall" ? "stall alert" : "check-in"} for ${identity?.agent_id}:\n${wake.text}`, display: true, details: { reason: wake.reason } }, this.idle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" });
	}

	/** Pi settled: deliver queued messages unless the controller will wake this session after batching. */
	onSettled(): void {
		if (!this.interactive() || this.lastInboxPending <= 0) return;
		if (this.managedTui()) void this.deliverInbox({ triggerTurn: this.onMessage !== "next_turn" });
		else if (this.onMessage !== "wake") void this.deliverInbox({ triggerTurn: false });
	}

	seen(): Set<string> {
		const key = this.identity?.agent_id ?? "_";
		let s = seenCache().get(key);
		if (!s) {
			s = new Set();
			seenCache().set(key, s);
		}
		return s;
	}

	/** Message IDs already injected into this transcript survive crashes: re-seed the dedupe set from it. */
	private seededIds: string[] = [];
	private seedSeenFromTranscript(): void {
		this.seededIds = [];
		try {
			for (const e of this.ctx?.sessionManager.getEntries() ?? []) {
				const m = e as { type: string; customType?: string; details?: { message_ids?: string[] } };
				if (m.type === "custom_message" && m.customType === INBOX_MESSAGE) for (const id of m.details?.message_ids ?? []) this.seededIds.push(id);
			}
		} catch {
			/* ignore */
		}
	}

	/**
	 * Claim pending messages (GET /inbox leases them) and split into unseen vs already-injected.
	 * Callers inject `fresh` (as ONE custom message built by `inboxMessage`) and then call `ack(all)`.
	 * At-least-once delivery + message_id dedupe; dedupe IDs are re-seeded from the transcript.
	 */
	async claimInbox(limit = 20): Promise<{ fresh: Envelope[]; all: Envelope[] }> {
		const identity = this.identity;
		if (!identity) return { fresh: [], all: [] };
		const seen = this.seen();
		for (const id of this.seededIds) seen.add(id);
		try {
			const res = await this.client.inbox(limit, { timeoutMs: 5_000 });
			if (this.identity !== identity) return { fresh: [], all: [] };
			this.lastInboxPending = 0;
			return { fresh: res.messages.filter((m) => !seen.has(m.message_id)), all: res.messages };
		} catch (e) {
			if (this.identity !== identity) return { fresh: [], all: [] };
			throw e;
		}
	}

	inboxMessage(fresh: Envelope[]): { customType: string; content: string; display: boolean; details: { message_ids: string[] } } {
		const content =
			`Team inbox: ${fresh.length} new message(s) for ${this.identity?.agent_id}. They are durable org messages delivered by the controller.\n\n` +
			fresh.map((m) => formatEnvelope(m)).join("\n\n---\n\n");
		return { customType: INBOX_MESSAGE, content, display: true, details: { message_ids: fresh.map((m) => m.message_id) } };
	}

	markInjected(fresh: Envelope[]): void {
		const seen = this.seen();
		for (const m of fresh) seen.add(m.message_id);
		if (seen.size > 5_000) for (const d of [...seen].slice(0, seen.size - 5_000)) seen.delete(d);
	}

	/** Ack every claimed ID (duplicates included). Failures are fine: redelivery is deduped. */
	async ack(all: Envelope[], identity: Identity | undefined = this.identity): Promise<void> {
		for (const m of all) {
			if (!identity || this.identity !== identity) return;
			try {
				await this.client.ack(m.message_id, { timeoutMs: 5_000 });
			} catch (e) {
				if (this.identity !== identity) return;
				if (this.handleAgentError(e, identity)) return;
			}
		}
	}

	/**
	 * Interactive/RPC delivery path: inject via pi.sendMessage, then ack.
	 * A human's session only receives them for the next turn unless triggerTurn is requested.
	 * (Managed one-shot workers use the before_agent_start / agent_before_settle paths instead.)
	 */
	async deliverInbox(o: { triggerTurn?: boolean } = {}): Promise<Envelope[]> {
		if (!this.identity || this.delivering) return [];
		const identity = this.identity;
		this.delivering = true;
		try {
			const { fresh, all } = await this.claimInbox();
			if (this.identity !== identity) return [];
			if (fresh.length) {
				const trigger = o.triggerTurn ?? false;
				this.pi.sendMessage(
					this.inboxMessage(fresh),
					trigger ? (this.idle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" }) : { deliverAs: "nextTurn" },
				);
				this.markInjected(fresh);
			}
			await this.ack(all, identity);
			if (this.identity !== identity) return [];
			return fresh;
		} catch (e) {
			this.handleAgentError(e, identity);
			return [];
		} finally {
			this.delivering = false;
		}
	}

	/**
	 * Managed one-shot worker, agent_before_settle: claim once; if there is new work, return it as a
	 * custom_message entry plus ONE continuation. Guarded: never on abort/error (note: Pi 1.4.0 reports
	 * context.canContinue=false at settle even though entries+continue work, so it is not used as a gate), or beyond MAX_SETTLE_CONTINUATIONS per process. Otherwise let Pi settle and exit.
	 */
	settleContinuations = 0;
	async onBeforeSettle(ev: { outcome?: string; context?: { canContinue?: boolean } }): Promise<
		{ entries: { type: "custom_message"; customType: string; content: string; display: boolean; details: unknown }[]; continue: true } | undefined
	> {
		if (!this.identity?.managed || this.persistentSession() || this.delivering) return undefined;
		if (ev.outcome && ev.outcome !== "completed") return undefined;
		if (this.settleContinuations >= MAX_SETTLE_CONTINUATIONS) return undefined;
		const identity = this.identity;
		this.delivering = true;
		try {
			const { fresh, all } = await this.claimInbox();
			if (this.identity !== identity) return undefined;
			if (!fresh.length) {
				void this.ack(all, identity);
				return undefined;
			}
			this.settleContinuations++;
			this.markInjected(fresh);
			// Ack after Pi has appended the entry (the continuation keeps the process alive).
			setTimeout(() => void this.ack(all, identity), 0);
			return { entries: [{ type: "custom_message", ...this.inboxMessage(fresh) }], continue: true };
		} catch (e) {
			this.handleAgentError(e, identity);
			return undefined;
		} finally {
			this.delivering = false;
		}
	}

	/** before_agent_start: messages already pending when a turn starts (human prompt, wake, or resume launch) ride along with it. */
	async inboxForRunStart(): Promise<ReturnType<TeamRuntime["inboxMessage"]> | undefined> {
		if (!this.identity || this.delivering) return undefined;
		if (!this.identity.managed && this.lastInboxPending <= 0) return undefined;
		const identity = this.identity;
		this.delivering = true;
		try {
			const { fresh, all } = await this.claimInbox();
			if (this.identity !== identity) return undefined;
			if (!fresh.length) {
				void this.ack(all, identity);
				return undefined;
			}
			this.markInjected(fresh);
			setTimeout(() => void this.ack(all, identity), 0);
			return this.inboxMessage(fresh);
		} catch (e) {
			this.handleAgentError(e, identity);
			return undefined;
		} finally {
			this.delivering = false;
		}
	}
}
