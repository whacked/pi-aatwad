# 00 — Product contract: installable Pi extension

## User-visible design

1. User installs the eventual package with Pi's package manager (`pi install ./path/to/package`, or a published npm/git spec). Package contains extension AND local controller/executor code as ordinary Node dependencies/entries.
2. User runs normal `pi`. Extension initializes a controller client; it does not auto-create a new organization without explicit `/team init` or configured opt-in enrollment.
3. `/team init` registers current session as organization root (or `/team join <invitation>` enrolls an authorized managed session). Controller is started/discovered automatically via per-user socket/data directory; no manual second process step.
4. Every new child Pi process is launched with the extension installed and explicit, short-lived enrollment credential plus stable agent and spawn-intent identifiers. Its model/provider and workspace are selected by policy.
5. `/team tree`, `/team status`, `/team budget`, `/team inspect <agent>`, `/team stop` work within Pi. `/team watch` / tmux is optional; all functions work without tmux.
6. On subsequent Pi launches, organization persists; `/team resume <run>` or explicit reconnect restores membership/inspection. Do not silently enroll an unrelated session by cwd alone.

## Single-package, two-process architecture

`Pi parent/worker (extension/client)` <-> `local controller (background singleton)` <-> `SQLite + durable scheduler` <-> `managed Pi worker processes`.

A Pi extension is loaded within the agent's process; if it were sole coordinator, ending the root Pi TUI could orphan workers and lose budget control. Therefore controller is a **separate background process shipped inside the same package**, auto-started on demand. This is not a separately installed service.

**Bootstrap race:** use a per-user state-directory lock + atomic socket ownership and readiness handshake; if two Pi processes start concurrently, at most one controller accepts ownership of the data root. Failed/startup handshake is retried with bounded backoff. Do not trust an unrelated stale socket; validate peer identity and readiness. Do not use a world-accessible `/tmp/agent-org.sock` as default.

**Controller lifecycle:** controller owns workers, not the interactive Pi process. It stays alive when active workers/tasks or outstanding leases exist. When idle, it may exit; new Pi instance relaunches and reconciles. During package upgrades ensure schema compatibility/migration and avoid two controllers writing the same DB. Document service supervision fallback (launchd/systemd-user optional, not required). Installer must not silently configure privileged global services.

**Child enrollment:** controller mints short-lived, scoped, single-use enrollment credentials bound to spawn intent and agent. Spawn environment passes token through a protected channel or protected temporary file; never put secrets in command-line arguments or logs. Child extension performs enrollment handshake, then receives scoped authority; no `team init` from managed child. Never grant arbitrary root privileges to children.

## Official extension surface

Use Pi package manifest (`pi.extensions`) and documented extension APIs for `registerCommand`, `registerTool`, events, and UI; implement a thin typed controller client. Keep process supervision/SQLite writes out of extension event handlers. See https://pi.dev/docs/latest/extensions and https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs for current API; pin tested Pi version. `pi install npm:...` is valid only once code is published under that name.

## Default behavior and privacy

No organization creation on install. Session identity comes from controller registration and explicit persisted agent mapping, not unstable cwd or TUI pane identity. Controller stores minimal run metadata and references to Pi transcripts; do not copy all transcripts across agents automatically. No provider secrets in SQLite, protocol payloads, or agent prompts.

## Non-goals

A fully peer-to-peer serverless organization; a daemon inside every Pi session; multi-user network service; production OS sandbox; cross-harness workers in v1. The controller APIs should permit later adapters.
