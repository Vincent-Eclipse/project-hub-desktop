// Meilenstein 4.3 - Work Request + Automation-UX-Grundlage (Workflow-Daten +
// UX-Grundlage, KEINE KI-Ausfuehrung). Fortlaufende Migration nach dem
// bestehenden Schema (siehe 001-005) - der bestehende Migrationsstand wird
// nicht angefasst, nur ergaenzt.
//
// work_requests <-> work_request_decisions ist eine einfache 1:n-Beziehung
// (wie chat_messages <-> project_context_versions). work_request_tasks
// verknuepft einen Work Request mit bestehenden tasks-Zeilen (Meilenstein
// 4.2) - task_id ist hier bewusst der PRIMARY KEY (nicht Teil eines
// zusammengesetzten Schluessels), analog session_chat_messages.chat_message_id
// in 003_sessions_continuations.ts: das erzwingt strukturell, dass eine
// Aufgabe zu hoechstens einem Work Request gehoeren kann, ohne eine
// zusaetzliche Anwendungspruefung fuer den Grundfall zu benoetigen (die
// Service-Ebene prueft trotzdem explizit vor, um einen sprechenden Fehler
// statt einer rohen Constraint-Verletzung zu liefern).
export const MIGRATION_006_WORK_REQUESTS = {
  version: 6,
  name: 'work_requests',
  sql: `
CREATE TABLE work_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  intent_markdown TEXT NOT NULL,
  plan_markdown TEXT,
  status TEXT NOT NULL DEFAULT 'IDEA' CHECK (status IN (
    'IDEA','PLANNING','NEEDS_DECISION','READY','EXECUTING','REVIEWING',
    'CHANGES_REQUIRED','READY_FOR_APPROVAL','DONE','BLOCKED','PAUSED','CANCELLED'
  )),
  created_by TEXT NOT NULL CHECK (created_by IN ('LEON','CHATGPT','CLAUDE','SYSTEM')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_work_requests_project ON work_requests(project_id);
CREATE INDEX idx_work_requests_status ON work_requests(status);

-- Optionen/Empfehlung sind reine Planungs-Metadaten; options_json speichert
-- eine Liste stabiler {key,label,descriptionMarkdown?}-Objekte (siehe
-- workRequestService.ts) - niemals Array-Positionen als Identitaet.
CREATE TABLE work_request_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_request_id INTEGER NOT NULL REFERENCES work_requests(id) ON DELETE CASCADE,
  question_markdown TEXT NOT NULL,
  options_json TEXT NOT NULL CHECK (json_valid(options_json)),
  recommended_option_key TEXT,
  recommendation_markdown TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','CANCELLED')),
  resolved_option_key TEXT,
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);

CREATE INDEX idx_work_request_decisions_request ON work_request_decisions(work_request_id);
CREATE INDEX idx_work_request_decisions_status ON work_request_decisions(status);

-- task_id als PRIMARY KEY erzwingt: eine Aufgabe gehoert zu hoechstens einem
-- Work Request (siehe Kommentar oben). UNIQUE(work_request_id, position)
-- haelt die Anzeige-Reihenfolge je Work Request eindeutig und deterministisch.
CREATE TABLE work_request_tasks (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  work_request_id INTEGER NOT NULL REFERENCES work_requests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  UNIQUE (work_request_id, position)
);

CREATE INDEX idx_work_request_tasks_request ON work_request_tasks(work_request_id);
`
}
