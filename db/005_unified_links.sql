-- One link model (docs/design/unified-team-links.md): an agent links under another agent,
-- in the same team or another one. reporting_edges becomes that table:
--   parent_run_id NULL      link inside the child's team (a manager edge, as before)
--   parent_run_id NOT NULL  link to an agent in another team (formerly team_reporting_links)
--   origin                  'spawned' (recruited by the parent) or 'joined' (an existing session attached)
--   terminatable            1 when dismissing the child may stop its team; 0 when it only severs the link
-- Values are validated by the controller; no column constraints, so the columns stay droppable.
ALTER TABLE reporting_edges ADD COLUMN parent_run_id TEXT;
ALTER TABLE reporting_edges ADD COLUMN origin TEXT NOT NULL DEFAULT 'spawned';
ALTER TABLE reporting_edges ADD COLUMN terminatable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reporting_edges ADD COLUMN close_reason TEXT;

-- Sessions that joined a team through POST /runs/:id/join are joins, not recruits.
UPDATE reporting_edges SET origin = 'joined', terminatable = 0
WHERE parent_run_id IS NULL AND child_id IN (SELECT agent_id FROM spawn_intents WHERE status = 'EXTERNAL');

-- Leader-to-leader reporting links become joined, non-terminatable links between the two roots.
INSERT INTO reporting_edges(id, run_id, parent_id, child_id, valid_from, valid_to, reason, parent_run_id, origin, terminatable, close_reason)
SELECT l.id, l.child_run_id, pr.root_agent_id, cr.root_agent_id, l.created_at, l.closed_at, 'reporting link', l.parent_run_id, 'joined', 0, l.close_reason
FROM team_reporting_links l JOIN runs cr ON cr.id = l.child_run_id JOIN runs pr ON pr.id = l.parent_run_id
ORDER BY l.rowid;

-- Coordination messages now reference the link rows in reporting_edges.
CREATE TABLE team_reporting_messages_v5 (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  link_id TEXT NOT NULL REFERENCES reporting_edges(id),
  withdrawn_at TEXT
);
INSERT INTO team_reporting_messages_v5(message_id, link_id, withdrawn_at) SELECT message_id, link_id, withdrawn_at FROM team_reporting_messages;
DROP TABLE team_reporting_messages;
ALTER TABLE team_reporting_messages_v5 RENAME TO team_reporting_messages;

DROP INDEX team_reporting_child;
DROP INDEX team_reporting_parent;
DROP TABLE team_reporting_links;
CREATE INDEX cross_team_links ON reporting_edges(parent_run_id) WHERE valid_to IS NULL AND parent_run_id IS NOT NULL;

-- Read-only compatibility for tools and queries written against the old table.
CREATE VIEW team_reporting_links AS
SELECT id, run_id AS child_run_id, parent_run_id, valid_from AS created_at, valid_to AS closed_at, close_reason
FROM reporting_edges WHERE parent_run_id IS NOT NULL;
