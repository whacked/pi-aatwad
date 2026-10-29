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
- Launch: `pi --mode json -p --session <session file> --provider P --model M -e <package extension path> "<bootstrap prompt>"` with env `PI_TEAM_ENROLL_FILE` and `PI_TEAM_STATE_DIR`. (Exact flags verified against Pi 1.4.0 by the executor smoke test.)
- Process identity = pid + process start time (`ps -o lstart= -p PID`) + launch token stored in `sessions`.
- Tests/demo use `PI_TEAM_EXECUTOR=<node script>`: a fake worker that speaks the same enrollment/heartbeat/tool HTTP protocol without an LLM, so no paid credentials are required.

## Not in v0.1
tmux watch, git worktree merging, provider usage reconciliation beyond reported usage, Windows IPC.
