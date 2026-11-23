#!/usr/bin/env node
// Fake bb CLI for tests: just enough of `bb thread …` for the bb backend. State lives in the JSON file
// $FAKE_BB_STATE ({threads: {id: thread}, calls: [argv]}); every mutating call is recorded there. Reads
// (show, list) never write, so a polling supervisor cannot overwrite a concurrent change.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const file = process.env.FAKE_BB_STATE;
if (!file) { process.stderr.write("FAKE_BB_STATE is not set\n"); process.exit(2); }
const state = JSON.parse(readFileSync(file, "utf8"));
const argv = process.argv.slice(2);
const readOnly = argv[1] === "show" || argv[1] === "list";
if (!readOnly) state.calls.push(argv);
const save = () => { if (!readOnly) writeFileSync(file, JSON.stringify(state, null, 1)); };
const json = argv.includes("--json");
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const opts = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const out = (v) => { save(); process.stdout.write(JSON.stringify(v) + "\n"); process.exit(0); };
const notFound = (id) => {
	save();
	if (json) process.stdout.write(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: `Thread not found: ${id}` } }) + "\n");
	else process.stderr.write(`Error: Thread not found: ${id}\n`);
	process.exit(1);
};
const [group, cmd, id] = argv;
if (group !== "thread") { save(); process.stderr.write(`unsupported: ${argv.join(" ")}\n`); process.exit(2); }
const t = id && !id.startsWith("--") ? state.threads[id] : undefined;
switch (cmd) {
	case "show":
		if (!t) notFound(id);
		out({ thread: t, environment: t.hostId ? { id: `env_${t.id}`, hostId: t.hostId, path: t.path } : null, pendingTodos: [] });
	case "list":
		out(opts("--thread").map((x) => state.threads[x]).filter((x) => x && !x.deletedAt));
	case "spawn": {
		if (state.failSpawn) { save(); process.stderr.write(`Error: ${state.failSpawn}\n`); process.exit(1); }
		const nid = `thr_fake${Object.keys(state.threads).length + 1}`;
		const prompt = readFileSync(opt("--prompt-file"), "utf8");
		state.threads[nid] = { id: nid, status: "active", title: opt("--title") ?? null, projectId: opt("--project"), parentThreadId: opt("--parent-thread"), hostId: opt("--machine"), path: opt("--environment"), model: opt("--model") ?? null, prompts: [prompt], archivedAt: null, deletedAt: null };
		if (state.dataDir) mkdirSync(join(state.dataDir, "thread-storage", nid), { recursive: true });
		out({ id: nid, status: "active" });
	}
	case "tell":
		if (!t) notFound(id);
		if (t.archivedAt) { save(); process.stderr.write("Error: HTTP 409: Thread is archived\n"); process.exit(1); }
		t.prompts.push(readFileSync(opt("--message-file"), "utf8"));
		t.status = "active";
		save(); process.exit(0);
	case "stop":
		if (!t) notFound(id);
		t.status = "idle"; t.stopped = (t.stopped ?? 0) + 1;
		save(); process.exit(0);
	case "archive":
		if (!t) notFound(id);
		t.archivedAt = new Date().toISOString();
		save(); process.exit(0);
	case "open":
		if (!t) notFound(id);
		save(); process.exit(0);
	default:
		save(); process.stderr.write(`unsupported: ${argv.join(" ")}\n`); process.exit(2);
}
