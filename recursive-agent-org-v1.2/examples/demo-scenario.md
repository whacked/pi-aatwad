# Executable demo script specification

Provide a `scripts/demo.sh` (or TypeScript test) that runs:

1. Initialize SQLite, register two available models, launch root A.
2. Root delegates a verification task to Lead B, configured on a different model. Inspect `org tree` and persisted sessions.
3. B proposes 2 workers; A approves within a delegated envelope; controller reserves budget and spawns C, D.
4. C, itself a subordinate, proposes one nested worker E. Initially request exceeds C/B delegated slots. B escalates; A approves an increased bounded grant; controller spawns E.
5. D proposes 100 workers; reject for global cap, with an audit event and no spawn.
6. Reparent E from C to B; validate no cycles, transfer reservations; verify historical edge remains.
7. Kill controller mid-delivery; restart; verify no duplicate workers and no missing messages, reattach or recover live sessions.
8. Pause/resume a worker; complete work; retire subtree; verify final reservation release and task artifacts.
9. Output `tree.json`, `events.jsonl`, `budget.json`, and `test-report.txt` into `demo-output/`.

All IDs and model names in examples are illustrative; scripts must use configured installed providers and never assume paid API credentials exist.

## Invocation
Perform this from an ordinary Pi session with the installed extension: `/team init`, initiate task/delegation through agent tools, inspect with `/team tree` and `/team budget`. Exit the root Pi interface while a child runs, then reopen Pi and inspect/reconnect. No independent `org` CLI installation or manually launched controller.
