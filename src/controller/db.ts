// SQLite access: open + migrate, transaction helper, tiny query helpers, event/outbox emission.
import { DatabaseSync } from "node:sqlite";
import type { StatementSync, SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { projectAgentId, readableId } from "../shared/readable-id.ts";
import { fail } from "./errors.ts";

export type DB = DatabaseSync;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

const stmtCache = new WeakMap<DB, Map<string, StatementSync>>();

function stmt(db: DB, sql: string): StatementSync {
	let m = stmtCache.get(db);
	if (!m) stmtCache.set(db, (m = new Map()));
	let s = m.get(sql);
	if (!s) m.set(sql, (s = db.prepare(sql)));
	return s;
}

function norm(params: unknown[]): SQLInputValue[] {
	return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : (p as SQLInputValue)));
}

export function get(db: DB, sql: string, ...params: unknown[]): Row | undefined {
	return stmt(db, sql).get(...norm(params)) as Row | undefined;
}
export function all(db: DB, sql: string, ...params: unknown[]): Row[] {
	return stmt(db, sql).all(...norm(params)) as Row[];
}
export function run(db: DB, sql: string, ...params: unknown[]): number {
	return Number(stmt(db, sql).run(...norm(params)).changes);
}

export function nowIso(): string {
	return new Date().toISOString();
}
export function isoPlus(ms: number, from = Date.now()): string {
	return new Date(from + ms).toISOString();
}
/** `agent`: `<keyword>-<4 words>-<stamp>`; `run`: `run-<abbr>-<4 words>`; anything else: `<prefix>-<16 hex>`. */
export function newId(prefix: string, cwd = process.cwd(), stamp?: string): string {
	if (prefix === "agent") return projectAgentId(cwd, stamp);
	return prefix === "run" ? readableId(prefix, cwd) : `${prefix}-${randomBytes(8).toString("hex")}`;
}

export const FRESH_ID_ATTEMPTS = 16;

/**
 * A readable ID not yet used in `table`. Readable IDs carry fewer random bits than hex ones (agents of one team
 * share every non-random part), so check before inserting and draw again instead of failing on the primary key.
 * Callers run inside the request transaction (single writer), so the check cannot race another insert.
 */
export function freshId(db: DB, table: "runs" | "agents", make: () => string, attempts = FRESH_ID_ATTEMPTS): string {
	for (let i = 0; i < attempts; i++) {
		const id = make();
		if (!get(db, `SELECT 1 AS taken FROM ${table} WHERE id = ?`, id)) return id;
	}
	fail("CONFLICT", `could not draw an unused ${table === "runs" ? "run" : "agent"} ID in ${attempts} attempts`);
}

/** BEGIN IMMEDIATE transaction. Nested calls join the outer transaction. */
export function tx<T>(db: DB, fn: () => T): T {
	if (db.isTransaction) return fn();
	db.exec("BEGIN IMMEDIATE");
	try {
		const r = fn();
		db.exec("COMMIT");
		return r;
	} catch (e) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* already rolled back */
		}
		throw e;
	}
}

export function openDb(path: string, migrationsDir: string): DB {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
	migrate(db, migrationsDir);
	return db;
}

/** Applies db/NNN_*.sql in order, each once, recorded in schema_migrations. Caller holds the controller lock. */
export function migrate(db: DB, dir: string): number {
	db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
	const files = readdirSync(dir)
		.filter((f) => /^\d{3}_.*\.sql$/.test(f))
		.sort();
	for (const f of files) {
		const version = Number.parseInt(f.slice(0, 3), 10);
		if (get(db, "SELECT 1 FROM schema_migrations WHERE version = ?", version)) continue;
		// PRAGMAs (journal_mode etc.) cannot run inside a transaction; they are set at open.
		const sql = readFileSync(join(dir, f), "utf8")
			.split("\n")
			.filter((l) => !/^\s*PRAGMA\b/i.test(l))
			.join("\n");
		tx(db, () => {
			db.exec(sql);
			run(db, "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)", version, f, nowIso());
		});
	}
	return Number(get(db, "SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations")!.v);
}

export interface EventInput {
	run_id: string;
	actor_id: string | null;
	type: string;
	entity_id?: string | null;
	payload?: unknown;
}

/** Appends an audit event plus its outbox row. Must be called inside the mutation's transaction. */
export function emit(db: DB, e: EventInput): string {
	const id = newId("evt");
	const payload = JSON.stringify(e.payload ?? {});
	const ts = nowIso();
	run(db, "INSERT INTO events(id, run_id, actor_id, type, entity_id, payload_json, created_at) VALUES (?,?,?,?,?,?,?)", id, e.run_id, e.actor_id, e.type, e.entity_id ?? null, payload, ts);
	run(db, "INSERT INTO outbox(id, event_id, topic, payload_json, status, available_at) VALUES (?,?,?,?, 'PENDING', ?)", newId("obx"), id, e.type, payload, ts);
	return id;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
	if (s == null) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}

/**
 * Event retention. Events are the audit trail and are kept, except high-volume kinds nothing reads
 * back once they are old: usage reports (spend is kept on allocations) and liveness flaps.
 * Published outbox rows older than a day are removed first; they grew with every event.
 * Returns the number of events removed.
 */
export const EVENT_RETENTION_MS: Record<string, number> = {
	"usage.reported": 7 * 24 * 3600_000,
	"agent.lost": 30 * 24 * 3600_000,
	"agent.reconnected": 30 * 24 * 3600_000,
};
export function pruneEvents(db: DB, now = Date.now()): number {
	// Published outbox rows have done their job (the reconciler acted on them); pending ones pin their event.
	run(db, "DELETE FROM outbox WHERE status = 'PUBLISHED' AND available_at < ?", new Date(now - 24 * 3600_000).toISOString());
	let removed = 0;
	for (const [type, keepMs] of Object.entries(EVENT_RETENTION_MS)) {
		removed += run(db, "DELETE FROM events WHERE type = ? AND created_at < ? AND id NOT IN (SELECT event_id FROM outbox)", type, new Date(now - keepMs).toISOString());
	}
	return removed;
}
