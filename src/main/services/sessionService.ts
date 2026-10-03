import type Database from 'better-sqlite3'
import type {
  AssignChatMessageToSessionInput,
  CreateContinuationSessionInput,
  CreateSessionInput,
  Session,
  SessionChatMessageAssignment,
  SessionProvider,
  SessionStatus,
  UpdateSessionInput
} from '@shared/types'
import { SESSION_STATUS_TRANSITIONS } from '@shared/types'
import { getProjectById, ProjectArchivedError } from './projectsService'
import { logEvent } from './eventLogService'
import {
  AnotherActiveSessionExistsError,
  ChatMessageAlreadyAssignedError,
  ChatMessageNotFoundError,
  ChatMessageProviderMismatchError,
  ChatMessageSessionProjectMismatchError,
  ContinuationError,
  SessionContextMismatchError,
  SessionError,
  SessionNotFoundError,
  SnapshotNotFoundError,
  SnapshotProviderMismatchError,
  SnapshotSessionMismatchError
} from './sessionErrors'

const MAX_CHAIN_DEPTH = 500

interface SessionRow {
  id: number
  project_id: number
  provider: string
  title: string
  status: string
  current_task: string
  master_context_version_id: number | null
  predecessor_session_id: number | null
  based_on_snapshot_id: number | null
  notes: string
  created_at: string
  updated_at: string
  completed_at: string | null
}

function mapRow(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider as SessionProvider,
    title: row.title,
    status: row.status as SessionStatus,
    currentTask: row.current_task,
    masterContextVersionId: row.master_context_version_id,
    predecessorSessionId: row.predecessor_session_id,
    basedOnSnapshotId: row.based_on_snapshot_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  }
}

export function listSessions(db: Database.Database, projectId: number): Session[] {
  getProjectById(db, projectId)
  const rows = db
    .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at ASC, id ASC')
    .all(projectId) as SessionRow[]
  return rows.map(mapRow)
}

export function getSessionById(db: Database.Database, id: number): Session {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
  if (!row) throw new SessionNotFoundError(id)
  return mapRow(row)
}

/** Leitet den Nachfolger ausschliesslich per Abfrage ab - es gibt kein gespeichertes successor-Feld. */
export function getSuccessorSession(db: Database.Database, sessionId: number): Session | null {
  getSessionById(db, sessionId)
  const row = db.prepare('SELECT * FROM sessions WHERE predecessor_session_id = ?').get(sessionId) as
    | SessionRow
    | undefined
  return row ? mapRow(row) : null
}

/**
 * Liefert die vollstaendige Sitzungskette (root-to-tail), zu der `sessionId`
 * gehoert. Findet zuerst die Wurzel rueckwaerts ueber predecessor_session_id,
 * laeuft dann vorwaerts ueber abgeleitete Nachfolger. predecessor_session_id
 * ist per DB-Constraint immer kleiner als die eigene id, ein Zyklus ist
 * dadurch strukturell ausgeschlossen - die Tiefenbegrenzung ist eine
 * zusaetzliche Absicherung.
 */
export function listSessionChain(db: Database.Database, sessionId: number): Session[] {
  let root = getSessionById(db, sessionId)

  let depth = 0
  while (root.predecessorSessionId !== null) {
    depth += 1
    if (depth > MAX_CHAIN_DEPTH) {
      throw new Error(`Sitzungskette ueberschreitet die maximale Tiefe von ${MAX_CHAIN_DEPTH}.`)
    }
    root = getSessionById(db, root.predecessorSessionId)
  }

  const chain: Session[] = [root]
  let current = root
  depth = 0
  for (;;) {
    const next = getSuccessorSession(db, current.id)
    if (next === null) break
    depth += 1
    if (depth > MAX_CHAIN_DEPTH) {
      throw new Error(`Sitzungskette ueberschreitet die maximale Tiefe von ${MAX_CHAIN_DEPTH}.`)
    }
    chain.push(next)
    current = next
  }
  return chain
}

function assertValidStatusTransition(current: SessionStatus, next: SessionStatus): void {
  const allowed = SESSION_STATUS_TRANSITIONS[current]
  if (!allowed.includes(next)) {
    throw new SessionError(
      'INVALID_SESSION_STATUS_TRANSITION',
      `Sitzungsstatus kann nicht von "${current}" zu "${next}" wechseln.`
    )
  }
}

function assertNoOtherActiveSession(db: Database.Database, projectId: number, provider: SessionProvider): void {
  const row = db
    .prepare(`SELECT id FROM sessions WHERE project_id = ? AND provider = ? AND status = 'ACTIVE'`)
    .get(projectId, provider) as { id: number } | undefined
  if (row) throw new AnotherActiveSessionExistsError(projectId, provider)
}

/**
 * Faengt eine Verletzung von idx_sessions_one_active_per_provider ab und
 * uebersetzt sie in den sprechenden Servicefehler statt eine rohe
 * SqliteError-Meldung durchzureichen. assertNoOtherActiveSession() deckt den
 * Normalfall bereits vorab ab - dies ist eine zusaetzliche Absicherung.
 */
function runTranslatingActiveConflict<T>(fn: () => T, projectId: number, provider: SessionProvider): T {
  try {
    return fn()
  } catch (error) {
    if (
      error instanceof Error &&
      (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
      error.message.includes('sessions.project_id, sessions.provider')
    ) {
      throw new AnotherActiveSessionExistsError(projectId, provider)
    }
    throw error
  }
}

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

export function createSession(db: Database.Database, input: CreateSessionInput): Session {
  const project = getProjectById(db, input.projectId)
  if (project.isArchived) throw new ProjectArchivedError(input.projectId)

  const status = input.status ?? 'ACTIVE'
  if (input.masterContextVersionId !== undefined && input.masterContextVersionId !== null) {
    assertContextVersionBelongsToProject(db, input.projectId, input.masterContextVersionId)
  }
  if (status === 'ACTIVE') {
    assertNoOtherActiveSession(db, input.projectId, input.provider)
  }
  const isTerminal = status === 'COMPLETED' || status === 'ABANDONED'

  const sessionId = runTranslatingActiveConflict(
    () =>
      db.transaction(() => {
        const result = db
          .prepare(
            `INSERT INTO sessions
              (project_id, provider, title, status, current_task, master_context_version_id, notes, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ${isTerminal ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : 'NULL'})`
          )
          .run(
            input.projectId,
            input.provider,
            input.title?.trim() ?? '',
            status,
            input.currentTask?.trim() ?? '',
            input.masterContextVersionId ?? null,
            input.notes?.trim() ?? ''
          )
        const id = Number(result.lastInsertRowid)
        logEvent(db, {
          projectId: input.projectId,
          type: 'SESSION_CREATED',
          payload: { sessionId: id, provider: input.provider, status }
        })
        return id
      })(),
    input.projectId,
    input.provider
  )

  return getSessionById(db, sessionId)
}

export function updateSession(db: Database.Database, input: UpdateSessionInput): Session {
  const session = getSessionById(db, input.id)
  const project = getProjectById(db, session.projectId)
  if (project.isArchived) throw new ProjectArchivedError(session.projectId)

  const fields: string[] = []
  const values: unknown[] = []
  const changedFieldNames: string[] = []

  if (input.title !== undefined) {
    const trimmed = input.title.trim()
    if (trimmed !== session.title) {
      fields.push('title = ?')
      values.push(trimmed)
      changedFieldNames.push('title')
    }
  }
  if (input.currentTask !== undefined) {
    const trimmed = input.currentTask.trim()
    if (trimmed !== session.currentTask) {
      fields.push('current_task = ?')
      values.push(trimmed)
      changedFieldNames.push('currentTask')
    }
  }
  if (input.notes !== undefined) {
    const trimmed = input.notes.trim()
    if (trimmed !== session.notes) {
      fields.push('notes = ?')
      values.push(trimmed)
      changedFieldNames.push('notes')
    }
  }
  if (input.masterContextVersionId !== undefined && input.masterContextVersionId !== session.masterContextVersionId) {
    if (input.masterContextVersionId !== null) {
      assertContextVersionBelongsToProject(db, session.projectId, input.masterContextVersionId)
    }
    fields.push('master_context_version_id = ?')
    values.push(input.masterContextVersionId)
    changedFieldNames.push('masterContextVersionId')
  }
  if (input.status !== undefined && input.status !== session.status) {
    assertValidStatusTransition(session.status, input.status)
    if (input.status === 'ACTIVE') assertNoOtherActiveSession(db, session.projectId, session.provider)
    fields.push('status = ?')
    values.push(input.status)
    changedFieldNames.push('status')
    if ((input.status === 'COMPLETED' || input.status === 'ABANDONED') && session.completedAt === null) {
      fields.push(`completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      changedFieldNames.push('completedAt')
    }
  }

  // Keine effektive Aenderung - kein unnoetiger Schreibvorgang, kein Event.
  if (fields.length === 0) return session

  runTranslatingActiveConflict(
    () =>
      db.transaction(() => {
        values.push(input.id)
        db.prepare(
          `UPDATE sessions SET ${fields.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
        ).run(...values)
        logEvent(db, {
          projectId: session.projectId,
          type: 'SESSION_UPDATED',
          payload: { sessionId: input.id, changedFields: changedFieldNames }
        })
      })(),
    session.projectId,
    session.provider
  )

  return getSessionById(db, input.id)
}

interface SnapshotOwnershipRow {
  id: number
  project_id: number
  session_id: number
  provider: string
  confirmation_state: string
  master_context_version_id: number | null
  current_task: string
}

/**
 * Laedt einen Snapshot und prueft, dass er tatsaechlich zur angegebenen
 * Sitzung (und deren Projekt) gehoert, denselben Provider hat, bestaetigt
 * ist, und dass seine master_context_version_id (falls gesetzt) zum
 * selben Projekt gehoert - ein FK garantiert jeweils nur, dass die ID
 * ueberhaupt existiert, nicht die richtige Zuordnung.
 */
function getConfirmedSnapshotForSession(
  db: Database.Database,
  snapshotId: number,
  fromSession: Session
): SnapshotOwnershipRow {
  const row = db
    .prepare(
      'SELECT id, project_id, session_id, provider, confirmation_state, master_context_version_id, current_task FROM continuation_snapshots WHERE id = ?'
    )
    .get(snapshotId) as SnapshotOwnershipRow | undefined
  if (!row) throw new SnapshotNotFoundError(snapshotId)
  if (row.session_id !== fromSession.id || row.project_id !== fromSession.projectId) {
    throw new SnapshotSessionMismatchError(snapshotId, fromSession.id)
  }
  if (row.provider !== fromSession.provider) {
    throw new SnapshotProviderMismatchError(snapshotId, row.provider, fromSession.provider)
  }
  if (row.confirmation_state !== 'CONFIRMED') {
    throw new ContinuationError('SNAPSHOT_NOT_CONFIRMED', `Snapshot ${snapshotId} ist nicht bestaetigt.`)
  }
  if (row.master_context_version_id !== null) {
    assertContextVersionBelongsToProject(db, fromSession.projectId, row.master_context_version_id)
  }
  return row
}

const VALID_FROM_SESSION_FINAL_STATUSES = ['PAUSED', 'COMPLETED'] as const

/**
 * Laufzeit-Absicherung zusaetzlich zur TS-Typisierung: ein unzulaessiger Wert
 * darf nicht als anderer, tatsaechlich gueltiger ACTIVE-Statusuebergang
 * missverstanden werden.
 */
function assertValidFromSessionFinalStatus(value: string | undefined): void {
  if (value === undefined) return
  if (!(VALID_FROM_SESSION_FINAL_STATUSES as readonly string[]).includes(value)) {
    throw new SessionError(
      'INVALID_SESSION_STATUS_TRANSITION',
      `fromSessionFinalStatus muss PAUSED oder COMPLETED sein, nicht "${value}".`
    )
  }
}

/**
 * Uebersetzt eine UNIQUE-Verletzung auf sessions.predecessor_session_id oder
 * auf idx_sessions_one_active_per_provider in den sprechenden Servicefehler,
 * statt eine rohe SqliteError-Meldung durchzureichen. Die vorab in
 * createContinuationSession durchgefuehrten Pruefungen decken den Normalfall
 * bereits ab - dies ist eine zusaetzliche Absicherung fuer den Insert selbst.
 */
function translateContinuationInsertConflict(error: unknown, fromSessionId: number, projectId: number, provider: SessionProvider): never {
  if (error instanceof Error && (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
    if (error.message.includes('sessions.predecessor_session_id')) {
      throw new ContinuationError(
        'SESSION_ALREADY_HAS_SUCCESSOR',
        `Sitzung ${fromSessionId} hat bereits eine Nachfolgesitzung.`
      )
    }
    if (error.message.includes('sessions.project_id, sessions.provider')) {
      throw new AnotherActiveSessionExistsError(projectId, provider)
    }
  }
  throw error
}

/**
 * Vollstaendig atomar: saemtliche Pruefungen (Ausgangssitzung, Projekt-Archiv-
 * Status, vorhandener Nachfolger, Snapshot-Eignung, Ziel-Provider-
 * Eindeutigkeit) sowie die Vorgaenger-Abstufung, das Anlegen der neuen
 * Sitzung und das SESSION_CONTINUED-Ereignis laufen innerhalb derselben
 * db.transaction()-Operation und lesen ihre entscheidungsrelevanten Werte
 * frisch aus der Datenbank.
 */
export function createContinuationSession(db: Database.Database, input: CreateContinuationSessionInput): Session {
  assertValidFromSessionFinalStatus(input.fromSessionFinalStatus)

  const newSessionId = db.transaction(() => {
    const fromSession = getSessionById(db, input.fromSessionId)
    const project = getProjectById(db, fromSession.projectId)
    if (project.isArchived) throw new ProjectArchivedError(fromSession.projectId)

    const existingSuccessor = getSuccessorSession(db, fromSession.id)
    if (existingSuccessor !== null) {
      throw new ContinuationError(
        'SESSION_ALREADY_HAS_SUCCESSOR',
        `Sitzung ${fromSession.id} hat bereits eine Nachfolgesitzung.`
      )
    }

    const snapshot = getConfirmedSnapshotForSession(db, input.basedOnSnapshotId, fromSession)

    const sameProvider = input.provider === fromSession.provider
    let fromSessionTargetStatus: SessionStatus | null = null
    if (sameProvider && fromSession.status === 'ACTIVE') {
      const finalStatus = input.fromSessionFinalStatus ?? 'PAUSED'
      assertValidStatusTransition(fromSession.status, finalStatus)
      fromSessionTargetStatus = finalStatus
    }

    if (fromSessionTargetStatus !== null) {
      const completedClause =
        fromSessionTargetStatus === 'COMPLETED' ? `, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')` : ''
      db.prepare(
        `UPDATE sessions SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')${completedClause} WHERE id = ?`
      ).run(fromSessionTargetStatus, fromSession.id)
    }

    // fromSession ist an dieser Stelle (falls betroffen) bereits umgestuft,
    // die Pruefung erfasst also ausschliesslich noch andere aktive
    // Sitzungen des Zielproviders.
    assertNoOtherActiveSession(db, fromSession.projectId, input.provider)

    let newId: number
    try {
      const result = db
        .prepare(
          `INSERT INTO sessions
            (project_id, provider, title, status, current_task, master_context_version_id, predecessor_session_id, based_on_snapshot_id)
           VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`
        )
        .run(
          fromSession.projectId,
          input.provider,
          input.title?.trim() ?? '',
          snapshot.current_task,
          snapshot.master_context_version_id,
          fromSession.id,
          snapshot.id
        )
      newId = Number(result.lastInsertRowid)
    } catch (error) {
      translateContinuationInsertConflict(error, fromSession.id, fromSession.projectId, input.provider)
    }

    logEvent(db, {
      projectId: fromSession.projectId,
      type: 'SESSION_CONTINUED',
      payload: {
        fromSessionId: fromSession.id,
        toSessionId: newId,
        fromSessionDemoted: fromSessionTargetStatus !== null,
        fromSessionFinalStatus: fromSessionTargetStatus
      }
    })

    return newId
  })()

  return getSessionById(db, newSessionId)
}

function assertAuthorMatchesProvider(author: string, session: Session, chatMessageId: number): void {
  if (author === 'LEON' || author === 'SYSTEM') return
  if (author === session.provider) return
  throw new ChatMessageProviderMismatchError(chatMessageId, session.id)
}

/**
 * Ordnet eine bestehende Chat-Nachricht einer Sitzung zu. Dieselbe Funktion
 * wird auch von chatService.ts (addChatMessage/addImportedChatMessage) beim
 * direkten Speichern mit sessionId genutzt, damit keine zweite, parallele
 * Pruef-/SQL-Logik entsteht. Vollstaendig atomar: Sitzung/Projekt/Nachricht
 * laden, alle Zugehoerigkeits-/Archiv-/Doppelzuordnungs-Pruefungen,
 * Sequenznummer-Berechnung, Insert, Event und Ergebnis-Lesen laufen
 * innerhalb derselben db.transaction()-Operation.
 */
export function assignChatMessageToSession(
  db: Database.Database,
  input: AssignChatMessageToSessionInput
): SessionChatMessageAssignment {
  return db.transaction(() => {
    const session = getSessionById(db, input.sessionId)
    const project = getProjectById(db, session.projectId)
    if (project.isArchived) throw new ProjectArchivedError(session.projectId)

    const messageRow = db
      .prepare('SELECT project_id, author FROM chat_messages WHERE id = ?')
      .get(input.chatMessageId) as { project_id: number; author: string } | undefined
    if (!messageRow) throw new ChatMessageNotFoundError(input.chatMessageId)
    if (messageRow.project_id !== session.projectId) {
      throw new ChatMessageSessionProjectMismatchError(input.chatMessageId, input.sessionId)
    }
    assertAuthorMatchesProvider(messageRow.author, session, input.chatMessageId)

    const existing = db
      .prepare('SELECT session_id FROM session_chat_messages WHERE chat_message_id = ?')
      .get(input.chatMessageId) as { session_id: number } | undefined
    if (existing) throw new ChatMessageAlreadyAssignedError(input.chatMessageId)

    const seqRow = db
      .prepare('SELECT COALESCE(MAX(sequence_number), 0) AS maxSeq FROM session_chat_messages WHERE session_id = ?')
      .get(input.sessionId) as { maxSeq: number }
    const sequenceNumber = seqRow.maxSeq + 1

    try {
      db.prepare(
        'INSERT INTO session_chat_messages (chat_message_id, session_id, sequence_number) VALUES (?, ?, ?)'
      ).run(input.chatMessageId, input.sessionId, sequenceNumber)
    } catch (error) {
      if (error instanceof Error && (error as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw new ChatMessageAlreadyAssignedError(input.chatMessageId)
      }
      throw error
    }

    logEvent(db, {
      projectId: session.projectId,
      type: 'CHAT_MESSAGE_ASSIGNED_TO_SESSION',
      payload: { chatMessageId: input.chatMessageId, sessionId: input.sessionId, sequenceNumber }
    })

    const row = db
      .prepare(
        'SELECT chat_message_id, session_id, sequence_number, created_at FROM session_chat_messages WHERE chat_message_id = ?'
      )
      .get(input.chatMessageId) as {
      chat_message_id: number
      session_id: number
      sequence_number: number
      created_at: string
    }
    return {
      sessionId: row.session_id,
      chatMessageId: row.chat_message_id,
      sequenceNumber: row.sequence_number,
      createdAt: row.created_at
    }
  })()
}
