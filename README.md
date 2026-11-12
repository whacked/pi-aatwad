# pi-recursive-team

A Pi package that lets ordinary [Pi](https://pi.dev) sessions run **recursive agent organizations**. A root session recruits leads, and leads recruit workers. Every expansion is proposed, reviewed up the chain, budgeted, and audited by a local controller that starts automatically.

Implements the v1.2 brief in [`recursive-agent-org-v1.2/`](recursive-agent-org-v1.2/README.md). The concrete engineering decisions are recorded in [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).

**Status: v0.1.12, early implementation.** It is tested against Pi 1.4.0 and Node 24. See [Limitations](#limitations).

## Install

```bash
# Published/default branch:
pi install git:github.com/whacked/pi-aatwad

# This feature branch, after it has been pushed:
pi install git:github.com/whacked/pi-aatwad@feat/team-reporting

# Or a local checkout:
pi install ./path/to/pi-aatwad
pi
```

> `pi install npm:…` is not usable yet. Node refuses type-stripping inside `node_modules`, so an npm release needs a JS build step first.

Git installation clones the package outside `node_modules`, so it works with the
current TypeScript controller. Pick one source above; if this package was already
installed from a local path, remove that local source before switching to Git.
Restart Pi or run `/reload` after installing. Git refs can select a branch, tag or
commit; see [Pi package installation](https://pi.dev/docs/latest/packages).

Requires Node ≥ 22.13 (for built-in `node:sqlite` and type stripping), Pi and `ps`
on the controller's PATH. Git is needed for Git installation and repository
worktrees. tmux is optional. There are no runtime npm dependencies. If the Pi
executable has a custom location, set `PI_TEAM_PI_BIN=/absolute/path/to/pi` before
starting the controller. A long-running controller keeps its original environment;
restart it after changing PATH, credentials or that executable override.

## Use

To return to an existing team in a fresh Pi session:

```text
/team resume
/team watch
```

`resume` automatically attaches when exactly one valid team is available; with multiple
teams, it shows a picker with active member/running process counts. Without an interactive
UI, multiple candidates are listed so you can pass a run ID explicitly. No `init` is required. Cancelled and terminal teams are excluded from the picker and resume/stop
autocomplete, while `/team list all` and history commands retain the audit record.
`/team watch` from an unattached session uses the same automatic selection/picker behavior. If you
already ran `init`, resuming a different team cancels only that unused new team
when it has no members or work. Existing teams with work continue independently.

For a new team with no resource caps:

```text
/team init --unlimited
Create alpha and beta. Have each declare readiness, then wait for assignments.
/team watch
```

In a valid tmux pane, member creation through the leader's tool opens live Pi panes automatically unless `/team watch off` was selected.
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
| `/team resume [run_id] [agent_id]` | Auto-resume the sole valid team, pick among multiple teams, or attach directly. Works without init. |
| `/team list [all]` | List active teams, reporting relationships and member counts; `all` includes history. |
| `/team report-to <run_id\|none>` | Make this leader report to another team leader, or disconnect it. |
| `/team reporting [--all\|dismiss\|transfer <run_id>\|wake on\|off]` | Inspect, dismiss or transfer reporting links; configure automatic inbox turns. |
| `/team admin [status\|unlimited\|bounded] [run_id]` | Human operator: inspect, remove or restore resource caps. |
| `/team tree` / `status` / `budget [agent]` | Live logical hierarchy, controller and run status, limits and reservations. |
| `/team inbox` / `proposals` / `events` | Durable messages, expansion reviews, audit log. |
| `/team inspect <agent_id>` | Tasks, sessions (model, pid, transcript), reporting history, budget. |
| `/team watch [open\|status\|close\|off\|debug] [run_id]` | Manage live member panes; show optional controls with `debug`. |
| `/team watch focus <agent_id> [run_id]` | Focus a member monitor pane. |
| `/team send <agent_id> <message>` | Send directions through durable team messaging. |
| `/team stop [agent_id\|run_id]` | Controlled cancellation. Cascades to the subtree, revokes tokens and releases reservations. |

Every participating agent, root or worker, gets the same tools: `team_send_message`, `team_delegate_task`, `team_request_expansion`, `team_review_expansion`, `team_get_tree`, `team_get_inbox`, `team_report_progress`, `team_complete_task`, `team_close_member`, `team_get_models`, `team_get_budget`, `team_set_budget`, `team_set_model`, plus root-only `team_reporting`, `team_register_model`, `team_create_member`, and `team_watch`. What an agent may actually *do* is decided by the controller from its delegated envelope. A proposal is a request, not a guarantee.

### Reporting relationships between existing team leaders

Any active team leader can report to another active team leader. There is no
special role to enable and no reserved name. All teams must use the same local
controller/state directory. Each leader can receive reports while also reporting
to another leader; cycles are rejected.

For example, five projects are already running. Open a fresh Pi session and run:

```text
/team init
```

This creates an ordinary team leader. Note its `run_id`. Use `/team list` to discover
existing teams. In each old leader's session, run:

```text
/team report-to <new_leader_run_id>
```

Or tell that leader: “Report to the team leader for run `<new_leader_run_id>`.”
It uses `team_reporting` with action `connect` and `parent_run_id`. The receiving
leader needs no setup. Leaders keep their identities, sessions, members, worktrees,
budgets and approvals. `resume` takes over an identity; connecting leaders does
not require it. Each leader can have one active reporting parent at a time.

Both leaders receive an introduction with a bounded snapshot of open tasks, active
members, and recent task progress. The reporting leader is asked for its goal,
progress, blockers, pending decisions and next action. The receiving leader can
maintain consolidated status and ask follow-up questions. `/team reporting` lists
linked root agent IDs; use `/team send <agent_id> <message>` or `team_send_message`
to communicate. Cross-team messages permit `question`, `answer`, and `task.progress`.
Each team retains its own task delegation, recruitment, approvals, budget authority
and transcripts. Ordinary workers and sibling teams do not gain cross-team access.
Use `causation_id` or `correlation_id` to link an answer to its question.

Human leader inboxes are delivered for their next turn by default. To enable
automatic inbox turns, run this separately in each participating leader session:

```text
/team reporting wake on
```

`/team reporting wake off` disables automatic turns. Open, idle, running leaders
check their inbox on heartbeat (normally within 10 seconds); busy leaders wait
until idle. Automatic turns can spend model credits. Closing a session preserves
links and queues reports; no replacement root process is launched. Leaders should
report meaningful changes and decisions and avoid acknowledgement loops.

| Where | Command | Effect |
|---|---|---|
| Reporting leader | `/team report-to none` | End its link to its reporting parent. Its own reports stay attached. |
| Receiving leader | `/team reporting transfer <run_id>` | Transfer all leaders reporting to it to another ordinary leader, with handoff history. Its own parent link stays attached. |
| Any leader | `/team reporting dismiss` | End all reporting links attached to this leader. Every team and session continues running. |
| Any leader | `/team reporting --all` | Inspect active and closed links. |
| Human operator | `/team stop [run_id]` | Stop that team's own hierarchy. Separately linked teams continue running. |

To remove the temporary reporting parent from the example, run `/team reporting
dismiss` in its session. If you also want to stop its own team, follow with
`/team stop`. To replace it, create another ordinary team and transfer its reports
to that team's run ID before dismissing or stopping the old one.

Transfer sends current team snapshots and up to 30 recent coordination messages
per link as reference history; it does not copy full Pi conversations. The receiving
leader should confirm current facts. Disconnect, dismissal, transfer, or an ordinary
root stop/failure withdraw undelivered coordination messages and questions without
a linked answer. Both sides receive notice; already delivered directions remain
in context. Message and link history remain in the audit record. An offline leader
keeps its links; a terminal leader ends them.

### What happens underneath

```
pi (root) ──unix socket──▶ controller (background, one per user) ──▶ SQLite (WAL)
                                  │
                                  └─ launches worker `pi` processes (same extension, own worktree)
```

- **The controller is auto-started** by the first command that needs it. It is a detached process, so it keeps running when your Pi exits, and it exits by itself once idle (no live workers or pending spawns). Its state dir is `~/Library/Application Support/pi-recursive-team/` on macOS and `${XDG_STATE_HOME:-~/.local/state}/pi-recursive-team/` on Linux, with mode 0700. The socket is per-user, never under `/tmp`.
- **Workers** run as interactive Pi harnesses in tmux when `/team watch` is enabled, or detached `pi --mode json -p --session <file>` processes otherwise. Each enrolls with a one-time credential passed through a 0600 file (never argv) and works in its own git worktree under `<workspace>/.team-worktrees/<run>/<agent>`. Interactive workers stay at their Pi prompt between assignments. Headless workers exit when their prompt settles and are relaunched on the **same Pi transcript and the same agent ID** for new work.
- **Identity.** A logical agent ID is independent of the Pi session, process and model. If you close the root Pi, its reports keep working. Reopen Pi and use `/team resume` to choose a team. Pi's own `/resume` restores a previous conversation and automatically re-attaches its saved team identity when it is the same non-managed Pi session and the agent is still active. Running `/team resume <run>` afterward reports “Already attached” for that team; no second attach is needed. A forked or cloned Pi session is never silently adopted, and saved managed-worker identities require deliberate takeover.

### Configuration

`/team init config.json` accepts a partial `RunConfig` (see `src/shared/protocol.ts`): global hard caps (`limits`), a model catalog (`models`), and the root's envelope. Without one, there are no numeric spend, worker-lifetime, member-count, pending-spawn, grant or depth limits; the catalog contains just the root's own model (id `leader`). The historical design example is not the default policy. Runs never expire: legacy `max_run_seconds` values are accepted for compatibility but ignored. Provider API keys stay in your environment. They are never stored in SQLite or sent in messages.

### Human operator resource policy

The initial human operator has a separate controller credential. `/team admin unlimited`
disables run-wide spend, member-count, pending-spawn, grant and recursion-depth
caps from the current run. Explicit worker budgets and inherited worker lifetime policies still apply. `/team init --unlimited` enables
this when creating a run. `/team admin bounded` restores enforcement of the stored
bounded limits. Accounting remains enabled in both modes. Removing caps does not
resume already-paused agents automatically.

Agents can read the policy through `team_get_budget` but cannot change it using their
session credentials. Unlimited policy is a run-wide human decision; it does not grant
agents operator identity, cross-run access or permission to bypass reporting hierarchy.
The leader decides whether individual workers need explicit budgets or lifetimes; omitted limits inherit its policy without inventing allocations.
If the user requests unlimited mode in a bounded run, it should explain the human
command `/team admin unlimited`, not claim that unlimited runs are impossible.

### Conversational teams and model selection

No configuration file is required. Start Pi in your repository, then:

```text
/team init

Implement the feature described below. Create whatever team you need.
[Your requirements here.]
```

The leader decides useful roles and creates members using its current session model,
including after `/model` changes or Pi session resume. The catalog's `leader` entry
retains the initial model for explicit selection; it is not the implicit default once
the leader has switched models.
It may briefly offer alternatives discovered from Pi without requiring model
selection before work starts. There are no implicit member budgets or lifetimes. Omitted
`max_cost_usd` shares the leader's budget pool (unbounded if the leader is unbounded);
omitted `max_runtime_seconds` inherits its lifetime policy. Leaders may explicitly choose
either limit, including in operator-unlimited mode. Child subtree/grant authority inherits
its leader's envelope rather than starting at zero. The injected context explains effective
limits, grant authority, management tools, and when manager approval is required. Descendant
budgets/models can be changed, paused members resumed through budget updates, and members
closed; controller lifecycle endpoints additionally support pause/resume.

Explicit budgets start separate pools; inheriting members' actual spend is charged once
against their pool, including after members retire. Budget changes to the pool owner affect
its inheriting members. Setting an inherited member's explicit budget separates its inherited
branch into a new pool, subject to grant and ancestor limits. Pool membership survives reparenting;
worker lifetime policies are inherited at creation and measured from each worker's own start.
New finalized assistant/tool usage is reported with persisted, idempotent retries. Exhaustion
pauses affected members and aborts active work; an in-flight provider request can still overshoot
before final usage is known. Existing saved numeric policies remain configured (except run age);
new defaults do not silently erase intentional limits. The controller has no idle shutdown by
default; `PI_TEAM_IDLE_MS` is an optional operator-selected resource-cleanup setting, not a run lifetime.

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

### Names, budgets, and model changes

Agent arguments accept exact names or IDs in commands and tools: budget, model,
inspect, send, stop, watch focus, resume's member argument, and task delegation.
Names are case insensitive and scoped to the attached team. Quote names containing
spaces. Ambiguous names require an ID; an active member takes precedence over old
closed members with the same name. IDs remain usable without an attached team.
Omitting `name` in `team_create_member` assigns Alpha, Beta, Gamma, and other
friendly unused names. Autocomplete suggests active member names.

```text
/team budget Alpha
/team budget Alpha 5
/team budget Alpha 5 --resume
/team model Alpha openrouter/vendor/model-id
/team send "Senior Reviewer" Review the latest patch
/team watch focus Alpha
/team stop Beta
```

You can instead ask the leader: “Give Alpha a $5 total budget” or “Switch Alpha to
openrouter/vendor/model-id”. It uses `team_set_budget` or `team_set_model` with the
name. Budget changes retain accounting, update ancestor reservations, and enforce
grant, ancestor and global ceilings. They cannot lower the ceiling below consumed
spend. `resume: true` also resumes the member; otherwise paused state is preserved.
`/team admin unlimited` remains the human-only way to remove caps.

A model change is queued, then applied through Pi's model API when the member is
idle (normally on its next heartbeat, within about 10 seconds). The process, pane,
agent ID, tasks and transcript stay intact. Busy members finish their current run
first. Offline members launch with the new model. The tree marks pending switches;
missing authentication or model availability leaves the request pending and shows
a warning in that member's Pi. No config edits or manual member restart are needed.

Using `/model` directly in a member pane works normally. The plugin persists the
actual selection for future worker restarts and updates tree/inspect state without
sending a leader inbox notification. A later leader request can change it again.
Switches do not reset budgets or context; Pi handles any required context compaction.

Pi 1.4.0 already enables automatic context compaction by default, including context
overflow recovery. Each member uses Pi's own compaction settings; `/compact` remains
available in its pane. The plugin does not add a separate compactor. See
[Pi compaction documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md).

### SSH, Herdr and execution without tmux

Team recruitment and reporting do not require tmux. Execution depends on the
hosting environment and the team's saved terminal setting:

| Environment | Default behavior |
|---|---|
| Plain terminal or SSH, without tmux | Controller launches detached, one-shot Pi workers with durable inboxes and transcripts. |
| Herdr | Pi stays in its Herdr pane; workers use detached execution. Inherited outer tmux markers are ignored when `HERDR_ENV=1`. |
| Valid tmux pane containing this Pi | Member creation automatically opens team panes beside Pi unless explicitly disabled. |
| Missing tmux or stale inherited pane markers | Automatic pane setup cannot block recruitment; detached workers remain available. |
| Saved tmux session/pane becomes unavailable | Controller records a fallback notice and switches workers to detached execution, preserving identities, tasks and transcripts. |

To force detached workers, including inside tmux:

```text
/team watch off
```

This persists for the team until `/team watch open`. Existing interactive workers
are stopped and relaunched on their saved transcripts; an active turn is interrupted
and instructed to continue. Old tmux panes may remain as exited panes and can be
closed. `/team watch close` only hides/detaches the view and leaves interactive
workers running. `/team watch status` works without tmux in detached mode.

Without tmux there are no live member panes or direct keyboard input to workers.
Use the leader's team tools, `/team send`, `/team inbox`, `/team inspect`, and
`/team reporting`. Detached workers exit when their prompt settles and relaunch on
the same transcript for new assignments. The controller and detached workers survive
an ordinary root-session exit or SSH disconnect; host shutdown or session cleanup
policies can still stop processes. Resume with `/team resume` later.

There is no native Herdr pane backend. `/team watch open` explicitly requests tmux;
outside tmux it opens a separate, detached tmux session and prints an attach command
for another terminal. If tmux is missing, that explicit request gives an actionable
error while team work continues detached. It never nests or attaches tmux inside
Herdr automatically. Herdr documents the limitations of nested tmux in its
[agent hosting guide](https://herdr.dev/tui/docs/agents/).

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
owns launch, restart and cancellation, so a view refresh never starts a
competing Pi process. Without tmux mode, workers retain the headless one-shot path.

When Pi is already inside tmux, `/team watch` creates member panes **in the current
window of the current session**, beside the existing Pi pane. It does not move Pi,
create or switch sessions, rename windows, or change unrelated panes. The team
uses only the region originally occupied by Pi: the leader receives approximately
60% of that region, with member Pis sharing the rest. The
layout adapts to region dimensions and membership while preserving the position,
size and processes of unrelated panes. The controller remembers this location so
new and restarted members return to the same group.

Outside tmux, the previous behavior remains: Pi stays in its original terminal,
and `/team watch` creates a dedicated session for member Pis and prints an attach
command for another terminal. A temporary readiness pane is replaced by the first
member, so it does not occupy space while agents are working.

Use tmux's default `Ctrl-b` then arrow keys to navigate panes, or `z` to zoom a
pane temporarily. `/team watch focus <agent_id>` selects a member and
`/team watch status` reports the session and panes. `Ctrl-b d` and
`/team watch close` leave live Pi processes running. Inside an existing session,
`/team watch close` hides any debug controls without detaching your client or
changing session/window selection. In a dedicated
session, close detaches its clients without destroying live terminals. Use
`/team stop <agent_id>` to cancel a member, or `/team stop <run_id>` to cancel the team. Killing a tmux pane or server terminates the harnesses it hosts;
the controller recovers eligible members within its retry policy, falling back to
detached execution when the saved terminal location is unavailable.

Normal use shows **only the leader and member Pi panes**. Layout coordination runs
inside the existing background controller; there is no TEAM CONTROL pane or extra
coordinator process to watch. `/team watch debug` (or `team_watch` with action
`debug`) opens one optional diagnostic pane. Normal view opening hides legacy
control panes, including duplicates. Pane titles use the assigned member names
rather than Pi's default `π` and worktree identifier.

To close members, ask the leader to use `team_close_member` with their agent IDs.
It cancels the member and descendants, revokes credentials, stops their Pi
processes, releases reservations, and removes their panes. Its response explicitly
reports whether process shutdown is confirmed. Repeating a close is harmless.
Completing a task or changing its budget does not terminate an agent. Closed
members leave `/team tree` and `team_get_tree` by default; `/team tree --all`,
`team_get_tree` with `include_closed: true`, inspect and events retain history.
Recruit replacements normally with `team_create_member`.

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
