# Qwen secretary experiment: results (2026-11-22)

**Verdict:** Qwen 3.8 27B worked as a secretary-style top-level leader. Over 21 minutes it
tracked three projects run by stronger sub-leaders, ran three operator-requested status rounds
(including the two milestone rounds) and two scheduled check-ins on its own, relayed requests,
and kept an accurate journal. Join, assignment
across a link, dismissal, leaving and stopping all behaved as designed. 13 of 14 scripted checks
passed; the one failure is explained below and is not a defect.

Run: Docker (linux/aarch64, Node 24, Pi 1.5.0), 21.4 minutes, all Pi processes driven over RPC by
`driver.ts`. Final journal: [`results/journal.md`](results/journal.md); its 22 intermediate versions
are in `results/journal-snapshots/`; the operator's view is in
[`results/transcript.md`](results/transcript.md).

## Cast and outcome

| Leader | Model | Mission | Outcome |
|---|---|---|---|
| T, secretary | Qwen 3.8 27B (mac-studio-1 mtplx) | Track the program, keep `journal.md` | 80 model responses, all tool calls well-formed |
| A, LEDGER | Opus 5.5 | Python package + CLI + tests; 2 members | Done about 2 minutes after assignment: 11/11 tests pass, CLI flags the over-budget month |
| B, SORTBENCH | GPT-5.6-Sol | Benchmark + report; 1 member | Done in about 4.5 min, then extended on request (memory section) |
| C, BOOKNOTES | OpenRouter free | Summaries of chapters I-III; 1 member | Done in about 4 min, then extended on the operator's direct request (themes) |

All three sub-leaders recruited their own members, as required. The missions were easier than
intended: every project finished within about 5 minutes, so the later status rounds reported
completed, idle projects. A follow-up run should use missions that take 10-20 minutes so status
rounds see work in progress.

## Timeline (minutes from start)

| Time | Event |
|---|---|
| 0.0 | B and C start independently and begin their missions |
| 0.1 | T starts and creates the journal (interaction 1) |
| 0.3 | A starts and joins T; T gets a 5-minute scheduled check-in |
| 0.8 | T assigns A its mission across the link with `team_delegate_task` (interaction 2) |
| 1.8 | B and C, mid-mission, join T |
| 2.4-3.3 | Status round 1 (interaction 3): T asks all three, their answers wake it, journal updated |
| 3.8-6.1 | T, unprompted, tells each sub-leader to close its idle members; all three do |
| 7.1 | Operator talks directly to C (themes) |
| 7.2 | Interaction 4: risk question answered from the journal only, as asked |
| 7.2-8.8 | Interaction 5: T records a new requirement and relays it to B; B delivers; T records it |
| 9.4 | Scheduled check-in 1: T asks all three, records the confirmations |
| 14.4 | Scheduled check-in 2: same |
| 16.8 | Interaction 6: status round 2 with deliverables (commit IDs) recorded |
| 19.4 | Check-in 3 handled sensibly: no new questions, since a full round had just completed |
| 20.4 | Verified: T, A, B, C connected (LIVE), idle, awaiting instructions |
| 20.6 | Operator makes A's link terminatable; T closes A's team: stopped, resumable, link closed |
| 20.7 | B leaves T (`/team join none`): detached, still running independently |
| 21.2 | C closes its own team's members through itself and idles |
| 21.3 | Operator makes C's link terminatable and stops T: T and C stop together; B is stopped separately |
| 21.4 | No Pi processes remain; all agents and transcripts are kept in the database |

## How well the 27B model did

**Strengths**
- **Followed the standing brief:** the journal format, timestamps from `date -u`, and the
  ask-then-end-turn pattern. It never polled or slept, and every answer from a sub-leader woke it
  and led to a journal update.
- **Accurate, specific journal:** commit IDs, test counts, and the over-budget month. It
  reconciled reports that arrived out of order and noted when a project was extended.
- **Correct tool use across links:** `team_delegate_task` with its own acceptance criteria;
  `team_send_message` questions to sub-leaders in other teams; `team_close_member` to dismiss A.
- **Followed constraints:** the "do not contact anyone" constraint on interaction 4.
- **Proportionate check-ins:** on the third check-in it decided not to re-ask because a full
  round had just finished.

**Lapses**
- **Acted beyond its brief (unprompted cleanup):** it told the sub-leaders to close their idle
  members without being asked (3.8-6.1 min). The brief said it only relays the operator's
  requests. Harmless here, but a secretary should not direct resource changes unprompted.
- **Misattribution:** it credited BOOKNOTES with adding themes "on its own initiative". The
  operator had asked C directly, which the secretary could not see. Talking to a sub-leader
  directly leaves the secretary's record incomplete unless the sub-leader reports it.
- **A promise it cannot keep:** it agreed to "pause" LEDGER's scheduled check-ins. The schedule
  belongs to the secretary itself, so the promise means nothing to the controller (it did then
  skip re-asking LEDGER).

Speed was not a problem: short replies took 5-20 seconds, and a full status round took about a
minute.

## Join, leave and close behaviour

| Operation | Result |
|---|---|
| Join under T (A before its mission; B and C mid-mission) | Joined, not terminatable, as default; introductions delivered to both sides |
| Assign work across a link | Task created in T's team, owned by A; A woke on it and reported completion up |
| Peers / up / down messaging | All status traffic flowed down (questions) and up (answers, progress, completion) |
| Scheduled check-ins (`/team attention checkin 5m`) | Fired at 9.4, 14.4 and 19.4 min, 5 minutes apart |
| Four leaders awaiting instructions | Verified LIVE and idle before teardown |
| Close A (operator made it terminatable; T dismissed it) | A's team stopped (resumable) and its link closed |
| Disconnect B (`/team join none`) | Link closed; B kept running as an independent leader |
| C deallocates its own team | C closed its member itself and stayed idle |
| Close T and everything around it | T stopped and C stopped with it (terminatable); B stopped separately; no processes left; memory kept |

**The failed check:** "A's members are paused, not deleted" failed because A had already closed
its members at the secretary's suggestion (minute 4.3), so there was nothing left for the
dismissal to stop resumably. The dismissal itself worked: A's team went to STOPPED, resumable.

**First check-in later than nominal (cause not determined):** the schedule should have started
about 0.9 min in, the first time T was idle with a sub-leader linked, so the first check-in was due
near 5.9 min. It came at 9.4 min; after that the 5-minute spacing was exact. The controller's
in-memory wake state was lost with the container, and wakes are not recorded as events, so it is
unclear whether the schedule started late or a check-in was decided while T had just become busy and
was dropped by the extension (the heartbeat reply arrives after the busy flag was sent). Follow-up:
record each wake as an event, and have the extension queue a wake that arrives while busy instead of
discarding it.

## Environment and cost

- **Linux:** the built-in session host's tests pass on linux/aarch64 with the prebuilt
  `@lydell/node-pty-linux-arm64` (nothing compiled), including attaching from a real PTY. A
  separate check confirmed that recruits of an RPC-driven leader in the container ran as live
  interactive Pi sessions in the built-in host (native backend).
- **Credentials:** copied (not mounted) into the container. No token was refreshed inside it, so
  the host credentials were untouched; the copies were deleted afterwards.
- **Cost:** the controller recorded a nominal $1.35 at list prices: A's leader $0.46, B's leader
  $0.40, the rest from their members. Opus and Sol ran on subscription OAuth, and Qwen and the
  OpenRouter free model cost nothing, so actual API spend was about $0. Even at list prices it
  stayed under the $2 budget.

## Changes made for this experiment

- **Scheduled check-ins** (`checkin_seconds`, `/team attention checkin 5m`): wake a lead on a
  fixed schedule even when nothing changed. Existing ticks fire only on change.
- **Attention digests** (stall, tick, check-in) now include a lead's linked sub-leaders and the
  tasks assigned to them. Before this, a secretary whose reports were linked teams got empty
  digests, and check-ins never fired.
- **This harness:** Dockerfile, RPC driver and missions, reusable for the next round.

## Suggestions for the next round

1. **Harder missions:** 10-20 minutes each, so status rounds report real progress and the timed
   check-ins land mid-work.
2. **Restrict initiative in the brief,** or give the secretary a narrower toolset (for example no
   `team_close_member` until the operator asks), to measure whether a 27B model respects role
   limits.
3. **Copy direct operator requests to the lead:** when the operator talks to a sub-leader directly,
   have the sub-leader send its lead a short note, so the secretary's journal stays complete.
4. **Teach the secretary the check-in controls:** expose `/team attention` per report, so it can
   actually pause check-ins for one project instead of promising to.
5. **Make wakes observable and loss-free** (see the late first check-in above).
