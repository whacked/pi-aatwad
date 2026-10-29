# 06 — Work packages and delivery order (Pi-extension-first)

## M0 — Single installable Pi package skeleton **(mandatory first)**
TypeScript repository/package with `src/extension/index.ts`, `src/controller`, `src/executor`, `src/shared`. Pi package manifest `pi.extensions` references the real extension entry. Validate installing from local package (`pi install ./...`); launch ordinary Pi; expose `/team help` and `/team status`. Pin/test a Pi release. No separately installed controller. Include a smoke test that Pi can load the extension after install and `/reload` does not duplicate controller instances.

## M1 — Controller auto-bootstrap and enrollment **(mandatory)**
Per-user socket/data directory with permissions; single-instance lock and readiness handshake; idle shutdown policy. Extension starts controller on demand and authenticates as local Pi session. `/team init` explicitly registers root; managed child uses enrollment token instead. Controller restart + Pi reconnection works. Concurrent two-Pi initialization yields exactly one controller. Controller is a supervised background process, not bound to parent process lifetime.

## M2 — Durable organization, tasks and messages
SQLite migrations, runs/agents/temporal edges/sessions/tasks/event log/outbox/inbox; scoped API, idempotency, replay; Pi `/team tree`, `/team inbox`, and `get_team`/`send_message`/`delegate_task` tools. Verify sessions persist when TUI exits.

## M3 — Expansion governance and model routing
Proposal/decision/escalation workflow, budgets/slots, reservations, global caps and model catalog. Agent tools `request_expansion`, `review_expansion`, `get_models`, `get_budget`. Atomic decision/reservation before spawn. Parent review can occur using normal Pi tools while manager itself is a subordinate.

## M4 — Pi workers, multi-provider recruitment and recovery
Controller launches Pi workers using explicit extension+scoped enrollment credentials, selected model and dedicated worktrees. Worker handshake and session identity, heartbeat, graceful stop, restart reconciliation and no duplicate spawns. Parent TUI exit does not kill descendants; controller death/restart reconciles processes. Two configured model/provider options. Document credentials and budget enforcement limits.

## M5 — UX and demo
`/team inspect`, `/team status`, `/team stop`, `/team resume`, `/team budget` operational; optional tmux observer. Full nested escalation scenario demonstrated entirely from a normal interactive Pi. Record tree, decision history, message audit and model choices. Installation and uninstall docs, troubleshooting and cleanup.

## M6 — Hardening gate
20 concurrent workers if practical, races at approval and bootstrap, package upgrade/schema migration, bad tokens, client reconnects, interrupted process handshakes, policy bypass risk disclosure, and cancellation cleanup. No NATS before measured need.

## Suggested responsibility split
- Developer A: Pi extension shell, commands, tools and enrollment UX.
- Developer B: controller lifecycle, durable data model, messaging.
- Developer C: governance, budgets, model policy.
- Developer D: Pi worker launcher, recovery, end-to-end tests.

## Definition of shipped v1
A **working installable Pi extension** with automatic local controller, not a stand-alone CLI that happens to run Pi workers. Tests in `tests/acceptance.md` pass. Deliver source, installable artifact, migrations, demo and limitations. `examples/package.manifest.example.json` is illustrative; adapt/verify against pinned Pi release.

**Release blocker:** tests in `tests/acceptance.md` under “Topology and crash/recovery v1 release gates” must pass before v1 release. Implement `db/002_runtime_and_topology.sql` and `docs/08-recovery-topology-and-context.md`.
