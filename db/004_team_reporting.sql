-- Cross-team coordination is independent of reporting_edges and budget authority.
CREATE TABLE team_reporting_settings (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  wake_on_message INTEGER NOT NULL DEFAULT 0 CHECK(wake_on_message IN (0,1))
);
CREATE TABLE team_reporting_links (
  id TEXT PRIMARY KEY,
  child_run_id TEXT NOT NULL REFERENCES runs(id),
  parent_run_id TEXT NOT NULL REFERENCES runs(id),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  CHECK(child_run_id <> parent_run_id)
);
CREATE UNIQUE INDEX team_reporting_child ON team_reporting_links(child_run_id) WHERE closed_at IS NULL;
CREATE INDEX team_reporting_parent ON team_reporting_links(parent_run_id) WHERE closed_at IS NULL;
CREATE TABLE team_reporting_messages (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  link_id TEXT NOT NULL REFERENCES team_reporting_links(id),
  withdrawn_at TEXT
);
