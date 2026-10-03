export const MIGRATION_004_PROJECT_RULES = {
  version: 4,
  name: 'project_rules',
  sql: `
CREATE TABLE project_rule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  content_markdown TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('LEON','CHATGPT','CLAUDE','SYSTEM')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, version_number)
);

CREATE TRIGGER project_rule_versions_no_update
BEFORE UPDATE ON project_rule_versions
BEGIN
  SELECT RAISE(ABORT, 'Project Rules versions are immutable');
END;

-- Preserve history while the project exists; allow the project FK cascade.
CREATE TRIGGER project_rule_versions_no_delete
BEFORE DELETE ON project_rule_versions
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
  SELECT RAISE(ABORT, 'Project Rules versions are append-only');
END;
`
}
