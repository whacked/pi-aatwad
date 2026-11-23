# pi-recursive-team

A Pi package that lets ordinary [Pi](https://pi.dev) sessions run **recursive agent organizations**. A root session recruits leads, and leads recruit workers. Every expansion is proposed, reviewed up the chain, budgeted, and audited by a local controller that starts automatically.

Implements the v1.2 brief in [`recursive-agent-org-v1.2/`](recursive-agent-org-v1.2/README.md). The concrete engineering decisions are recorded in [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).

**Status: v0.1.46, early implementation.** It is tested against Pi 1.4.0 and Node 24. See [Limitations](#limitations).

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
Restart Pi or run `/reload` after installing. `/team version` reports the loaded extension and controller versions, source paths and controller state directory, even when this session is not enrolled; it does not start a stopped controller. `/team status` also reports the loaded extension version and controller PID. `/reload` reloads the extension, not an already-running controller. The next `/team` command that needs the controller notices one running an older package version, asks it to shut down gracefully and starts a fresh one from the loaded code; members reconnect on their own. A newer controller is left alone. Git refs can select a branch, tag or
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
UI, multiple candidates are listed so you can pass a run ID explicitly. No `init` is required. Stopped teams stay resumable; cancelled, terminal and removed teams are excluded from the picker and resume/stop
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

Commands with optional targets use the current team when attached; otherwise they
select the sole viable team or show a picker. Member commands select the sole active
(non-terminal) member, or prompt when several exist; with no members they can target
the leader itself. Explicit invalid targets never fall back to another candidate.
`/team budget` keeps its attached-session self-budget display. Paused members remain
viable, while cancelled/terminal teams are never offered for automatic selection.
Without UI, ambiguous candidates are listed and require an explicit target.

Destructive operations ask for confirmation even when only one target exists:
stopping a subtree, changing budgets/resource policy/reporting links, disabling or
closing terminal views, taking over a root or member session, and cancelling an unused team
during resume. Selection or confirmation cancellation makes no changes. Add `--yes`
to these commands to explicitly authorize them; headless use requires it.

Examples with an omitted member target: `/team inspect`, `/team budget 5`,
`/team model openai/gpt-6.1-sol`, `/team send "Please review"`, or
`/team send -- Please review this change`. The `--` separator also supports
multiword model names when the target is omitted. Other command arguments remain required.

`/team stop` suspends the current team, or selects a viable team when unattached;
an explicit run ID stops another team. Stop is resumable, never a cancellation:
the controller stops the worker processes it owns and revokes credentials, while
identities, tasks, budgets and transcripts are kept. `/team resume <run_id>`
restores exactly the members that were running (deliberately paused members stay
paused) and relaunches them on their saved transcripts when work is waiting.
Repeated stops succeed harmlessly, and a stop whose process cleanup failed stays
`CLEANING` until `/team stop` is retried. Stopping your own team suspends the local
association without claiming a newer session took over, and you can still issue
operator commands for other teams.

`/team remove [run_id]` is the destructive counterpart: it cancels every member,
stops owned processes, revokes all credentials and takes the team out of every
listing; a removed team can never be resumed. It always asks for confirmation
(`--yes` without a UI). Neither command kills your Pi, deletes worktrees or touches
project files. To close one member, ask the leader (`team_close_member`). 

tmux pane tags outlive the Pi session that set them. When the leader Pi itself runs
in a pane still tagged for another team, `/team watch` verifies that (the pane's
process is an ancestor of this Pi), replaces the tag and opens the member panes; it
reports which team the pane used to show. Nothing in the other team is stopped: its
members continue detached and `/team resume <run_id>` returns to them. A pane this
Pi does not occupy is never taken over. `/team watch focus <member>` switches to one
member's pane.

Inside Pi:

| Command | What it does |
|---|---|
| `/team init [--unlimited] [config.json]` | Makes this session the **root** of a new organization. This is the only way an org is created; installing the package creates nothing. |
| `/team resume [run_id] [agent_id]` | Auto-resume the sole valid team, pick among multiple teams, or attach directly. Works without init. |
| `/team list [all]` | Teams for this project: name, state, live/total members, open tasks, last activity, model and what each is doing; `all` adds other projects, empty, closed and old teams. |
| `/team version` | Loaded extension/controller versions, source paths and controller state directory; works without enrollment and never starts the controller. |
| `/team join <run_id\|agent_id\|none> [--terminatable]` | Link this team under another team's leader (run ID) or any of its agents (agent ID); `none` detaches. That agent becomes your lead: it can assign you tasks and dismiss you. `--terminatable` (operator) lets dismissal stop your team. It does not merge teams or take over that leader (that is `resume`). |
| `/team report-to ...` | Alias for `join`. |
| `/team leave` | Alias for `/team join none`. |
| `/team exit-policy [stop\|keep]` | What quitting Pi does to this team: stop it resumably (default) or keep it running in the background. |
| `/team rename <name>` | Set the team's name. |
| `/team host [refresh]` | Show which host this Pi detected (bb, Rex, tmux, built-in session host, detached) and why; `refresh` detects again. |
| `/team prune` | Close this team's idle members that have no open tasks. |
| `/team join none` *(in a member)* | Leave the team: this session and its conversation continue as the leader of a new, empty team. The old member identity is retired there (its manager is told). `/team join <target>` in a member leaves and then joins, which is how a member moves to another team. |
| `/team dismiss <name\|agent_id> [--stop\|--keep] [reason]` | End a team linked under you: it detaches, or stops resumably when its link is terminatable. `--stop`/`--keep` override (operator). |
| `/team roster` | Everyone ever linked under you: active, detached, dismissed or closed. |
| `/team recall <name\|agent_id>` | Bring one back with its context: a dismissed team resumes (if your dismissal stopped it) and links under you again; a closed member returns in the same position, continuing its transcript. |
| `/team rehire <name\|agent_id>` | Fill that position with a new agent and a fresh context. |
| `/team link <name\|agent_id> terminatable on\|off` | Operator: whether dismissing that linked team (or joined member) may stop it. |
| `/team reporting [--all\|dismiss\|transfer [run_id]\|wake on\|off]` | Inspect, dismiss or transfer reporting links. `wake on\|off` is shorthand for `/team attention on-message wake\|next-turn`. |
| `/team attention [team\|agent] [on-message wake\|next-turn] [batch 15s] [stall 3m\|off] [tick 10m\|off] [cap N] [reset]` | When idle sessions get automatic turns. See [Automatic turns](#automatic-turns-attention). |
| `/team admin [status\|limits\|clear-limits\|clear-deadlines\|unlimited\|bounded] [run_id]` | Human operator: list the limits in force, remove them all, or change resource policy. |
| `/team tree` / `status` / `budget [agent]` | Live logical hierarchy, controller and run status, limits and reservations. |
| `/team inbox` / `proposals` / `events` | Durable messages, expansion reviews, audit log. |
| `/team inspect [agent_id]` | Tasks, sessions (model, pid, transcript), reporting history, budget. |
| `/team watch [open\|status\|close\|off\|debug] [run_id]` | Manage live member panes; show optional controls with `debug`. |
| `/team watch focus [agent_id] [run_id]` | Focus a member monitor pane. |
| `/team send [agent_id] <message>` | Send directions through durable team messaging. |
| `/team stop [run_id]` | Suspend a whole team resumably: stops owned workers, keeps identities, tasks and transcripts for `/team resume`. |
| `/team remove [run_id] [--yes]` | Permanently remove a whole team. Cannot be resumed; Pi, worktrees and project files are preserved. |

Every participating agent, root or worker, gets the same tools: `team_send_message`, `team_delegate_task`, `team_request_expansion`, `team_review_expansion`, `team_get_tree`, `team_get_inbox`, `team_report_progress`, `team_complete_task`, `team_close_member`, `team_get_models`, `team_get_budget`, `team_set_budget`, `team_set_model`, plus root-only `team_reporting`, `team_register_model`, `team_create_member`, and `team_watch`. What an agent may actually *do* is decided by the controller from its delegated envelope. A proposal is a request, not a guarantee.

### Quitting Pi, finding teams again

**Quitting stops your team by default.** When you quit the leader's Pi (`/quit`, Ctrl+D, a
double Ctrl+C, or closing the terminal), the team is stopped resumably: members pause, and their
transcripts and tasks are kept. `/team resume` brings it back and continues interrupted work.

- If someone in the team tree is **working** when you quit, Pi asks first and you can cancel.
- If everyone is **idle**, Pi quits immediately and prints a note saying what it stopped.
- Closing the terminal cannot be confirmed, but the same policy runs.

To leave a team **running in the background** after you quit, opt in per team with
`/team exit-policy keep` (`/team exit-policy stop` restores the default). When you come back,
`/team resume` prints what happened while you were away: completed tasks with summaries, the
number of progress reports, and messages waiting for you. Queued messages arrive with your next
turn, and scheduled check-ins resume.

If a leader's harness disappears without quitting cleanly (a crash or a killed process), the
controller pauses its team once every member has been idle for 15 minutes. Busy members are never
interrupted, and teams set to `keep` are left alone.

**Finding teams.**
- **Names:** teams get a name, defaulting to the project name derived from the working directory (see Readable IDs). Set one with
  `/team init --name <name>` or `/team rename <name>`.
- **`/team list`:** shows the teams for the current project (its git top-level), newest
  activity first. Each line gives the name, state, live/total members, open tasks, last
  activity, the leader's model, and what the team is working on or finished last.
- **Hidden by default:** empty teams, closed teams, teams from other projects, and teams stopped
  more than a week ago. `/team list all` shows everything.
- **Startup notice:** starting Pi in a project with teams prints a one-line reminder.
- **`/team prune`:** closes this team's members that are idle and have no open tasks.
  `/team recall` brings one back.

### Linking teams: join, lead, dismiss

Any team can link under any agent of another team, usually its leader. The agent
above becomes the team's **lead**: control flows one step down, reports flow up and
sideways. There is no special role to enable and no reserved name. A "member" that
joins is just a team (possibly empty) linked under its lead; see
[docs/design/unified-team-links.md](docs/design/unified-team-links.md). All teams must use the same local
controller/state directory. Each leader can receive reports while also reporting
to another leader; cycles are rejected.

For example, five projects are already running. Open a fresh Pi session and run:

```text
/team init
```

This creates an ordinary team leader. Note its `run_id`. Use `/team list` to discover
existing teams. In each old leader's session, run:

```text
/team join <new_leader_run_id>
```

(`/team report-to` is an alias.)

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
to communicate. The lead can assign tasks to the agent linked directly under it
(`team_delegate_task`); the task lives in the lead's team, and the linked agent can
break it down in its own team and reports progress and completion up. Messages go down
one step, up to the lead, and sideways between peers under the same lead (`question`,
`answer`, `task.progress`). A lead never reaches two levels down. Each team retains
its own recruitment, approvals, budget and transcripts; a lead can read (not change) its
whole linked subtree. If the lead's team has a default member budget
(`/team admin member-default <usd>`), a joining team gets it added once.

Dismissing a linked team (`/team dismiss`, or the lead's `team_close_member`) detaches
it by default; joined teams are not terminatable. When the human marks a link
terminatable (`/team join --terminatable` or `/team link`), dismissal stops that team
resumably, and the stop continues down terminatable links while joined teams below
detach and keep running. Recruited members are terminatable by default.
Use `causation_id` or `correlation_id` to link an answer to its question.

Leaders are woken automatically when reports arrive (see
[Automatic turns](#automatic-turns-attention)); `/team reporting wake off` makes
this leader's messages wait for your next prompt instead. Closing a session preserves
links and queues reports; no replacement root process is launched. Leaders should
report meaningful changes and decisions and avoid acknowledgement loops.

| Where | Command | Effect |
|---|---|---|
| Linked team | `/team join none` | End its link to its lead. Its own reports stay attached. |
| Lead | `/team dismiss <agent>` | Detach a linked team, or stop it if its link is terminatable. |
| Receiving leader | `/team reporting transfer <run_id>` | Transfer all leaders reporting to it to another ordinary leader, with handoff history. Its own parent link stays attached. |
| Any leader | `/team reporting dismiss` | End all reporting links attached to this leader. Every team and session continues running. |
| Any leader | `/team reporting --all` | Inspect active and closed links. |
| Human operator | `/team stop [run_id]` | Suspend that team's own hierarchy (resumable), and teams linked under it on terminatable links. Joined teams continue running; `/team resume` brings back everything it stopped. |

### Automatic turns (attention)

There are two separate mechanisms. The **liveness heartbeat** runs every 10 seconds in
the background. It renews the lease and polls the inbox count. It never sends anything
to the model and never blocks the session. The **attention policy** decides when an idle
session's model gets a turn without a human prompt. The controller makes these decisions,
so every harness follows the same policy.

| Setting | Default | Meaning |
|---|---|---|
| `on-message` | `wake` | `wake` starts a turn for new messages. `next-turn` holds them until you next type. |
| `batch` | `15s` | Wait until the oldest undelivered message is this old, so several reports become one turn. |
| `stall` | `3m` | Wake a manager whose direct reports have all been idle this long while tasks are open. Its status digest marks work that is "not yet picked up". |
| `tick` | `off` | Periodic check-in with a status digest. Sent only if team status changed since the last one. |
| `cap` | `20` | Maximum automatic turns per rolling hour. `0` disables automatic turns. |

Busy sessions are never interrupted. Paused agents are never woken. An unchanged
stalled team wakes its manager only once. If you type while messages are held, they
are added to that turn. `/team attention` (no arguments) shows the team defaults;
`/team attention <agent> stall off` overrides one agent; `reset` re-inherits. Leaders
and agents use `team_set_attention`. Automatic turns spend model credits.

Dispatching is a handoff. `team_create_member`, `team_delegate_task` and
`team_send_message` return as soon as the controller has stored the work. The result
says whether the owner is idle (picks it up within about 10 seconds), busy or not yet
running. The leader is told not to poll or wait, and to return control to you. Reports
then wake it under this policy.

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
- **Readable IDs.** New agent IDs use `<keyword>-<four random words>-<yyyyMMdd>.<n>`, for example `standard-cell-river-maple-orbit-cloud-20261123.2`. The stamp `<yyyyMMdd>.<n>` belongs to the team: `<n>` is 1 for the first team created for the project that (local) day, 2 for the second, and so on; every member of the team carries its stamp. The project is the root session’s git top-level, else its CWD—the same scoping `/team list` uses. The keyword is the project name of the originating root session’s CWD (members share it, including when a workspace override is configured). The project name walks up from the CWD, adding folder names (outermost first) until they carry at least 6 informative characters. Generic folders such as `src`, `lib`, `app`, `tmp` or `test` stay in the name but count zero, and the walk never climbs past the home directory or uses more than three folders. So `/path/to/something/cool/src` is `something-cool-src`, `~/code/pi-aatwad` is `pi-aatwad`, and `/tmp` is just `tmp`. Folder names are lowercased and ASCII-normalized, and filler words (`a`, `an`, `the`, `project`, `repo`, `repository`) are dropped inside a folder name when other words remain. The keyword is at most 19 characters. When the name is longer, these steps apply in order until it fits:
  1. drop vowels from outer folders (`smthng-cl-src`);
  2. keep two words of the innermost folder;
  3. drop vowels from the innermost folder;
  4. drop outer folders;
  5. cut.

  Empty results fall back to `project`. The default team name uses the same project name, up to 40 characters. Run IDs use `run-<abbr>-<four random words>`, for example `run-scg-borrow-vault-visit-carpet`, where `<abbr>` is the first character of each word of the project name (at most six; `p` when there are none): `standard-cell-generator` → `scg`, `something/cool/src` → `scs`. Words are selected independently with replacement from the bundled 2,048-word vocabulary using cryptographic randomness: **44 random bits** per ID (the keyword, abbreviation and stamp add none). Because teammates share everything but those words, the controller checks each new run and agent ID before inserting it and draws again on a collision (bounded; a CONFLICT error after 16 attempts). Existing IDs—`agent-<hex>`, `agent-<six words>`, `<keyword>-<four words>-<seven digits>` and `run-<six words>`—remain valid and are never renamed; members recruited into a team created before v0.1.42 keep the seven-digit form. Internal record IDs and authentication credentials are unchanged. The vocabulary is the MIT-licensed [BIP-0039 English word list](https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt), not a wallet/secret format.\n  - **Naming follow-up:** the heuristic uses only the CWD path; project metadata or backend-LLM keyword selection may be considered later.
- **Identity.** A logical agent ID is independent of the Pi session, process and model. If you close the root Pi, its reports keep working. Reopen Pi and use `/team resume` to choose a team. Pi's own `/resume` restores a previous conversation and automatically re-attaches its saved team identity when it is the same non-managed Pi session and the agent is still active. Running `/team resume <run>` afterward reports “Already attached” for that team; no second attach is needed. A forked or cloned Pi session is never silently adopted, and saved managed-worker identities require deliberate takeover.

### Configuration

`/team init config.json` accepts a partial `RunConfig` (see `src/shared/protocol.ts`): global hard caps (`limits`), a model catalog (`models`), and the root's envelope. Without one, there are no numeric spend, worker-lifetime, member-count, pending-spawn, grant or depth limits; the catalog contains just the root's own model (id `leader`). The historical design example is not the default policy. Runs never expire: legacy `max_run_seconds` values are accepted for compatibility but ignored. Provider API keys stay in your environment. They are never stored in SQLite or sent in messages.

### Limits are opt-in

A team has no spend, time, member-count or depth limit unless a human asks for one.
This matters most on subscription accounts, where dollar accounting is not meaningful
and an invented ceiling only pauses members mid-work. Leaders are instructed never
to invent a member budget or lifetime.

| Human operator | Effect |
|---|---|
| `/team admin limits [run_id]` | List every limit in force: run caps, the leader's envelope, and each member's own ceiling or timer. |
| `/team admin clear-limits [run_id]` | Remove all of them, return every member to one shared unbounded pool, and resume members that a limit had paused. Deliberate pauses are left alone and listed. |
| `/team budget <member> <usd>` | Set one member's total spend ceiling when you want one. |
| `/team budget <member> none [--resume]` | Remove that ceiling; the member shares its lead's budget again. |

Teams created before limits became opt-in keep the caps that were saved with them
(for example a $25 run, a $20 leader envelope, 11 members, one-hour sessions).
`/team resume` points this out, and `/team admin clear-limits` removes them. When a
limit blocks an agent, the error names the limit and these commands, so the agent
reports the remedy instead of asking for a new team. Agents can remove a
descendant's ceiling (`team_set_budget` with `max_cost_usd: null`) but can never
change run-level policy.

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
new defaults do not silently erase intentional limits. To remove an existing team's saved
lifetime policy, the human operator can run `/team admin clear-deadlines [run_id]`.
This explicitly clears session and total-runtime limits for every existing member,
as well as the root/global defaults inherited by future members. It preserves budgets,
grants, resource mode, membership, task states, and transcripts; paused members remain
paused until deliberately resumed. It does not rewrite pending expansion requests;
newly approved explicit worker timers still apply. The action is transactional and audited.
The controller has no idle shutdown by
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

After upgrading an existing installation, reload/restart Pi. The first `/team` command
replaces a controller still running older code (which would lack new endpoints) with one
running the loaded version.

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

Agent arguments accept exact names, full IDs, or unique ID-word references in
commands and tools: budget, model, inspect, send, stop, watch focus, resume's
member argument, and task delegation. Names and short references are case
insensitive and scoped to the attached team; full IDs remain usable without an
attached team and across linked teams. Exact names take precedence; an active
member takes precedence over old closed members with the same exact name.

For `standard-cell-river-maple-orbit-cloud-20261123.2`, use `maple`, `agent maple`, or
`river maple`. Keyword tokens and the stamp's date and counter tokens (`20261123`,
`2`, or `20261123.2`) also work, though teammates share the stamp, so alone it is
usually ambiguous. Older IDs match the same way, including their complete
seven-digit suffix (`5831042`); legacy `agent-…` IDs retain word matching. Tokens can occur anywhere in
the ID; multi-token references must be adjacent and ordered. Spaces, hyphens (and a stamp's dot)
are equivalent, but partial tokens do not match (`map` is not `maple`). If another
ID starts `standard-cell-river-egg-…`, `river` is
ambiguous, while `maple` and `egg` select their respective agents. Ambiguity lists
full candidate IDs instead of guessing—even if one matching member is inactive.
Use more words or a full ID to disambiguate. Quote references containing spaces
in commands, for example `/team send "river maple" "Please review the change"`.
Tools accept the same multi-word reference as a single string argument.
Omitting `name` in `team_create_member` assigns Alpha, Beta, Gamma, and other
friendly unused names. Autocomplete suggests active member names.

```text
/team budget Alpha
/team budget Alpha 5
/team budget Alpha 5 --resume
/team budget Alpha none
/team model Alpha openrouter/vendor/model-id
/team send "Senior Reviewer" Review the latest patch
/team watch focus Alpha
```

You can instead ask the leader: “Give Alpha a $5 total budget” or “Switch Alpha to
openrouter/vendor/model-id”. It uses `team_set_budget` or `team_set_model` with the
name. Budget changes retain accounting, update ancestor reservations, and enforce
grant, ancestor and global ceilings. They cannot lower the ceiling below consumed
spend. `resume: true` also resumes the member; otherwise paused state is preserved.
`max_cost_usd: null` (or `/team budget <member> none`) removes a member's ceiling.
Run-level caps are removed only by the human, with `/team admin clear-limits`.

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

### Where members run: tmux, Rex, or the built-in session host

Team recruitment and reporting do not require a multiplexer. Members are
interactive Pi sessions you can switch into, wherever the leader runs.

**How the host is chosen.** Each Pi detects its host when it starts, trying the
richest environment first and falling back down the chain:

1. **bb**: detected from `BB_THREAD_ID`. Members as bb child threads are not
   implemented yet, so bb always falls through to the next host.
2. **Rex**: `REX_SERVER`/`REX_BLOCK`. Members open as blocks beside the leader's block.
   tmux running inside Rex uses Rex.
3. **tmux**: `TMUX`/`TMUX_PANE`. Members open as panes beside the leader's pane.
4. **Built-in session host**: always available where prebuilt terminal support exists.
5. **Detached workers**: the last resort.

Environment markers are inherited by child processes, so they are only claims. A host is
used only once the live system confirms this Pi is really inside it:
- tmux must report this Pi's own terminal for the pane.
- Rex's block must be an ancestor process of this Pi.
- Either way, Pi must have a terminal at all. A Pi started by bb, which has none, never takes
  over a tmux pane bb itself was launched from.

Stale markers simply fall through to the next host.

`/team host` shows which host was chosen and why each candidate was skipped.
`/team host refresh` detects again, for example after moving Pi into tmux or Rex.
The `team_host` tool does the same for agents, and the controller API exposes it as
`GET /agents/:id/host` and `POST /agents/:id/host/refresh`. A refresh request is picked up on
the session's next heartbeat. `PI_TEAM_HOST_VERIFY=markers` skips the process check, for
wrappers that run Pi outside the terminal they name; tmux or Rex must still recognise the pane
or block.

| Environment | Default behavior |
|---|---|
| Plain terminal or SSH, without tmux | Members run in the built-in session host. `/team watch focus <name>` switches this terminal into a member; `/team back` there comes back. |
| Rex (Superlogical) | Member creation automatically splits interactive member blocks beside the leader's block. |
| tmux pane containing this Pi | Member creation automatically opens team panes beside Pi unless explicitly disabled. |
| Missing tmux or stale inherited pane markers | The markers fail verification and the next host is used (normally the built-in session host). |
| bb | The built-in session host, until bb child-thread members exist. |
| Herdr | Not specifically supported. It behaves like a plain terminal (built-in session host). tmux markers inherited from an outer tmux fail verification, because Herdr gives Pi its own terminal. |
| Platform without prebuilt terminal support (for example Alpine/musl, Windows) | Workers use detached, one-shot execution. |
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

Detached workers (after `/team watch off`, or where no session host is available)
have no terminal or direct keyboard input. Use the leader's team tools, `/team send`,
`/team inbox`, `/team inspect`, and `/team reporting`. Detached workers exit when their prompt settles and relaunch on
the same transcript for new assignments. The controller and detached workers survive
an ordinary root-session exit or SSH disconnect; host shutdown or session cleanup
policies can still stop processes. Resume with `/team resume` later.

Member panes open beside the leader Pi in tmux and Rex. There is no detached tmux
session mode, and the team never nests or attaches tmux inside another multiplexer. Teams saved by
older versions with a detached tmux session fall back to detached workers; reopen
them from a leader Pi inside tmux.

### Members in a plain terminal (built-in session host)

Outside tmux and Rex, members run in **ptyd**, a small background process (one per
controller state directory) that holds each member's terminal, in the spirit of
Claude Code's background agents. Members keep running when the leader Pi exits or the
SSH connection drops, and `/team resume` returns to them.

- **Seeing them:** a line under the leader's input lists running members, for example
  `team: ● Alpha  ● Beta · /team watch focus <name> switches`.
- **Switching in:** `/team watch focus Alpha` hands this terminal to Alpha's live Pi,
  exactly as Pi hands the terminal to an external editor. You see Alpha's screen and
  type directly to it.
- **Coming back:** type `/team back` in the member. The member keeps running and the
  leader redraws. If a member exits, you return to the leader automatically. No key is
  bound by default; set `PI_TEAM_DETACH_KEY=ctrl-]` (any `ctrl-<key>`) to add one.
- **From another terminal:** `pi-team-attach Alpha` attaches there instead.

The host uses `@lydell/node-pty`, which ships prebuilt binaries for macOS (x64, arm64)
and glibc Linux (x64, arm64; glibc 2.28 or newer), so nothing is compiled at install.
Its log is `ptyd.log` in the state directory; it exits by itself when it hosts nothing.

### Interactive Pi teams in tmux

Both legacy tmux layout strings and tmux 3.8 JSON layouts are supported.

Install `tmux` and put it on PATH. Run `/team watch` or ask the leader to open the
team terminals. **Each member pane runs a separate, interactive Pi harness** on a
real tmux PTY: its own prompt, model, transcript, worktree and process identity.
A deadline-stopped member remains paused and resumable, but its dead Pi pane is
removed automatically after its process exits. A live paused Pi stays visible;
RUNNING workers awaiting restart keep their panes for the executor to reuse.
Removing a pane does not dismiss the member or discard its transcript. Idle workers
and completed tasks alone do not trigger a deadline or pane cleanup.

The agent name appears as a **bold, accent-colored label on the right of the input's top border** (the root shows “Team leader”), as well as highlighted in the footer. The label follows the active identity and theme, fits narrow terminals, and preserves existing custom editors, keyboard shortcuts, and border status indicators. If another editor leaves no spare border space, the footer still identifies the agent. Reload the extension with `/reload` to apply this to an already-open Pi.

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

Use tmux's default `Ctrl-b` then arrow keys to navigate panes, or `z` to zoom a
pane temporarily. `/team watch focus <agent_id>` selects a member and
`/team watch status` reports the session and panes. `Ctrl-b d` and
`/team watch close` leave live Pi processes running. Inside an existing session,
`/team watch close` hides any debug controls without detaching your client or
changing session/window selection. Use
`/team stop <run_id>` to suspend the team, `/team remove <run_id>` to end it permanently, or ask the leader to close a single member. Killing a tmux pane or server terminates the harnesses it hosts;
the controller recovers eligible members within its retry policy, falling back to
detached execution when the saved terminal location is unavailable.

Normal use shows **only the leader and member Pi panes**. Layout coordination runs
inside the existing background controller; there is no TEAM CONTROL pane or extra
coordinator process to watch. `/team watch debug` (or `team_watch` with action
`debug`) opens one optional diagnostic pane. Normal view opening hides legacy
control panes, including duplicates. Pane titles use the assigned member names
rather than Pi's default `π` and worktree identifier.

### Interactive Pi teams in Rex

When the leader Pi runs in a [Rex](https://www.superlogical.com/rex/) terminal, the
same commands work with Rex blocks instead of tmux panes. Members split **in place
in the leader's window**: the first member takes about 40% beside the leader, and
each later member splits the roomiest member block. Each member block is labeled
`Name [agent-id]` and runs its own interactive Pi, so you can click into it or type
directly. `/team watch focus <name>` (or the leader's `team_watch` focus action)
switches Rex's focus to that member; Rex's own keys move between blocks.

Member blocks are held by the Rex server, so they outlive the leader Pi, and
`/team resume` plus `/team watch` returns to them. A member that exits unexpectedly
keeps its block open until the controller relaunches it on its saved transcript in a
replacement block in the same place. Closing a member closes its block; the leader's
block is never closed or resized by the team.

Rex blocks have no per-block metadata, so the team records which block hosts which
member in `rex-tags/` under the controller state directory. The controller calls the
`rex` CLI, which must be on its PATH (starting the controller from a Rex terminal
does this, and Rex's `REX_BIN_DIR` is also checked). If it cannot reach Rex, workers
fall back to detached execution as with tmux. The debug control pane is tmux-only.

### Member decoration

Each member has one decoration: its name, agent ID and a color that stays stable
for that agent. How it is shown depends on what the hosting terminal can render:

| Host capability | Shown as |
|---|---|
| Native components (planned for Rex) | The host's own rich decoration; no extra header |
| Titled border or label (tmux pane title, Rex block label) | Host label `Name [agent-id]`, plus a colored header line drawn by the member Pi |
| Nothing (plain terminals) | The colored header line drawn by the member Pi |

The header line sits above the member's input box and reads
`Name  team member · agent-id`. The leader keeps its "Team leader" input-border label.

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
real Pi processes during promotion. If there is insufficient space, enlarge the terminal
rather than creating more windows. Managed members cannot manage the team terminal session.


## Claude Code interop

Claude Code sessions join the same teams as Pi sessions. Both go through the same local controller
and protocol. A Claude Code session is an ordinary team agent with harness `claude-code`, so
everything else applies unchanged: tasks, messages, attention, reparenting, transfers,
`report-to`/`join` and budgets. Leaders and members can be any mix of Pi and Claude Code.

Install the plugin from this checkout (it supplies the MCP server and hooks):

```text
/plugin marketplace add /path/to/pi-aatwad
/plugin install pi-team@pi-aatwad
```

Then ask Claude to use the `team_*` tools.

| Goal | Tool call |
|---|---|
| Found a team and lead it | `team_join` mode `new_team` |
| Lead an existing team (take over its root) | `team_join` mode `leader`, `run_id` |
| Join under an existing team's leader or an agent (you lead your own team linked under it) | `team_join` mode `member` (or `join`), `run_id`, optional `manager` |
| Resume an existing agent identity | `team_join` mode `agent`, `run_id`, `agent` |
| Link your existing team under another leader | `team_report_to` `run_id` (`none` detaches) |
| Move a member under another manager | `team_reassign` |
| Leave (identity and tasks remain; manager notified) | `team_leave` |

Members a Claude Code leader creates with `team_create_member` run as Pi workers. A Claude Code
member is never launched or relaunched by the controller; its session is the process. When
Claude Code exits without `team_leave`, its lease lapses, the agent shows as lost, and nothing
replaces it. Rejoin with `team_join` mode `agent`, or `/team resume <run_id> <agent>` from Pi.

Delivery mirrors the Pi paths. The MCP server sends the 10-second liveness heartbeat. Hooks
deliver messages:

- `SessionStart` adds team context and keeps the identity across `/clear` and `--resume`.
- `UserPromptSubmit` attaches pending messages to your prompt.
- `Stop` continues with messages that arrived during the turn, at most 5 times per prompt.

An idle Claude Code session cannot be prompted from outside, so the session runs a background
waiter (`node src/claude/cli.ts wait`). It stays silent until the controller decides to wake this
session under its attention policy, then exits with the messages and Claude takes a turn. The
`Stop` hook asks Claude once to restart it if it is not running. Set `PI_TEAM_CLAUDE_WAITER=0` to
rely on prompts and stops only. The `/team attention` settings apply to Claude Code agents too.

Limits: Claude Code does not report per-message cost to the controller, so spend limits do not
count its own usage, though they still count the Pi members it recruits. Model switching
(`team_set_model`) does not apply to Claude Code sessions.

## bb (thread graph proof of concept)

`integrations/bb-plugin-thread-graph` is a bb plugin (bb 0.47+) that draws a left-to-right graph
of threads and their parent/child links above bb's thread list; parentless threads float below.
It is the first step towards showing team members as bb child threads. See its README to install.

## Controller API

The controller serves HTTP on its unix socket (`<state dir>/c.sock`). The full route list,
with each route's auth and purpose, is generated from the route table:

```sh
# macOS; on Linux the socket is ~/.local/state/pi-recursive-team/c.sock
curl -s --unix-socket "$HOME/Library/Application Support/pi-recursive-team/c.sock" http://controller/openapi.json
```

No token or protocol header is needed for this document. Every other request needs the
`x-team-protocol` header and a bearer token. Request and response types are in
`src/shared/protocol.ts`.

## Develop

```bash
npm install          # dev only: typescript + types
npm test             # node --test over test/**
npx tsc --noEmit
bash scripts/demo.sh # end-to-end scenario with a credential-free fake worker → demo-output/
```

The tests never spend provider credits. Worker scenarios use `PI_TEAM_EXECUTOR=test/fixtures/fake-worker.ts`, and real-Pi smoke tests use a local fake OpenAI-compatible server with an isolated `PI_CODING_AGENT_DIR`.

## Uninstall, stop, purge

- `/team stop <run_id>` stops a run's managed workers resumably; `/team remove <run_id>` ends the team permanently.
- `pi remove ./path/to/pi-recursive-team` removes the extension. It does **not** stop running workers or delete organization data.
- To stop the controller, use `/team stop` on active runs (it idles out on its own) or send SIGTERM to the pid in `controller.json`.
- To purge all state, run this after stopping: `rm -rf "<state dir>"` (path above). Worker worktrees live under each workspace's `.team-worktrees/`. Remove them with `git worktree remove`.

## Limitations

- **Not a sandbox.** Limits apply only to *managed* workers. Any agent with shell access can start unmanaged processes, spend money directly, or read files the OS user can read, including the controller's `operator.token`. Governance is cooperative accounting plus process supervision, not isolation. Managed workers are not given `PI_TEAM_STATE_DIR` and reach the controller only through the socket named in their one-time enrollment file. But a same-uid worker can still find the state dir at its default path (and read `operator.token` / `org.sqlite`), so this is mitigation, not isolation.
- Cost accounting is approximate. Reservations are estimates; actual spend is reconciled only from usage that workers report (`/sessions/usage`).
- There is no automatic worktree merge or cleanup, no fork-as-new-agent attach mode, and no Windows IPC.
- Model ids containing `:` are interpreted by Pi as a thinking-level suffix.
