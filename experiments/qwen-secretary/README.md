# Qwen secretary experiment

Can a 27B open model act as a top-level "secretary" leader that keeps track of three
independent projects, each run by a more capable sub-leader with its own team? The
experiment also exercises the unified team links end to end: joining, assigning work across
a link, scheduled check-ins, dismissal, leaving, and stopping.

## Cast

| Session | Model | Role |
|---|---|---|
| T-secretary | Qwen 3.8 27B (`mac-studio-1-mtplx/mtplx-qwen38-27b-optimized-speed`) | Top-level leader; keeps `/work/lead/journal.md` |
| A-ledger | Claude Opus 5.5 | Hard project: Python package + CLI + tests, two members |
| B-sortbench | GPT-5.6-Sol | Medium project: sorting benchmark and report, one member |
| C-booknotes | OpenRouter free router | Easy project: summarize chapters I-III of *The Time Machine*, one member |

Missions and the secretary's standing instructions are in `missions.ts`.

## Script (driver.ts)

The driver plays the human operator. It runs every leader as a Pi RPC session and checks each
step against the controller database.

1. B and C start independently (`/team init`) and begin their missions.
2. T starts and receives its standing instructions (interaction 1). A starts and joins T
   (`/team join <T>`). T gets a scheduled check-in (`/team attention checkin 5m`) and assigns
   A its mission with `team_delegate_task` (interaction 2).
3. After A starts working, B and C join T. T adds them to the journal and runs a status round
   (interaction 3: first milestone update).
4. The operator talks directly to C.
5. Interactions 4 and 5 with T: a question answered from the journal, and a request relayed to B.
6. T handles two scheduled check-ins on its own (5 and 10 minutes after they are enabled).
7. Interaction 6: second milestone status round.
8. Verify the four leaders are connected and idle.
9. The operator makes A's link terminatable; T closes A's team (resumable stop).
10. B leaves T (`/team join none`).
11. C closes its own members through itself and idles.
12. The operator makes C's link terminatable and stops T (cascading to C); B is stopped
    separately. All Pi processes exit; the agents remain in the database.

## Running it

```sh
# from the repository root
docker build -f experiments/qwen-secretary/Dockerfile -t pi-team-experiment .
mkdir -p experiments/qwen-secretary/seed experiments/qwen-secretary/results
curl -L -o experiments/qwen-secretary/seed/book.txt https://gutenberg.pglaf.org/cache/epub/35/pg35.txt
S=$(mktemp -d); cp ~/.pi/agent/auth.json ~/.pi/agent/models.json "$S"/
docker run --rm --init -v "$S:/pi-agent" -v "$PWD/experiments/qwen-secretary/results:/results" \
  -v "$PWD/experiments/qwen-secretary/seed:/seed:ro" pi-team-experiment
```

Credentials are copied, not mounted, so an OAuth refresh inside the container cannot race the
host. If the container refreshed a token, copy that provider's entry back to the host's
`auth.json` afterwards, then delete the temporary directory. Models can be overridden with
`MODEL_LEAD`, `MODEL_A`, `MODEL_B`, `MODEL_C`, and the interval with `CHECKIN`.

Results land in `results/`: `transcript.md` (the operator's view), per-session event logs,
journal snapshots, the final `journal.md`, project archives and `checks.json`.
