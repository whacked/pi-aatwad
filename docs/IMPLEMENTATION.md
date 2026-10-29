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
- Workers are **one-shot**: the process exits when its prompt settles (observed STOPPED, not a failure). The controller relaunches with `resume=true` on the **same** `--session` file when the agent has unacked inbox deliveries or an open task. In the worker, the extension claims the inbox in `before_agent_start` and once more in `agent_before_settle` (one guarded continuation, at most 20 per process).
- Worker env is an allowlist (`src/executor/env.ts`). Workers get `PI_TEAM_ENROLL_FILE` and `PI_TEAM_LAUNCH_TOKEN` but **not** `PI_TEAM_STATE_DIR`. In managed mode the extension uses only the enroll file's `socket_path`, never reads `operator.token`, and never starts a controller.
- Process identity = pid + process start time (`ps -o lstart= -p PID`) + launch token stored in `sessions`.
- Tests/demo use `PI_TEAM_EXECUTOR=<node script>`: a fake worker that speaks the same enrollment/heartbeat/tool HTTP protocol without an LLM, so no paid credentials are required.

## Governance accounting
- An approval is a grant from the reviewer's pool. Reservations are recorded at **every** ancestor, so siblings cannot overcommit. Global hard caps (`max_live_agents`, `max_pending_spawns`, `emergency_max_depth`, `max_run_usd`, `max_run_seconds`, `allow_providers`) are checked first and cannot be overridden by root.
- `max_run_usd` counts consumed spend across the run (root included) plus the unconsumed part of active reservations. On terminate, the unspent part is released and a settled charge (`BudgetView.settled_usd`) stays at each ancestor.
- Deadlines: per-session, per-role runtime and per-run wallclock. Policy `BLOCKED` (default: pause and keep budget) or `FAILED`.

## Controller tunables (env, positive integers in ms unless noted)
`PI_TEAM_IDLE_MS`, `PI_TEAM_CLAIM_MS`, `PI_TEAM_HEARTBEAT_LEASE_MS`, `PI_TEAM_TICK_MS`, `PI_TEAM_LAUNCH_GRACE_MS`, `PI_TEAM_ENROLL_TTL_MS`, `PI_TEAM_HUNG_MS`, `PI_TEAM_MAX_LAUNCH_ATTEMPTS` (count), `PI_TEAM_MAX_RESTARTS` (count). See `src/controller/main.ts`.

## Verification
- `npm test`: unit + integration tests for controller, executor and extension, plus two e2e tests: `test/e2e/demo.test.ts` (the 9-step `examples/demo-scenario.md` against a real controller process with fake workers, including SIGKILL of the controller mid-delivery) and `test/e2e/real-pi-worker.test.ts` (real `pi` worker with a local fake OpenAI-compatible model).
- `npx tsc --noEmit` is clean. `bash scripts/demo.sh` writes `demo-output/`.
- The code was independently reviewed twice; every finding (8 initial, 4 from the re-review) was fixed with regression tests (`test/controller/review-fixes*.test.ts`).

## Not in v0.1 (known gaps against the brief)
- tmux `/team watch`; git worktree merge/cleanup; Windows IPC; npm-registry install (needs a JS build).
- Model switch for an existing agent (new session under the same agent ID) has no API yet.
- Usage reconciliation only sums worker-reported `/sessions/usage`; nothing pulls usage from providers.
- Fork-as-new-agent and detach attach modes. A forked Pi session gets a notice and must `/team resume` explicitly.
- No compaction-hook test for org context. Context is re-fetched from `/me` on every `before_agent_start`, never cached.
- `pending_work_policy=reassign` only sends a handoff notice; it does not re-own tasks. The outbox is logged, not consumed externally.
- Same-uid workers are not isolated (see README Limitations).
