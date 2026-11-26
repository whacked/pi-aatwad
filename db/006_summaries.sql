-- Team summaries (written by a small model, opt-in per project) and per-project settings.
-- The outbox is gone: since v0.1.53 consumers follow the events table by sequence number.
DROP TABLE IF EXISTS outbox;

-- Settings that belong to a project (a directory), not to one team: e.g. which model summarizes.
-- settings_json: {"summarizer": {"state": "enabled", "model": "provider/id"} | {"state": "declined"}}
CREATE TABLE project_settings (
  project TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

-- One row per summarized window of a team's event log, (from_seq, to_seq]. window_text tells what
-- happened in that window; overview_text is the rolling picture of the whole team up to to_seq.
-- Derived data: never read back by the summarizer except the previous overview.
CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  window_text TEXT NOT NULL,
  overview_text TEXT NOT NULL,
  model TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX summaries_run ON summaries(run_id, to_seq);
