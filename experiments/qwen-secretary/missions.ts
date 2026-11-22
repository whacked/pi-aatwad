// Missions for the Qwen secretary experiment: three projects of different difficulty, each
// meant to finish within about 15 minutes, plus the secretary's standing instructions.

export const SECRETARY_BRIEF = `You are my secretary and the top-level leader of a small program of three independent projects. You do not do project work yourself and you do not recruit members. Sub-leaders will report to you; each runs its own team.

Your job:
- Keep track of each project and its sub-leader, and relay my requests to them.
- Keep /work/lead/journal.md current. Format: a "Projects" section with one subsection per project (project name, sub-leader agent ID, mission in one line, status, last update time, latest report in 1-3 lines), then a "Log" section of timestamped entries, newest last. Use the current UTC time (run \`date -u +%H:%M\` when you need it).
- When I ask for a status update, and on every scheduled check-in: send each sub-leader one short question asking for its status (team_send_message, type question), then end your turn. When their answers arrive, update the project subsections and add one log entry, then give me a 2-4 line summary. Do not poll, sleep or wait for replies.
- Answer my questions briefly.

Start now: create /work/lead/journal.md with the two sections and one log entry saying the program started. There are no projects yet.`;

export const MISSIONS = {
	a: `Project LEDGER, in /work/ledger (a git repository). Build a small Python package \`ledger\` with a CLI: \`python3 -m ledger report transactions.csv --rules rules.json\`. It must (1) parse a CSV of bank transactions (date, description, amount), (2) assign each a category using keyword rules from rules.json, (3) print a per-month, per-category spending table, and (4) flag months whose total spending exceeds a monthly budget given in rules.json. Include sample transactions.csv and rules.json, pytest tests (\`python3 -m pytest\` must pass), and a short README. Recruit two members with team_create_member (for example an implementer and a tester) and coordinate them; integrate their work into the main branch of /work/ledger. Keep it small and finish within 15 minutes. Report progress to your lead when asked.`,

	b: `Project SORTBENCH, in /work/sortbench (a git repository). Produce report.md comparing insertion sort, merge sort and Python's built-in sorted() on random, already-sorted and reversed inputs of 1,000, 5,000 and 20,000 integers. Recruit one member with team_create_member to write and run bench.py (pure Python, standard library only; cap insertion sort at 5,000 items so it stays fast) and send you the timings; you write the analysis and the conclusions. Commit both files to main. Finish within 15 minutes.`,

	c: `Project BOOKNOTES, in /work/booknotes (a git repository). book.txt is H. G. Wells' "The Time Machine". Write summaries.md with a short summary (3-5 sentences) of each of chapters I, II and III only. Recruit one member with team_create_member to summarize chapter III while you summarize chapters I and II; then combine everything into summaries.md and commit it to main. Finish within 15 minutes.`,
};
