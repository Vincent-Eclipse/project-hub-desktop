// Meilenstein 4.2 - Aufgaben-Grundlage (Storage + Verwaltung, KEINE Ausfuehrung).
// Fortlaufende Migration nach dem bestehenden Schema (siehe 001-004) - der
// bestehende Migrationsstand wird nicht angefasst, nur ergaenzt.
//
// task_dependencies bildet eine Viele-zu-Viele-Beziehung zwischen Aufgaben
// desselben Projekts ab. Anders als bei den einfachen Vorgaenger-Ketten in
// 003_sessions_continuations.ts (dort reicht "< id" fuer Zyklenfreiheit) kann
// ein beliebiger Abhaengigkeitsgraph nicht durch eine simple CHECK-Klausel
// zyklenfrei gehalten werden. Selbstverweise werden daher direkt hier per
// CHECK verhindert; Fremdprojekt-Referenzen und echte Zyklen werden bewusst
// in taskService.ts (Anwendungsebene) geprueft, nicht ueber SQL-Trigger mit
// rekursiven CTEs - das bleibt auditierbar und konsistent mit dem Rest des
// Schemas, das komplexe fachliche Regeln in Services statt in der DB haelt.
export const MIGRATION_005_TASKS = {
  version: 5,
  name: 'tasks',
  sql: `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  goal_markdown TEXT NOT NULL DEFAULT '',
  description_markdown TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'BACKLOG'
    CHECK (status IN ('BACKLOG','PLANNED','READY','RUNNING','NEEDS_REVIEW','CHANGES_REQUESTED','BLOCKED','DONE')),
  acceptance_criteria_markdown TEXT NOT NULL DEFAULT '',
  verification_requirements_markdown TEXT NOT NULL DEFAULT '',
  -- Rein projektrelative logische Pfadangaben (siehe taskRelevantFiles.ts) -
  -- werden vom Main-Prozess nie gegen das echte Dateisystem aufgeloest,
  -- gelesen, geschrieben oder ausgefuehrt. Reine Planungs-Metadaten.
  relevant_files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(relevant_files_json)),
  blocked_reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL CHECK (created_by IN ('LEON','CHATGPT','CLAUDE','SYSTEM')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status ON tasks(status);

-- Reine Planungs-Metadaten (siehe taskService.ts) - beeinflussen NIE
-- automatisch den Status einer Aufgabe und implementieren keine
-- Ausfuehrungs-Gates.
CREATE TABLE task_dependencies (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id != depends_on_task_id)
);

CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
`
}
