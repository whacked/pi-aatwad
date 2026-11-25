import { test } from "node:test";
import assert from "node:assert/strict";
import { emit, pruneEvents } from "../../src/controller/db.ts";
import { harness, newRun, sql } from "./helpers.ts";

test("old usage reports and liveness flaps are pruned; the rest of the audit trail is kept", async () => {
	const h = await harness();
	try {
		const t = await newRun(h);
		const db = h.h.db;
		const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString(), recent = new Date(Date.now() - 3600_000).toISOString();
		for (const [type, at] of [["usage.reported", old], ["usage.reported", recent], ["agent.lost", old], ["task.completed", old]] as const) {
			emit(db, { run_id: t.run_id, actor_id: t.root, type, entity_id: t.root, payload: {} });
			db.prepare("UPDATE events SET created_at = ? WHERE seq = (SELECT MAX(seq) FROM events)").run(at);
			db.prepare("UPDATE outbox SET status = 'PUBLISHED', available_at = ? WHERE event_id = (SELECT id FROM events WHERE seq = (SELECT MAX(seq) FROM events))").run(at);
		}
		const count = (type: string) => Number(sql(h, "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ?", t.run_id, type)[0].n);
		assert.equal(pruneEvents(db), 2);
		assert.equal(count("usage.reported"), 1, "recent usage kept");
		assert.equal(count("agent.lost"), 0);
		assert.equal(count("task.completed"), 1, "task history is never pruned");
		assert.equal(Number(sql(h, "SELECT COUNT(*) AS n FROM outbox WHERE available_at = ?", old)[0].n), 0, "old published outbox rows are gone");
	} finally { await h.cleanup(); }
});
