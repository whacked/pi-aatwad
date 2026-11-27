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
- An approval is a grant from the reviewer's pool. Reservations are recorded at **every** ancestor, so siblings cannot overcommit. Numeric caps default to `null` (unbounded), worker timers to `0` (disabled). Configured global caps (`max_live_agents`, `max_pending_spawns`, `emergency_max_depth`, `max_run_usd`, `allow_providers`) are checked first. Run age is never enforced; legacy `max_run_seconds` is ignored. The human operator may explicitly disable run-wide numeric resource caps using the persisted `operator_unlimited` policy (worker-selected budgets/timers remain enforced); agent credentials cannot change it. Provider eligibility and hierarchy authorization still apply.
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
region dimensions. Closing an in-place view hides optional debug controls;
controller lifecycle operations stop workers. There is no dedicated/detached tmux
session mode (removed in v0.1.23). Explicit tmux pane/server destruction
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
pane or separate coordinator process is needed. Explicit debug mode retains one diagnostic
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


## Terminal environment fallback (v0.1.7)

Terminal hosting is selected independently of TTY presence. A normal shell, SSH or
Herdr session uses detached Pi workers; a valid tmux host can automatically open
panes during recruitment. `HERDR_ENV=1` takes precedence over inherited tmux markers.
Automatic setup verifies that the pane's process is an ancestor of this Pi before
mutating it. Failure is returned as `terminal_warning` on successful recruitment,
not a failed member creation. Explicit `/team watch open` still reports tmux errors.

`POST /runs/:id/terminal` now accepts `{enabled:false}`. It clears `terminal`, sets
`terminal_disabled`, and prevents automatic pane creation until explicit reopening.
The reconciler handles changes in both directions through process supervision:
stop the old harness, fence its credential, and requeue on the same agent and Pi
transcript. Tasks, worktrees and allocations stay intact; active turns are interrupted.
Old pane cleanup is left to tmux rather than starting a competing pane supervisor.

Before mode changes and launches, PiExecutor checks that a saved tmux location
exists and remains owned. Missing tmux, dead sockets, vanished panes and lost
ownership clear the saved terminal configuration in a fenced transaction, emit
`run.terminal_fallback` and send a root notice. Existing interactive workers move
to detached execution, and new workers start there without consuming failed launch
attempts for a preflight-detected terminal outage. The ordinary launch retry policy
still applies to failures after preflight and to missing Pi executables. A missing
Pi executable gives an actionable PATH/PI_TEAM_PI_BIN diagnostic. Its path is
resolved before changing to a member's worktree.

Herdr is a host for the root Pi, not a worker-pane backend. tmux commands clear
outer tmux markers in Herdr; explicit watch reports that Herdr cannot host member
panes and does not touch tmux. Environment tests cover
missing tmux, plain SSH, inherited markers, Herdr, headless opt-out, live mode
changes, saved-terminal fallback, process launch without tmux and missing Pi.

## Cancellation recovery (v0.1.8)

Root termination persists the corresponding terminal run status and emits a
`run.status_changed` event in the same transaction. Startup reconciles historical
run rows with terminal roots, preserving agent history (`RETIRED` roots map to
`COMPLETED` runs).

Repeated cancellation remains authorized and returns an empty affected-agent list
when no agent changes status. Cascade cancellation also revisits terminal agents
to release leftover reservations, cancel pending work, revoke credentials and end
active sessions. After commit, recorded process identities are probed and any
surviving managed processes are stopped, including those in already-stopped
sessions. Retries preserve session end times and avoid duplicate termination
events or budget settlement. Attach and resume still reject terminal agents.

## Worker lifetime and process-loss notices (v0.1.9)

Task completion is not worker termination. Interactive members keep their Pi
prompt and remain reachable until their manager or the human closes them.
Bootstrap, resume and per-turn org context explicitly tell members not to exit,
kill their pane or retire themselves after completing work. The lifecycle API
already requires a strict ancestor (or operator), so workers cannot retire themselves.

New runs default `limits.max_agent_seconds` to 0 (disabled), and direct recruitment
no longer supplies an implicit 600-second runtime. Positive, explicitly configured
role/proposal runtime and global per-agent session limits still apply; when both
are set, the child envelope uses the smallest positive cap. No clock resetting or
idle grace weakens an explicit deadline. The run-wide deadline and spend caps are
unchanged. Persisted runs and allocations keep their existing configuration;
these new defaults do not silently erase an old or explicitly requested limit.

Terminal process exits, missed heartbeat leases and missing processes discovered
at controller startup send durable `system.notice` messages to the manager.
Restart scheduling sends `worker_restart_scheduled` (not a claim that launch has
succeeded); launch failure and exhausted retries retain their failure notices.
Budget exhaustion also notifies the manager, but does not kill the Pi process.
Deadline notices identify the controller stop, configured limit and resulting
PAUSED/FAILED state. Leaders are instructed to refresh their tree and understanding
when receiving lifecycle notices. Normal inbox turn/wake policy is unchanged;
notices persist even when the leader is busy or not auto-waking.

Tmux uses `remain-on-exit` to retain process output, so a dead pane is a process
exit, not evidence that its task was completed. The controller owns recovery of
unexpected terminal exits, using the saved transcript and agent identity. Normal
detached one-shot exits remain quiet (they settle after each prompt by design).
Regression tests use both stub processes and real Pi in in-place tmux:
complete the actual task, age its session past the former default limits, send
more work, deliberately kill it, observe a notice, and verify resumed communication.

## Reclaiming stale leader-pane tags (v0.1.10)

Tmux pane tags outlive individual Pi sessions. A fresh session followed by
`/team init` creates a new run, but does not erase the previous run's pane tags.
`/team watch off` and terminal fallback can also delete saved terminal locations
while leaving those tags behind. Previously, watch tried to release the old
run's saved layout; missing or moved locations made that cleanup a no-op on the
current pane, then `TmuxWatch.open()` threw `This pane already belongs to another team`.

Watch now releases only the verified leader-pane tags on the current tmux server
when their old run is known to this controller and has zero active members.
It does not use saved locations to tear down another layout, kill the human Pi
process, cancel the old root-only run, or alter its history. The old run remains
resumable. `releaseLeaderPane()` verifies both owner and `leader` role before
clearing tags; active-member teams, worker panes, and unknown/controller-foreign
owners remain protected. Low-level ownership checks remain in place.

Tests cover saved, missing, disabled and moved terminal locations, protected
foreign/worker/active-team panes, unchanged human PID, preservation of a different
saved layout and the old run, plus the full fresh-session init/watch command path.

## Host detection and member decoration (v0.1.23)

`terminalHost()` names the innermost multiplexer: Herdr, then tmux (`TMUX` and a
`%n` `TMUX_PANE`), then Rex (`REX_SERVER` and a `block:` `REX_BLOCK`), otherwise
plain. `src/terminal/host.ts` maps each kind to capabilities: whether members can
run in persistent, switchable sessions there today (only tmux), the richest native
decoration it renders, and the reason shown when sessions are unavailable.
`openTerminals` rejects with `NoSessionHostError` before contacting the controller
or tmux when the host cannot hold member sessions. The dedicated tmux session mode
is removed. A saved terminal configuration without a leader location is reported by
`terminalProblem`, so the reconciler's existing fallback moves those teams to
detached workers.

`src/terminal/decor.ts` holds the per-member decoration (sanitized name, agent ID,
stable xterm-256 color) and `planDecoration`, the single dispatch from a host's
decoration mode to native rendering and/or a self-drawn header. tmux applies the
native label as the pane title. Member Pis (managed identities in TUI mode) install
a width-safe header widget above the editor when the plan asks for one. When Rex
gains native components, only its capability entry changes.


## Rex member blocks (v0.1.23)

`src/terminal/view.ts` defines `TerminalView`, the backend-neutral interface for member
terminals beside the leader; `terminalView()` picks the backend from the saved
`terminal.backend` (absent means tmux). `TmuxWatch` and `RexView` implement it. The
executor's gated launch, terminal preflight and sync, `openTerminals` (including stale
leader-tag takeover) and `/team watch`/`team_watch` all go through it. Members start
under `env -i` plus the backend's own markers (`TMUX`/`TMUX_PANE`, or `REX_*`), so a
member's host detection, and therefore its decoration plan, matches its real terminal.

`RexView` drives the `rex` CLI with `-S <server>` and `--autostart=false`, always with
full IDs, and with `REX_SESSION`/`REX_BLOCK` removed from its environment: Rex scopes
block lookups to `REX_SESSION`, which would hide blocks in other sessions. Members are
created with `rex split --shell=none --keep-open --focus=false --label`; the block's
`process` method supplies the PID for process identity, and a missing `child` marks a
dead block. Rex has no respawn, so a relaunch splits the old block and closes it, letting
the replacement take its exact place. Ownership tags are 0600 JSON files under
`<state>/rex-tags/`, one per block; the leader's tag is the ownership check that tmux
performs with `@pi_team_owner`. Saved Rex locations use `window:`/`block:` IDs, which the
controller validates per backend; debug mode is rejected for Rex.
Integration tests under `test/terminal/` run against the real Rex server, in throwaway
sessions, when the suite runs inside Rex, including a real interactive Pi member.

## Built-in session host (v0.1.24)

Hosts without a multiplexer (plain terminals, SSH, Herdr) map to the `native` backend.
`src/terminal/native/daemon.ts` (ptyd) is a per-state-directory daemon on `ptyd.sock`
(0600, in the 0700 state directory), with an O_EXCL pid lock. It spawns members through
`@lydell/node-pty` (prebuilt, N-API) and mirrors each terminal into `@xterm/headless`.
Requests and replies are length-prefixed frames (1 byte type, 4 byte length): JSON for
control and raw data for terminal bytes. An attach request switches the connection to
streaming: it sizes the PTY to the client, repaints with the serialized viewport, then
relays bytes both ways. ptyd exits only when it hosts nothing and nobody is connected.

`NativeView` implements `TerminalView` with a fixed `native` location (validated by
the controller). Launches use the same startup gate, with `PI_TEAM_PTYD`/`PI_TEAM_PTY`
kept through `env -i`; a relaunch replaces the member's terminal. Preflight only checks
platform support, so idle teams never start the daemon.

Switching happens in the leader: `/team watch focus` stops Pi's TUI inside a
`ui.custom` placeholder, runs `native/attach.ts` with inherited stdio in the alternate
screen, then restarts and force-renders the TUI. This is the same sequence Pi uses for its
external editor. `/team back` in a member writes a private OSC (`7726;pi-team;detach`),
which ptyd turns into a detach event for attached clients; in tmux and Rex the same
command focuses the leader instead. Leaders show a member strip below the editor,
refreshed from `/me` on heartbeat and after turns. Tests cover the daemon, the attach
client in a real PTY, a real Pi member, and a real leader Pi switching into a member and
back.

## Unified links, phase 1 (schema 5, v0.1.26)

First step of docs/design/unified-team-links.md. `reporting_edges` is now the one link
table: rows with `parent_run_id` NULL are links inside a team (manager edges, as before);
rows with `parent_run_id` set link a team's agent under another team's agent. Each row
records `origin` (`spawned` or `joined`) and `terminatable`. Migration 005 moves
`team_reporting_links` into it as joined, non-terminatable links between the roots,
marks members added by `POST /runs/:id/join` as joined and non-terminatable, rebuilds
`team_reporting_messages` to reference the link rows, and leaves a read-only
`team_reporting_links` view for compatibility. Behavior is unchanged: ancestry, subtree,
manager and budget walks only follow in-team links, and cross-team links still grant
coordination only. Reporting views now include `origin` and `terminatable`.


## Unified links, phase 2: authority across links (v0.1.27)

An agent's lead is its in-team manager or, for an agent linked under another team, that
agent (`getLead`). Control reaches one step down: `POST /tasks` accepts an owner linked
directly under the caller, and the task lives in the lead's team with the sub as owner.
The sub may break it down in its own team (`parent_task_id` may point at the lead's task),
and its progress and completion go to the assigning lead. Cross-team messages follow the
relation: down to a linked sub (question, answer, task.progress, system.notice), up to the
lead and sideways to peers under the same lead (question, answer, task.progress).
Assignments only travel as tasks. Reads reach the whole linked subtree: a lead can read the
tree and agents of any team linked below it, and `GET /runs/:id/tree?linked=1` shows linked
teams under their leads with `run_id` on those nodes (the plain tree, used by the
reconciler and terminal sync, is unchanged). `/me` reports the lead, linked subs and peers
across teams with `run_id`; name resolution searches the linked tree. Severing a link
removes all of this.

## Unified links, phase 3: dismissal and stop cascade (v0.1.28)

`POST /agents/:id/dismiss` (the agent's lead, or the operator) ends the link from another
team. On a non-terminatable link that is all. On a terminatable link it first stops the
child's team with the existing resumable whole-team stop, cascades through terminatable
links below, and severs the non-terminatable links below the stopped teams so those teams
carry on independently. The operator can force either outcome with `stop`. A plain
`/runs/:id/stop` also stops terminatable linked teams (recording `stopped_by_run_id`),
keeps joined teams running and linked so their reports queue, and `/runs/:id/resume`
resumes the teams it stopped. `POST /agents/:id/link` lets the operator set `terminatable`
on any active link; a lead cannot cancel or retire an in-team joined member whose link is
not terminatable.

## Unified links, phase 4: budget on join (v0.1.29)

A team that links under another keeps its allocation unchanged. The operator can give a
team a default member budget (`POST /runs/:id/admin` `{mode: "member-default", usd}`;
`null` removes it); when another team links under it, that amount is added once to the
joining root's `max_subtree_usd` (event `budget.join_grant`). Unlimited teams and
ceiling-free envelopes are left alone, and re-confirming an existing link grants nothing.

## Unified links, phase 5: one join in both harnesses (v0.1.30)

`/team join <run_id|agent_id|none> [--terminatable]` is the Pi command for linking (with
`/team report-to` as its alias); a run ID links under that team's leader, an agent ID
under that agent (`team_reporting` connect accepts `parent_agent_id`). Only the operator
can make a new link terminatable. `/team dismiss` and `/team link ... terminatable on|off`
expose phase 3, and `/team admin member-default <usd|none>` phase 4. `team_close_member`
dismisses a team linked under the caller instead of cancelling it, in Pi and Claude Code.
Claude Code's `team_join` mode `member` (alias `join`) now creates the session's own team
and links it under the target, instead of adding an in-team member; mode `agent` finds the
agent's own team through the linked tree. Leaving notifies the lead across teams.
`POST /runs/:id/join` remains for compatibility.

## Unified links, phase 6: roster, recall, rehire (v0.1.31)

`GET /agents/:id/roster` lists everyone ever linked under an agent (latest link per child):
origin, terminatable, whether still active, agent status, the linked team's lifecycle state,
the responsibility it was recruited for, and why the link ended. `POST /roster/recall`
brings one back with its context. A former linked team keeps its identity: it is resumed
when this lead's dismissal stopped it (a stop by anyone else needs the operator) and linked
again with its previous terminatable setting. A closed in-team recruit cannot be revived
in place, so recall recruits a new member with the same name and responsibility whose Pi
session path is the old transcript. `POST /roster/rehire` recruits a new member in the same
position with a fresh context. Pi: `/team roster`, `/team recall`, `/team rehire` and the
`team_roster` tool; Claude Code: `team_roster`.

## Unified links, phase 7: display (v0.1.32)

`/team tree` and `team_get_tree` request the linked tree, so teams linked under an agent
appear beneath it, marked `⇢ team <run_id>`. The leader's member strip marks linked teams
with `⇢` and offers `/team watch focus` only when it has its own members; focusing a linked
team explains that it runs in its own session and terminal.

## Moving a member: leave, then join (v0.1.34)

`POST /sessions/secede` lets a non-root member leave its team. The controller creates a new
team whose root has the member's role, working directory, model and Pi transcript, notifies
the old lead (`member_seceded`), and retires the old identity with `terminateAgent(...,
{ keepProcess: true })`, so the running Pi process is never stopped: it continues as the new
root with a new credential. In Pi, `/team join none` in a member does this, and
`/team join <target>` in a member does it and then links under the target. A managed worker
that leaves keeps its managed status (no operator token), so operator-only actions stay with
the human's own sessions.

## Scheduled check-ins across linked teams (v0.1.35)

The attention status digest (stall alerts, ticks) now covers a lead's direct subs across
links and the tasks it assigned to them, so a secretary-style leader whose reports are
linked team leaders gets meaningful digests. New `checkin_seconds` (`/team attention
checkin 5m`) wakes an idle lead on a fixed schedule even when nothing changed, for scheduled
status rounds; `tick` still fires only on change. The wake text points the model at its
standing check-in instructions from the human.

## Quitting, finding teams, and leaderless teams (v0.1.39)

`RunSummary` carries a name (`RunConfig.name`, default the leader's folder), the leader's
directory and model, last activity, open tasks, a one-line summary and an `empty` flag;
`POST /runs/:id/settings` sets `name` and `on_leader_exit` (`stop` by default, or `keep`).
`/team list` is scoped to the project (git top-level) and hides empty, closed, other-project and
week-old stopped teams; Pi startup notes existing teams for the project.

Pi has no cancellable quit event, so the extension's editor wrapper guards the three interactive
quit paths (Ctrl+D on an empty editor, the second Ctrl+C within 500ms, a submitted `/quit`):
`GET /runs/:id/activity` reports live and busy members across the linked tree, and a busy tree
asks for confirmation. `session_shutdown` (reason quit, awaited by Pi, also on SIGTERM/SIGHUP) then
applies the exit policy for interactive sessions: `stop` runs the resumable team stop (cascading
to terminatable linked teams) and prints a note; `keep` leaves it running. Print-mode runs never
apply it. `GET /runs/:id/away` summarizes completed tasks, progress and waiting messages since the
leader's previous session ended, shown by `/team resume`. The reconciler pauses a team whose root
is not LIVE and whose members have all been idle for `leaderlessIdleMs` (15 minutes), unless its
policy is `keep`. `/team prune` closes idle members without open tasks.


## Pluggable hosts and backends; API discovery (v0.1.41)

Supersedes the `terminalHost()`/`host.ts` detection of v0.1.23 and the Herdr special cases
of v0.1.7.

**Two registries.** `src/terminal/backends.ts` holds one `BackendFacts` per place member
terminals can live (`tmux`, `rex`, `native`), with everything that differs between them:
- the noun and label used in messages;
- whether members sit beside the leader;
- the decoration mode;
- debug-pane support;
- the location format and validator, and any fixed location;
- the environment marker named in errors;
- a platform support check and a lazy view factory.

It is pure data plus lazy imports, so the controller (location validation) and the
executor (preflight) use it too. Code outside `src/terminal/` no longer compares backend
names.

`src/terminal/hosts.ts` holds the ordered host providers: bb > Rex > tmux > built-in session
host > detached. Each provider has:
- `markers(env)`: detection from environment markers;
- optional `unusable()`: known reasons, such as bb child threads not being implemented or an
  unsupported platform;
- optional `verify()`.

`detectHost()` walks the chain, and the first host that is detected and usable wins. Each
candidate is recorded with detected/usable/reason, so the choice can be explained. Adding a
host or backend means adding a provider or a facts entry.

**Verification.** Inherited markers are claims. tmux is accepted only when `#{pane_tty}` of
`TMUX_PANE` is this process's own tty. Rex is accepted only when the block's process is an
ancestor of this one. Both require that the process has a tty at all.

This covers several cases with one rule:
- stale markers;
- a multiplexer nested inside a pane (Herdr inside tmux): the pane tty differs;
- Pi in bb's RPC mode under a bb started from tmux: no tty.

`PI_TEAM_HOST_VERIFY=markers` skips the process checks but still requires tmux or Rex to
answer for the pane or block. Tests that drive panes from outside use it.

**In-memory state.** `currentHost()` returns the last verified detection for the current
markers, else a markers-only answer (`verified: false`). `refreshHost()` replaces it.
`TeamRuntime.start` detects once at startup and sends the result to
`POST /sessions/host`. That is a separate route, so older controllers merely 404 it.
- `GET /agents/:id/host` returns the latest report.
- `POST /agents/:id/host/refresh` (the agent itself, its leaders or lead, or the operator)
  sets a flag that the heartbeat response returns as `host_refresh`; the session re-detects
  and reports, which clears it.
- Events: `agent.host_detected` (host changed) and `agent.host_refresh_requested`.
- `/team host [refresh]` and the `team_host` tool show `describeHost()`.

**Discovery.** `GET /openapi.json` (no token, no protocol header) is OpenAPI 3.1 generated
from the route table. Each route lists its path parameters, the protocol and idempotency
headers, and its auth as `x-auth`. Summaries live in `src/controller/openapi.ts`;
`test/controller/host-api.test.ts` fails when a route has no summary.

The tmux view moved from `src/watch/tmux.ts` to `src/terminal/tmux.ts`.

## Readable IDs with project abbreviation and day counter (v0.1.42)

**Agent IDs** are `<keyword>-<4 words>-<yyyyMMdd>.<n>`, e.g.
`standard-cell-river-maple-orbit-cloud-20261123.2`. The trailing `<yyyyMMdd>.<n>` is the
team's stamp, assigned once in `createRun` (`nextIdStamp` in `src/controller/runs.ts`) and
stored in the run config as `id_stamp: { project, date, n }`. `n` is 1 + the highest `n`
already stored for the same project and local date, counting removed teams too, so a
number is never reused that day. Member creation (`governance.ts`) reads the stored stamp
instead of re-deriving it, so all agents of a team share it even after midnight.

**Project** is `projectRoot(root cwd)`: the git top-level, else the CWD. This is the same
function the `/team list` scoping uses (now in `src/shared/readable-id.ts`, re-exported
from `commands.ts`). The list's containment test (`sameProject`) is not an equivalence,
so it cannot key a counter; inside a git repo both agree. Outside git, a team started in a
subdirectory counts separately from its parent directory.

**Date format** is the single constant `ID_DATE_FORMAT` (`yyyyMMdd`, local time). The
user's request said `yyyyMM`, but a per-day counter needs the day. The reference
matcher accepts any `<4+ digits>.<n>` stamp, so changing the format needs no other edit.

**Run IDs** are `run-<abbr>-<4 words>`, e.g. `run-scg-borrow-vault-visit-carpet`. `<abbr>`
is the first character of each basename token, using the same tokens as the keyword and
skipping generic words. It is capped at 6 characters, with `p` when empty. Run IDs
previously had 6 words (66 bits). They now have 4 (44 bits): with 10,000 runs on one
controller, the collision chance is about 3 × 10⁻⁶.

**Collisions.** Agents of one team share keyword and stamp, so the 4 words (44 bits) are
the only random part. `freshId(db, table, make)` in `db.ts` checks the table before the
insert and draws again, at most 16 times, then fails with CONFLICT. It runs inside the
request transaction, so the check cannot race. Tests force collisions through
`idRandom.int`, the replaceable random source in `readable-id.ts`.

**Compatibility.** There is no migration. Old IDs (`agent-<hex>`, `agent-<6 words>`,
`<keyword>-<4 words>-<7 digits>`, `run-<6 words>`) stay valid, and `isFullAgentId` and
`matchesAgentWords` accept both project-ID forms. Teams without `id_stamp` (created
before v0.1.42) recruit members with the legacy 7-digit suffix, so a team stays uniform,
and they do not count toward today's numbering. In stamped IDs the date and counter are
separate reference tokens, so `20261123`, `2` and `20261123.2` all match. These references
are usually ambiguous within a team, because teammates share the stamp.

**Other derivers.** No other readable `<function>-<slug>` IDs exist. The remaining
`newId` prefixes (`msg`, `task`, `evt`, `edge`, `teamop`, …) are `<prefix>-<16 hex>` and
unchanged. Credentials, controller IDs (`ctl-<hex>`) and pty handles are opaque.

### Project names from the path (v0.1.43)

`projectNameFolders(cwd)` walks up from the CWD, prepending folder tokens, until the non-generic
characters reach `MIN_NAME_INFO` (6). `GENERIC_FOLDERS` (src, lib, app, tmp, …) count zero but are kept.
The walk stops at the home directory, at the root, or at `MAX_NAME_FOLDERS` (3).

`projectName(cwd, max)` fits the result into `max` characters by these steps, in order:
1. drop vowels from outer folders, outermost first;
2. keep two words of the innermost folder;
3. drop vowels from the innermost folder;
4. drop outer folders;
5. cut.

The agent ID keyword is `projectName(cwd, 19)`, the run abbreviation is the initials of all name words,
and the default team name is `projectName(cwd, 40)`. All of it is pure string work on the path, so
`/team list` can compute names cheaply.

## Observed models (v0.1.44)

A member's model in the tree, roster and `/me` comes from its agent record. That record was set at
recruitment and updated only by explicit selections (`model_select` events other than `restore`, and
leader-requested changes). A model restored from a member's transcript, or resolved differently by Pi
at startup, never reached the record, so leads could see a model the member was not running.

On each heartbeat (without a pending requested change) the session now posts
`POST /sessions/model {provider, model, observed: true}` when its live model differs from its last
report. An observation updates the record and `actual_model` and emits `agent.model_observed` (with the
previously recorded model). It never clears a pending `model_change`. An unchanged observation is a
no-op. Older controllers reject the `observed` key; the session then stops reporting.

## Orphaned controllers (v0.1.45)

A controller is reachable only through its state directory's socket, and the lock file is its claim
on that directory. Deleting the directory (as every test does with its temp state dir) used to leave
the controller running forever. Housekeeping (every 5 s, or a quarter of the idle timeout) now stops
the controller, reason `orphaned`, when its lock file or socket is gone. A lock held by a rival
controller is not checked here: the database lease already fences that case.

## No controllers for deleted team state (v0.1.46)

The orphan check (v0.1.45) stops a controller whose lock or socket disappears, but a client could
still start a new controller after the state dir was deleted: a heartbeat in flight while a test
removed its temp dir re-created the dir and started an empty controller that nothing would ever
stop. A client holding a session token now calls `ensureController` with `existingStateDir`: it
spawns only if the state dir still has its database, and passes `PI_TEAM_EXISTING_STATE=1`, so the
controller itself re-checks before creating anything (`StateGoneError`, exit 0). Clients without a
token (first start, operator commands) still create the state dir as before.

## Whole messages (v0.1.47)

`formatEnvelope` cut every message body to 1,500 characters (with `…`) since the first
implementation. It renders messages wherever they reach a model: inbox delivery into Pi,
`team_get_inbox`, and the Claude Code inbox tool and hook. The controller stored the full body, but a
delivered message is acknowledged and cannot be fetched again, so agents received instructions and
task assignments that simply stopped mid-sentence (reported by a sub-team leader: "Classify each as
(a) not expressible, (…"). Bodies are now delivered whole. `MAX_MESSAGE_CHARS` (100,000) is only a
safety ceiling, and a body over it says where it was cut and asks the sender for the rest.

## bb member threads (v0.1.48)

bb is now a usable host and a terminal backend (`BACKENDS.bb`). A leader Pi in a bb thread gets its
members as child threads; everything bb-specific is behind the backend registry and host chain.

- **Detection** (`hosts.ts`): markers `BB_THREAD_ID` + `BB_CLI`. Verified when `bb thread show`
  knows the thread, it is not archived, it has a machine, and this Pi has no tty (bb runs its agent
  Pi headless; a Pi from a shell inside the thread inherits the markers but has a terminal).
- **Backend facts**: `controlEnv` (`BB_CLI`, `BB_SERVER_URL`, `BB_DATA_DIR`) is saved with the
  team's terminal options (`TerminalOptions.env`, validated per backend), so the controller reaches
  the same bb without the leader's environment. `launch()` marks a host that starts Pi itself;
  `PiExecutor.launch` hands such launches to it instead of allocating a terminal.
- **Launch** (`src/executor/bb.ts`): fresh member: `bb thread spawn --parent-thread <leader>
  --environment <workspace> --machine <leader's machine> --parent-notifications off
  --lifecycle-owner-thread <leader> --title <role> --prompt-file <bootstrap>`. Restart with a live
  thread: `bb thread stop`, then `bb thread tell --mode auto --message-file <resume prompt>`, so the
  transcript and Pi session stay one. Agent -> thread map: `<state>/bb-threads/<team owner>/<agent>.json`.
- **Identity**: the worker env (enrollment file path, agent/run IDs, launch token, resume flag) is
  written as `pi-team-claim.json` into `<BB_DATA_DIR>/thread-storage/<thread>` (the member's
  `$BB_THREAD_STORAGE`). `TeamRuntime.takeHostClaim()` consumes it at `session_start`; when the
  first prompt is the controller's bootstrap or resume prompt and no claim is there yet,
  `awaitHostClaim()` waits up to 15 s in `before_agent_start`. No title marker or bb plugin is needed.
- **Supervisor** (`src/executor/bb-member.ts`): the process the controller tracks. It polls the
  thread and exits when it is archived or gone; SIGTERM runs `bb thread stop`. The launcher waits
  for its `watching` line, so an immediate stop is never lost. A crashed member Pi is detected by
  its heartbeat lease (LOST, then the hung grace), then stopped and restarted through the thread.
- **View** (`src/terminal/bb.ts`): `panes()` lists member threads in one `bb thread list --thread …`
  call; `removeMember` archives; `focus` runs `bb thread open`; tags are no-ops (threads are not
  contested like panes).
- **Waking**: managed members in `rpc` mode under bb count as persistent sessions (like `tui`), so
  inbox messages wake them; before, they behaved as one-shot workers and were never woken.
- **Team name**: `/team init` without `--name` uses the leader thread's title.
- `/team init` prints "no limit" for unlimited budget caps instead of `≤$null`.

Verified end to end against an isolated bb 0.50.1 with a fake model (a local harness, not committed):
leader thread -> `/team init` (team named after the thread) -> recruit -> member
child thread enrolled by claim, completed its task and woke the leader; cancel stopped and archived
the thread. Not shown in bb: `/team` command output (bb ignores Pi notifications and custom
messages; it logs them as `provider/unhandled`).

## Teams that outlive their leader's process (v0.1.49)

Found from a bb leader that silently lost its team and an EasyCard `/team resume` that failed with
`CONFLICT: team … is stopped; resume it first`.

- **bb leaders keep their team.** `onQuit` applies the exit policy only when the human quits. Under
  bb (`BB_THREAD_ID`), the thread outlives its Pi process: bb restarts and idle eviction end Pi with
  `reason: "quit"`, which used to stop the team. Now it does nothing there.
- **Resume, then attach, without a pause in between.** `/team resume` calls `POST /runs/:id/resume`
  and then `POST /runs/:id/attach`. The leaderless-team sweep (`pauseLeaderlessTeams`) saw a
  RUNNING team whose root had no recent heartbeat and idle members, and stopped it again before the
  attach. It now skips a team resumed less than `leaderlessIdleMs` ago.
- **A session that returns to a stopped team says so.** Restoring a persisted identity attaches
  without resuming (attach must not revive a stopped team). On `team_stopped` it now sets the
  notice `Team … was stopped while this session was away; run /team resume <run> <agent>`. Team
  tools put the notice in their `not enrolled` error, so a model can relay the exact command. bb
  shows no Pi notifications, so that error was the only place it could surface.
- **Choosing a team.** `/team resume` choices and run completions list this project's teams first
  (`projectFirst`) and show each team's directory.
- **Routing work to linked teams.** `/me` children and peers, and linked nodes of
  `GET /runs/:id/tree?linked=1`, carry `team_name` and `project` (the linked agent's working
  directory). The context block and tree show `linked team "<name>" <run> in <dir>`, so a lead with
  several linked teams can tell which one owns which project.

## Open-session warnings, log and event retention (v0.1.50)

- **Another open session already leads a team here.** `GET /runs` reports `leader_live` (the root
  agent is LIVE). At startup, and after `/team init`, a Pi session in a project with such a team
  gets a warning that lists each option with its full command: lead that team from here
  (`/team resume <run>`, the other session loses it), link under its leader (`/team join <run>`),
  or put that team under this one (in the other session, `/team join <this run>`). Doing nothing
  keeps the session as it is. Nothing is blocked (`openLeaderHints`).
- **Controller log.** Successful heartbeats and GET requests are no longer logged (they were 96% of
  all lines); writes and every failure still are (`logged`). The log rolls over to
  `controller.log.1` at 20 MB.
- **Event retention.** Hourly, from housekeeping: published outbox rows older than a day are
  deleted, then `usage.reported` events older than 7 days and `agent.lost`/`agent.reconnected`
  older than 30 days (`pruneEvents`). Spend lives on allocations, so nothing reads those back.
  All other events remain the audit trail.

## Host sleep does not stop teams (v0.1.51)

Found when an EasyCard team stopped mid-job: the laptop slept for 23 minutes, and the controller's
first tick on wake ran 10 ms before the leader's first heartbeat. Every lease had expired and the
leader's last heartbeat was older than `leaderlessIdleMs`, so the team was paused and the leader's
heartbeat came back 401.

The reconciler now notices a stall: when a tick runs more than one lease period after the previous
one, it judges no absence for one lease period (`waking()`): no lease expiry (LOST), no restarts,
no leaderless pauses. Live sessions heartbeat within that period; anything still silent afterwards
is handled as before.

## Leads resume stopped linked teams (v0.1.52)

A lead could message a team linked under it but not bring it back once it stopped, so a paused
sub-team needed a human at its own terminal.

- `POST /agents/:id/resume-team` (`resumeLinked`): the lead the agent's team is linked directly
  under, or the operator, resumes that team (`resumeWithCascade`, so teams that stopped with it
  come back too). 409 when the team is not stopped. Tools: `team_resume_team` (Pi) and the same
  name in the Claude Code MCP server; the leader context mentions it.
- The stopped team's leader session re-attaches by itself (`watchForResume`). A non-managed session
  that lost its identity to a stop (credentials revoked, or restored onto a stopped team) checks
  each heartbeat interval; once the team is resumed it attaches to its agent again, unless the
  agent's latest session belongs to another Pi session (someone ran `/team resume` elsewhere), in
  which case it only says so. `GET /agents/:id` sessions now carry `pi_session_id` for that check.

## One way to read history; consumers instead of an outbox (v0.1.53)

- **History boundary** (`src/controller/history.ts`): every read of the event log goes through
  `scanEvents` / `latestEvent` / `countEvents` (filters: team, types, entities, after a sequence
  number, since a time; oldest or newest first). Writes stay in `emit()`, inside the transaction of
  the change. Callers (team summaries, the away summary, link notices, admin limit causes,
  `/team events`) no longer join SQL against `events`, so the store behind the module can be
  tiered or moved later. Readers already tolerate missing history.
- **Outbox replaced by consumers.** `emit()` no longer writes an outbox row per event: its only
  reader mirrored events into the controller log. An `EventConsumer` follows the log by sequence
  number and remembers its cursor; any number can read independently. The controller log is one,
  best effort (`holdsRetention: false`). Retention (`pruneEvents`, moved here) never deletes past
  the slowest consumer that holds retention. Cursors are in memory for now; a consumer that must
  not miss events across restarts needs a durable cursor table, added with the next schema change
  (which can also drop the unused `outbox` table). No schema change in this release.

## Team brief; progress no longer wakes (v0.1.54)

- **Brief** (`src/controller/brief.ts`, `GET /agents/:id/brief`): what is going on under an agent,
  built from the database and the event log with no model involved. Members with state and open
  tasks; what needs the reader (unread questions and answers, proposals to review, stopped linked
  teams); and notable changes since the reader last looked (tasks completed, members joining,
  closed, failing or out of budget, teams stopping, resuming or auto-pausing) plus a count of
  progress reports. Scope: the agent's subtree and the teams linked directly under it. Readable by
  the agent, its leads (including the lead it is linked under) and the operator.
- **Seen markers**: `POST /agents/:id/brief/seen {seq, reader}` stores the last event the reader saw
  in the agent's metadata (`brief_seen_seq`, `brief_seen_seq_human`), so the leader's model and the
  human looking at its session never hide changes from each other. No schema change.
- **Where it shows**: `team_brief` (Pi tool and Claude Code MCP tool; marks the model's marker),
  `/team brief [--all]` (the human's marker). Stall prompts point at `team_brief`.
- **Progress reports alone no longer wake an idle agent** (`decideWake`). They are still delivered
  with the next turn and counted in the brief; questions, answers, completions and notices wake as
  before. This removes the most frequent "nothing to do" turns.

## Summaries and member threads (v0.1.55, schema 6)

- **Schema 6** (`db/006_summaries.sql`): `project_settings` (per-project JSON, today the summarizer
  choice), `summaries` (one row per summarized window `(from_seq, to_seq]` of a team's events:
  `window_text`, rolling `overview_text`, model, cost), and the unused `outbox` table is dropped.
  Older controllers cannot open a schema-6 database; running sessions on older code get a
  "newer controller" error until they reload.
- **Settings** (`/projects/settings`, operator): `{summarizer: {state: "enabled", model} |
  {state: "declined"}}` keyed by project directory; a team uses the innermost configured project
  containing its leader's working directory.
- **Making summaries** (`summarizeIfDue`): on demand, after a brief or summaries read, when the
  project enabled them, at least `SUMMARY_MIN_EVENTS` (8) records happened since the last summary
  (the summarizer's own traces and liveness noise excluded), the team is within budget, and none is
  in flight; a failure waits 10 minutes. Input: the previous overview plus the new records as lines
  (time, who, what, with message and task text). The model answers two sections, `## Window` and
  `## Overview` (`splitSections` tolerates sloppy output). Cost goes through `chargeUsage` (shared
  with usage reports, so budget limits apply); events `summary.created` / `summary.failed`.
- **The model call** (`piSummarize`): `pi --mode json --no-session --no-tools --no-extensions
  --no-skills --no-prompt-templates --no-context-files --no-mcp --no-themes --model <m>
  --system-prompt <instructions>` with the records on stdin; the answer and cost come from the
  final assistant `message_end`. Injectable (`ControllerOptions.summarize`) for tests; tested for
  real against a fake OpenAI-compatible server.
- **Setup** (`src/extension/summarizer.ts`): `suggestSummarizer` picks from Pi's model registry a
  small model (name hints such as mini, haiku, flash, or up to 14B parameters), cheapest first,
  else the cheapest priced model. `/team summarizer setup` offers detect (confirm or pick another),
  pick, or decline; without a UI it prints the commands (`use <provider/model>`, `off`). Session
  start, `/team init` and `/team resume` say which model summarizes, that summaries were declined,
  or offer them.
- **Reading**: `GET /runs/:id/summaries?q=&before_seq=` (the team's agents, the lead it is linked
  under, the operator), `GET /agents/:id/thread/:member` (one member's messages both ways plus its
  task progress and completions, deduplicated against the messages that carry them, `?before=`
  pages back). Tools `team_history` (Pi and Claude Code), commands `/team history`, and the brief
  shows the latest overview.

## A structured stream for leads (v0.1.56)

- **Headlines and briefings**: `team_report_progress` takes an optional `headline` (one line, at
  most 160 characters); `team_complete_task` takes `headline` and `briefing` (up to 20,000
  characters). Both are recorded in the event store (and the task result). The lead's message carries
  the headline and `has_briefing`, never the briefing itself; the brief shows headlines (marked
  `[briefing]`), member threads show the briefing, summaries use headlines and the start of the
  briefing. Member bootstrap instructions ask for this by default; a lead or the human may ask for
  another way.
- **Sender labels**: delivered envelopes carry `from_role` and, for another team, `from_team`
  (`senderLabel`, stamped by the controller from the sender's credential). Formatting, summaries and
  the brief name senders as "Role [id] of team "Name"".
- **Grouped delivery** (`formatInbox`, used by Pi delivery, the Claude Code hooks and both inbox
  tools): one batch grouped by sender, senders with questions first; each task's progress reduced to
  the latest report, with a pointer to `team_history member` for the rest; a single sender with no
  progress stays a plain list.
- **Size-split summaries** (`fitWindow`): records that do not fit one model input (24,000
  characters) go into the next summary instead of being dropped; the next one is made right away.
- **Recursion**: a team's summary input includes the latest overview of each team linked directly
  under it (`linkedOverviews`), not their events. The brief suggests sub-leads beyond
  `MAX_DIRECT_REPORTS` (8).

## Scoped authority and the pi-team command (v0.1.58)

- **Scope** (`inScope` in `format.ts`): a session's `/team` commands act on runs whose leader works
  in the session's project, its own run, and runs linked under it at any depth (`reports_to_run_id`
  chain). `stop`, `remove`, `resume`, `tree`, `events` and `list` refuse or hide anything else, with
  a hint naming the `pi-team` command (or, for resume, opening Pi in that project). Completions
  follow the same rule. `join` still offers every team: it only places this team under another.
- **Orphans** (`isOrphaned`): not closed, not stopped, no live leader session, live members.
  Interactive session start shows one line about them (`orphanNotice`).
- **`pi-team`** (`src/cli/main.ts`, package bin): the operator's global view outside any agent
  session: `teams [--all]`, `orphans`, `tree`, `stop`, `resume`, `remove --yes`.
- **Claude Code**: `team_list_teams` lists only in-scope teams and counts the rest; `team_join`
  modes `leader` and `agent` no longer attach. They return the command the human runs with `!` in
  that session: `cli.ts takeover <run> [agent]` (`src/claude/takeover.ts`), which finds the Claude
  session through its parent process, attaches with operator authority and writes the session's
  identity; the MCP server now always heartbeats and picks the identity up.
- Not enforcement: the operator token is readable by the user's processes, agents included.

## Large teams (v0.1.59)

Found on a team with 41 members, 38 of them live with no open tasks (37 idle Pi processes, 4 GB).

- **Member strip**: when the names do not fit, it shows `team: N members, L live · ` then live
  members first, as many as fit, and `+K more · /team tree lists all`; it never overflows.
- **Roster**: `/team roster` lists current members and counts former ones; `/team roster all` lists
  everyone ever linked under you.
- **Idle members**: the brief points out members idle over 30 minutes with no open task (each keeps a
  Pi process running) and the commands that close (`/team prune`) and bring back (`/team recall`) them.

## Former members are searchable; takeovers say what happened (v0.1.60)

- **Closing a member** already stops its process and keeps its identity, transcript and task history;
  `/team recall` brings it back with that context. What was missing was finding the right one.
  Roster entries now carry `missions` (task count; the five newest non-cancelled tasks with status
  and headline or summary), and `GET /agents/:id/roster?q=` keeps entries whose role,
  responsibility, task titles, summaries, headlines or briefings mention every word.
  `/team roster [all] [words…]` and `team_roster list` (`query`, `all`) use them
  (`formatRoster`); `team_create_member` and `team_roster` tell the lead to search former members
  before recruiting for similar work.
- **Takeovers**: "this session was FENCED" is replaced by what happened and what to do: another
  session took over the agent; this one no longer acts for it; `/team resume <run> <agent>` takes
  it back; `/team inspect <agent>` finds the other one. Where the controller can tell, a second line
  says when that session started, its process and its Pi transcript. The status line reads "taken
  over by another session".

## The leader comes back (v0.1.61)

Reported by a bb leader whose respawned Pi found its team stopped and stayed out of it until the
operator ran `pi-team resume`.

- A stop now records its `cause` when only the leader's absence caused it: `leader_exit` (the exit
  policy ran as the leader's Pi ended; `POST /runs/:id/stop {cause}`) or `leader_absent` (the
  leaderless-team sweep). Stops anyone decided on carry no cause.
- When the same leader session returns (`resumeIfOnlyAbsent`: on restore, or when its credential is
  revoked while it is alive), a team stopped for one of those causes resumes and the session
  re-attaches, unless another Pi session has taken the agent over since. Deliberate stops still wait
  for `/team resume`.
- Team lists in sessions say "no leader session" for running teams whose leader is not connected.
