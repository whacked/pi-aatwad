// Typed controller client: HTTP/1.1 + JSON over the per-user Unix socket.
// Used by the Pi extension (under jiti) and by plain `node --test` tests, so it
// must stay erasable TypeScript with explicit .ts imports and zero npm deps.
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, fstatSync } from "node:fs";
import { basename } from "node:path";
import { matchesAgentWords } from "./agent-reference.ts";
import {
	ENV_STATE_DIR,
	HDR_IDEMPOTENCY,
	HDR_PROTOCOL,
	PROTOCOL_VERSION,
	SCHEMA_VERSION,
} from "./protocol.ts";
import type {
	ReportingRequest,
	ReportingStatus,
	ApiError,
	AttachRequest,
	AttachResponse,
	BudgetView,
	CreateExpansionRequest,
	CreateExpansionResponse,
	CreateRunRequest,
	CreateRunResponse,
	DecisionRequest,
	DecisionResponse,
	DelegateTaskRequest,
	DelegateTaskResponse,
	EnrollRequest,
	EnrollResponse,
	ErrorCode,
	EventView,
	HealthResponse,
	HeartbeatRequest,
	HeartbeatResponse,
	InboxResponse,
	InspectResponse,
	LifecycleRequest,
	LifecycleResponse,
	ModelsResponse,
	OrgContext,
	ProposalView,
	RecoveryStatus,
	RunSummary,
	SendMessageRequest,
	SendMessageResponse,
	TaskStatus,
	TreeResponse,
} from "./protocol.ts";
import { ensureStateDir } from "./paths.ts";
import type { StatePaths } from "./paths.ts";
import { controllerEntry } from "./paths.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Controller answered with an ApiError body (or a non-JSON error). */
export class TeamApiError extends Error {
	code: ErrorCode;
	status: number;
	details: unknown;
	constructor(code: ErrorCode, message: string, status: number, details?: unknown) {
		super(`${code}: ${message}`);
		this.name = "TeamApiError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

/** Socket missing / refused / reset: the controller is not (or no longer) reachable. */
export class ControllerUnavailableError extends Error {
	errno: string;
	constructor(message: string, errno: string) {
		super(message);
		this.name = "ControllerUnavailableError";
		this.errno = errno;
	}
}

/** A controller answered but speaks a different protocol/schema version. Never retried or replaced. */
export class ControllerIncompatibleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ControllerIncompatibleError";
	}
}

// Bun-backed standalone Pi uses FailedToOpenSocket instead of a POSIX errno.
const UNAVAILABLE_CODES = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTSOCK", "ETIMEDOUT_CONNECT", "FailedToOpenSocket"]);

export function isUnavailable(err: unknown): err is ControllerUnavailableError {
	return err instanceof ControllerUnavailableError;
}

// ---------------------------------------------------------------------------
// Raw request
// ---------------------------------------------------------------------------

export interface RawRequestOptions {
	body?: unknown;
	token?: string;
	idempotencyKey?: string;
	timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
/** Managed-worker reconnect backoff (~8s total). */
export const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];

/**
 * One HTTP request over the unix socket. POST requests always carry an idempotency key
 * (generated when the caller does not supply one). Resolves to the parsed 2xx JSON body.
 */
export function rawRequest<T>(socketPath: string, method: "GET" | "POST", path: string, opts: RawRequestOptions = {}): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const headers: Record<string, string> = {
			[HDR_PROTOCOL]: String(PROTOCOL_VERSION),
			accept: "application/json",
		};
		let payload: string | undefined;
		if (opts.token) headers.authorization = `Bearer ${opts.token}`;
		if (method === "POST") {
			headers[HDR_IDEMPOTENCY] = opts.idempotencyKey ?? randomUUID();
			payload = JSON.stringify(opts.body ?? {});
			headers["content-type"] = "application/json";
			headers["content-length"] = String(Buffer.byteLength(payload));
		}
		let settled = false;
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};
		const req = httpRequest({ socketPath, method, path, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("error", (e) => done(() => reject(new ControllerUnavailableError(`controller connection error: ${e.message}`, "ECONNRESET"))));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let parsed: unknown = undefined;
				try {
					parsed = text ? JSON.parse(text) : {};
				} catch {
					parsed = undefined;
				}
				const status = res.statusCode ?? 0;
				if (status >= 200 && status < 300) {
					if (parsed === undefined) {
						done(() => reject(new TeamApiError("INTERNAL", `controller returned non-JSON body for ${method} ${path}`, status)));
					} else {
						done(() => resolve(parsed as T));
					}
					return;
				}
				const apiErr = parsed as ApiError | undefined;
				if (apiErr && typeof apiErr === "object" && apiErr.error && typeof apiErr.error.code === "string") {
					done(() => reject(new TeamApiError(apiErr.error.code, apiErr.error.message ?? "", status, apiErr.error.details)));
				} else {
					const code: ErrorCode = status === 426 ? "PROTOCOL_MISMATCH" : status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : "INTERNAL";
					done(() => reject(new TeamApiError(code, `HTTP ${status} for ${method} ${path}${text ? `: ${text.slice(0, 200)}` : ""}`, status)));
				}
			});
		});
		req.setTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
			req.destroy(new Error("__timeout__"));
		});
		req.on("error", (e: NodeJS.ErrnoException) => {
			if (e.message === "__timeout__") {
				done(() => reject(new ControllerUnavailableError(`controller did not answer ${method} ${path} within ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, "ETIMEDOUT")));
				return;
			}
			const errno = e.code ?? "EUNKNOWN";
			if (UNAVAILABLE_CODES.has(errno)) {
				done(() => reject(new ControllerUnavailableError(`controller not reachable at ${socketPath} (${errno})`, errno)));
			} else {
				done(() => reject(e));
			}
		});
		if (payload !== undefined) req.write(payload);
		req.end();
	}).catch(async (error: unknown) => {
		// Some runtimes throw during request construction instead of emitting error.
		const errno = (error as NodeJS.ErrnoException | null)?.code;
		if (errno && UNAVAILABLE_CODES.has(errno)) {
			throw new ControllerUnavailableError(`controller not reachable at ${socketPath} (${errno})`, errno);
		}
		// Standalone Pi's Bun runtime can lose the Unix-socket errno in its
		// HTTP bridge. Verify via net rather than treating every URL error as
		// permission to start a controller. This also covers synchronous throws.
		if (error instanceof Error && error.message.includes("Was there a typo in the url or port?")) {
			await probeSocket(socketPath, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		}
		throw error;
	});
}

/** Recover a real connection errno when the HTTP runtime has hidden it. */
function probeSocket(socketPath: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect({ path: socketPath });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new ControllerUnavailableError(`controller connection timed out at ${socketPath}`, "ETIMEDOUT"));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve();
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			socket.destroy();
			const errno = error.code ?? "EUNKNOWN";
			reject(UNAVAILABLE_CODES.has(errno)
				? new ControllerUnavailableError(`controller not reachable at ${socketPath} (${errno})`, errno)
				: error);
		});
	});
}

// ---------------------------------------------------------------------------
// Controller bootstrap
// ---------------------------------------------------------------------------

export interface EnsureOptions {
	/** Script to launch; default controllerEntry(). Tests point this at a fake controller. */
	entry?: string;
	/** Executable for the controller; default: node (process.execPath when it is node). */
	nodePath?: string;
	/** Total readiness budget after spawning. Default 10s. */
	readyTimeoutMs?: number;
	/** Timeout for a single /health ping. */
	pingTimeoutMs?: number;
	/** Extra env for the spawned controller. */
	env?: Record<string, string>;
}

export interface EnsureResult {
	health: HealthResponse;
	spawned: boolean;
}

/** Shared across module instances in one process (jiti re-imports on /reload). */
function inflightMap(): Map<string, Promise<EnsureResult>> {
	const key = Symbol.for("pi-recursive-team.ensureController.inflight");
	const g = globalThis as unknown as Record<symbol, Map<string, Promise<EnsureResult>> | undefined>;
	let m = g[key];
	if (!m) {
		m = new Map();
		g[key] = m;
	}
	return m;
}

/** Count of controller spawns attempted by this process (diagnostics + tests). */
export function spawnCount(): number {
	const g = globalThis as unknown as Record<symbol, number | undefined>;
	return g[Symbol.for("pi-recursive-team.spawnCount")] ?? 0;
}
function bumpSpawnCount(): void {
	const g = globalThis as unknown as Record<symbol, number | undefined>;
	const k = Symbol.for("pi-recursive-team.spawnCount");
	g[k] = (g[k] ?? 0) + 1;
}

function checkCompatible(h: HealthResponse, socket: string): HealthResponse {
	if (h.protocol !== PROTOCOL_VERSION || h.schema !== SCHEMA_VERSION) {
		throw new ControllerIncompatibleError(
			`controller at ${socket} (pid ${h.pid}) speaks protocol ${h.protocol}/schema ${h.schema}, this extension needs protocol ${PROTOCOL_VERSION}/schema ${SCHEMA_VERSION}. ` +
				`Stop the old controller (/team stop or POST /controller/shutdown) after its workers finish, or upgrade/downgrade the package so both match.`,
		);
	}
	return h;
}

/** GET /health. Resolves to health, throws ControllerUnavailableError if nothing answers, ControllerIncompatibleError on version mismatch. */
export async function ping(paths: StatePaths, timeoutMs = 2_000): Promise<HealthResponse> {
	try {
		const h = await rawRequest<HealthResponse>(paths.socket, "GET", "/health", { timeoutMs });
		return checkCompatible(h, paths.socket);
	} catch (e) {
		if (e instanceof TeamApiError && e.code === "PROTOCOL_MISMATCH") {
			throw new ControllerIncompatibleError(`controller at ${paths.socket} rejected protocol ${PROTOCOL_VERSION}: ${e.message}`);
		}
		throw e;
	}
}

function resolveNode(override?: string): string {
	if (override) return override;
	const exe = basename(process.execPath).toLowerCase();
	// Inside Pi, execPath is node when Pi runs on Node; if Pi is a compiled/bun binary fall back to PATH.
	if (/^node(\.exe)?$/.test(exe) && !("bun" in process.versions)) return process.execPath;
	return "node";
}

function nodeArgsFor(entry: string): string[] {
	const [maj, min] = process.versions.node.split(".").map(Number);
	const args: string[] = [];
	if (maj === 22 && min < 18) args.push("--experimental-strip-types");
	args.push("--disable-warning=ExperimentalWarning", entry);
	return args;
}

function tailFile(path: string, bytes = 2_000): string {
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			const len = Math.min(bytes, size);
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, size - len);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function ensureOnce(paths: StatePaths, opts: EnsureOptions): Promise<EnsureResult> {
	const pingTimeout = opts.pingTimeoutMs ?? 2_000;
	try {
		return { health: await ping(paths, pingTimeout), spawned: false };
	} catch (e) {
		if (!isUnavailable(e)) throw e;
	}
	// Nothing answered: launch a controller. It owns lock/socket/singleton logic and exits quietly
	// if another instance holds the lock, in which case we simply keep polling the winner.
	ensureStateDir(paths);
	const entry = opts.entry ?? controllerEntry();
	const logFd = openSync(paths.log, "a", 0o600);
	let exitInfo: string | undefined;
	let failedExit = false;
	try {
		const child = spawn(resolveNode(opts.nodePath), nodeArgsFor(entry), {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: { ...process.env, ...opts.env, [ENV_STATE_DIR]: paths.dir },
			cwd: paths.dir,
		});
		bumpSpawnCount();
		child.on("error", (err) => {
			exitInfo = `spawn error: ${err.message}`;
			failedExit = true;
		});
		child.on("exit", (code, signal) => {
			exitInfo = `controller process exited (code ${code}${signal ? `, signal ${signal}` : ""})`;
			// code 0 = lost the singleton race to another instance: keep polling the winner.
			if (code !== 0) failedExit = true;
		});
		child.unref();
	} finally {
		closeSync(logFd);
	}
	const deadline = Date.now() + (opts.readyTimeoutMs ?? 10_000);
	let delay = 50;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
		delay = Math.min(delay * 2, 500);
		try {
			return { health: await ping(paths, pingTimeout), spawned: true };
		} catch (e) {
			if (!isUnavailable(e)) throw e;
			lastErr = e;
		}
		if (failedExit) break;
	}
	const tail = tailFile(paths.log).trim();
	throw new ControllerUnavailableError(
		(failedExit ? `controller failed to start at ${paths.socket}` : `controller did not become ready within ${opts.readyTimeoutMs ?? 10_000}ms at ${paths.socket}`) +
			(exitInfo ? `; ${exitInfo}` : "") +
			(lastErr instanceof Error ? `; last error: ${lastErr.message}` : "") +
			(tail ? `\n--- ${paths.log} (tail) ---\n${tail}` : ""),
		"ENOTREADY",
	);
}

/**
 * Discover or start the singleton controller for `paths`. Concurrent callers in one process share
 * one in-flight attempt (=> at most one spawn per process). Once settled, the next call pings again,
 * so a healthy controller is never re-spawned (e.g. on /reload) and a dead one is restarted.
 */
export function ensureController(paths: StatePaths, opts: EnsureOptions = {}): Promise<EnsureResult> {
	const m = inflightMap();
	const existing = m.get(paths.socket);
	if (existing) return existing;
	const p = ensureOnce(paths, opts).finally(() => {
		if (m.get(paths.socket) === p) m.delete(paths.socket);
	});
	m.set(paths.socket, p);
	return p;
}

/** Read the operator token, waiting for the controller to create it after first start. */
export async function readOperatorToken(paths: StatePaths, waitMs = 5_000): Promise<string> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (existsSync(paths.operatorToken)) {
			const t = readFileSync(paths.operatorToken, "utf8").trim();
			if (t) return t;
		}
		if (Date.now() >= deadline) {
			throw new Error(`operator token not found at ${paths.operatorToken} (is the controller running for state dir ${paths.dir}?)`);
		}
		await sleep(50);
	}
}

// ---------------------------------------------------------------------------
// Typed client
// ---------------------------------------------------------------------------

export interface CallOptions {
	/** Stable key so retries of the same logical operation are deduplicated by the controller. */
	idempotencyKey?: string;
	timeoutMs?: number;
	/** Override the bearer for this call (e.g. operator token for /runs). */
	token?: string;
}

export interface TeamClientOptions {
	paths: StatePaths;
	/** Default bearer, evaluated per call (agent session token when enrolled). */
	token?: () => string | undefined;
	ensure?: EnsureOptions;
	/** Called after a reconnect (controller was restarted) — lets the UI notice. */
	onReconnect?: (r: EnsureResult) => void;
	/** Disable auto ensure+retry (tests). */
	noReconnect?: boolean;
	/** Evaluated at failure time; false suppresses ensure+retry (e.g. after session_shutdown). */
	shouldReconnect?: () => boolean;
	/**
	 * "ensure" (default): on unavailable, ensureController() then retry once.
	 * "retry": NEVER ensure/spawn; retry with backoff (managed workers: the controller launched us,
	 * and they must not touch the state dir).
	 */
	reconnect?: "ensure" | "retry";
	/** Backoff schedule for reconnect "retry". */
	retryDelaysMs?: number[];
}

export type CompleteStatus = Extract<TaskStatus, "DONE" | "FAILED" | "BLOCKED">;

function q(params: Record<string, string | number | undefined>): string {
	const s = Object.entries(params)
		.filter(([, v]) => v !== undefined && v !== "")
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
		.join("&");
	return s ? `?${s}` : "";
}
const enc = encodeURIComponent;

export class TeamClient {
	paths: StatePaths;
	opts: TeamClientOptions;
	constructor(opts: TeamClientOptions) {
		this.opts = opts;
		this.paths = opts.paths;
	}

	/**
	 * Perform a call. On "controller unavailable" (socket missing/refused/reset) it runs
	 * ensureController() and retries exactly once, reusing the same idempotency key.
	 */
	async call<T>(method: "GET" | "POST", path: string, body?: unknown, o: CallOptions = {}): Promise<T> {
		const idempotencyKey = method === "POST" ? (o.idempotencyKey ?? randomUUID()) : undefined;
		const send = () =>
			rawRequest<T>(this.paths.socket, method, path, {
				body,
				token: o.token ?? this.opts.token?.(),
				idempotencyKey,
				timeoutMs: o.timeoutMs,
			});
		try {
			return await send();
		} catch (e) {
			if (!isUnavailable(e) || this.opts.noReconnect || this.opts.shouldReconnect?.() === false) throw e;
			if (this.opts.reconnect === "retry") {
				let last: unknown = e;
				for (const d of this.opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS) {
					await sleep(d);
					if (this.opts.shouldReconnect?.() === false) break;
					try {
						return await send();
					} catch (e2) {
						if (!isUnavailable(e2)) throw e2;
						last = e2;
					}
				}
				throw last;
			}
			const r = await ensureController(this.paths, this.opts.ensure);
			this.opts.onReconnect?.(r);
			return await send();
		}
	}

	get<T>(path: string, o?: CallOptions): Promise<T> {
		return this.call<T>("GET", path, undefined, o);
	}
	post<T>(path: string, body: unknown, o?: CallOptions): Promise<T> {
		return this.call<T>("POST", path, body, o);
	}

	health(): Promise<HealthResponse> {
		return this.get<HealthResponse>("/health");
	}
	// operator
	createRun(req: CreateRunRequest, o: CallOptions): Promise<CreateRunResponse> {
		return this.post("/runs", req, o);
	}
	listRuns(o: CallOptions): Promise<{ runs: RunSummary[] }> {
		return this.get("/runs", o);
	}
	attach(runId: string, req: AttachRequest, o: CallOptions): Promise<AttachResponse> {
		return this.post(`/runs/${enc(runId)}/attach`, req, o);
	}
	recovery(runId: string, o: CallOptions): Promise<RecoveryStatus> {
		return this.get(`/runs/${enc(runId)}/recovery`, o);
	}
	shutdown(force: boolean, o: CallOptions): Promise<{ stopping: true }> {
		return this.post("/controller/shutdown", { force }, o);
	}
	reporting(runId: string, history = false, o?: CallOptions): Promise<ReportingStatus> {
		return this.get(`/runs/${enc(runId)}/reporting${history ? "?history=1" : ""}`, o);
	}
	setReporting(runId: string, req: ReportingRequest, o?: CallOptions): Promise<ReportingStatus> {
		return this.post(`/runs/${enc(runId)}/reporting`, req, o);
	}
	// enrollment (no bearer)
	enroll(req: EnrollRequest, o: CallOptions = {}): Promise<EnrollResponse> {
		return this.post("/enroll", req, { ...o, token: "" });
	}
	// agent
	heartbeat(req: HeartbeatRequest, o?: CallOptions): Promise<HeartbeatResponse> {
		return this.post("/sessions/heartbeat", req, o);
	}
	me(o?: CallOptions): Promise<OrgContext> {
		return this.get("/me", o);
	}
	tree(runId: string, o?: CallOptions, activeOnly = false): Promise<TreeResponse> {
		return this.get(`/runs/${enc(runId)}/tree${activeOnly ? "?active_only=1" : ""}`, o);
	}
	/** Resolve exact names or unique whole-word ID references within a run; full IDs need no run. */
	async resolveAgent(ref: string, runId?: string, o?: CallOptions): Promise<string> {
		// Preserve exact-ID routing (including cross-team IDs) for both saved hex and new word IDs.
		if (/^agent-(?:[0-9a-f]{16}|[a-z]+(?:-[a-z]+){5})$/i.test(ref) || ref === "controller") return ref;
		if (!runId) throw new Error("Agent names and short IDs require an attached team; use /team resume or a full agent ID");
		const t = await this.tree(runId, o);
		const flat = (n: TreeResponse["root"]): TreeResponse["root"][] => [n, ...n.children.flatMap(flat)];
		const nodes = flat(t.root);
		if (nodes.some((n) => n.agent_id === ref)) return ref;
		const matches = nodes.filter((n) => n.role.trim().toLowerCase() === ref.trim().toLowerCase());
		const active = matches.filter((n) => !["CANCELLED", "COMPLETED", "FAILED", "RETIRED"].includes(n.status));
		// Exact names retain active-replacement semantics. ID aliases must be
		// unambiguous across all members, so lifecycle changes cannot silently retarget them.
		const candidates = matches.length ? (active.length ? active : matches) : nodes.filter((n) => matchesAgentWords(n.agent_id, ref));
		if (candidates.length === 1) return candidates[0].agent_id;
		if (candidates.length > 1) throw new Error(`Ambiguous agent reference '${ref}'; use more ID words or a full ID: ${candidates.map((n) => `${n.role} [${n.agent_id}]`).join(", ")}`);
		throw new Error(`No agent named '${ref}' or matching those ID words in this team. Use /team tree to see names and IDs.`);
	}

	sendMessage(req: SendMessageRequest, o?: CallOptions): Promise<SendMessageResponse> {
		return this.post("/messages", req, o);
	}
	inbox(limit?: number, o?: CallOptions): Promise<InboxResponse> {
		return this.get(`/inbox${q({ limit })}`, o);
	}
	ack(messageId: string, o?: CallOptions): Promise<{ acked: true }> {
		return this.post(`/messages/${enc(messageId)}/ack`, {}, { idempotencyKey: `ack:${messageId}`, ...o });
	}
	delegateTask(req: DelegateTaskRequest, o?: CallOptions): Promise<DelegateTaskResponse> {
		return this.post("/tasks", req, o);
	}
	reportProgress(taskId: string, note: string, o?: CallOptions): Promise<unknown> {
		return this.post(`/tasks/${enc(taskId)}/progress`, { note }, o);
	}
	completeTask(
		taskId: string,
		body: { summary: string; status?: CompleteStatus; artifacts?: { kind: string; uri: string; sha256?: string }[] },
		o?: CallOptions,
	): Promise<unknown> {
		return this.post(`/tasks/${enc(taskId)}/complete`, body, o);
	}
	requestExpansion(req: CreateExpansionRequest, o?: CallOptions): Promise<CreateExpansionResponse> {
		return this.post("/expansions", req, o);
	}
	decideExpansion(proposalId: string, req: DecisionRequest, o?: CallOptions): Promise<DecisionResponse> {
		return this.post(`/expansions/${enc(proposalId)}/decision`, req, o);
	}
	proposals(scope: "review" | "mine", o?: CallOptions): Promise<{ proposals: ProposalView[] }> {
		return this.get(`/proposals${q({ scope })}`, o);
	}
	models(o?: CallOptions): Promise<ModelsResponse> {
		return this.get("/models", o);
	}
	budget(agentId: string, o?: CallOptions): Promise<BudgetView> {
		return this.get(`/budgets/${enc(agentId)}`, o);
	}
	events(params: { run_id?: string; after?: number; limit?: number }, o?: CallOptions): Promise<{ events: EventView[] }> {
		return this.get(`/events${q(params)}`, o);
	}
	inspect(agentId: string, o?: CallOptions): Promise<InspectResponse> {
		return this.get(`/agents/${enc(agentId)}`, o);
	}
	lifecycle(agentId: string, req: LifecycleRequest, o?: CallOptions): Promise<LifecycleResponse> {
		return this.post(`/agents/${enc(agentId)}/lifecycle`, req, o);
	}
}
