# pi-recursive-team

A Pi package that lets ordinary [Pi](https://pi.dev) sessions run **recursive agent organizations**. A root session recruits leads, and leads recruit workers. Every expansion is proposed, reviewed up the chain, budgeted, and audited by a local controller that starts automatically.

Implements the v1.2 brief in [`recursive-agent-org-v1.2/`](recursive-agent-org-v1.2/README.md). The concrete engineering decisions are recorded in [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).

**Status: v0.1, the first implementation.** It is tested against Pi 1.4.0 and Node 24. See [Limitations](#limitations).

## Install

```bash
pi install ./path/to/pi-recursive-team     # local path (works today)
pi                                          # ordinary Pi
```

> `pi install npm:…` is not usable yet. Node refuses type-stripping inside `node_modules`, so an npm release needs a JS build step first.

Requires Node ≥ 22.13 (for built-in `node:sqlite` and type stripping). There are no runtime npm dependencies.

## Use

Inside Pi:

| Command | What it does |
|---|---|
| `/team init [config.json]` | Makes this session the **root** of a new organization. This is the only way an org is created; installing the package creates nothing. |
| `/team resume <run_id> [agent_id]` | Deliberately re-attach this session to an existing run or agent. This fences any older session of that agent. |
| `/team tree` / `status` / `budget [agent]` | Live logical hierarchy, controller and run status, limits and reservations. |
| `/team inbox` / `proposals` / `events` | Durable messages, expansion reviews, audit log. |
| `/team inspect <agent_id>` | Tasks, sessions (model, pid, transcript), reporting history, budget. |
| `/team stop <agent_id\|run_id>` | Controlled cancellation. Cascades to the subtree, revokes tokens and releases reservations. |

Every participating agent, root or worker, gets the same tools: `team_send_message`, `team_delegate_task`, `team_request_expansion`, `team_review_expansion`, `team_get_tree`, `team_get_inbox`, `team_report_progress`, `team_complete_task`, `team_get_models`, `team_get_budget`. What an agent may actually *do* is decided by the controller from its delegated envelope. A proposal is a request, not a guarantee.

### What happens underneath

```
pi (root) ──unix socket──▶ controller (background, one per user) ──▶ SQLite (WAL)
                                  │
                                  └─ launches worker `pi` processes (same extension, own worktree)
```

- **The controller is auto-started** by the first command that needs it. It is a detached process, so it keeps running when your Pi exits, and it exits by itself once idle (no live workers or pending spawns). Its state dir is `~/Library/Application Support/pi-recursive-team/` on macOS and `${XDG_STATE_HOME:-~/.local/state}/pi-recursive-team/` on Linux, with mode 0700. The socket is per-user, never under `/tmp`.
- **Workers** are detached `pi --mode json -p --session <file>` processes. Each enrolls with a one-time credential passed through a 0600 file (never argv) and works in its own git worktree under `<workspace>/.team-worktrees/<run>/<agent>`. A worker runs until its prompt settles. When new work arrives, the controller relaunches it on the **same Pi transcript and the same agent ID**.
- **Identity.** A logical agent ID is independent of the Pi session, process and model. If you close the root Pi, its reports keep working. Reopen Pi and use `/team resume <run>` (or the same Pi session re-attaches automatically). A forked or cloned Pi session is never silently adopted.

### Configuration

`/team init config.json` accepts a partial `RunConfig` (see `src/shared/protocol.ts`): global hard caps (`limits`), a model catalog (`models`), and the root's envelope. Without one, the defaults from `recursive-agent-org-v1.2/examples/config.example.yaml` apply, and the catalog contains just the root's own model (id `leader`). Provider API keys stay in your environment. They are never stored in SQLite or sent in messages.

## Develop

```bash
npm install          # dev only: typescript + types
npm test             # node --test over test/**
npx tsc --noEmit
bash scripts/demo.sh # end-to-end scenario with a credential-free fake worker → demo-output/
```

The tests never spend provider credits. Worker scenarios use `PI_TEAM_EXECUTOR=test/fixtures/fake-worker.ts`, and real-Pi smoke tests use a local fake OpenAI-compatible server with an isolated `PI_CODING_AGENT_DIR`.

## Uninstall, stop, purge

- `/team stop <run_id>` stops a run's managed workers.
- `pi remove ./path/to/pi-recursive-team` removes the extension. It does **not** stop running workers or delete organization data.
- To stop the controller, use `/team stop` on active runs (it idles out on its own) or send SIGTERM to the pid in `controller.json`.
- To purge all state, run this after stopping: `rm -rf "<state dir>"` (path above). Worker worktrees live under each workspace's `.team-worktrees/`. Remove them with `git worktree remove`.

## Limitations

- **Not a sandbox.** Limits apply only to *managed* workers. Any agent with shell access can start unmanaged processes, spend money directly, or read files the OS user can read, including the controller's `operator.token`. Governance is cooperative accounting plus process supervision, not isolation.
- Cost accounting is approximate. Reservations are estimates; actual spend is reconciled only from usage that workers report (`/sessions/usage`).
- There is no tmux observer (`/team watch` is a stub), no worktree merge or cleanup, no fork-as-new-agent attach mode, and no Windows IPC.
- Model ids containing `:` are interpreted by Pi as a thinking-level suffix.
