import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../../src/controller/db.ts";
import { EventConsumer, pruneEvents } from "../../src/controller/history.ts";
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
		}
		// A row left by the outbox that controllers before v0.1.53 wrote for every event.
		db.prepare("INSERT INTO outbox(id, event_id, topic, payload_json, status, available_at) SELECT 'obx-legacy', id, type, '{}', 'PUBLISHED', ? FROM events WHERE type = 'agent.lost'").run(old);
		const count = (type: string) => Number(sql(h, "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ?", t.run_id, type)[0].n);
		assert.equal(pruneEvents(db), 2);
		assert.equal(count("usage.reported"), 1, "recent usage kept");
		assert.equal(count("agent.lost"), 0);
		assert.equal(count("task.completed"), 1, "task history is never pruned");
		assert.equal(Number(sql(h, "SELECT COUNT(*) AS n FROM outbox")[0].n), 0, "old published outbox rows are gone, and no new ones are written");
	} finally { await h.cleanup(); }
});

test("consumers follow the log by cursor, and retention waits for the slowest one that holds it", async () => {
	const h = await harness();
	try {
		const t = await newRun(h);
		const db = h.h.db;
		const seen: string[] = [];
		const audit = new EventConsumer(db, "test-audit", (events) => seen.push(...events.map((e) => e.type)));
		const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
		emit(db, { run_id: t.run_id, actor_id: t.root, type: "usage.reported", entity_id: t.root, payload: {} });
		db.prepare("UPDATE events SET created_at = ? WHERE seq = (SELECT MAX(seq) FROM events)").run(old);
		assert.equal(pruneEvents(db), 0, "the audit consumer has not read it yet");
		assert.equal(audit.poll(), 1);
		assert.deepEqual(seen, ["usage.reported"]);
		assert.equal(audit.poll(), 0, "nothing new");
		assert.equal(pruneEvents(db), 1, "read by every consumer that holds retention, so it may go");
		audit.close();
	} finally { await h.cleanup(); }
});
