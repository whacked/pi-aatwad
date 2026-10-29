// SQLite access: open + migrate, transaction helper, tiny query helpers, event/outbox emission.
import { DatabaseSync } from "node:sqlite";
import type { StatementSync, SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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
export function newId(prefix: string): string {
	return `${prefix}-${randomBytes(8).toString("hex")}`;
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
