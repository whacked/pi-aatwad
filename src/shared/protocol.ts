// Wire contract between the Pi extension (client) and the local controller.
// Single source of truth: controller and extension both import from here.
// Erasable TypeScript only (runs under Node type stripping and under Pi's jiti).

export const PROTOCOL_VERSION = 1;
/** Number of applied SQL migrations (db/001, db/002, ...). */
export const SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
// HTTP/1.1 + JSON over a per-user Unix domain socket (see paths.ts).
// Request headers:
//   x-team-protocol: <PROTOCOL_VERSION>      required on every request; mismatch -> 426 PROTOCOL_MISMATCH
//   authorization: Bearer <token>            operator token OR agent session token (see Auth)
//   idempotency-key: <opaque string>         required on every mutating request (POST)
// Every response body is JSON: either the result object (2xx) or ApiError (4xx/5xx).

export const HDR_PROTOCOL = "x-team-protocol";
export const HDR_IDEMPOTENCY = "idempotency-key";

export type ErrorCode =
	| "PROTOCOL_MISMATCH"
	| "UNAUTHENTICATED"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "INVALID" // schema/validation failure
	| "CONFLICT" // state-machine violation, stale topology version, cycle, etc.
	| "IDEMPOTENCY_MISMATCH" // same key reused with different payload
	| "BUDGET_EXCEEDED"
	| "HARD_CAP"
	| "STALE_SESSION" // fenced session attempt
	| "INTERNAL";

/**
 * HTTP status per error code. Clients should branch on `error.code`, not on the status
 * (several codes share 401 / 409).
 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
	PROTOCOL_MISMATCH: 426,
	UNAUTHENTICATED: 401,
	STALE_SESSION: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	INVALID: 400,
	CONFLICT: 409,
	IDEMPOTENCY_MISMATCH: 409,
	BUDGET_EXCEEDED: 409,
	HARD_CAP: 409,
	INTERNAL: 500,
};

/** Well-known fields of ApiError.error.details (all optional; other fields may appear). */
export interface ApiErrorDetails {
	/** FORBIDDEN (per-decision grant exceeded) / BUDGET_EXCEEDED at the reviewer: escalating may help. */
	hint?: "ESCALATE";
	/** CONFLICT on a decision by a stale reviewer: the proposal was returned (PENDING) to this reviewer. */
	new_reviewer_id?: string;
	/** HARD_CAP: violated global caps; the proposal is already REJECTED (audited). */
	violations?: string[];
	proposal_status?: ProposalStatus;
	/** BUDGET_EXCEEDED: the ancestor whose subtree envelope would be exceeded. */
	agent_id?: string;
	max_grant_slots?: number;
	max_grant_usd?: number;
	/** INVALID (schema): individual validation messages. */
	errors?: string[];
	[k: string]: unknown;
}

export interface ApiError {
	error: { code: ErrorCode; message: string; details?: ApiErrorDetails | unknown };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
// Two principal kinds:
//  * operator: the local OS user. Proven by presenting the contents of
//    <stateDir>/operator.token (0600, created by the controller on first start).
//    Operator may create runs, attach/resume roots, stop anything, read anything.
//  * agent session: bearer token minted by the controller for exactly one
//    (agent_id, session_id, generation). Obtained by
//      - POST /runs (root bootstrap, operator)            -> returns root session token
//      - POST /runs/:id/attach (operator)                 -> new session attempt for root (or any agent) token
//      - POST /enroll (one-time enrollment credential)    -> managed child session token
//    Tokens are fenced: creating a new session attempt for an agent revokes older ones (STALE_SESSION).
//    Actor identity always comes from the token, never from request bodies.
//
// Enrollment: the controller writes a one-time credential into a 0600 file and
// passes its path to the child Pi via env PI_TEAM_ENROLL_FILE (never argv).
// The child extension reads + deletes the file, then calls POST /enroll.
// Credential expires after ENROLL_TTL_MS and is single-use.

export const ENV_ENROLL_FILE = "PI_TEAM_ENROLL_FILE";
/** Overrides the state directory (tests, demo). */
export const ENV_STATE_DIR = "PI_TEAM_STATE_DIR";
/** Overrides the executor used for workers: "pi" (default) or path to a node script (tests). */
export const ENV_EXECUTOR = "PI_TEAM_EXECUTOR";
export const ENROLL_TTL_MS = 10 * 60_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_LEASE_MS = 45_000;

export interface EnrollmentFile {
	version: 1;
	socket_path: string;
	run_id: string;
	agent_id: string;
	spawn_intent_id: string;
	token: string; // one-time enrollment secret
	expires_at: string; // ISO
}

// ---------------------------------------------------------------------------
// Domain enums (mirror db/*.sql)
// ---------------------------------------------------------------------------

export type RunStatus = "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";
export type AgentStatus = "PROVISIONING" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED" | "RETIRED";
export type DesiredState = "RUNNING" | "PAUSED" | "RETIRED";
export type ObservedState = "STARTING" | "LIVE" | "LOST" | "STOPPED" | "FAILED";
export type SessionStatus = "REQUESTED" | "STARTING" | "LIVE" | "STOPPED" | "FAILED" | "LOST";
export type TaskStatus = "OPEN" | "ASSIGNED" | "IN_PROGRESS" | "DONE" | "BLOCKED" | "FAILED" | "CANCELLED";
export type ProposalStatus = "PENDING" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "ESCALATED";
export type Decision = "APPROVE" | "REJECT" | "AMEND" | "ESCALATE";
export type DeliveryStatus = "PENDING" | "CLAIMED" | "ACKED";
export type SpawnIntentStatus = "PENDING" | "LAUNCHING" | "LAUNCHED" | "LIVE" | "FAILED" | "CANCELLED";
export type PendingWorkPolicy = "retain" | "reassign" | "pause";
export type LifecycleAction = "pause" | "resume" | "retire" | "cancel";
export type ChildrenPolicy = "cascade" | "transfer_children_to" | "pause_subtree";

export const MESSAGE_TYPES = [
	"task.assigned",
	"task.progress",
	"task.completed",
	"question",
	"answer",
	"team.expand.request",
	"team.expand.decision",
	"agent.lifecycle",
	"system.notice",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

// ---------------------------------------------------------------------------
// Contracts (JSON schemas in contracts/*.schema.json are authoritative)
// ---------------------------------------------------------------------------

export interface Envelope {
	version: 1;
	message_id: string;
	run_id: string;
	type: MessageType;
	from: string;
	to: string;
	correlation_id?: string;
	causation_id?: string;
	deadline?: string;
	payload: Record<string, unknown>;
}

export interface ExpansionRole {
	title: string;
	responsibility: string;
	count: number;
	capabilities: string[];
	preferred_model_id?: string;
	max_cost_usd: number;
	max_runtime_seconds?: number;
}

export interface ExpansionProposal {
	version: 1;
	run_id: string;
	requester_id: string;
	task_id: string;
	reason: string;
	alternatives: string;
	estimated_cost_usd: number;
	max_runtime_seconds?: number;
	roles: ExpansionRole[];
}

// ---------------------------------------------------------------------------
// Config / policy
// ---------------------------------------------------------------------------

export interface ModelCatalogEntry {
	id: string; // logical catalog id, e.g. "economy-coder"
	provider: string; // pi provider name
	model: string; // pi model id (passed as --provider/--model)
	capability_tags: string[];
	tool_support: boolean;
	context_window?: number;
	cost_per_m_input_usd: number | null;
	cost_per_m_output_usd: number | null;
	latency_class?: "fast" | "medium" | "slow";
	availability: "available" | "unavailable";
}

export interface GlobalLimits {
	max_live_agents: number;
	max_pending_spawns: number;
	emergency_max_depth: number;
	max_run_usd: number;
	max_run_seconds: number;
	max_agent_seconds: number;
	allow_providers: string[];
}

/** Delegated envelope of one agent (allocations.limits_json). Ceilings. */
export interface Envelope_Limits {
	max_subtree_slots: number; // live descendants this agent's subtree may hold
	max_subtree_usd: number; // spend ceiling for the whole subtree (incl. self)
	max_session_seconds: number;
	max_grant_slots: number; // most slots it may approve in a single decision without escalation
	max_grant_usd: number; // most usd it may approve in a single decision without escalation
	allowed_providers: string[];
	allowed_capabilities: string[]; // empty = any
}

/**
 * Model catalog conventions:
 *  - The controller always adds an entry with id LEADER_MODEL_ID mirroring the root's own provider/model
 *    ("same model as leader"), and adds that provider to limits.allow_providers.
 *  - If /team init reported no provider/model, both are DEFAULT_PROVIDER ("default"): the executor must then
 *    omit --provider/--model and let Pi use its configured default.
 *  - Null costs rank as 0 (selection) and the choice is flagged `cost_estimated` in agent metadata.
 */
export const LEADER_MODEL_ID = "leader";
export const DEFAULT_PROVIDER = "default";

/** What happens to an agent whose runtime deadline expires (see RunConfig.deadline_policy). */
export type DeadlinePolicy = "BLOCKED" | "FAILED";

export interface RunConfig {
	limits: GlobalLimits;
	models: ModelCatalogEntry[];
	root_envelope: Envelope_Limits;
	/** What happens to descendants when the root session is lost. */
	root_failure_policy: "continue" | "pause_subtree";
	workspace_root: string; // absolute; workers get dirs/worktrees under <workspace_root>/.team-worktrees/
	/**
	 * Runtime deadline handling (envelope.max_session_seconds per session attempt; role/proposal
	 * max_runtime_seconds across all attempts). Default "BLOCKED": process stopped, open tasks BLOCKED,
	 * agent PAUSED (resumable). "FAILED": process stopped, open tasks FAILED, agent FAILED, reservations released.
	 */
	deadline_policy?: DeadlinePolicy;
}

// ---------------------------------------------------------------------------
// API: request/response shapes
// ---------------------------------------------------------------------------

/** GET /health (no auth needed, protocol header still required) */
export interface HealthResponse {
	ok: true;
	protocol: number;
	schema: number;
	controller_id: string;
	fencing_epoch: number;
	pid: number;
	started_at: string;
	state_dir: string;
	live_workers: number;
}

/** POST /runs (operator). Explicit /team init. */
export interface CreateRunRequest {
	config?: Partial<RunConfig>; // merged over defaults
	root: { role: string; pi_session_id?: string; pi_session_path?: string; cwd: string; provider?: string; model?: string };
}
export interface CreateRunResponse {
	run_id: string;
	root_agent_id: string;
	session_id: string;
	token: string;
	envelope: Envelope_Limits;
}

/** GET /runs (operator) -> RunListResponse */
export interface RunListResponse {
	runs: RunSummary[];
}
export interface RunSummary {
	run_id: string;
	status: RunStatus;
	root_agent_id: string;
	created_at: string;
	topology_version: number;
	agents: number;
}

/** POST /runs/:id/attach (operator). Explicit /team resume. New session attempt; fences the old one. */
export interface AttachRequest {
	agent_id?: string; // default: run root
	pi_session_id?: string;
	pi_session_path?: string;
	/** "attach" = become this agent; "fork" = create a new agent reporting to agent_id's manager (requires approval -> not in v1, returns FORBIDDEN) */
	mode?: "attach";
}
export interface AttachResponse {
	run_id: string;
	agent_id: string;
	session_id: string;
	token: string;
}

/** POST /enroll (no bearer; one-time credential in body) */
export interface EnrollRequest {
	token: string;
	agent_id: string;
	spawn_intent_id: string;
	pi_session_id?: string;
	pi_session_path?: string;
	pid: number;
	process_started_at?: string;
	/** From env PI_TEAM_LAUNCH_TOKEN; controller matches it against the launched process identity. */
	launch_token?: string;
}
export interface EnrollResponse {
	run_id: string;
	agent_id: string;
	session_id: string;
	token: string;
	parent_id: string | null;
	task_id: string | null;
}

/** POST /sessions/heartbeat (agent). Renews lease. Returns pending-work hints. */
export interface HeartbeatRequest {
	busy?: boolean;
	pi_session_id?: string;
	pi_session_path?: string;
	last_entry_id?: string;
}
export interface HeartbeatResponse {
	lease_until: string;
	inbox_pending: number;
	desired_state: DesiredState;
}

/** GET /me (agent) - who am I + effective org context (bounded, fresh from SQLite). */
export interface OrgContext {
	run_id: string;
	agent_id: string;
	session_id: string;
	role: string;
	is_root: boolean;
	parent: { agent_id: string; role: string } | null;
	children: { agent_id: string; role: string; status: AgentStatus; observed_state: ObservedState }[];
	/** Live agents with the same manager. Messageable directly (team_send_message). */
	peers?: { agent_id: string; role: string; status: AgentStatus; observed_state: ObservedState }[];
	tasks: { task_id: string; title: string; status: TaskStatus; parent_task_id: string | null }[];
	envelope: Envelope_Limits;
	budget: BudgetView;
	pending_proposals_to_review: number;
	inbox_pending: number;
	desired_state: DesiredState;
	topology_version: number;
}

export interface TreeNode {
	agent_id: string;
	role: string;
	status: AgentStatus;
	desired_state: DesiredState;
	observed_state: ObservedState;
	model: string | null;
	parent_id: string | null;
	children: TreeNode[];
}
/** GET /runs/:id/tree */
export interface TreeResponse {
	run_id: string;
	topology_version: number;
	root: TreeNode;
	history: { child_id: string; parent_id: string; valid_from: string; valid_to: string | null }[];
}

/** POST /messages (agent). Body is the envelope minus server-assigned fields. `from` is ignored/overwritten by actor. */
export interface SendMessageRequest {
	to: string;
	type: MessageType;
	payload: Record<string, unknown>;
	correlation_id?: string;
	causation_id?: string;
	deadline?: string;
}
export interface SendMessageResponse {
	message_id: string;
}

/** GET /inbox?limit=  (agent; own inbox only). Claims deliveries with a lease. */
export interface InboxResponse {
	messages: Envelope[];
}
/** POST /messages/:id/ack (agent; recipient only) -> { acked: true } */

/** POST /tasks (agent). Delegate to a direct report (or self when parent_task_id is own task). */
export interface DelegateTaskRequest {
	owner_id: string;
	title: string;
	spec?: Record<string, unknown>;
	parent_task_id?: string;
}
export interface DelegateTaskResponse {
	task_id: string;
	message_id: string;
}
/** POST /tasks/:id/progress (agent; task owner). Sends task.progress to the owner's manager. */
export interface TaskProgressRequest {
	note: string;
}
export interface TaskProgressResponse {
	task_id: string;
	status: "IN_PROGRESS";
	message_id: string | null; // null when the owner has no manager (root)
}
/** Artifact reference. File paths (relative or file:) must stay inside the run's workspace_root; other URI schemes (git:, https:) pass. */
export interface ArtifactRef {
	kind: string;
	uri: string;
	sha256?: string;
}
/** POST /tasks/:id/complete (agent; task owner). Sends task.completed to the owner's manager. */
export interface TaskCompleteRequest {
	summary: string;
	artifacts?: ArtifactRef[];
	status?: "DONE" | "FAILED" | "BLOCKED";
}
export interface TaskCompleteResponse {
	task_id: string;
	status: "DONE" | "FAILED" | "BLOCKED";
	message_id: string | null;
	artifact_ids: string[];
}
/** POST /messages/:id/ack (agent; recipient). Duplicate acks are harmless. */
export interface AckResponse {
	acked: true;
}

/** POST /expansions (agent). Body is ExpansionProposal minus requester_id/run_id (taken from actor). */
export type CreateExpansionRequest = Omit<ExpansionProposal, "requester_id" | "run_id">;
export interface CreateExpansionResponse {
	proposal_id: string;
	status: ProposalStatus;
	/** Nearest non-terminal manager (the root reviews its own); null = operator review (no live manager). */
	reviewer_id: string | null;
}

/** POST /expansions/:id/decision (agent = current reviewer). */
export interface DecisionRequest {
	decision: Decision;
	reason: string;
	/** AMEND only: replacement roles (new revision, returns to PENDING with requester). */
	amended_roles?: ExpansionRole[];
	/** ESCALATE: optional raised grant asked from reviewer's manager. */
	expected_topology_version?: number;
}
export interface DecisionResponse {
	proposal_id: string;
	status: ProposalStatus;
	revision: number;
	spawned_agent_ids: string[]; // agents created in PROVISIONING (spawn queued) on APPROVE
	reviewer_id: string | null; // next reviewer when ESCALATED
}

/**
 * GET /proposals?scope=review|mine (agent) -> ProposalListResponse.
 * Operator: scope=all (default, optional run_id=) or scope=review (proposals escalated past the root, reviewer_id null).
 */
export interface ProposalListResponse {
	proposals: ProposalView[];
}
export interface ProposalView {
	proposal_id: string;
	requester_id: string;
	reviewer_id: string | null;
	status: ProposalStatus;
	revision: number;
	request: ExpansionProposal;
	/** "WITHDRAW" is recorded by the controller (attributed to the run root) when the requester is terminated. */
	decisions: { reviewer_id: string; decision: Decision | "WITHDRAW"; reason: string; revision: number; created_at: string }[];
}

/** POST /agents/:id/reparent (agent with authority over both scopes, or operator) */
export interface ReparentRequest {
	new_parent_id: string;
	expected_topology_version: number;
	reason: string;
	pending_work_policy: PendingWorkPolicy;
	/** default true: subtree moves with the agent. false requires children_policy. */
	move_subtree?: boolean;
	children_policy?: { kind: "transfer_children_to"; agent_id: string };
}
export interface ReparentResponse {
	agent_id: string;
	old_parent_id: string;
	new_parent_id: string;
	topology_version: number;
}

/** POST /agents/:id/lifecycle (manager-in-scope or operator) */
export interface LifecycleRequest {
	action: LifecycleAction;
	reason: string;
	children_policy?: ChildrenPolicy;
	transfer_children_to?: string;
	/** Required when transfer_children_to actually moves children (optimistic topology check; CONFLICT if stale). */
	expected_topology_version?: number;
}
export interface LifecycleResponse {
	agent_id: string;
	status: AgentStatus;
	desired_state: DesiredState;
	affected_agent_ids: string[];
}

/** GET /budgets/:agent_id (self or ancestor or operator) */
export interface BudgetView {
	agent_id: string;
	limits: Envelope_Limits;
	reserved_slots: number;
	reserved_usd: number;
	/** Actual spend of terminated descendants, still charged to this subtree (bounded by max_subtree_usd with reserved_usd). Optional for older controllers. */
	settled_usd?: number;
	consumed_usd: number;
	subtree_live_agents: number;
	available_slots: number;
	available_usd: number;
}

/** GET /models (agent) */
export interface ModelsResponse {
	models: (ModelCatalogEntry & { eligible: boolean; ineligible_reason?: string })[];
}

/** GET /events?run_id=&after=&limit= (scoped read; agents: own run only) -> EventsResponse */
export interface EventsResponse {
	events: EventView[];
	/** Pass as `after` to continue. */
	next_after: number;
}
export interface EventView {
	seq: number;
	id: string;
	run_id: string;
	actor_id: string | null;
	type: string;
	entity_id: string | null;
	payload: unknown;
	created_at: string;
}

/** GET /agents/:id (inspect) */
export interface InspectResponse {
	agent: TreeNode & { metadata: Record<string, unknown>; created_at: string; last_heartbeat_at: string | null };
	sessions: { session_id: string; status: SessionStatus; provider: string; model: string; pi_session_path: string | null; started_at: string | null; ended_at: string | null; pid: number | null }[];
	tasks: { task_id: string; title: string; status: TaskStatus }[];
	reporting_history: { parent_id: string; valid_from: string; valid_to: string | null }[];
	budget: BudgetView;
}

/** GET /runs/:id/recovery (operator) - get_recovery_status */
export interface RecoveryStatus {
	run_id: string;
	agents: { agent_id: string; desired_state: DesiredState; observed_state: ObservedState; session_id: string | null; pid: number | null }[];
	pending_spawn_intents: { id: string; agent_id: string; status: SpawnIntentStatus }[];
	unacked_deliveries: number;
}

/** POST /controller/shutdown (operator) { force?: boolean } -> ShutdownResponse */
export interface ShutdownResponse {
	stopping: true;
}

/**
 * POST /sessions/usage (agent): report provider usage for the caller's own allocation.
 * When consumed_usd reaches the agent's own reservation, the agent is paused (desired PAUSED) and
 * a budget.exhausted event is recorded.
 */
export interface UsageReportRequest {
	cost_usd: number;
	input_tokens?: number;
	output_tokens?: number;
	model?: string;
}
export interface UsageReportResponse {
	consumed_usd: number;
	budget_exhausted: boolean;
}

/**
 * Idempotency notes: every POST needs idempotency-key. Same key + same body replays the stored
 * response (POST /sessions/heartbeat is not stored). Responses carrying a bearer `token`
 * (POST /runs, /runs/:id/attach, /enroll) are stored redacted; a replay mints a fresh token for the
 * same session and revokes the previous one.
 */
