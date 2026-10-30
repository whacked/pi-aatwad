# pi-recursive-team

A Pi package that lets ordinary [Pi](https://pi.dev) sessions run **recursive agent organizations**. A root session recruits leads, and leads recruit workers. Every expansion is proposed, reviewed up the chain, budgeted, and audited by a local controller that starts automatically.

Implements the v1.2 brief in [`recursive-agent-org-v1.2/`](recursive-agent-org-v1.2/README.md). The concrete engineering decisions are recorded in [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).

**Status: v0.1.3, early implementation.** It is tested against Pi 1.4.0 and Node 24. See [Limitations](#limitations).

## Install

```bash
pi install ./path/to/pi-recursive-team     # local path (works today)
pi                                          # ordinary Pi
```

> `pi install npm:…` is not usable yet. Node refuses type-stripping inside `node_modules`, so an npm release needs a JS build step first.

Requires Node ≥ 22.13 (for built-in `node:sqlite` and type stripping). There are no runtime npm dependencies.

## Use

To return to an existing team in a fresh Pi session:

```text
/team resume
/team watch
```

`resume` shows a picker with active member/running process counts. No `init` is
required. Cancelled and terminal teams are excluded from the picker and resume/stop
autocomplete, while `/team list all` and history commands retain the audit record.
`/team watch` from an unattached session offers the same resume picker. If you
already ran `init`, resuming a different team cancels only that unused new team
when it has no members or work. Existing teams with work continue independently.

For a new team with no resource caps:

```text
/team init --unlimited
Create alpha and beta. Have each declare readiness, then wait for assignments.
/team watch
```

In tmux, member creation through the leader's tool opens live Pi panes immediately.
`watch` opens or reuses the view. A fresh `init` alone creates an **empty** team;
`reports 0` and `live workers 0` mean there are no member processes to display.
Use `/team list` to find other teams instead of repeatedly creating new ones.

`/team stop` stops the current team. An explicit run or agent ID stops another
team/member. Repeated stops of cancelled targets succeed harmlessly. Stopping your
own team ends the local association without claiming a newer session took over,
and you can still issue operator commands for other teams. Stopped team panes and
ownership tags are released without killing the human's Pi pane. A leftover pane
tag with no active members is recovered automatically; active foreign teams are
protected with instructions to resume or stop them first.

Inside Pi:

| Command | What it does |
|---|---|
| `/team init [--unlimited] [config.json]` | Makes this session the **root** of a new organization. This is the only way an org is created; installing the package creates nothing. |
| `/team resume [run_id] [agent_id]` | Pick a resumable team or attach directly. Works in a fresh Pi session without init. |
| `/team list [all]` | List active teams with member counts; `all` includes history. |
| `/team admin [status\|unlimited\|bounded] [run_id]` | Human operator: inspect, remove or restore resource caps. |
| `/team tree` / `status` / `budget [agent]` | Live logical hierarchy, controller and run status, limits and reservations. |
| `/team inbox` / `proposals` / `events` | Durable messages, expansion reviews, audit log. |
| `/team inspect <agent_id>` | Tasks, sessions (model, pid, transcript), reporting history, budget. |
| `/team watch [open\|status\|close] [run_id]` | Open or manage a tmux dashboard and automatic member panes. |
| `/team watch focus <agent_id> [run_id]` | Focus a member monitor pane. |
| `/team send <agent_id> <message>` | Send directions through durable team messaging. |
| `/team stop [agent_id\|run_id]` | Controlled cancellation. Cascades to the subtree, revokes tokens and releases reservations. |

Every participating agent, root or worker, gets the same tools: `team_send_message`, `team_delegate_task`, `team_request_expansion`, `team_review_expansion`, `team_get_tree`, `team_get_inbox`, `team_report_progress`, `team_complete_task`, `team_get_models`, `team_get_budget`, plus root-only `team_register_model`, `team_create_member`, and `team_watch`. What an agent may actually *do* is decided by the controller from its delegated envelope. A proposal is a request, not a guarantee.

### What happens underneath

```
pi (root) ──unix socket──▶ controller (background, one per user) ──▶ SQLite (WAL)
                                  │
                                  └─ launches worker `pi` processes (same extension, own worktree)
```

- **The controller is auto-started** by the first command that needs it. It is a detached process, so it keeps running when your Pi exits, and it exits by itself once idle (no live workers or pending spawns). Its state dir is `~/Library/Application Support/pi-recursive-team/` on macOS and `${XDG_STATE_HOME:-~/.local/state}/pi-recursive-team/` on Linux, with mode 0700. The socket is per-user, never under `/tmp`.
- **Workers** run as interactive Pi harnesses in tmux when `/team watch` is enabled, or detached `pi --mode json -p --session <file>` processes otherwise. Each enrolls with a one-time credential passed through a 0600 file (never argv) and works in its own git worktree under `<workspace>/.team-worktrees/<run>/<agent>`. Interactive workers stay at their Pi prompt between assignments. Headless workers exit when their prompt settles and are relaunched on the **same Pi transcript and the same agent ID** for new work.
- **Identity.** A logical agent ID is independent of the Pi session, process and model. If you close the root Pi, its reports keep working. Reopen Pi and use `/team resume <run>` (or the same Pi session re-attaches automatically). A forked or cloned Pi session is never silently adopted.

### Configuration

`/team init config.json` accepts a partial `RunConfig` (see `src/shared/protocol.ts`): global hard caps (`limits`), a model catalog (`models`), and the root's envelope. Without one, the defaults from `recursive-agent-org-v1.2/examples/config.example.yaml` apply, and the catalog contains just the root's own model (id `leader`). Provider API keys stay in your environment. They are never stored in SQLite or sent in messages.

### Human operator resource policy

The initial human operator has a separate controller credential. `/team admin unlimited`
removes numeric spend, runtime, member-count, pending-spawn, grant and recursion-depth
caps from the current run, including existing members. `/team init --unlimited` enables
this when creating a run. `/team admin bounded` restores enforcement of the stored
bounded limits. Accounting remains enabled in both modes. Removing caps does not
resume already-paused agents automatically.

Agents can read the policy through `team_get_budget` but cannot change it using their
session credentials. Unlimited policy is a run-wide human decision; it does not grant
agents operator identity, cross-run access or permission to bypass reporting hierarchy.
The leader should honor an unlimited policy rather than inventing dollar allocations.
If the user requests unlimited mode in a bounded run, it should explain the human
command `/team admin unlimited`, not claim that unlimited runs are impossible.

### Conversational teams and model selection

No configuration file is required. Start Pi in your repository, then:

```text
/team init

Implement the feature described below. Create whatever team you need.
[Your requirements here.]
```

The leader decides useful roles and creates members using its initial model.
It may briefly offer alternatives discovered from Pi without requiring model
selection before work starts. In bounded mode, default member limits are $2 and 600 seconds. In operator
unlimited mode, no finite allocations or runtime caps are needed.

To specify a member and model directly:

```text
Create a member called Adjudicator using <exact Pi model ID or name>.
Have it independently review the proposed solution and report defects.
```

The leader resolves the model using Pi's authenticated model registry, registers
its provider/model association in the current run, and creates the member with
its task. Qualified IDs such as `provider/model-id` avoid ambiguity; OpenRouter
IDs can contain another slash (`openrouter/vendor/model-id`). Ambiguous names
require a choice, and unknown or unauthenticated models produce an actionable
error rather than a silent substitution. OpenRouter credentials alone do not
make every remote model discoverable: configure the model in Pi if it is absent.

The tools supporting this interaction are:

- `team_get_models` with `source: "available"`: discover authenticated Pi models.
  The default source, `catalog`, lists models registered in the run.
- `team_register_model`: resolve an exact model ID or unique name and add it to
  the run. Only the root can register models. This also permits its provider in
  global policy; delegated provider restrictions still apply.
- `team_create_member`: create one named member, assign its responsibility, and
  approve recruitment within the root's budget. Omit `model` to use `leader`,
  pass `model` for discovery and registration on the fly, or use
  `preferred_model_id` for an existing catalog entry. Specify optional
  `max_cost_usd` and `max_runtime_seconds` to override member defaults.

Subordinate managers still recruit through reviewed expansion proposals.
Registrations persist in the controller database across session resumes and
controller restarts; no config file or reload is needed. Existing members keep
their models. Failed direct recruitment rolls back its model registration and
task creation; retries with the same tool-call ID do not create duplicate members.

Use `/team tree`, `/team inspect <agent_id>`, and `/team events` to inspect the
team. Creation returns provisioned IDs; workers start asynchronously. Each worker
uses its own worktree, so integration of commits or patches is explicit.

Authenticate providers in Pi or supply their API keys before starting the
controller. Workers use Pi authentication and the controller's inherited
allowlisted environment. Changing a later root session's environment does not
update an already running controller. Models registered only in memory by another
extension must also be made available to worker Pi processes. Discovery checks
configured authentication, not a live API call or credit balance. Capability tags
for discovered chat models are broad defaults, not verified performance claims.

After upgrading an existing installation, reload/restart Pi and let any old controller
exit (it exits when idle) before using the new runtime configuration tools. A controller
already running older code will not have the new endpoints.

`/team init config.json` remains available for advanced initial policy settings.
For lower-level expansion proposals without an explicit model preference, the
controller chooses the cheapest eligible catalog entry by configured input/output
cost sum; unknown costs count as zero. Direct conversational member creation
explicitly defaults to `leader` instead.

Standalone Pi still needs `node` on PATH for the controller. Its embedded runtime
reports an unavailable Unix socket as `FailedToOpenSocket`, sometimes with the
message “Was there a typo in the url or port?”. The client recognizes that code
and uses a direct socket probe when only the misleading message is available,
so absent or refused sockets trigger controller startup.

### Interactive Pi teams in tmux

Both legacy tmux layout strings and tmux 3.8 JSON layouts are supported.

Install `tmux` and put it on PATH. Run `/team watch` or ask the leader to open the
team terminals. **Each member pane runs a separate, interactive Pi harness** on a
real tmux PTY: its own prompt, model, transcript, worktree and process identity.
These are not log-tail panels. Type directly in a member's Pi prompt, or have the
leader delegate tasks and send messages with `team_send_message` or
`/team send <agent_id> <message>`. An idle interactive member automatically starts
a new turn when a controller message arrives, and remains open after its turn
finishes. The usual per-agent spend and runtime limits still apply.

The first `/team watch` enables interactive workers for the run. Existing headless
workers are stopped and relaunched in panes on their saved transcripts, preserving
agent IDs and tasks; an active turn is interrupted and the resumed Pi is instructed
to continue it. Future members launch directly into interactive panes. The controller
owns launch, restart and cancellation, so a dashboard refresh never starts a
competing Pi process. Without tmux mode, workers retain the headless one-shot path.

When Pi is already inside tmux, `/team watch` creates member panes **in the current
window of the current session**, beside the existing Pi pane. It does not move Pi,
create or switch sessions, rename windows, or change unrelated panes. The team
uses only the region originally occupied by Pi: the leader receives approximately
60% of that region, with member Pis and a small dashboard sharing the rest. The
layout adapts to region dimensions and membership while preserving the position,
size and processes of unrelated panes. The controller remembers this location so
new and restarted members return to the same group.

Outside tmux, the previous behavior remains: Pi stays in its original terminal,
and `/team watch` creates a dedicated session with a dashboard and member Pis and
prints an attach command for another terminal.

Use tmux's default `Ctrl-b` then arrow keys to navigate panes, or `z` to zoom a
pane temporarily. `/team watch focus <agent_id>` selects a member and
`/team watch status` reports the session and panes. `Ctrl-b d` and
`/team watch close` leave live Pi processes running. Inside an existing session,
`/team watch close` stops only the small dashboard, without detaching your client
or changing session/window selection; `/team watch` restores it. In a dedicated
session, close detaches its clients without destroying live terminals. Use
`/team stop <agent_id>` to cancel a member, or `/team stop <run_id>` to cancel the team. Killing a tmux pane or server terminates the harnesses it hosts;
the controller may restart eligible members within its retry policy.

To return later, `/team resume <run_id>` and `/team watch`. Interactive mode is
persisted across controller restarts. Terminal panes survive controller outages
and resume receiving assignments when it returns. Old log viewers are replaced by
real Pi processes during promotion; dedicated sessions still consolidate old member
windows into the leader window. If there is insufficient space, enlarge the terminal
rather than creating more windows. Managed members cannot manage the team terminal session.


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

- **Not a sandbox.** Limits apply only to *managed* workers. Any agent with shell access can start unmanaged processes, spend money directly, or read files the OS user can read, including the controller's `operator.token`. Governance is cooperative accounting plus process supervision, not isolation. Managed workers are not given `PI_TEAM_STATE_DIR` and reach the controller only through the socket named in their one-time enrollment file. But a same-uid worker can still find the state dir at its default path (and read `operator.token` / `org.sqlite`), so this is mitigation, not isolation.
- Cost accounting is approximate. Reservations are estimates; actual spend is reconciled only from usage that workers report (`/sessions/usage`).
- There is no automatic worktree merge or cleanup, no fork-as-new-agent attach mode, and no Windows IPC.
- Model ids containing `:` are interpreted by Pi as a thinking-level suffix.
