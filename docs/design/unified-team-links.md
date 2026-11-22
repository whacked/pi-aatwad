# Unified team links: join = report-to, with lead authority

Status: agreed design (2026-11-22). Phases 1-3 implemented (schema 5, v0.1.28); later phases pending.

## Why

Today a session can connect to another in two unrelated ways:

- **Join as a member** (Claude Code `team_join` mode `member`, `POST /runs/:id/join`):
  the session becomes an agent inside the other team's run, under a manager, with the
  team's budget and the manager's control. It gives up the team it was leading.
- **Report to a leader** (`/team report-to`, `/team join` in Pi, Claude Code
  `team_report_to`): two independent teams linked root to root. Reports and questions
  flow; the parent has no authority.

The two are the same idea seen at different sizes. Every session leads a team, possibly
an empty one. A "member" is an agent whose team happens to be empty. "Lead" and "member"
are positions in the information flow, not kinds of agent.

## Model

### Links

A **link** attaches a child agent under a parent agent. Any agent can link under any other
agent, in the same team or another one.

| Rule | Detail |
|---|---|
| One lead | An agent has at most one active parent link. |
| No cycles | A link that would make an agent its own ancestor is rejected. |
| Rerouting | Detach, then attach. There is no move-in-place. |
| Who links | The human operator, directly or by telling an agent to. The receiving side does not accept or refuse. |
| Origin | `spawned` (the parent recruited the child) or `joined` (an existing session attached). |
| `terminatable` | Per link. Defaults: spawned = true, joined = false. The human operator can change it and can override every rule below. |

`join` and `report-to` become the same operation: create a `joined` link.

### Direction of control and information

- **Control flows down one step.** A parent can assign tasks to, message, and dismiss its
  direct children only. It cannot reach its children's children; the child decides how to
  delegate further.
- **Reports flow up and sideways.** A child reports to its parent and can message its
  peers (other children of the same parent), across teams.

### Tasks across a link

A task assigned by a parent lives in the parent's team and is owned by the child. The child
can break it into tasks in its own team; those link back to the parent task as
`parent_task_id`. Progress and completion flow up to the parent's team.

### Dismissal

Dismissing a child is a message to terminate its team. What happens depends on the link:

| Link | Effect of dismissal |
|---|---|
| Not terminatable (default for joins) | Only the link is severed. The child's team keeps running and becomes independent. |
| Terminatable (default for recruits) | The child's team is stopped: sessions end and terminals close. |

Stopping cascades down through terminatable links only. At a non-terminatable link the
cascade severs that link instead, and the agent below keeps running as an independent
lead. Example: lead A has joined sub-lead B (not terminatable). B has recruits B1 and B2
(terminatable) and a joined sub-lead C (not terminatable).

- A dismisses B: the A to B link is severed. Nothing stops.
- A human makes the A to B link terminatable, then A dismisses B: B, B1 and B2 stop.
  The B to C link is severed, and C keeps running.
- B dismisses B1: B1 stops.

When a lead's own team is stopped, children on terminatable links stop with it. Children
on non-terminatable links keep running, and their reports queue until the lead returns.

Stopping is not permanent removal. It ends sessions and closes terminals, keeping
identities, transcripts, tasks and worktrees. Permanent removal stays a separate operator
action.

### Roster

Every team keeps the history of its children, including stopped and severed ones. From the
roster a lead (or the human) can:

- **Recall** a former child: resume the same agent identity and transcript ("call the
  contractor back"), and re-link it.
- **Rehire** a position: create a new agent with the same name and responsibility but a
  fresh context ("new hire, same position").

### Budget

- A joined team keeps the budget it already had. If it could run a task before, it can run
  it to the end of its budget.
- If the new parent has a default budget policy for new members, that amount is added to
  the joined team's budget when the link is made.
- Budgets remain unlimited by default, so neither rule changes anything unless limits were
  set.
- Each team keeps spending from its own budget; links do not pool or cap spend beyond the
  one-time addition.

## Surfaces

| Operation | Pi | Claude Code |
|---|---|---|
| Lead a new team | `/team init` | `team_join` mode `new_team` |
| Attach this session under another agent | `/team join <agent or run> [--terminatable]` (`/team report-to` stays as an alias) | `team_join` mode `join`, `target`, optional `terminatable` |
| Detach from the current lead | `/team join none` (`/team report-to none`) | `team_report_to none` / `team_leave` link-only |
| Recruit a worker (spawned, terminatable) | `team_create_member` | `team_create_member` |
| Dismiss a direct child | `team_close_member`, `/team dismiss <name>` | `team_close_member` |
| Take over an existing identity | `/team resume <run> [agent]` | `team_join` mode `leader` / `agent` |
| Recall or rehire from the roster | `/team recall <name>`, `/team rehire <name>` | same tools |

A session that is not leading a team when it joins gets an empty team created first, so it
always joins as a lead of its own (possibly empty) team.

## Migration from the current data model

| Today | Becomes |
|---|---|
| `reporting_edges` (manager to member inside a run) | Links with origin `spawned`, terminatable. |
| `team_reporting_links` (root run to root run) | Links between the two root agents, origin `joined`, not terminatable. |
| In-run members added by `POST /runs/:id/join` | Links with origin `joined`, not terminatable. |
| Cross-team restrictions (no delegation, `question`/`answer`/`task.progress` only) | Replaced by the one-step control rule above. |

Runs stay as the unit of budget, transcripts and worktrees. What changes is that links can
cross runs and carry `terminatable`.

## Implementation phases

1. **Links table:** one table for parent/child agent links with origin, `terminatable`,
   validity window, one-parent and no-cycle checks. Migrate both existing edge tables.
2. **Authority:** one-step parent powers across links (assign, message, dismiss), peer
   messaging across teams, cross-team tasks owned by the child.
3. **Dismissal and stopping:** the cascade rules above, with operator override.
4. **Budget:** carry-over plus the one-time additive grant.
5. **Surfaces:** unified Pi commands and Claude Code tools; `/team join` and
   `/team report-to` become one operation.
6. **Roster:** recall and rehire.
7. **Display:** the leader's member strip and tree show joined children as well as
   recruits; joined children are switched to in their own terminals or harness windows.

## Open questions

- Can a lead **see** (read-only) deeper than one level, for example its children's
  rosters and task progress, while only controlling one level down?
- Names: what happens when a joining agent's name collides with an existing child name?
- Recruiting a Claude Code worker from either harness remains out of scope.
