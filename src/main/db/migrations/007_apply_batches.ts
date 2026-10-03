// Meilenstein 4.8B.2B - Durable Journal + State Machine (Admission Only).
// Legt apply_batches / apply_batch_entries an - den durablen Recovery-/
// Audit-Journal fuer bereits (frisch) autorisierte Apply-Vorgaenge. Diese
// Migration fuegt AUSSCHLIESSLICH Schema hinzu (siehe 004/006) - keine
// Mutation von Bestandsdaten.
//
// KRITISCH (siehe applyAuthorityService.ts, codeChangeReviewTypes.ts):
// KEINE Zeile in diesen beiden Tabellen ist jemals Autorisierung fuer eine
// neue oder erneute Filesystem-Mutation. authorization_json ist
// AUSSCHLIESSLICH Audit-/Diagnose-Evidenz - operative Spalten sind
// gewoehnliche, unabhaengig geschriebene Werte (KEINE GENERATED-Spalten -
// kontrollierte Design-Entscheidung, siehe M4.8B2B-Implementation-Spec.md
// Abschnitt 3/5), niemals aus dem JSON abgeleitet.
//
// Der frozen state vocabulary (siehe @shared/applyBatchTypes.ts) wird hier
// EXAKT als CHECK-Constraint gespiegelt - keine Substitution, keine Zusatz-
// Werte.
//
// SQL-Grammatik-Hinweis: CREATE TABLE verlangt ALLE Spaltendefinitionen VOR
// jedem eigenstaendigen (nicht an eine einzelne Spalte gebundenen) Table-
// Level-CHECK - Spalten und Table-Level-Constraints koennen NICHT
// verschachtelt werden. An eine Spalte gebundene CHECKs (direkt nach dem
// Spaltentyp) sind ueberall zulaessig; mehrspaltige CHECKs stehen daher
// hier bewusst gesammelt am Ende jeder Tabelle, nach der letzten Spalte.
export const MIGRATION_007_APPLY_BATCHES = {
  version: 7,
  name: 'apply_batches',
  sql: `
CREATE TABLE apply_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  review_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  schema_version TEXT NOT NULL,

  -- Audit-/Diagnose-Snapshot only - never operational authority, never a
  -- source normalized columns are derived from (no GENERATED columns).
  authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),

  -- Root native identity, captured once per batch by the single Prepare()
  -- call (B.2C scope). NULL until the batch actually reaches PREPARED - see
  -- the corrected biconditional at the end of this table.
  root_native_file_id_128_hex TEXT
    CHECK (root_native_file_id_128_hex IS NULL OR
           (length(root_native_file_id_128_hex) = 32 AND root_native_file_id_128_hex NOT GLOB '*[^0-9a-f]*')),
  root_native_volume_serial TEXT
    CHECK (root_native_volume_serial IS NULL OR
           (length(root_native_volume_serial) BETWEEN 1 AND 20 AND root_native_volume_serial NOT GLOB '*[^0-9]*')),

  state TEXT NOT NULL DEFAULT 'ADMITTED' CHECK (state IN (
    'ADMITTED','PREPARED','APPLYING','SUCCEEDED','ROLLING_BACK','ROLLED_BACK',
    'RECOVERY_REQUIRED','RECOVERY_CONFLICT'
  )),

  -- Durable recovery-origin marker. NOT a ninth state - a strict subset of
  -- state's own domain, stored separately, set exactly once at the
  -- <state> -> RECOVERY_REQUIRED transition (B.2C scope), and NEVER cleared
  -- again, including once the batch reaches a terminal state.
  pre_recovery_state TEXT CHECK (pre_recovery_state IS NULL OR pre_recovery_state IN (
    'ADMITTED','PREPARED','APPLYING','ROLLING_BACK'
  )),

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,

  -- Forbidden before recovery has ever happened, and on every state that is
  -- itself part of the normal, still-in-flight (non-recovery) progression.
  CHECK (state IN ('RECOVERY_REQUIRED','RECOVERY_CONFLICT','SUCCEEDED','ROLLED_BACK') OR pre_recovery_state IS NULL),
  -- Mandatory for as long as the batch is actively parked in a recovery state.
  CHECK (state NOT IN ('RECOVERY_REQUIRED','RECOVERY_CONFLICT') OR pre_recovery_state IS NOT NULL),
  -- SUCCEEDED can never be reached from a batch that never ran prepareLease()
  -- at all - nothing could have completed. (Schema-level minimum only - B.2C's
  -- transition service must additionally enforce, procedurally, that ONLY a
  -- pre_recovery_state of 'APPLYING' - never 'PREPARED' or 'ROLLING_BACK'
  -- either - may resolve to SUCCEEDED; that finer rule is transition-history
  -- enforcement, out of a row-local CHECK's reach.)
  CHECK (NOT (state = 'SUCCEEDED' AND pre_recovery_state IS 'ADMITTED')),

  -- Pair-completeness: closes the partial-evidence hole in every otherwise
  -- permissive state (ADMITTED, RECOVERY_REQUIRED, RECOVERY_CONFLICT, ...) -
  -- either BOTH root-identity members are present, or NEITHER is. NULL-safe
  -- (IS NULL never propagates NULL, unlike a plain = comparison).
  CHECK ((root_native_file_id_128_hex IS NULL) = (root_native_volume_serial IS NULL)),

  -- Corrected root-evidence requirement, using NULL-safe IS/IS NOT (plain =
  -- would silently pass whenever pre_recovery_state IS NULL, which is exactly
  -- the case that matters most on the normal, non-crash path).
  CHECK (
    (root_native_file_id_128_hex IS NOT NULL AND root_native_volume_serial IS NOT NULL)
    =
    (
      state != 'ADMITTED'
      AND NOT (
        state IN ('RECOVERY_REQUIRED','RECOVERY_CONFLICT','ROLLED_BACK')
        AND pre_recovery_state IS 'ADMITTED'
      )
    )
  )
);

-- One-unresolved-batch-per-project: every non-terminal state. A partial
-- UNIQUE index (same technique as idx_sessions_one_active_per_provider in
-- migration 003) - a real DB-level constraint, not an app-level-only check.
CREATE UNIQUE INDEX idx_apply_batches_one_unresolved_per_project
  ON apply_batches(project_id)
  WHERE state IN ('ADMITTED','PREPARED','APPLYING','ROLLING_BACK','RECOVERY_REQUIRED','RECOVERY_CONFLICT');

CREATE INDEX idx_apply_batches_project ON apply_batches(project_id);
CREATE INDEX idx_apply_batches_state ON apply_batches(state);

CREATE TRIGGER apply_batches_no_update_terminal
BEFORE UPDATE ON apply_batches
WHEN OLD.state IN ('SUCCEEDED','ROLLED_BACK')
BEGIN
  SELECT RAISE(ABORT, 'apply_batches: terminal batches are immutable');
END;


CREATE TABLE apply_batch_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES apply_batches(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),

  mutation_type TEXT NOT NULL CHECK (mutation_type IN ('MODIFY','CREATE')),
  rel_path TEXT NOT NULL,

  proposed_sha256 TEXT NOT NULL
    CHECK (length(proposed_sha256) = 64 AND proposed_sha256 NOT GLOB '*[^0-9a-f]*'),
  proposed_byte_length INTEGER NOT NULL CHECK (proposed_byte_length >= 0),

  -- Durable MODIFY original-content evidence - captured from proven review
  -- provenance at admission time (applyBatchJournalService.ts), verified
  -- before INSERT, never re-derived afterward. Strict XOR against
  -- mutation_type is enforced at the end of this table (multi-column) -
  -- SQLite has no built-in SHA-256, so original_sha256 actually matching
  -- sha256(original_bytes) cannot itself be a CHECK constraint; that is
  -- enforced procedurally by the admission service.
  original_bytes BLOB,
  original_sha256 TEXT
    CHECK (original_sha256 IS NULL OR (length(original_sha256) = 64 AND original_sha256 NOT GLOB '*[^0-9a-f]*')),
  original_byte_length INTEGER CHECK (original_byte_length IS NULL OR original_byte_length >= 0),

  -- Pre-forward target identity, MODIFY only (B.2C writes this at the
  -- entry's own PREPARED transition, from prepareLease()'s per-entry
  -- outcome). Used by the future "as-original" reverse-lease recovery probe.
  -- CREATE entries never have one (Prepare() never touches a CREATE target) -
  -- enforced at the end of this table (multi-column).
  prepared_native_file_id_128_hex TEXT
    CHECK (prepared_native_file_id_128_hex IS NULL OR
           (length(prepared_native_file_id_128_hex) = 32 AND prepared_native_file_id_128_hex NOT GLOB '*[^0-9a-f]*')),
  prepared_native_volume_serial TEXT
    CHECK (prepared_native_volume_serial IS NULL OR
           (length(prepared_native_volume_serial) BETWEEN 1 AND 20 AND prepared_native_volume_serial NOT GLOB '*[^0-9]*')),

  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN (
    'PENDING','PREPARED','APPLY_ATTEMPTING','APPLIED','ROLLBACK_ATTEMPTING','ROLLED_BACK','RECOVERY_CONFLICT'
  )),

  -- Post-forward (APPLIED) target identity - used by the future "as-applied"
  -- reverse-lease recovery probe for MODIFY, and by B.2A's
  -- recoverDeleteCreated for CREATE (unchanged, native/windows-safe-apply).
  -- Mandatory-once-APPLIED requirement enforced at the end of this table.
  native_file_id_128_hex TEXT
    CHECK (native_file_id_128_hex IS NULL OR
           (length(native_file_id_128_hex) = 32 AND native_file_id_128_hex NOT GLOB '*[^0-9a-f]*')),
  native_volume_serial TEXT
    CHECK (native_volume_serial IS NULL OR
           (length(native_volume_serial) BETWEEN 1 AND 20 AND native_volume_serial NOT GLOB '*[^0-9]*')),
  written_sha256 TEXT
    CHECK (written_sha256 IS NULL OR (length(written_sha256) = 64 AND written_sha256 NOT GLOB '*[^0-9a-f]*')),
  written_byte_length INTEGER CHECK (written_byte_length IS NULL OR written_byte_length >= 0),

  failure_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  UNIQUE (batch_id, ordinal),
  UNIQUE (batch_id, rel_path),

  CHECK (
    (mutation_type = 'MODIFY' AND original_bytes IS NOT NULL AND original_sha256 IS NOT NULL
       AND original_byte_length IS NOT NULL AND length(original_bytes) = original_byte_length)
    OR
    (mutation_type = 'CREATE' AND original_bytes IS NULL AND original_sha256 IS NULL
       AND original_byte_length IS NULL)
  ),

  CHECK (mutation_type != 'CREATE' OR (prepared_native_file_id_128_hex IS NULL AND prepared_native_volume_serial IS NULL)),
  CHECK (
    NOT (mutation_type = 'MODIFY' AND state IN ('PREPARED','APPLY_ATTEMPTING','APPLIED','ROLLBACK_ATTEMPTING'))
    OR (prepared_native_file_id_128_hex IS NOT NULL AND prepared_native_volume_serial IS NOT NULL)
  ),

  -- Pair-completeness: closes the partial-evidence hole in every otherwise
  -- permissive state (PENDING, ROLLED_BACK, RECOVERY_CONFLICT, ...) - each of
  -- these three evidence pairs is either BOTH present or NEITHER present,
  -- never one-sided. NULL-safe (IS NULL never propagates NULL).
  CHECK ((prepared_native_file_id_128_hex IS NULL) = (prepared_native_volume_serial IS NULL)),
  CHECK ((native_file_id_128_hex IS NULL) = (native_volume_serial IS NULL)),
  CHECK ((written_sha256 IS NULL) = (written_byte_length IS NULL)),

  CHECK (
    state != 'APPLIED' OR
    (native_file_id_128_hex IS NOT NULL AND native_volume_serial IS NOT NULL
       AND written_sha256 IS NOT NULL AND written_byte_length IS NOT NULL)
  )
);

CREATE INDEX idx_apply_batch_entries_batch ON apply_batch_entries(batch_id);
CREATE INDEX idx_apply_batch_entries_state ON apply_batch_entries(state);

CREATE TRIGGER apply_batch_entries_no_update_terminal
BEFORE UPDATE ON apply_batch_entries
WHEN OLD.state = 'ROLLED_BACK'
BEGIN
  SELECT RAISE(ABORT, 'apply_batch_entries: ROLLED_BACK entries are immutable');
END;
`
}
