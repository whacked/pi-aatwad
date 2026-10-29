-- 003: controller runtime metadata (auth, enrollment, generations, versioned edges, delivery markers).
-- Apply after 002. Only hashes of bearer/enrollment secrets are stored.

-- Agents: current execution binding (identity stays stable; these are mutable projections).
ALTER TABLE agents ADD COLUMN current_session_id TEXT;
ALTER TABLE agents ADD COLUMN provider TEXT;
ALTER TABLE agents ADD COLUMN model TEXT;
ALTER TABLE agents ADD COLUMN model_id TEXT;
ALTER TABLE agents ADD COLUMN cwd TEXT;
ALTER TABLE agents ADD COLUMN pi_session_path TEXT;
ALTER TABLE agents ADD COLUMN restart_attempts INTEGER NOT NULL DEFAULT 0;

-- Sessions: generation-scoped attempts with recorded OS identity.
ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN pid INTEGER;
ALTER TABLE sessions ADD COLUMN spawn_intent_id TEXT;
ALTER TABLE sessions ADD COLUMN enrolled_at TEXT;
ALTER TABLE sessions ADD COLUMN reported_pid INTEGER;

-- Spawn intents: launch attempt bookkeeping.
ALTER TABLE spawn_intents ADD COLUMN session_id TEXT;
ALTER TABLE spawn_intents ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spawn_intents ADD COLUMN last_error TEXT;
ALTER TABLE spawn_intents ADD COLUMN updated_at TEXT;
ALTER TABLE spawn_intents ADD COLUMN spec_json TEXT NOT NULL DEFAULT '{}';

-- Reporting edges: topology versions for get_ancestry/get_subtree(at_version).
ALTER TABLE reporting_edges ADD COLUMN from_version INTEGER;
ALTER TABLE reporting_edges ADD COLUMN to_version INTEGER;
ALTER TABLE reporting_edges ADD COLUMN reason TEXT;

ALTER TABLE messages ADD COLUMN causation_id TEXT;
ALTER TABLE messages ADD COLUMN deadline TEXT;
ALTER TABLE deliveries ADD COLUMN claimed_at TEXT;
ALTER TABLE deliveries ADD COLUMN acked_at TEXT;

ALTER TABLE proposals ADD COLUMN original_reviewer_id TEXT;
ALTER TABLE proposals ADD COLUMN updated_at TEXT;

ALTER TABLE tasks ADD COLUMN assigned_by TEXT;
ALTER TABLE tasks ADD COLUMN result_json TEXT;

ALTER TABLE reservations ADD COLUMN created_at TEXT;
ALTER TABLE reservations ADD COLUMN released_at TEXT;

ALTER TABLE idempotency ADD COLUMN status_code INTEGER NOT NULL DEFAULT 200;
ALTER TABLE idempotency ADD COLUMN created_at TEXT;
-- When the stored response carried a bearer token, it is redacted and a fresh token for this session is minted on replay.
ALTER TABLE idempotency ADD COLUMN reissue_session_id TEXT;

-- Immutable proposal revision history (AMEND never mutates history).
CREATE TABLE IF NOT EXISTS proposal_revisions (
  proposal_id TEXT NOT NULL REFERENCES proposals(id), revision INTEGER NOT NULL,
  request_json TEXT NOT NULL, author_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, revision)
);

-- Agent session bearer tokens (sha256 of secret).
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL REFERENCES agents(id), session_id TEXT NOT NULL REFERENCES sessions(id),
  generation INTEGER NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS auth_tokens_agent ON auth_tokens(agent_id) WHERE revoked_at IS NULL;

-- One-time enrollment credentials (sha256 of secret), bound to intent + session attempt.
CREATE TABLE IF NOT EXISTS enrollment_credentials (
  token_hash TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL REFERENCES agents(id), spawn_intent_id TEXT NOT NULL REFERENCES spawn_intents(id),
  session_id TEXT NOT NULL REFERENCES sessions(id), enroll_file TEXT,
  expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deliveries_inbox ON deliveries(recipient_id, status);
CREATE INDEX IF NOT EXISTS reservations_ancestor ON reservations(ancestor_id) WHERE state = 'ACTIVE';
CREATE INDEX IF NOT EXISTS reservations_beneficiary ON reservations(beneficiary_id) WHERE state = 'ACTIVE';
CREATE INDEX IF NOT EXISTS spawn_intents_status ON spawn_intents(status);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS proposals_reviewer ON proposals(reviewer_id, status);
