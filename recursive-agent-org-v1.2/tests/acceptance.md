# Acceptance checklist (automate these)

**Product gate:** all tests in `tests/extension-acceptance.md` also pass; no separate manual daemon installation.

## Structural
- [ ] Root has no active parent; each other agent exactly one active parent.
- [ ] Reparent rejects cycles and cross-run edges.
- [ ] A manager can itself be subordinate and sponsor requests for subordinates.
- [ ] Historical reporting edges remain inspectable.

## Approval & authority
- [ ] Unapproved expansion never spawns.
- [ ] Parent approval within envelope succeeds; beyond envelope escalates.
- [ ] Root cannot override hard global caps.
- [ ] Concurrent sibling approvals cannot overcommit any ancestor allocation.
- [ ] Denied/amended proposals retain request/decision audit trails.

## Persistence
- [ ] Duplicate request with identical idempotency key returns same result.
- [ ] Same key with different payload fails.
- [ ] Repeat spawn-delivery does not create a second worker.
- [ ] Crash between durable spawn intent and process start recovers correctly.
- [ ] Crash between process start and status commit reconciles process before retry.
- [ ] Restart preserves tasks, messages, sessions, approvals, and topology.
- [ ] Inbox redelivery is harmless after receiver processing.

## Models & tools
- [ ] Child can use different provider/model from parent.
- [ ] Model and tool availability constraints reject invalid choices.
- [ ] Model switch creates a new session under same agent ID.
- [ ] No direct SQLite access from untrusted agent tool context.

## Lifecycle, cost & workspace
- [ ] Pause/resume/cancel/retire honor permissions and revoke tokens.
- [ ] Release slots/reservations on terminal process; preserve consumed cost.
- [ ] Provider usage reconciles estimated vs actual costs where supplied.
- [ ] Workspace traversal is rejected; concurrent worker worktrees are isolated.
- [ ] Logs contain audit trace IDs but no API secrets.

## Required end-to-end
- [ ] Run all steps in `examples/demo-scenario.md` with repeatable output.

## Topology and crash/recovery v1 release gates (mandatory)
- [ ] Killing root Pi process leaves tracked children alive under the declared root-failure policy; controller remains healthy; reattached root keeps original agent ID.
- [ ] Killing a non-root manager does not orphan descendants; their reporting edges and reserved budgets survive; manager resumes as same agent with a new session attempt.
- [ ] Killing a worker, then resuming it, preserves task, inbox, context reference, and agent ID. No duplicate process or message effects.
- [ ] Killing/restarting controller reconstructs current tree, reconnects live sessions, fences stale attempts, and reconciles uncertain spawns without duplicate agents.
- [ ] Reparenting a manager moves its entire subtree atomically; history shows old/new manager; no transient orphan is observable.
- [ ] Reparenting an individual while retaining its former children requires explicit reassignment policy; invalid policy is rejected.
- [ ] Reparent race with expansion approval or simultaneous move detects stale topology version; exactly one valid outcome commits.
- [ ] Cycle, cross-run join, over-budget destination, or unauthorized transfer rejects without mutating topology or allocation.
- [ ] Stale proposal reviewer/approval from previous parent cannot create an unauthorized new child after a move.
- [ ] Pi session fork/branch does not silently create duplicate organizational identity; deliberate attach/fork/detach is tested.
- [ ] After compaction/reparent/resume, effective model context includes current parent, active grants and pending commitments from SQLite, not obsolete cached hierarchy.
