# 01 — Scope and success criteria

## Problem
Existing agent teams are mostly flat and harness-specific. v1 supports an agent that is simultaneously a subordinate and a manager, with requests for additional capacity reviewed upward. Model/provider selection is made at recruitment time and validated centrally.

## Product requirement
The deliverable must be a **single installable Pi package** that extends ordinary Pi sessions; a local controller is auto-discovered/started by the extension and requires no separate manual installation. `/team init` explicitly creates the root. All participating Pi sessions load the same extension and can recruit according to delegated authority.

## Must-haves
1. One logical organization and root agent per run. Any member may request subordinate agents.
2. Agents can send durable typed messages and delegate tasks to direct reports. One task can have child tasks.
3. Agents propose expansions with expected responsibilities, model preference/capability, costs and alternatives. Parents may approve/reject/amend/escalate; controller enforces delegated authority.
4. Dynamic role assignment and reparenting of agents; maintain historical edges.
5. Concurrent agent cap; per-subtree currency/token/slot budget; per-agent runtime deadlines; safe failure modes.
6. A model catalog supporting multiple provider/model IDs; Pi executor implements at least two configured backends, including same model as leader.
7. Persistent SQLite state, message outbox, crash-safe reconciliation, CLI inspection, and artifact references.
8. Bootstrap root via `/team init` inside Pi; pause/resume/cancel via Pi commands; inspect trace and tree; graceful shutdown. Standalone CLI is optional diagnostics only.
9. Auto-start/discover controller, child enrollment handshake, independent controller lifetime, single-package distribution and restart without root Pi alive.

## Explicit non-goals
- Multi-node workers, remote multi-tenancy or provable isolation.
- Fully autonomous promotions/reorganizations without authorization.
- Rich browser UI (tmux attach is an optional observer).
- Agent-driven shell privilege escalation or self-modifying policy.
- Concurrent edits to a shared uncoordinated worktree.

## Invariants
- Exactly one **active** parent for each non-root agent; root has none. Reparenting cannot introduce cycles.
- No agent controls the governor or edits its own allocation directly.
- Every spawned agent traces to an approved proposal or the root bootstrap.
- Reservation precedes spawn; release/reconciliation follows termination.
- Agent identity survives process or model changes; process session does not.
- Messages and decisions are append-only audit events, with mutable projections for efficiency.
- Controller owns state transitions; LLM output is untrusted proposed action.
- Every mutation has a stable idempotency key; retry returns prior result.

## Definition of done
Demonstrate Root -> Lead A -> Worker B -> Worker C with an escalation, differing models, a refused expansion, reparenting, controller restart, and no double spawn / overspend. Show SQL audit history and CLI tree at end. All tests in `tests/acceptance.md` green.
