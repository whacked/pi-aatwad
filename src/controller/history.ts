// The event log. Writes go through emit() (db.ts), inside the transaction of the change they record.
// Every read of event history goes through this module, so the store behind it (today the events
// table in org.sqlite) can later be tiered or moved, e.g. old events offloaded and loaded back,
// without touching the features that read it. Readers must tolerate missing history: retention or
// offloading may have removed old events.
import { type DB, all, get, parseJson, run } from "./db.ts";

export interface EventRow {
	seq: number;
	id: string;
	run_id: string;
	actor_id: string | null;
	type: string;
	entity_id: string | null;
	payload_json: string;
	created_at: string;
}

export interface EventQuery {
	run_id?: string;
	/** Any of these event types. */
	types?: readonly string[];
	/** Any of these entities (an agent, a task, a link...). */
	entity_ids?: readonly string[];
	after_seq?: number;
	/** created_at strictly after this ISO time. */
	since?: string;
	limit?: number;
	/** Oldest first (default) or newest first. */
	order?: "asc" | "desc";
}

function where(q: EventQuery): { sql: string; params: unknown[] } {
	const clauses: string[] = [], params: unknown[] = [];
	if (q.run_id !== undefined) { clauses.push("run_id = ?"); params.push(q.run_id); }
	if (q.types?.length) { clauses.push(`type IN (${q.types.map(() => "?").join(",")})`); params.push(...q.types); }
	if (q.entity_ids) {
		if (!q.entity_ids.length) return { sql: "WHERE 0", params: [] };
		clauses.push(`entity_id IN (${q.entity_ids.map(() => "?").join(",")})`); params.push(...q.entity_ids);
	}
	if (q.after_seq !== undefined) { clauses.push("seq > ?"); params.push(q.after_seq); }
	if (q.since !== undefined) { clauses.push("created_at > ?"); params.push(q.since); }
	return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function scanEvents(db: DB, q: EventQuery = {}): EventRow[] {
	const w = where(q);
	const limit = q.limit ?? 1000;
	return all(db, `SELECT seq, id, run_id, actor_id, type, entity_id, payload_json, created_at FROM events ${w.sql} ORDER BY seq ${q.order === "desc" ? "DESC" : "ASC"} LIMIT ?`, ...w.params, limit) as EventRow[];
}

export function latestEvent(db: DB, q: EventQuery = {}): EventRow | undefined {
	return scanEvents(db, { ...q, order: "desc", limit: 1 })[0];
}

export function countEvents(db: DB, q: EventQuery = {}): number {
	const w = where(q);
	return Number(get(db, `SELECT COUNT(*) AS n FROM events ${w.sql}`, ...w.params)!.n);
}

export function payloadOf<T>(e: EventRow): T {
	return parseJson<T>(e.payload_json, {} as T);
}

/** The newest event's sequence number (0 for an empty log). */
export function headSeq(db: DB): number {
	return Number(get(db, "SELECT COALESCE(MAX(seq), 0) AS s FROM events")!.s);
}

// ------------------------------------------------------------------ consumers
/**
 * A reader that follows the log in order and remembers how far it got (its cursor), instead of a
 * per-row "published" flag. Any number of consumers can follow the same log independently.
 * Cursors are in memory: a consumer that must survive restarts without gaps needs a durable cursor
 * (a table) when one is added. Retention never deletes events a registered consumer has not read,
 * unless it is best effort (holdsRetention: false).
 */
export class EventConsumer {
	cursor: number;
	readonly db: DB;
	readonly name: string;
	/** Retention waits for this consumer. False for best-effort readers such as the diagnostic log. */
	readonly holdsRetention: boolean;
	private readonly handle: (events: EventRow[]) => void;
	constructor(db: DB, name: string, handle: (events: EventRow[]) => void, o: { from?: "head" | number; holdsRetention?: boolean } = {}) {
		this.db = db;
		this.name = name;
		this.handle = handle;
		this.holdsRetention = o.holdsRetention ?? true;
		this.cursor = (o.from ?? "head") === "head" ? headSeq(db) : (o.from as number);
		consumers.add(this);
	}

	/** Hand the next batch to the handler, then advance. Returns how many events were handled. */
	poll(limit = 500): number {
		const batch = scanEvents(this.db, { after_seq: this.cursor, limit });
		if (!batch.length) return 0;
		this.handle(batch);
		this.cursor = batch[batch.length - 1].seq;
		return batch.length;
	}

	close(): void {
		consumers.delete(this);
	}
}

const consumers = new Set<EventConsumer>();

// ------------------------------------------------------------------ retention
/**
 * Events are the audit trail and are kept, except high-volume kinds nothing reads back once they
 * are old: usage reports (spend is kept on allocations) and liveness flaps. Never past the slowest
 * consumer. Returns the number of events removed.
 */
export const EVENT_RETENTION_MS: Record<string, number> = {
	"usage.reported": 7 * 24 * 3600_000,
	"agent.lost": 30 * 24 * 3600_000,
	"agent.reconnected": 30 * 24 * 3600_000,
};
export function pruneEvents(db: DB, now = Date.now()): number {
	// Pre-v0.1.53 outbox rows (no longer written) pin their events; drop the published ones.
	run(db, "DELETE FROM outbox WHERE status = 'PUBLISHED' AND available_at < ?", new Date(now - 24 * 3600_000).toISOString());
	const floor = Math.min(...[...consumers].filter((c) => c.db === db && c.holdsRetention).map((c) => c.cursor), Number.MAX_SAFE_INTEGER);
	let removed = 0;
	for (const [type, keepMs] of Object.entries(EVENT_RETENTION_MS)) {
		removed += run(db, "DELETE FROM events WHERE type = ? AND created_at < ? AND seq <= ? AND id NOT IN (SELECT event_id FROM outbox)", type, new Date(now - keepMs).toISOString(), floor);
	}
	return removed;
}
