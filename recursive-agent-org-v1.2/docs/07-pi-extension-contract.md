# 07 — Pi extension implementation contract

## Extension initialization
`src/extension/index.ts` is a documented default-export Pi extension factory. Register commands and tools immediately so users can interact with unloaded/idle controller state. Do **not** asynchronously spawn a controller every time the factory loads; use a shared, idempotent `ensureController()` promise/client. When session context becomes available, identify whether session is (a) enrolled managed child, (b) previous root/member being explicitly resumed, or (c) unenrolled standalone Pi. Handle `/reload`, session switches, end and process shutdown without killing organization members.

## Human-facing commands (proposed; adapt to actual API syntax)
- `/team init [config]` — explicit root registration; prints run ID and available budget.
- `/team resume <run_id>` — explicit join/resume by authorized local principal; do not adopt another agent ID blindly.
- `/team tree` — live logical hierarchy (not only active processes).
- `/team status` — controller status, run, agent, session, pending work.
- `/team budget` — subtree limits and actual/reserved usage.
- `/team inbox`, `/team proposals` — durable messages, approvals.
- `/team inspect <agent_id>` — tasks, history, model, worker status; optional attach.
- `/team stop <agent_id|run_id>` — authorized controlled cancellation.
- `/team watch` — optional tmux viewer; no correctness dependency.

## Tools exposed to all agents
`team_send_message`, `team_delegate_task`, `team_request_expansion`, `team_review_expansion`, `team_get_tree`, `team_get_inbox`, `team_report_progress`, `team_complete_task`, `team_get_models`, `team_get_budget`. Implement schema validation in the extension for usability and again in controller for authority. Tool availability is identical across roles; controller decides which actions are authorized. Tool calls use actual authenticated actor identity, not a caller-supplied string.

## Session start and context
Inject small role/task/policy context when relevant using documented Pi extension hooks (verify precise hook names in pinned API). Avoid dumping entire org tree and transcripts into context. The controller sends task summaries and messages via durable inbox, with explicit acknowledgement after incorporation. Do not assume Pi's append-only session JSONL is central org state. Keep session ID link as metadata.

## Auto-start mechanics
- Directory defaults: `${XDG_STATE_HOME:-~/.local/state}/pi-recursive-team/` on Unix, with platform-specific app data on macOS/Windows; secure `0700` directory; Unix socket under user-specific runtime/state path; SQLite and lock files there.
- A controller process obtains exclusive process lock and starts listener; a contender waits for a valid handshake, never starts a second writer.
- `ensureController()` first pings existing instance; on no response attempts launch and polls readiness with timeout; on error reports clear recoverable message in Pi.
- Controller reports protocol/schema version; reject incompatible client, avoid concurrent migrations.
- Worker processes launched with stable intent ID and restricted one-time enrollment capability. The extension joins the correct run and recognizes parent automatically after handshake.
- Terminating root Pi does not terminate controller/children. Clean stop is explicitly requested via `/team stop`, or idle controller self-shutdown when no active work.

## Workspaces
Root can use the current project; managed child gets a worktree or isolated directory linked to scoped task. Never run multiple write-capable workers in same Git checkout by default. Workers inherit safe environment subset; API keys are resolved via configured provider environment, not sent in team messages.

## Compatibility and packaging
- Follow current https://pi.dev/docs/latest/extensions for TypeScript imports, commands/tools, Pi manifest and package loading.
- Build should include all runtime dependencies in `dependencies` (not solely `devDependencies`) when needed at runtime.
- Pi model identifier / `--model` invocation and session flags MUST be verified against pinned version via integration smoke test; do not assume across versions.
- Package uninstall must not silently destroy SQLite state or kill independently running jobs; offer explicit stop and purge flow.

## Launch lifecycle tests
Test install, first launch, init, managed child extension auto-enrollment, parallel Pi launch, root UI exit, controller restart, extension reload, Pi upgrade incompatibility, uninstallation, and state preserved across reinstall.
