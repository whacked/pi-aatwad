# Implementation decisions (v0.1, first impl)

Spec: `recursive-agent-org-v1.2/` (read-only brief). This file records the concrete choices the team made.

## Runtime
- **Pinned Pi:** 1.4.0 (`@earendil-works/pi-coding-agent`). Extension API docs: `~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, types in `dist/core/extensions/types.d.ts`, examples in `examples/extensions/`.
- **Node >= 22.13 with native type stripping.** All source is *erasable* TypeScript (no `enum`, no parameter properties, no namespaces; `import type` for types; imports use explicit `.ts` extensions). Pi loads the extension via jiti; the controller runs as `node src/controller/main.ts`.
- **SQLite:** `node:sqlite` (`DatabaseSync`) — no native npm dependency. WAL + busy_timeout.
- **Zero runtime npm dependencies.** Host-provided `typebox` / `@earendil-works/*` are peerDependencies only.
- Known limitation: Node refuses type stripping under `node_modules/`, so `pi install npm:` needs a JS build step (future). `pi install ./path` / git works now.

## Process topology
```
pi (root, extension) ──HTTP/unix socket──▶ controller (detached node process, singleton per state dir)
                                              │  SQLite WAL (sole writer)
                                              └─ spawns detached worker `pi` processes (executor)
worker pi (same extension) ──enroll/heartbeat/tools──▶ controller
```
- State dir: `src/shared/paths.ts` (`PI_TEAM_STATE_DIR` overrides; tests always set it).
- Wire contract: `src/shared/protocol.ts`. Change it only via the team lead.

## Singleton + fencing
- `controller.lock` created with `O_EXCL` holding `{pid, started_at, controller_id}`. Stale-lock recovery: lock owner pid dead (or pid reused with different start time) → remove and retry. Then `controller_lease` row: bump `fencing_epoch` in `BEGIN IMMEDIATE`. Socket: unlink stale only after the lock is held; listen; write `controller.json`; readiness = `GET /health` answers.
- Idle shutdown: no live workers, no pending spawn intents, no client requests for `PI_TEAM_IDLE_MS` (default 10 min) → exit cleanly.

## Workers (executor)
- A worker is a detached `pi` process (`spawn(..., {detached: true, stdio: [ignore, log, log]}).unref()`), so it survives both the root TUI and the controller.
- Launch (verified against Pi 1.4.0 by `test/executor/pi-smoke.test.ts` and `test/e2e/real-pi-worker.test.ts`):
  `pi --mode json -p --session <file> [--provider P] [--model M] -e <pkg>/src/extension/index.ts -- "<prompt>"`.
  `--provider/--model` are omitted for the `default` model. No `--continue` (ambiguous), no `--approve` (workers don't trust project-local `.pi`).
- Without terminal mode, workers are **one-shot**: the process exits when its prompt settles (observed STOPPED, not a failure). The controller relaunches with `resume=true` on the **same** `--session` file when the agent has unacked inbox deliveries or an open task. In the worker, the extension claims the inbox in `before_agent_start` and once more in `agent_before_settle` (one guarded continuation, at most 20 per process).
- Worker env is an allowlist (`src/executor/env.ts`). Workers get `PI_TEAM_ENROLL_FILE` and `PI_TEAM_LAUNCH_TOKEN` but **not** `PI_TEAM_STATE_DIR`. In managed mode the extension uses only the enroll file's `socket_path`, never reads `operator.token`, and never starts a controller.
- Process identity = pid + process start time (`ps -o lstart= -p PID`) + launch token stored in `sessions`.
- Tests/demo use `PI_TEAM_EXECUTOR=<node script>`: a fake worker that speaks the same enrollment/heartbeat/tool HTTP protocol without an LLM, so no paid credentials are required.

## Governance accounting
- An approval is a grant from the reviewer's pool. Reservations are recorded at **every** ancestor, so siblings cannot overcommit. In bounded mode, global hard caps (`max_live_agents`, `max_pending_spawns`, `emergency_max_depth`, `max_run_usd`, `max_run_seconds`, `allow_providers`) are checked first. The human operator may explicitly disable numeric resource caps using the persisted `operator_unlimited` policy; agent credentials cannot change it. Provider eligibility and hierarchy authorization still apply.
- `max_run_usd` counts consumed spend across the run (root included) plus the unconsumed part of active reservations. On terminate, the unspent part is released and a settled charge (`BudgetView.settled_usd`) stays at each ancestor.
- Deadlines: per-session, per-role runtime and per-run wallclock. Policy `BLOCKED` (default: pause and keep budget) or `FAILED`.

## Controller tunables (env, positive integers in ms unless noted)
`PI_TEAM_IDLE_MS`, `PI_TEAM_CLAIM_MS`, `PI_TEAM_HEARTBEAT_LEASE_MS`, `PI_TEAM_TICK_MS`, `PI_TEAM_LAUNCH_GRACE_MS`, `PI_TEAM_ENROLL_TTL_MS`, `PI_TEAM_HUNG_MS`, `PI_TEAM_MAX_LAUNCH_ATTEMPTS` (count), `PI_TEAM_MAX_RESTARTS` (count). See `src/controller/main.ts`.

## Verification
- `npm test`: unit + integration tests for controller, executor and extension, plus two e2e tests: `test/e2e/demo.test.ts` (the 9-step `examples/demo-scenario.md` against a real controller process with fake workers, including SIGKILL of the controller mid-delivery) and `test/e2e/real-pi-worker.test.ts` (real `pi` worker with a local fake OpenAI-compatible model).
- `npx tsc --noEmit` is clean. `bash scripts/demo.sh` writes `demo-output/`.
- The code was independently reviewed twice; every finding (8 initial, 4 from the re-review) was fixed with regression tests (`test/controller/review-fixes*.test.ts`).

## Not in v0.1 (known gaps against the brief)
- git worktree merge/cleanup; Windows IPC; npm-registry install (needs a JS build).
- Model switch for an existing agent (new session under the same agent ID) has no API yet.
- Usage reconciliation only sums worker-reported `/sessions/usage`; nothing pulls usage from providers.
- Fork-as-new-agent and detach attach modes. A forked Pi session gets a notice and must `/team resume` explicitly.
- No compaction-hook test for org context. Context is re-fetched from `/me` on every `before_agent_start`, never cached.
- `pending_work_policy=reassign` only sends a handoff notice; it does not re-own tasks. The outbox is logged, not consumed externally.
- Same-uid workers are not isolated (see README Limitations).

## Interactive tmux workers

`/team watch` persists terminal mode through `/runs/:id/terminal`. The reconciler
stops existing headless processes once and relaunches on the same transcripts and
agent IDs. New launch specs carry the persisted terminal configuration. PiExecutor
then creates or respawns real PTY panes with interactive Pi argv (no JSON/print
flags). A private, self-deleting shell launch file supplies the allowlisted worker
environment; credentials never appear in tmux argv. Shell `exec` preserves the
pane PID and process group as Pi's identity, so existing probe/stop/recovery and
fencing logic remain authoritative. Controller reconciliation arranges these panes.

Interactive managed workers trigger model turns for inbox messages when idle;
headless workers retain the bounded settle-continuation behavior. The leader's
existing pane stays in its original session and window. Pane-scoped ownership
and a persisted terminal location direct the executor to split that pane's region.
Custom layout replacement is confined to the team subtree (including tmux's
flattened sibling groups); unrelated pane geometry and processes are preserved.
A roughly 60% leader allocation and the remaining member grid adapt to
region dimensions. Closing an in-place view hides optional debug controls. Outside tmux,
the dedicated-session fallback remains, including detaching clients on close;
controller lifecycle operations stop workers. Explicit tmux pane/server destruction
has normal PTY hangup semantics and may trigger controller recovery.

The layout codec accepts legacy checksummed strings and tmux 3.8's version 2
JSON format. It writes the format returned by the server, preserves JSON pane
indexes, active/recent-pane metadata and unrelated cells, and separates layout
output from zoom state with a tab rather than splitting JSON on spaces.

## Session workflow and operator policy

`/team resume` discovers active roots through the shared controller and provides a
picker with active/live member counts. It does not create a new run. `init` followed
by `resume` retires the unused just-created empty root only after a successful
attachment. Cancelled runs remain durable but are excluded from active suggestions,
including old records whose run status lagged behind the root status.

Cancellation and supersession have separate structured stale-token reasons. A
stopped local identity is persisted as ended, with its heartbeat/cache cleared,
so reload does not reattach a cancelled agent. In-flight requests from an old
identity cannot invalidate a newly resumed one. Repeated cancellation is a no-op.
Pane ownership is released for stopped runs; operator-verified stale groups with
zero active members can be reused without taking over active groups.

`/runs/:id/admin` permits only operator credentials to change numeric resource
enforcement. Unlimited mode is a persisted boolean rather than a large finite
number. Budget views return `unlimited: true` with null available amounts; usage
accounting continues, while resource/grant checks and deadlines are disabled.

## Quiet team layout and member lifecycle

The controller invokes the Pi executor's terminal reconciliation hook on its
normal tick. Default layouts contain only live harness panes; no visible control
pane or separate coordinator process is needed. Dedicated sessions use a temporary
placeholder until their first Pi starts. Explicit debug mode retains one diagnostic
pane, with deterministic deduplication and cleanup of legacy controls.

The extension sets the terminal title to the controller-assigned role/name and
refreshes it after startup and turns; reconciliation also restores member titles.
`team_close_member` uses the existing manager-scoped cancellation API and confirms
process exit using PID/start-time identity. Reconciliation removes ended panes only
after their worker identity is dead. Active tree/children projections hide terminal
agents by default in user/model tools, with explicit archival tree access preserved.


## Named agents and live settings

Name resolution is scoped to a run and maps exact case-insensitive role/name matches
onto stable IDs before existing authorization checks. Active matches take priority
over historical matches; ambiguity never silently selects a member. Creation without
a name uses unused friendly names, including historical names to avoid accidental reuse.

Budget mutations update active own-spend reservations at every ancestor, preserving
consumed spend and separate descendant envelopes. The idempotent transaction checks
grant authority, ancestor commitments and the global ceiling before committing; an
optional lifecycle resume happens in the same transaction.

Model requests persist launch settings and a revisioned pending selection in agent
metadata. Heartbeats carry that selection to Pi, which calls setModel only when idle.
Acknowledgments clear only the matching revision. Direct model_select events persist
actual choices without leader inbox traffic, and retry persistence after outages.
Heartbeat results predating a local selection cannot overwrite that selection. Tree
projections distinguish the actual model from pending launch settings; successful
selection also updates the current session model. No additional schema migration is
needed. Pi owns transcript conversion, context management and automatic compaction.


## Reporting relationships between team leaders (v0.1.6)

Migration 004 adds `team_reporting_settings`, temporal `team_reporting_links`, and
`team_reporting_messages`. Links use generic `child_run_id` and `parent_run_id`
fields. Any active root can be a child, parent, or both; there is no role flag or
mode to enable. Links are separate from `reporting_edges`: each run keeps its own
root, reservations, grants and execution hierarchy. A partial unique index permits
one active reporting parent per team. Cycle and nonterminal-root checks run inside
the same transaction. Connecting leaders does not attach or replace sessions.

`GET /runs/:id/reporting?history=1` and `POST /runs/:id/reporting` are available to
the run root or operator. Mutations accept `action` (`connect`, `disconnect`,
`dismiss`, `transfer`, `wake`), optional `parent_run_id`, `wake_on_message`, and
`reason`. Existing idempotency and generation fencing apply. Disconnect closes
only the caller's parent link; dismiss closes all incident reporting links without
cancelling agents, processes or tasks. Transfer atomically moves all incoming
reporting links to another ordinary root and preserves the caller's parent link.
Stopping a team continues to use the existing lifecycle operation.

Cross-run `POST /messages` requires an active link between the exact source and
destination roots and permits only `question`, `answer`, and `task.progress`.
Message `run_id` is the recipient's run; payload routing metadata is assigned by
the controller. The sender's run gets `message.sent`, and the recipient's run gets
`reporting.message_received`. Links and transitions emit events to both runs.
Closing a link marks unacknowledged deliveries and unanswered questions withdrawn;
answers identify questions through `causation_id` or `correlation_id`. Withdrawal
notices refer to message IDs so already injected requests can be reconciled. No
transcript entries are deleted. Terminal-root cleanup also closes links on
cancellation, retirement or failure through other controller paths.

`/me` includes current reporting state for roots. Its bounded prompt section lists
linked leader IDs and reporting responsibilities. Connection notices carry up to
30 open tasks, 30 active members, and five recent task progress/completion events;
they ask for an initial narrative report. Transfer copies up to 30 recent messages
per link as reference history plus a fresh team snapshot. Consolidated narratives
live in ordinary Pi conversations; reports and links persist independently in SQLite.

Wake-on-message is an explicit, persisted per-root option, defaulting off. Heartbeat
returns `reporting_wake`; the extension starts a turn only when idle and controller
desired state is RUNNING. Paused roots only queue context. Root processes are never
spawned by this feature. Closing a terminal preserves links and queues reports.
