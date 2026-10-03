// Meilenstein 3 - Sitzungen, Fortsetzungs-Snapshots, menschliches Eingreifen.
// Fortlaufende Migration nach dem bestehenden Schema (siehe 001_init.ts,
// 002_response_imports.ts) - der bestehende Migrationsstand wird nicht
// angefasst, nur ergaenzt.
//
// Reihenfolge: sessions -> continuation_snapshots -> session_chat_messages ->
// session_events -> intervention_alerts -> intervention_alert_revisions ->
// continuation_required_files. Nur sessions.based_on_snapshot_id verweist
// vorwaerts auf continuation_snapshots (legt SQLite erst bei tatsaechlicher
// Verwendung fest, nicht beim CREATE TABLE) - der dadurch entstehende Zyklus
// sessions <-> continuation_snapshots ist ueber ON DELETE SET NULL aufgeloest,
// damit eine Kaskaden-Loeschung nie an einer Fremdschluessel-Pruefung
// scheitert. Alle anderen Tabellen referenzieren nur bereits zuvor angelegte
// Tabellen.
export const MIGRATION_003_SESSIONS_CONTINUATIONS = {
  version: 3,
  name: 'sessions_continuations',
  sql: `
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('CHATGPT','CLAUDE')),
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','PAUSED','LIMIT_REACHED','RESPONSE_INCOMPLETE','WAITING_ON_HUMAN','COMPLETED','ABANDONED')),
  current_task TEXT NOT NULL DEFAULT '',
  master_context_version_id INTEGER REFERENCES project_context_versions(id),
  -- Kein successor_session_id (waere eine redundante, nicht vollstaendig
  -- erzwingbare Gegenseitigkeit) - der Nachfolger wird per
  -- SELECT ... WHERE predecessor_session_id = ? abgeleitet. UNIQUE erlaubt
  -- hoechstens einen direkten Nachfolger je Sitzung. "< id" macht einen
  -- Zyklus strukturell unmoeglich, da ein Vorgaenger immer eine bereits
  -- existierende, frueher angelegte Zeile sein muss.
  predecessor_session_id INTEGER UNIQUE REFERENCES sessions(id)
    CHECK (predecessor_session_id IS NULL OR predecessor_session_id < id),
  based_on_snapshot_id INTEGER REFERENCES continuation_snapshots(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_status ON sessions(status);

-- Hoechstens eine ACTIVE-Sitzung je Projekt und Provider - eine CHATGPT- und
-- eine CLAUDE-Sitzung duerfen gleichzeitig ACTIVE sein.
CREATE UNIQUE INDEX idx_sessions_one_active_per_provider
  ON sessions(project_id, provider) WHERE status = 'ACTIVE';

CREATE TABLE continuation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  -- Denormalisiert (identisch zu sessions.provider), damit der Snapshot fuer
  -- sich genommen selbsterklaerend bleibt.
  provider TEXT NOT NULL CHECK (provider IN ('CHATGPT','CLAUDE')),
  master_context_version_id INTEGER REFERENCES project_context_versions(id),
  current_task TEXT NOT NULL DEFAULT '',
  confirmed_done_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(confirmed_done_json)),
  confirmed_open_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(confirmed_open_json)),
  blockers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blockers_json)),
  last_complete_section TEXT NOT NULL DEFAULT '',
  missing_sections_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(missing_sections_json)),
  next_exact_step TEXT NOT NULL DEFAULT '',
  additional_human_action TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (reason_code IN ('LIMIT_REACHED','CHAT_FULL','RESPONSE_TRUNCATED','MANUAL_PAUSE','OTHER')),
  confirmation_state TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (confirmation_state IN ('DRAFT','CONFIRMED')),
  -- Verweist von einem CONFIRMED-Snapshot auf den Entwurf, aus dem er
  -- hervorging (analog response_imports.base/result_context_version_id).
  -- "< id" schliesst Selbstverweise und Zyklen strukturell aus.
  derived_from_snapshot_id INTEGER REFERENCES continuation_snapshots(id)
    CHECK (derived_from_snapshot_id IS NULL OR derived_from_snapshot_id < id),
  created_by TEXT NOT NULL CHECK (created_by IN ('LEON','CHATGPT','CLAUDE','SYSTEM')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Vollstaendig unveraenderlich (append-only, wie project_context_versions) -
  -- "Bestaetigen" eines Entwurfs legt eine neue Zeile an, statt diese zu aendern.
  UNIQUE (session_id, version_number)
);

CREATE INDEX idx_snapshots_session ON continuation_snapshots(session_id);
CREATE INDEX idx_snapshots_project ON continuation_snapshots(project_id);
CREATE INDEX idx_snapshots_confirmation_state ON continuation_snapshots(confirmation_state);

-- Additive Zuordnung bestehender chat_messages zu Sitzungen. chat_message_id
-- als Primaerschluessel erzwingt zugleich, dass eine Nachricht hoechstens
-- einer Sitzung zugeordnet sein kann.
CREATE TABLE session_chat_messages (
  chat_message_id INTEGER PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (session_id, sequence_number)
);

CREATE INDEX idx_session_chat_messages_session ON session_chat_messages(session_id);

-- Append-only. Bewahrt eine als unvollstaendig erkannte Original-Antwort
-- dauerhaft, unabhaengig vom Apply-only-Lebenszyklus von response_imports,
-- ohne dabei Master-Context oder Projektmetadaten zu veraendern.
-- raw_response ist reine lokale Historie (analog response_imports.raw_response)
-- und fliesst nie automatisch in einen generierten Prompt ein.
CREATE TABLE session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('RESPONSE_INCOMPLETE','LIMIT_REACHED','CHAT_FULL','MANUAL_PAUSE','SESSION_RESUMED')),
  raw_response TEXT,
  chat_message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
  response_import_id INTEGER REFERENCES response_imports(id) ON DELETE SET NULL,
  continuation_snapshot_id INTEGER REFERENCES continuation_snapshots(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL CHECK (created_by IN ('LEON','CHATGPT','CLAUDE','SYSTEM'))
);

CREATE INDEX idx_session_events_session ON session_events(session_id);
CREATE INDEX idx_session_events_type ON session_events(event_type);

CREATE TABLE intervention_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN (
    'USAGE_LIMIT_REACHED','CHAT_FULL','RESPONSE_TRUNCATED','FILE_UPLOAD_REQUIRED',
    'LOCAL_VERIFICATION_REQUIRED','PATCH_APPLY_REQUIRED','SCREENSHOT_REQUIRED',
    'DECISION_REQUIRED','APPROVAL_REQUIRED','PROVIDER_QUESTION','UNEXPECTED_ERROR'
  )),
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','BLOCKING')),
  -- Vom ausloesenden Workflow gesetzter, stabiler Schluessel, um mehrere
  -- gleichzeitige Ursachen desselben Typs zu unterscheiden (z. B. zwei
  -- verschiedene FILE_UPLOAD_REQUIRED-Warnungen fuer zwei verschiedene Dateien).
  dedupe_key TEXT NOT NULL DEFAULT '',
  -- SHA-256 (kleingeschrieben) ueber {projectId, sessionId, type, dedupeKey} -
  -- bewusst nicht ueber reason/required_action/priority, damit inhaltliche
  -- Aenderungen weiterhin dieselbe Warnung aktualisieren statt eine neue anzulegen.
  dedupe_fingerprint TEXT NOT NULL
    CHECK (length(dedupe_fingerprint) = 64 AND dedupe_fingerprint NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL DEFAULT '',
  required_action TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  responsible_person TEXT NOT NULL DEFAULT 'LEON',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SNOOZED','RESOLVED','DISMISSED')),
  content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version >= 1),
  popup_acknowledged_version INTEGER
    CHECK (
      popup_acknowledged_version IS NULL
      OR (popup_acknowledged_version >= 1 AND popup_acknowledged_version <= content_version)
    ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  -- Immer im selben strftime(...)-Format wie alle anderen Zeitstempel -
  -- Faelligkeitspruefungen muessen julianday(snooze_until) <= julianday('now')
  -- verwenden, nie einen lexikografischen Vergleich mit datetime('now')
  -- (unterschiedliches Textformat, String-Vergleich waere falsch).
  snooze_until TEXT,
  -- Nur beim tatsaechlichen Anwenden des Metadatenvorschlags gesetzt
  -- (interventionService.applyMetadataSuggestion), nie bei Erstellung der
  -- Warnung - das Projekt kann sich bis dahin veraendert haben.
  metadata_suggestion_applied_at TEXT,
  captured_previous_status TEXT
    CHECK (captured_previous_status IS NULL OR captured_previous_status IN
      ('PLANNING','ACTIVE','WAITING_ON_HUMAN','TESTING','PAUSED','COMPLETED','ERROR')),
  captured_previous_next_actor TEXT
    CHECK (captured_previous_next_actor IS NULL OR captured_previous_next_actor IN
      ('LEON','CHATGPT','CLAUDE','NONE')),
  metadata_restored_at TEXT
);

CREATE INDEX idx_intervention_project ON intervention_alerts(project_id);
CREATE INDEX idx_intervention_status ON intervention_alerts(status);
CREATE INDEX idx_intervention_priority ON intervention_alerts(priority);

-- Dedupliziert ueber OPEN und SNOOZED (nicht nur OPEN) - eine SNOOZED-Warnung
-- darf nicht durch eine neue identische OPEN-Warnung dupliziert werden.
-- RESOLVED/DISMISSED sind ausgenommen - ein nach Abschluss erneut
-- auftretendes Problem legt eine neue Zeile mit frischer Historie an.
CREATE UNIQUE INDEX idx_intervention_dedupe_active
  ON intervention_alerts(dedupe_fingerprint) WHERE status IN ('OPEN','SNOOZED');

-- Append-only. Vollstaendige Inhaltshistorie je Warnung - die aktuelle Zeile
-- in intervention_alerts bleibt der schnelle "aktueller Zustand"-Zugriff,
-- diese Tabelle bewahrt jede fruehere Fassung unveraendert.
CREATE TABLE intervention_alert_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intervention_id INTEGER NOT NULL REFERENCES intervention_alerts(id) ON DELETE CASCADE,
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  priority TEXT NOT NULL CHECK (priority IN ('LOW','NORMAL','HIGH','BLOCKING')),
  reason TEXT NOT NULL DEFAULT '',
  required_action TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL CHECK (created_by IN ('LEON','CHATGPT','CLAUDE','SYSTEM')),
  UNIQUE (intervention_id, content_version)
);

CREATE INDEX idx_intervention_revisions_intervention ON intervention_alert_revisions(intervention_id);

-- Von Snapshots und Interventions-Warnungen gemeinsam genutzt, genau ein
-- Besitzer pro Zeile. Intervention-gebundene Zeilen haengen an der REVISION
-- (nicht direkt an der Warnung) - jede neue Inhaltsrevision erhaelt dadurch
-- ihre eigene, vollstaendige Dateiliste; alte Revisionen und ihre Dateien
-- bleiben unveraendert erhalten. Snapshot-gebundene Zeilen sind ebenso
-- unveraenderlich (der Snapshot selbst ist unveraenderlich).
CREATE TABLE continuation_required_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER REFERENCES continuation_snapshots(id) ON DELETE CASCADE,
  intervention_revision_id INTEGER REFERENCES intervention_alert_revisions(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  expected_filename TEXT NOT NULL DEFAULT '',
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  purpose TEXT NOT NULL DEFAULT '',
  is_required INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0,1)),
  reupload_required INTEGER NOT NULL DEFAULT 0 CHECK (reupload_required IN (0,1)),
  is_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (is_sensitive IN (0,1)),
  -- Rein informativ - wird nie vom Main-Prozess gelesen/geoeffnet, nie Teil
  -- eines generierten Prompts, unabhaengig von is_sensitive.
  local_path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (snapshot_id IS NOT NULL AND intervention_revision_id IS NULL)
    OR (snapshot_id IS NULL AND intervention_revision_id IS NOT NULL)
  )
);

CREATE INDEX idx_required_files_snapshot ON continuation_required_files(snapshot_id);
CREATE INDEX idx_required_files_intervention_revision ON continuation_required_files(intervention_revision_id);
`
}
