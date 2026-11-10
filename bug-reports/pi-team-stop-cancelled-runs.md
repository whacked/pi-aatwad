# Bug report: stopped teams remain RUNNING; repeated `/team stop` fails with CONFLICT

**Upstream:** https://github.com/whacked/pi-aatwad  
**Component:** pi-recursive-team extension/controller, not Pi core  
**Investigated:** 2026-11-10  
**Installed version:** 0.1.2  
**Source revision:** `4a922f93311a404b0696eb4af04a4384ced459d1` (clean package checkout)  
**Environment:** Linux, Pi 1.4.0, Node v26.12.0, tmux 3.8, native SQLite controller over Unix socket.

## Summary

`/team stop <run_id>` successfully cancels the root/subtree on its first invocation,
but does not update the corresponding run's persisted status. `GET /runs` therefore
continues reporting that stopped team as `RUNNING`. Repeating the stop command
uses a new request idempotency key and fails with:

```text
Error: /team stop: CONFLICT: agent is already CANCELLED
```

This makes historical cancelled organizations look like live, unkillable teams.
In the observed installation this was **not evidence of surviving managed workers**:
the affected agents/sessions were already stopped. Two separate behaviors combine:

1. Run lifecycle state is stale after root cancellation.
2. Stop is not semantically idempotent across distinct command invocations.

There is no need to delete organization history or edit SQLite to demonstrate it.

## User-visible reproduction

1. Start Pi with the package installed.
2. `/team init` (no workers are necessary).
3. Note the run ID; `/team stop <run_id>` and confirm.
4. Inspect the run listing/status or the run-ID completion suggestions.
5. `/team stop <run_id>` again and confirm.

**Actual:** first stop succeeds; run is still listed `RUNNING`; second stop emits
`CONFLICT: agent is already CANCELLED`.

**Expected:** stopping a run updates its run lifecycle status consistently with its
root/subtree. Repeating stop should report an already-stopped/no-op success, not an
operational failure. Historical records may remain visible, but must not claim to
be running. Stopping a cancelled agent is different from attempting to resume it;
resume/attach to terminal agents should still be rejected.

## Independently verified offline reproduction

Companion script: [`reproduce-team-stop.mjs`](reproduce-team-stop.mjs).
Run against the upstream checkout:

```sh
node --experimental-strip-types reproduce-team-stop.mjs /path/to/pi-aatwad
```

It imports the upstream controller test harness, creates **isolated temporary state**,
uses its fake executor, calls the real HTTP handlers, and removes its temporary state
in `finally`. It does not contact a model, spawn Pi workers, use the user's operator
credentials, or access the live controller. Its original assertions confirmed the reported bug. The companion script now
asserts the fixed behavior introduced in v0.1.8; the observed output below is
retained as historical evidence.

Observed output (IDs omitted by the script):

```json
{
  "first": { "http": 200, "status": "CANCELLED" },
  "same_key_replay": { "http": 200, "status": "CANCELLED" },
  "second_with_new_key": {
    "http": 409,
    "error": { "code": "CONFLICT", "message": "agent is already CANCELLED" }
  },
  "run_listing_status": "RUNNING",
  "agents": [
    { "status": "CANCELLED", "desired_state": "RETIRED", "observed_state": "STOPPED" }
  ]
}
```

The same-key replay succeeds: transport-level idempotency works. A fresh stop command
has a fresh key, so it reaches the terminal-state guard and fails. This is not an
idempotency-cache replay failure or a tmux rendering failure.

## Source trace at the revision above

- [`src/extension/commands.ts:210–233`](https://github.com/whacked/pi-aatwad/blob/4a922f93311a404b0696eb4af04a4384ced459d1/src/extension/commands.ts#L210-L233):
  `stop` resolves a run ID to its root and calls agent lifecycle with
  `{action: "cancel", children_policy: "cascade"}`. The comment explicitly says
  the protocol has no run-level stop.
- [`src/controller/topology.ts:184–222`](https://github.com/whacked/pi-aatwad/blob/4a922f93311a404b0696eb4af04a4384ced459d1/src/controller/topology.ts#L184-L222):
  `terminateAgent` updates agents, sessions, spawn intents, tasks and reservations,
  and schedules managed process shutdown. It does not transition `runs.status`.
- [`src/controller/topology.ts:235`](https://github.com/whacked/pi-aatwad/blob/4a922f93311a404b0696eb4af04a4384ced459d1/src/controller/topology.ts#L235):
  `if (isTerminal(subject.status)) fail("CONFLICT", ...)` runs before action-specific
  handling or descendant cleanup; it rejects repeated cancellation.
- [`src/controller/runs.ts:91`](https://github.com/whacked/pi-aatwad/blob/4a922f93311a404b0696eb4af04a4384ced459d1/src/controller/runs.ts#L91):
  run creation persists `status = 'RUNNING'`.
- [`src/controller/runs.ts:119–123`](https://github.com/whacked/pi-aatwad/blob/4a922f93311a404b0696eb4af04a4384ced459d1/src/controller/runs.ts#L119-L123):
  `listRuns` returns that persisted `r.status` without deriving it from the root.
  Its `agents` count includes historical/terminal agents, not just live workers.
- `src/extension/commands.ts:251–260`: run completions use the listing and display
  the stale status. There is no status filter for stop suggestions.
- Source search found no `UPDATE runs SET status` anywhere under `src/` at this
  revision. `RunStatus` already includes `CANCELLED`, so the missing transition is
  not a schema inability to represent cancellation.

No source patch was installed as part of this investigation.

## Local incident and shutdown outcome

The project `.team/` directory contains human-maintained board/status files; it is
**not the plugin's authoritative run index**. Git worker checkouts live under
`.team-worktrees/`. The actual run registry is the per-user controller's
`${XDG_STATE_HOME:-~/.local/state}/pi-recursive-team/org.sqlite`.

All nine controller runs had roots belonging to this project. Before cleanup:

- Nine run rows claimed `RUNNING`.
- Eight roots were already `CANCELLED`; all their descendants were stopped.
- One remaining root was logically `RUNNING` / observed `LOST`, with no process PID.
- Repeating cancellation of each of the eight terminal roots reproduced HTTP 409.

The remaining nonterminal root was cancelled through the authenticated lifecycle API
with cascade (HTTP 200). Post-cleanup checks found:

```text
project runs:                          9
agents CANCELLED / RETIRED / STOPPED: 22
sessions without ended_at:            0
spawn intents:                       13, all CANCELLED
managed Pi worker processes:          0
team dashboard/dead managed panes:    0
```

All nine run records still said `RUNNING`, demonstrating the stale-index defect even
after complete shutdown. The controller was then cleanly stopped through
`POST /controller/shutdown` (HTTP 200, `{"stopping":true}`), and process inspection
confirmed it exited. History/transcripts/worktrees were preserved. Run status was
not manually rewritten, so upstream evidence remains intact. A later team command
may auto-start the controller; that is documented normal behavior, not a new team.

Separate Claude/Codex sessions and project service/pipeline processes were not part
of this Pi run registry and were not killed. Stopping a managed organization should
not mean killing arbitrary same-user processes.

## Suggested fix scope

1. Make run cancellation a coherent, transactional lifecycle operation, or update
   the run row when its root is cancelled with cascade. Emit a run lifecycle event.
2. Repeated cancellation of an already-cancelled target should return an explicit
   successful no-op result after normal authorization checks. Preserve the existing
   rejection for invalid transitions such as resuming a terminal agent.
3. Handle partially cleaned-up state: a cancelled root must not prevent cleanup of
   surviving descendants, pending spawns, or remaining managed processes. Merely
   turning this 409 into an early 200 is insufficient for recovery scenarios.
4. Reconcile/migrate preexisting rows whose roots are terminal but whose run status
   is still `RUNNING`. Do not delete history as a workaround.
5. Display terminal runs accurately in listings; optionally default stop completions
   to actionable runs or clearly label already-stopped entries. Distinguish total
   historical agent count from live/starting worker count.

## Proposed regression cases

- First root cascade cancel: root/descendants terminal, tasks/spawns cancelled,
  unspent reservations released, sessions ended, executor stop invoked, **run status
  CANCELLED** and event recorded.
- Repeated stop with a **new** key: successful already-stopped response, no duplicate
  accounting releases, lifecycle side effects, or inconsistent timestamps.
- Replay using the **same** key: original response retained (existing behavior).
- Repeat after controller restart: same semantic no-op success.
- Cancelled-root fixture with nonterminal descendant or leftover process: cleanup
  still runs; do not return success while leaving managed work alive.
- Non-root cancellation: parent run remains running while it still has active work.
- Terminal-root run listing/completions and preexisting stale-row reconciliation.
- Authorization remains enforced for no-op cancellation; attach/resume remain fenced.

## Sharing notes

This report and the companion fake-executor reproduction contain no credentials,
PDK material, layouts, or transcripts and are suitable to send upstream. Full local
API evidence is deliberately not embedded or recommended as an upstream attachment.

## Resolution (v0.1.8)

The controller now retries cleanup for cancelled roots and terminal descendants,
reconciles persisted terminal run statuses at startup, and records run status
transitions. Regression coverage includes new-key retries, same-key replay, restart,
partial cleanup, surviving processes, budget settlement, authorization, and
terminal attach/resume fencing. See `test/controller/stop.test.ts`.
