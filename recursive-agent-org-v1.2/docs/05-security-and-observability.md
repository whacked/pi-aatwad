# 05 — Safety, limits, observability and UI

## Enforcement boundary
Pi extensions and tool policies are not a security sandbox. A child with arbitrary shell access may launch unmanaged processes, bypass managed-agent quotas, or access local credentials. v1 enforces controller-managed recruitment and budgets only. Strong prevention requires OS/container isolation and credential controls in a later release.

## Resource governor
Global: max live agents, maximum pending spawns, max tree depth as emergency guard, max wallclock per run, max spend, max context tokens, allowed providers/tool capability sets. Per subtree: delegated live-slot quota, spend allocation, token quota, and cumulative consumed cost. Atomically reserve before spawn. Reserved currency is an estimate; stop agents when budget thresholds are reached; reconcile with actual provider usage. Cost reporting is approximate until reconciled.

## Agent sandbox
Do not assume a spawned agent is isolated just because it is in a new tmux pane. v1 uses separate work directories / Git worktrees, tool allowlists, scoped controller tokens, limited local OS credentials where feasible, and explicit human/operator approval for dangerous system actions. No arbitrary execution of external scripts with elevated rights. Future multi-tenant environments require OS/container sandboxes and network policy.

## Workspace & merge
Task-specific Git worktree; child agents cannot concurrently modify parent's working tree. Ownership and final merge belong to designated task/manager. Git commit SHA + artifact checksum are stored in task outcomes. Controller rejects paths escaping registered workspace roots.

## Observability
Structured JSON logs: `run_id`, `agent_id`, `session_id`, `task_id`, `proposal_id`, `event_id`, `trace_id`, `model`, `duration_ms`, token usage, estimated cost. Extension commands query controller projections and audit log: `/team tree`, `/team inbox`, `/team proposals`, `/team budget`, `/team events`, `/team inspect <agent>`. Internal standalone CLI is optional for diagnostics. Export JSONL event stream for analysis.

## tmux
`org attach <agent>` creates/attaches to selected worker's live terminal when available. `org watch` opens a manager plus its immediate reports within current tmux size/pane constraints, hiding extra workers rather than crashing or resizing indefinitely. tmux is an observer, not the source of parent/child ownership.

## Failure rules
Hard cap reached -> deny expansion or allow a request to queue subject to deadline. Parent unavailable -> request stays pending; optional operator escalation, never autoapprove. Agent failed -> manager notified and task blocked/requeued per policy. On cancelled subtree -> revoke credentials, stop processes, settle reservations, preserve audit.
