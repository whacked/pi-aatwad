import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/controller/db.ts";
import { packageRoot } from "../../src/shared/paths.ts";

test("schema 5 turns leader-to-leader links and joined members into unified links, keeping history and coordination messages", () => {
	const dir = mkdtempSync(join(tmpdir(), "pt-mig5-"));
	const old = join(dir, "old");
	mkdirSync(old);
	for (const f of readdirSync(join(packageRoot(), "db")).filter((f) => /^00[1-4]_.*\.sql$/.test(f))) copyFileSync(join(packageRoot(), "db", f), join(old, f));
	const db = new DatabaseSync(join(dir, "org.sqlite"));
	try {
		db.exec("PRAGMA foreign_keys = ON;");
		assert.equal(migrate(db as never, old), 4);
		const run = (id: string, root: string) => {
			db.prepare("INSERT INTO runs(id, status, config_json) VALUES (?, 'RUNNING', '{}')").run(id);
			db.prepare("INSERT INTO agents(id, run_id, role, status) VALUES (?, ?, 'root', 'RUNNING')").run(root, id);
			db.prepare("UPDATE runs SET root_agent_id = ? WHERE id = ?").run(root, id);
		};
		run("run-top", "root-top"); run("run-mid", "root-mid"); run("run-old", "root-old");
		// A member that joined from outside, and an ordinary recruit, inside run-top.
		for (const [agent, status] of [["joined-1", "EXTERNAL"], ["recruit-1", "LIVE"]]) {
			db.prepare("INSERT INTO agents(id, run_id, role, status) VALUES (?, 'run-top', 'member', 'RUNNING')").run(agent);
			db.prepare("INSERT INTO reporting_edges(id, run_id, parent_id, child_id, valid_from) VALUES (?, 'run-top', 'root-top', ?, '2026-01-01')").run(`edge-${agent}`, agent);
			db.prepare("INSERT INTO spawn_intents(id, role_index, ordinal, agent_id, status) VALUES (?, 0, 0, ?, ?)").run(`spawn-${agent}`, agent, status);
		}
		db.prepare("INSERT INTO team_reporting_links(id, child_run_id, parent_run_id, created_at) VALUES ('report-active', 'run-mid', 'run-top', '2026-02-01')").run();
		db.prepare("INSERT INTO team_reporting_links(id, child_run_id, parent_run_id, created_at, closed_at, close_reason) VALUES ('report-closed', 'run-old', 'run-top', '2026-01-15', '2026-01-20', 'dismissed')").run();
		db.prepare("INSERT INTO messages(id, run_id, sender_id, recipient_id, type, payload_json) VALUES ('msg-1', 'run-top', 'root-mid', 'root-top', 'task.progress', '{}')").run();
		db.prepare("INSERT INTO team_reporting_messages(message_id, link_id) VALUES ('msg-1', 'report-active')").run();

		assert.equal(migrate(db as never, join(packageRoot(), "db")), 5);
		const links = db.prepare("SELECT id, run_id, parent_run_id, parent_id, child_id, valid_from, valid_to, origin, terminatable, close_reason FROM reporting_edges WHERE parent_run_id IS NOT NULL ORDER BY id").all();
		assert.deepEqual(links.map((l) => ({ ...l })), [
			{ id: "report-active", run_id: "run-mid", parent_run_id: "run-top", parent_id: "root-top", child_id: "root-mid", valid_from: "2026-02-01", valid_to: null, origin: "joined", terminatable: 0, close_reason: null },
			{ id: "report-closed", run_id: "run-old", parent_run_id: "run-top", parent_id: "root-top", child_id: "root-old", valid_from: "2026-01-15", valid_to: "2026-01-20", origin: "joined", terminatable: 0, close_reason: "dismissed" },
		]);
		const inTeam = Object.fromEntries(db.prepare("SELECT child_id, origin, terminatable FROM reporting_edges WHERE parent_run_id IS NULL").all().map((r) => [r.child_id, [r.origin, r.terminatable]]));
		assert.deepEqual(inTeam, { "joined-1": ["joined", 0], "recruit-1": ["spawned", 1] });
		assert.deepEqual({ ...db.prepare("SELECT link_id FROM team_reporting_messages WHERE message_id = 'msg-1'").get() }, { link_id: "report-active" });
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM team_reporting_links WHERE closed_at IS NULL").get()!.n, 1, "compatibility view");
		assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
