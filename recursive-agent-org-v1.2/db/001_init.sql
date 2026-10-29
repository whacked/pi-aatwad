PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL CHECK(status IN ('RUNNING','PAUSED','COMPLETED','FAILED','CANCELLED')), config_json TEXT NOT NULL);
CREATE TABLE agents (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, metadata_json TEXT NOT NULL DEFAULT '{}', UNIQUE(run_id,id));
CREATE TABLE reporting_edges (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), parent_id TEXT NOT NULL REFERENCES agents(id), child_id TEXT NOT NULL REFERENCES agents(id), valid_from TEXT NOT NULL, valid_to TEXT, CHECK(parent_id <> child_id));
CREATE UNIQUE INDEX one_active_parent ON reporting_edges(child_id) WHERE valid_to IS NULL;
CREATE INDEX active_reports ON reporting_edges(parent_id) WHERE valid_to IS NULL;
CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), parent_task_id TEXT REFERENCES tasks(id), owner_id TEXT REFERENCES agents(id), title TEXT NOT NULL, spec_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), harness TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, process_marker TEXT, context_ref TEXT, started_at TEXT, ended_at TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), sender_id TEXT NOT NULL REFERENCES agents(id), recipient_id TEXT NOT NULL REFERENCES agents(id), type TEXT NOT NULL, payload_json TEXT NOT NULL, correlation_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE deliveries (message_id TEXT NOT NULL REFERENCES messages(id), recipient_id TEXT NOT NULL REFERENCES agents(id), status TEXT NOT NULL CHECK(status IN ('PENDING','CLAIMED','ACKED')), lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(message_id,recipient_id));
CREATE TABLE proposals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), requester_id TEXT NOT NULL REFERENCES agents(id), reviewer_id TEXT REFERENCES agents(id), task_id TEXT REFERENCES tasks(id), revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, request_json TEXT NOT NULL, decided_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE proposal_decisions (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id), reviewer_id TEXT NOT NULL REFERENCES agents(id), decision TEXT NOT NULL, reason TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE allocations (agent_id TEXT PRIMARY KEY REFERENCES agents(id), limits_json TEXT NOT NULL, reserved_slots INTEGER NOT NULL DEFAULT 0 CHECK(reserved_slots >= 0), reserved_usd REAL NOT NULL DEFAULT 0 CHECK(reserved_usd >= 0), consumed_usd REAL NOT NULL DEFAULT 0 CHECK(consumed_usd >= 0));
CREATE TABLE reservations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), beneficiary_id TEXT NOT NULL REFERENCES agents(id), ancestor_id TEXT NOT NULL REFERENCES agents(id), slots INTEGER NOT NULL CHECK(slots >= 0), usd REAL NOT NULL CHECK(usd >= 0), state TEXT NOT NULL, proposal_id TEXT REFERENCES proposals(id));
CREATE TABLE spawn_intents (id TEXT PRIMARY KEY, proposal_id TEXT REFERENCES proposals(id), role_index INTEGER NOT NULL, ordinal INTEGER NOT NULL, agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id), status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(proposal_id,role_index,ordinal));
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs(id), actor_id TEXT, type TEXT NOT NULL, entity_id TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE outbox (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), topic TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE idempotency (actor_id TEXT NOT NULL, operation TEXT NOT NULL, idem_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, PRIMARY KEY(actor_id,operation,idem_key));
CREATE TABLE artifacts (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), agent_id TEXT REFERENCES agents(id), kind TEXT NOT NULL, uri TEXT NOT NULL, sha256 TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

-- Follow-up application logic REQUIRED:
-- Cross-run FK consistency, rooted tree/cycle checks, spend cap across ancestors,
-- no allocations to unapproved requests, and strict state transitions cannot be
-- enforced by this starter SQL alone. Implement in controller transactions/tests.
