# 08 — Durable identity, recursive topology, recovery, and context (NORMATIVE)

## Non-negotiable properties
1. **Agent ID != Pi session ID != process ID.** Agent identities survive restarts, changes of model, reassignment, and Pi session branching. A root is an agent whose reporting parent is NULL; any non-root may have children and be a worker concurrently.
2. **The authoritative live organization is a single rooted tree per run.** Store temporal `reporting_edges` (closed and active) in SQLite. The controller is its sole writer. All reads of ancestry, descendant membership, authorizations and subtree allocations are calculated from the committed snapshot, never inferred from Pi conversation messages or filesystem paths.
3. **An agent can be OFFLINE while still occupying a position in the organization.** Neither exiting Pi nor crashing deletes the agent, its tasks, commitments, reports, messages, or budget authority. `desired_state` (intent) and `observed_state` (process health) are distinct.
4. **Each session is an attempt to execute a persistent agent**, with a durable Pi session path/session identifier and a process ownership marker. A restart creates a new session attempt (possibly resuming the same Pi transcript); it never creates a new organizational agent.
5. **Topology, authority, and recovery are transactionally governed** in the controller; LLM conversation text is not a source of authority.

## Reparenting and joins/leaves
- `POST /agents/:id/reparent` takes expected topology version, target parent, reason, idempotency key and a `pending_work_policy` (retain, reassign, pause). Joining an existing tree is reparenting; leaving is reparenting to an authorized manager or operator-supervised retirement. Do not allow unparented non-root agents.
- In one `BEGIN IMMEDIATE` transaction: check actors' authorization over source AND destination scopes; verify same run, active membership, expected topology version, no self/cycle/ancestor-to-descendant move, subtree cost/slot envelopes in new ancestor chain, and ownership of ongoing proposals. Close previous edge, open new edge, move allocation reservations and update affected delegation grants; append event/outbox; increment run topology version; commit. Reject atomically if any constraint fails.
- Define whether subtree moves with its manager: **yes by default**. Individual transfer leaves previous descendants with their prior manager and must use explicit separate reparent operations. Retire/leave of an agent with children requires explicit `cascade`, `transfer_children_to`, or `pause_subtree` policy. No silent orphaning.
- In-flight proposals retain immutable original reviewer path but must be revalidated against CURRENT topology at decision/commit. Stale approvals are rejected or returned for fresh review. Messages and assigned tasks remain linked to stable agent IDs; new manager receives handoff event and a summary, not ownership of the previous manager's raw conversation.
- Model changes, role changes, session changes, and parent changes are independent operations. Keep a complete history with event causation IDs and timestamps.

## Recovery ownership and leader failure
- Controller is a **singleton per OS user / database**, acquired by IPC lock with process identity and database lease. Stale lock recovery needs a durable fencing epoch; never run two active schedulers against one DB.
- Each agent has desired state (`RUNNING`, `PAUSED`, `RETIRED`) and observed state (`STARTING`, `LIVE`, `LOST`, `STOPPED`, `FAILED`), plus heartbeat, lease expiry, and reconciliation generation. Distinguish *control-plane liveness* from model inference activity: a long tool call must not imply death merely because no turns completed.
- Pi root closure/crash does **not** kill descendants. Controller continues; root becomes LOST or STOPPED while reports continue under existing budgets, or pause subtree if an explicit per-run policy requires it. Governance requiring the root goes to PENDING until root resumes or an authorized operator acts.
- On restart: acquire scheduler leadership/fence; rebuild tree; scan all nonterminal agents/sessions/spawn intents, reconcile with actual OS process identity (PID plus start time/boot marker and agent launch token), reconnect live children, mark missing children LOST, redeliver unacked messages, and resume paused/missing sessions only when desired state and retry policies permit. Do not double-spawn after uncertain launch.
- Hard stop/cancel uses controller and OS supervision, not a conversation instruction. Each session attempt is generation-scoped: stale processes cannot publish authoritative results, approve expansions, or consume new budgets once fenced.
- Crash-safe user control: extension reconnects to the singleton controller and resolves agent identity via a durable enrollment token; opening an arbitrary Pi session never silently adopts an unrelated member. Handle user-opened Pi branch/fork explicitly (attach, fork-as-new-agent, or detached); never implicitly multiply organizational identity.

## Pi history and context
- Pi remains the authoritative native transcript; record canonical Pi session path/ID, selected leaf/branch, and last synchronized entry cursor in `session_checkpoints`. SQLite retains organizational events, tasks, approvals and messages. A transcript file alone cannot establish role, manager or authority.
- Use Pi hooks (`context`, relevant lifecycle hooks, compaction hooks, message injection) to assemble a bounded *effective model context* from task state, current parent/children, active grants, pending directives and unresolved commitments. Prefer fetching current facts from SQLite; do not depend on a stale compaction summary.
- Duplicate injected message after crash must be idempotent using message ID + recorded delivery state. Because session logging and SQLite cannot be in one local transaction, design reconciliation around at-least-once delivery and content markers, with no authority-changing side effects from context injection alone.
- Reparent does not rewrite transcript: append a new durable directive and refresh organizational context before next inference. Root/manager recovery must not assume the former parent is still authoritative.

## Required queries
`get_ancestry(agent_id, at_version?)`, `get_subtree(agent_id, at_version?)`, `get_reporting_history(agent_id)`, `get_current_manager(agent_id)`, `get_agent_sessions(agent_id)`, `get_recovery_status(run_id)`, `get_outstanding_commitments(agent_id)`.

## Invariants and test strategy
- Every committed snapshot is a rooted acyclic graph with one active parent for each non-root; root has none. Temporal edges may have historical parents, never two active parents.
- Every mutation that changes topology, roles, approvals, or budgets emits a durable audit event in the **same transaction**.
- Concurrent reparent/recruitment approvals are serialized and optimistic `expected_topology_version` checks prevent stale decisions.
- Recovery tests must use actual process kill and controller restart, not only mocked state transitions. Test root crash while descendants remain live, non-root manager crash, child crash, controller crash mid-spawn, restart while reparent pending, and reparent under saturated destination budget.
