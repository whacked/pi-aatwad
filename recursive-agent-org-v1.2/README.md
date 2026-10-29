# Recursive Agent Organization — v1 developer implementation handoff (Pi extension first)

**Status:** implementation specification, NOT functional software. **Product:** one installable Pi package; it equips any enrolled Pi session with recursive agent-team abilities. **Architecture:** TypeScript Pi extension + auto-managed local singleton controller + SQLite WAL + Pi worker processes (optional tmux observer).

## Required end-user experience

After developer builds/publishes the package, a user can run `pi install ./path/to/implemented-package` (or `pi install npm:<published-name>`) and launch ordinary `pi`. **Neither package name nor install command is usable from this handoff ZIP.** A `/team init` command enrolls the current Pi session as a root in a persistent organization. The extension automatically discovers/starts the controller, and every worker inherits the same extension. User can query `/team tree`, `/team status`, `/team budget`, `/team inspect <id>`, `/team stop`, and optionally `/team watch` (tmux). Agents gain organization tools to propose and review expansion, send messages and delegate tasks. No manually managed second application for routine use.

## Read in this order

1. `docs/00-product-and-install.md` — product boundaries, installation, onboarding, controller process lifetime.
2. `docs/01-scope.md` and `docs/02-architecture.md` — business rules and controller topology.
3. `docs/07-pi-extension-contract.md` — exact integration responsibilities and process bootstrap.
4. `docs/03-api-and-lifecycle.md`, `contracts/`, `db/` — authoritative controller contracts.
5. `docs/06-build-plan.md`, `tests/acceptance.md` — implementation and release gates.

## Hard architectural invariants

- **Every participating Pi is equally capable**, with authority limited by controller grants, not extension feature differences.
- **Extension = UX and narrow client**, controller = authoritative global scheduler, SQLite = durable source of truth. Extensions cannot write org database.
- **One controller per local user/data-root**, auto-started safely and independently of any Pi leader session. It stays alive while managed workers are active. Controller death can be recovered on later Pi launch or by supervised restart; no reliance on a root Pi process staying alive.
- **Hierarchy is a graph of responsibilities and historical reporting edges**, not nesting of Pi processes or tmux panes.
- **Proposals, authorization, allocation, and process provisioning are distinct durable operations.** No double spawn on retries.
- **Limits are enforceable only for managed workers.** Pi tools or arbitrary shell access are NOT a sandbox against unmanaged process spawning or resource usage.
- **SQLite WAL first; no NATS, Temporal or required separate operator daemon installation in v1.**

## Package layout and interfaces

`package.json` must expose a Pi extension via a `pi.extensions` manifest entry. Implementation target is `src/extension/index.ts`, `src/controller/*`, `src/executor/*`, and `src/shared/*`, bundled in the same npm/Git package. A command-line internal controller entrypoint may be included but is not a separate user installation. See `examples/package.manifest.example.json` for metadata shape (NOT a runnable package).

## Deliverable from dev

A real versioned and installable Pi package, source/tests, SQLite migrations, runnable example demo, recovery test logs, and docs showing zero-manual-daemon startup; package passes `tests/acceptance.md`. This ZIP is the engineering brief, not the deliverable runtime.

## Required topology and recovery spec (v1.2)
Read `docs/08-recovery-topology-and-context.md` before implementing the controller. Apply `db/002_runtime_and_topology.sql` after `db/001_init.sql`. Mandatory tests are in `tests/acceptance.md`. A stable logical agent ID is independent of manager, Pi session, model and OS process. Reparenting transfers the subtree by default; recovery restores agent identity and current reporting hierarchy.
