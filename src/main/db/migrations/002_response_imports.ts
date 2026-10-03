// Meilenstein 2 - Strukturierter Antwort-Import. Fortlaufende Migration
// nach dem bestehenden Schema (siehe 001_init.ts) - der bestehende
// Migrationsstand wird nicht angefasst, nur ergaenzt.
export const MIGRATION_002_RESPONSE_IMPORTS = {
  version: 2,
  name: 'response_imports',
  sql: `
-- Eine Zeile wird AUSSCHLIESSLICH bei einer tatsaechlich bestaetigten
-- Uebernahme angelegt (siehe responseImportService.applyResponseImport) -
-- es gibt bewusst keine Preview- oder Entwurfszeilen. parsed_result_json
-- und selected_actions_json werden von der Anwendungsschicht immer per
-- JSON.stringify() erzeugt; die CHECK-Constraints mit json_valid()
-- verhindern zusaetzlich auf Datenbankebene, dass dort jemals ungueltiges
-- JSON landen kann.
CREATE TABLE response_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('CHATGPT','CLAUDE')),
  raw_response TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  parsed_result_json TEXT NOT NULL CHECK (json_valid(parsed_result_json)),
  selected_actions_json TEXT NOT NULL CHECK (json_valid(selected_actions_json)),
  base_context_version_id INTEGER REFERENCES project_context_versions(id),
  result_context_version_id INTEGER REFERENCES project_context_versions(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_response_imports_project ON response_imports(project_id);
CREATE INDEX idx_response_imports_created_at ON response_imports(created_at);
`
}
