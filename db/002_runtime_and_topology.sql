-- Apply after 001_init.sql; SQLite >= 3.35. Migration introduces explicit runtime and topology metadata.
ALTER TABLE runs ADD COLUMN topology_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN root_agent_id TEXT REFERENCES agents(id);
ALTER TABLE agents ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'RUNNING' CHECK(desired_state IN ('RUNNING','PAUSED','RETIRED'));
ALTER TABLE agents ADD COLUMN observed_state TEXT NOT NULL DEFAULT 'STOPPED' CHECK(observed_state IN ('STARTING','LIVE','LOST','STOPPED','FAILED'));
ALTER TABLE agents ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE agents ADD COLUMN lease_until TEXT;
ALTER TABLE agents ADD COLUMN reconciliation_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN pi_session_path TEXT;
ALTER TABLE sessions ADD COLUMN pi_session_id TEXT;
ALTER TABLE sessions ADD COLUMN process_started_at TEXT;
ALTER TABLE sessions ADD COLUMN process_boot_id TEXT;
ALTER TABLE sessions ADD COLUMN launch_token TEXT;
ALTER TABLE sessions ADD COLUMN controller_epoch INTEGER;
CREATE TABLE IF NOT EXISTS controller_lease (
  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'local'),
  controller_id TEXT NOT NULL, fencing_epoch INTEGER NOT NULL,
  lease_until TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS session_checkpoints (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  pi_branch_leaf_id TEXT, last_entry_id TEXT, checkpoint_uri TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS topology_operations (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  subject_agent_id TEXT NOT NULL REFERENCES agents(id),
  from_parent_id TEXT REFERENCES agents(id), to_parent_id TEXT REFERENCES agents(id),
  expected_version INTEGER NOT NULL, committed_version INTEGER,
  work_policy TEXT NOT NULL, status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS session_agent_history ON sessions(agent_id, started_at);
CREATE INDEX IF NOT EXISTS agent_recovery_scan ON agents(desired_state, observed_state, lease_until);
-- Run all topology operations in BEGIN IMMEDIATE, check run/root identity,
-- cycle-freedom and subtree allocations in controller code, then increment
-- topology_version and emit event/outbox atomically. Migration alone cannot enforce a tree.
