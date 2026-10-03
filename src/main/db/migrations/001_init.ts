export const MIGRATION_001_INIT = {
  version: 1,
  name: 'init',
  sql: `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  project_type TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  folder_path TEXT,
  folder_comparison_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'PLANNING'
    CHECK (status IN ('PLANNING','ACTIVE','WAITING_ON_HUMAN','TESTING','PAUSED','COMPLETED','ERROR')),
  next_actor TEXT NOT NULL DEFAULT 'LEON'
    CHECK (next_actor IN ('LEON','CHATGPT','CLAUDE','NONE')),
  current_step TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  -- Verweist auf project_context_versions.id, obwohl diese Tabelle erst
  -- weiter unten im selben Skript angelegt wird. SQLite loest
  -- Fremdschluessel-Referenzen erst bei tatsaechlicher Verwendung auf, nicht
  -- beim CREATE TABLE selbst - eine "vorwaertsgerichtete" Referenz auf eine
  -- zu diesem Zeitpunkt noch nicht existierende Tabelle ist daher zulaessig
  -- und wird korrekt durchgesetzt, sobald beide Tabellen existieren (per
  -- PRAGMA foreign_key_check verifiziert). Die FK garantiert nur, dass die
  -- referenzierte Version-ID ueberhaupt existiert - die zusaetzliche Pruefung,
  -- dass sie auch zu DIESEM Projekt gehoert, bleibt Aufgabe von
  -- contextService.getCurrentContextVersion (siehe ContextIntegrityError).
  current_context_version_id INTEGER REFERENCES project_context_versions(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- SQLite behandelt jeden NULL-Wert in einer UNIQUE-Spalte als eigenstaendig
-- (nicht gleich zu anderen NULLs). Dadurch bleiben beliebig viele Projekte
-- OHNE Ordner erlaubt, waehrend zwei Projekte mit demselben
-- folder_comparison_key hart abgelehnt werden.

CREATE TABLE project_context_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  content_markdown TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('LEON','CHATGPT','CLAUDE','SYSTEM')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, version_number)
);

CREATE INDEX idx_context_versions_project ON project_context_versions(project_id);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('LEON','CHATGPT','CLAUDE','SYSTEM')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_chat_messages_project ON chat_messages(project_id);

CREATE TABLE project_role_template_overrides (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('CHATGPT','CLAUDE')),
  template TEXT NOT NULL,
  PRIMARY KEY (project_id, role)
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Schlankes Ereignisprotokoll. payload_json enthaelt bewusst nur IDs,
-- geaenderte Feldnamen und andere kleine Metadaten - NIE vollstaendige
-- Kontext-Inhalte oder Chat-Nachrichtentexte.
CREATE TABLE event_log_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_event_log_project ON event_log_entries(project_id);
CREATE INDEX idx_event_log_type ON event_log_entries(type);
`
}
