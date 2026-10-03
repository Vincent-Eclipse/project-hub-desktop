import type Database from 'better-sqlite3'
import type {
  Actor,
  ConfirmationState,
  ConfirmSnapshotInput,
  ContinuationSnapshot,
  CreateDraftSnapshotInput,
  RequiredFile,
  RequiredFileInput,
  SensitiveContentFinding,
  SessionProvider,
  SnapshotReasonCode
} from '@shared/types'
import { LOCAL_PATH_MAX_LENGTH, REQUIRED_FILE_DISPLAY_NAME_MAX_LENGTH } from '@shared/types'
import { getProjectById, ProjectArchivedError } from './projectsService'
import { getSessionById } from './sessionService'
import {
  ContinuationError,
  SessionContextMismatchError,
  SnapshotNotFoundError,
  SnapshotSessionMismatchError
} from './sessionErrors'

interface SnapshotRow {
  id: number
  project_id: number
  session_id: number
  version_number: number
  provider: string
  master_context_version_id: number | null
  current_task: string
  confirmed_done_json: string
  confirmed_open_json: string
  blockers_json: string
  last_complete_section: string
  missing_sections_json: string
  next_exact_step: string
  additional_human_action: string
  reason_code: string
  confirmation_state: string
  derived_from_snapshot_id: number | null
  created_by: string
  created_at: string
}

interface RequiredFileRow {
  id: number
  snapshot_id: number | null
  intervention_revision_id: number | null
  display_name: string
  expected_filename: string
  sha256: string | null
  purpose: string
  is_required: number
  reupload_required: number
  is_sensitive: number
  local_path: string | null
  created_at: string
}

function mapRequiredFileRow(row: RequiredFileRow): RequiredFile {
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    interventionRevisionId: row.intervention_revision_id,
    displayName: row.display_name,
    expectedFilename: row.expected_filename,
    sha256: row.sha256,
    purpose: row.purpose,
    isRequired: row.is_required === 1,
    reuploadRequired: row.reupload_required === 1,
    isSensitive: row.is_sensitive === 1,
    localPath: row.local_path,
    createdAt: row.created_at
  }
}

function listRequiredFilesForSnapshot(db: Database.Database, snapshotId: number): RequiredFile[] {
  const rows = db
    .prepare('SELECT * FROM continuation_required_files WHERE snapshot_id = ? ORDER BY id ASC')
    .all(snapshotId) as RequiredFileRow[]
  return rows.map(mapRequiredFileRow)
}

function mapSnapshotRow(row: SnapshotRow, requiredFiles: RequiredFile[]): ContinuationSnapshot {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    versionNumber: row.version_number,
    provider: row.provider as SessionProvider,
    masterContextVersionId: row.master_context_version_id,
    currentTask: row.current_task,
    confirmedDone: JSON.parse(row.confirmed_done_json) as string[],
    confirmedOpen: JSON.parse(row.confirmed_open_json) as string[],
    blockers: JSON.parse(row.blockers_json) as string[],
    lastCompleteSection: row.last_complete_section,
    missingSections: JSON.parse(row.missing_sections_json) as string[],
    nextExactStep: row.next_exact_step,
    additionalHumanAction: row.additional_human_action,
    reasonCode: row.reason_code as SnapshotReasonCode,
    confirmationState: row.confirmation_state as ConfirmationState,
    derivedFromSnapshotId: row.derived_from_snapshot_id,
    createdBy: row.created_by as Actor,
    createdAt: row.created_at,
    requiredFiles
  }
}

function getSnapshotRowById(db: Database.Database, snapshotId: number): SnapshotRow {
  const row = db.prepare('SELECT * FROM continuation_snapshots WHERE id = ?').get(snapshotId) as
    | SnapshotRow
    | undefined
  if (!row) throw new SnapshotNotFoundError(snapshotId)
  return row
}

function loadSnapshotById(db: Database.Database, snapshotId: number): ContinuationSnapshot {
  const row = getSnapshotRowById(db, snapshotId)
  return mapSnapshotRow(row, listRequiredFilesForSnapshot(db, row.id))
}

/**
 * Prueft, dass eine angegebene Kontext-Version zum selben Projekt gehoert.
 * sessionService.ts besitzt denselben Check bereits, haelt ihn aber privat -
 * hier lokal nachgebildet, um die eingefrorene Datei nicht anzufassen.
 */
function assertContextVersionBelongsToProject(
  db: Database.Database,
  projectId: number,
  contextVersionId: number
): void {
  const row = db.prepare('SELECT project_id FROM project_context_versions WHERE id = ?').get(contextVersionId) as
    | { project_id: number }
    | undefined
  if (!row || row.project_id !== projectId) {
    throw new SessionContextMismatchError(contextVersionId, projectId)
  }
}

function assertSessionInProject(session: { projectId: number }, projectId: number): void {
  if (session.projectId !== projectId) {
    throw new ContinuationError('SESSION_NOT_IN_PROJECT', 'Sitzung gehoert nicht zum angegebenen Projekt.')
  }
}

// ===========================================================================
// Sensible Inhalte
// ===========================================================================

const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const AUTHORIZATION_HEADER_PATTERN = /\bAuthorization\s*:\s*Bearer\s+\S+/i
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{16,}/
const KNOWN_TOKEN_PREFIX_PATTERN = /\b(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/

const SENSITIVE_ASSIGNMENT_NAMES = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'private_key',
  'client_secret',
  'authorization'
] as const

function isPlaceholderValue(rawValue: string): boolean {
  const value = rawValue.replace(/^["']|["']$/g, '').trim()
  if (value.length === 0) return true
  if (/^<.+>$/.test(value)) return true
  if (/^\{\{.+\}\}$/.test(value)) return true
  if (/^(your[_-]?api[_-]?key|changeme|xxx+|todo|example|sample|placeholder|set[_-]?locally)$/i.test(value)) {
    return true
  }
  return false
}

function assignmentFindingType(name: string): SensitiveContentFinding['type'] {
  if (name === 'password' || name === 'passwd') return 'PASSWORD_ASSIGNMENT'
  if (name === 'authorization') return 'AUTHORIZATION_BEARER'
  return 'ENV_ASSIGNMENT'
}

/**
 * Konservative, gezielte Erkennung erkennbarer Secrets in kuratierten
 * Freitextfeldern. Blockiert nicht pauschal SHA-256-Werte, Pfade,
 * Dateinamen oder Platzhalter wie <TOKEN> - siehe isPlaceholderValue().
 * Liefert nie den gefundenen Wert selbst zurueck, nur den Feldnamen.
 */
function scanForSensitiveContent(field: string, text: string): SensitiveContentFinding | null {
  if (PRIVATE_KEY_BLOCK_PATTERN.test(text)) {
    return {
      type: 'PRIVATE_KEY_BLOCK',
      field,
      approximateLocation: field,
      safeMessage: `Feld "${field}" enthaelt einen privaten Schluessel und wurde abgelehnt.`
    }
  }
  if (AUTHORIZATION_HEADER_PATTERN.test(text) || BEARER_TOKEN_PATTERN.test(text)) {
    return {
      type: 'AUTHORIZATION_BEARER',
      field,
      approximateLocation: field,
      safeMessage: `Feld "${field}" enthaelt einen Authorization-/Bearer-Wert und wurde abgelehnt.`
    }
  }
  if (KNOWN_TOKEN_PREFIX_PATTERN.test(text)) {
    return {
      type: 'API_TOKEN_PATTERN',
      field,
      approximateLocation: field,
      safeMessage: `Feld "${field}" enthaelt ein bekanntes API-Token-Muster und wurde abgelehnt.`
    }
  }
  for (const name of SENSITIVE_ASSIGNMENT_NAMES) {
    const pattern = new RegExp(`\\b${name}\\b\\s*[:=]\\s*["']?([^\\s"',;]+)`, 'i')
    const match = pattern.exec(text)
    const value = match?.[1]
    if (value !== undefined && !isPlaceholderValue(value)) {
      return {
        type: assignmentFindingType(name),
        field,
        approximateLocation: field,
        safeMessage: `Feld "${field}" enthaelt eine sensible Zuweisung ("${name}") und wurde abgelehnt.`
      }
    }
  }
  return null
}

function assertFieldNotSensitive(field: string, text: string): void {
  const finding = scanForSensitiveContent(field, text)
  if (finding) throw new ContinuationError('SENSITIVE_CONTENT_DETECTED', finding.safeMessage)
}

interface CuratedSnapshotText {
  currentTask: string
  confirmedDone: string[]
  confirmedOpen: string[]
  blockers: string[]
  lastCompleteSection: string
  missingSections: string[]
  nextExactStep: string
  additionalHumanAction: string
}

function assertNoSensitiveContent(fields: CuratedSnapshotText): void {
  assertFieldNotSensitive('currentTask', fields.currentTask)
  assertFieldNotSensitive('lastCompleteSection', fields.lastCompleteSection)
  assertFieldNotSensitive('nextExactStep', fields.nextExactStep)
  assertFieldNotSensitive('additionalHumanAction', fields.additionalHumanAction)
  fields.confirmedDone.forEach((item, index) => assertFieldNotSensitive(`confirmedDone[${index}]`, item))
  fields.confirmedOpen.forEach((item, index) => assertFieldNotSensitive(`confirmedOpen[${index}]`, item))
  fields.blockers.forEach((item, index) => assertFieldNotSensitive(`blockers[${index}]`, item))
  fields.missingSections.forEach((item, index) => assertFieldNotSensitive(`missingSections[${index}]`, item))
}

// ===========================================================================
// Required Files
// ===========================================================================

function assertValidSha256(value: string | null | undefined): void {
  if (value === null || value === undefined) return
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new ContinuationError('INVALID_SHA256', 'Der angegebene SHA-256-Wert ist ungueltig.')
  }
}

function assertValidLocalPath(value: string | null | undefined): void {
  if (value === null || value === undefined) return
  if (value.length > LOCAL_PATH_MAX_LENGTH) {
    throw new ContinuationError('INVALID_REQUIRED_FILE', 'Der lokale Pfad ist zu lang.')
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) {
    throw new ContinuationError('INVALID_REQUIRED_FILE', 'Der lokale Pfad enthaelt unzulaessige Steuerzeichen.')
  }
}

function assertValidOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new ContinuationError('INVALID_REQUIRED_FILE', `Feld "${field}" muss ein Boolean sein.`)
  }
}

/** Bildet eine gespeicherte Required-File-Zeile auf einen Eingabewert ab - ohne id/snapshotId/interventionRevisionId/createdAt, nur die fachlichen Metadaten. */
function toRequiredFileInput(file: RequiredFile): RequiredFileInput {
  return {
    displayName: file.displayName,
    expectedFilename: file.expectedFilename,
    sha256: file.sha256,
    purpose: file.purpose,
    isRequired: file.isRequired,
    reuploadRequired: file.reuploadRequired,
    isSensitive: file.isSensitive,
    localPath: file.localPath
  }
}

function insertRequiredFiles(db: Database.Database, snapshotId: number, files: RequiredFileInput[] | undefined): void {
  if (!files || files.length === 0) return
  const stmt = db.prepare(
    `INSERT INTO continuation_required_files
      (snapshot_id, display_name, expected_filename, sha256, purpose, is_required, reupload_required, is_sensitive, local_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const file of files) {
    if (typeof file.displayName !== 'string' || file.displayName.trim().length === 0) {
      throw new ContinuationError('INVALID_REQUIRED_FILE', 'displayName ist erforderlich.')
    }
    if (file.displayName.length > REQUIRED_FILE_DISPLAY_NAME_MAX_LENGTH) {
      throw new ContinuationError('INVALID_REQUIRED_FILE', 'displayName ist zu lang.')
    }
    assertValidSha256(file.sha256)
    assertValidLocalPath(file.localPath)
    assertValidOptionalBoolean(file.isRequired, 'isRequired')
    assertValidOptionalBoolean(file.reuploadRequired, 'reuploadRequired')
    assertValidOptionalBoolean(file.isSensitive, 'isSensitive')
    assertFieldNotSensitive('requiredFiles.displayName', file.displayName)
    assertFieldNotSensitive('requiredFiles.purpose', file.purpose ?? '')

    stmt.run(
      snapshotId,
      file.displayName,
      file.expectedFilename ?? '',
      file.sha256 ?? null,
      file.purpose ?? '',
      (file.isRequired ?? true) ? 1 : 0,
      file.reuploadRequired ? 1 : 0,
      file.isSensitive ? 1 : 0,
      file.localPath ?? null
    )
  }
}

// ===========================================================================
// Snapshot lesen
// ===========================================================================

export function listSnapshots(db: Database.Database, projectId: number, sessionId: number): ContinuationSnapshot[] {
  const session = getSessionById(db, sessionId)
  assertSessionInProject(session, projectId)
  const rows = db
    .prepare('SELECT * FROM continuation_snapshots WHERE session_id = ? ORDER BY version_number ASC')
    .all(sessionId) as SnapshotRow[]
  return rows.map((row) => mapSnapshotRow(row, listRequiredFilesForSnapshot(db, row.id)))
}

export function getSnapshot(
  db: Database.Database,
  projectId: number,
  sessionId: number,
  snapshotId: number
): ContinuationSnapshot {
  const session = getSessionById(db, sessionId)
  assertSessionInProject(session, projectId)
  const row = getSnapshotRowById(db, snapshotId)
  if (row.session_id !== sessionId || row.project_id !== projectId) {
    throw new SnapshotSessionMismatchError(snapshotId, sessionId)
  }
  return mapSnapshotRow(row, listRequiredFilesForSnapshot(db, row.id))
}

// ===========================================================================
// Snapshot schreiben
// ===========================================================================

function nextVersionNumber(db: Database.Database, sessionId: number): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(version_number), 0) AS maxVersion FROM continuation_snapshots WHERE session_id = ?')
    .get(sessionId) as { maxVersion: number }
  return row.maxVersion + 1
}

interface NewSnapshotRowData {
  projectId: number
  sessionId: number
  provider: SessionProvider
  masterContextVersionId: number | null
  currentTask: string
  confirmedDone: string[]
  confirmedOpen: string[]
  blockers: string[]
  lastCompleteSection: string
  missingSections: string[]
  nextExactStep: string
  additionalHumanAction: string
  reasonCode: SnapshotReasonCode
  confirmationState: ConfirmationState
  derivedFromSnapshotId: number | null
  createdBy: Actor
}

function insertSnapshotRow(db: Database.Database, data: NewSnapshotRowData): number {
  const versionNumber = nextVersionNumber(db, data.sessionId)
  const result = db
    .prepare(
      `INSERT INTO continuation_snapshots
        (project_id, session_id, version_number, provider, master_context_version_id, current_task,
         confirmed_done_json, confirmed_open_json, blockers_json, last_complete_section, missing_sections_json,
         next_exact_step, additional_human_action, reason_code, confirmation_state, derived_from_snapshot_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.projectId,
      data.sessionId,
      versionNumber,
      data.provider,
      data.masterContextVersionId,
      data.currentTask,
      JSON.stringify(data.confirmedDone),
      JSON.stringify(data.confirmedOpen),
      JSON.stringify(data.blockers),
      data.lastCompleteSection,
      JSON.stringify(data.missingSections),
      data.nextExactStep,
      data.additionalHumanAction,
      data.reasonCode,
      data.confirmationState,
      data.derivedFromSnapshotId,
      data.createdBy
    )
  return Number(result.lastInsertRowid)
}

/**
 * Faengt eine Verletzung von UNIQUE(session_id, version_number) ab und
 * uebersetzt sie in den sprechenden Servicefehler, statt eine rohe
 * SqliteError-Meldung durchzureichen - analog runTranslatingActiveConflict
 * in sessionService.ts. Im synchronen better-sqlite3-Betrieb greift dies
 * praktisch nie, ist aber eine zusaetzliche Absicherung fuer den Insert.
 */
function runTranslatingVersionConflict<T>(db: Database.Database, fn: () => T): T {
  try {
    return db.transaction(fn)()
  } catch (error) {
    if (
      error instanceof Error &&
      (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
      error.message.includes('continuation_snapshots.session_id, continuation_snapshots.version_number')
    ) {
      throw new ContinuationError(
        'SNAPSHOT_VERSION_CONFLICT',
        'Die Versionsnummer wurde zwischenzeitlich bereits vergeben.'
      )
    }
    throw error
  }
}

export function createDraftSnapshot(db: Database.Database, input: CreateDraftSnapshotInput): ContinuationSnapshot {
  const snapshotId = runTranslatingVersionConflict(db, () => {
    const session = getSessionById(db, input.sessionId)
    assertSessionInProject(session, input.projectId)
    const project = getProjectById(db, session.projectId)
    if (project.isArchived) throw new ProjectArchivedError(session.projectId)
    if (input.provider !== session.provider) {
      throw new ContinuationError(
        'PROVIDER_MISMATCH',
        'Angegebener Provider entspricht nicht dem Provider der Sitzung.'
      )
    }
    if (input.masterContextVersionId !== undefined && input.masterContextVersionId !== null) {
      assertContextVersionBelongsToProject(db, session.projectId, input.masterContextVersionId)
    }

    const confirmedDone = input.confirmedDone ?? []
    const confirmedOpen = input.confirmedOpen ?? []
    const blockers = input.blockers ?? []
    const missingSections = input.missingSections ?? []
    const currentTask = input.currentTask ?? ''
    const lastCompleteSection = input.lastCompleteSection ?? ''
    const nextExactStep = input.nextExactStep ?? ''
    const additionalHumanAction = input.additionalHumanAction ?? ''

    assertNoSensitiveContent({
      currentTask,
      confirmedDone,
      confirmedOpen,
      blockers,
      lastCompleteSection,
      missingSections,
      nextExactStep,
      additionalHumanAction
    })

    const id = insertSnapshotRow(db, {
      projectId: session.projectId,
      sessionId: session.id,
      provider: session.provider,
      masterContextVersionId: input.masterContextVersionId ?? null,
      currentTask,
      confirmedDone,
      confirmedOpen,
      blockers,
      lastCompleteSection,
      missingSections,
      nextExactStep,
      additionalHumanAction,
      reasonCode: input.reasonCode ?? 'OTHER',
      confirmationState: 'DRAFT',
      derivedFromSnapshotId: null,
      createdBy: input.createdBy
    })
    insertRequiredFiles(db, id, input.requiredFiles)
    return id
  })

  return loadSnapshotById(db, snapshotId)
}

export function confirmSnapshot(db: Database.Database, input: ConfirmSnapshotInput): ContinuationSnapshot {
  const snapshotId = runTranslatingVersionConflict(db, () => {
    const draftRow = getSnapshotRowById(db, input.draftSnapshotId)

    const session = getSessionById(db, draftRow.session_id)
    const project = getProjectById(db, session.projectId)
    if (project.isArchived) throw new ProjectArchivedError(session.projectId)
    if (draftRow.project_id !== session.projectId) {
      throw new SnapshotSessionMismatchError(draftRow.id, session.id)
    }
    if (draftRow.confirmation_state !== 'DRAFT') {
      throw new ContinuationError('SNAPSHOT_ALREADY_CONFIRMED', `Snapshot ${draftRow.id} ist bereits bestaetigt.`)
    }
    const alreadyConfirmedChild = db
      .prepare('SELECT id FROM continuation_snapshots WHERE derived_from_snapshot_id = ?')
      .get(draftRow.id) as { id: number } | undefined
    if (alreadyConfirmedChild) {
      throw new ContinuationError('SNAPSHOT_ALREADY_CONFIRMED', `Snapshot ${draftRow.id} wurde bereits bestaetigt.`)
    }

    const draftRequiredFiles = listRequiredFilesForSnapshot(db, draftRow.id)

    const corrections = input.corrections ?? {}
    // undefined: Required Files des Entwurfs unveraendert uebernehmen. Ein
    // ausdruecklich angegebenes Array (auch leer) ersetzt die Entwurfsliste
    // vollstaendig. Der Entwurf und seine Zeilen bleiben in jedem Fall
    // unveraendert - es werden nur neue Zeilen fuer den bestaetigten
    // Snapshot eingefuegt.
    const requiredFiles =
      corrections.requiredFiles !== undefined
        ? corrections.requiredFiles
        : draftRequiredFiles.map(toRequiredFileInput)
    const confirmedDone = corrections.confirmedDone ?? (JSON.parse(draftRow.confirmed_done_json) as string[])
    const confirmedOpen = corrections.confirmedOpen ?? (JSON.parse(draftRow.confirmed_open_json) as string[])
    const blockers = corrections.blockers ?? (JSON.parse(draftRow.blockers_json) as string[])
    const missingSections = corrections.missingSections ?? (JSON.parse(draftRow.missing_sections_json) as string[])
    const currentTask = corrections.currentTask ?? draftRow.current_task
    const lastCompleteSection = corrections.lastCompleteSection ?? draftRow.last_complete_section
    const nextExactStep = corrections.nextExactStep ?? draftRow.next_exact_step
    const additionalHumanAction = corrections.additionalHumanAction ?? draftRow.additional_human_action

    assertNoSensitiveContent({
      currentTask,
      confirmedDone,
      confirmedOpen,
      blockers,
      lastCompleteSection,
      missingSections,
      nextExactStep,
      additionalHumanAction
    })

    const id = insertSnapshotRow(db, {
      projectId: draftRow.project_id,
      sessionId: draftRow.session_id,
      provider: draftRow.provider as SessionProvider,
      masterContextVersionId: draftRow.master_context_version_id,
      currentTask,
      confirmedDone,
      confirmedOpen,
      blockers,
      lastCompleteSection,
      missingSections,
      nextExactStep,
      additionalHumanAction,
      reasonCode: draftRow.reason_code as SnapshotReasonCode,
      confirmationState: 'CONFIRMED',
      derivedFromSnapshotId: draftRow.id,
      createdBy: input.createdBy
    })
    insertRequiredFiles(db, id, requiredFiles)
    return id
  })

  return loadSnapshotById(db, snapshotId)
}
