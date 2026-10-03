import { describe, expect, it } from 'vitest'
import type { SessionStatus } from '@shared/types'
import { SESSION_STATUS_TRANSITIONS } from '@shared/types'
import { createTestDb } from '../testUtils/testDb'
import { createProject, archiveProject, ProjectArchivedError } from './projectsService'
import { createContextVersion } from './contextService'
import { addChatMessage } from './chatService'
import { listEventLog } from './eventLogService'
import {
  assignChatMessageToSession,
  createContinuationSession,
  createSession,
  getSessionById,
  getSuccessorSession,
  listSessionChain,
  listSessions,
  updateSession
} from './sessionService'
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
  SnapshotProviderMismatchError,
  SnapshotSessionMismatchError
} from './sessionErrors'

function newProject(db: ReturnType<typeof createTestDb>, name = 'Projekt') {
  return createProject(db, { name, projectType: 'Typ', description: '' })
}

/**
 * Legt einen bestaetigten Snapshot fuer `sessionId` an. Der Provider wird
 * standardmaessig aus der Sitzungszeile selbst gelesen (nicht fest verdrahtet),
 * damit Testdaten nicht widerspruechlich werden - ein expliziter `provider`-
 * Override ist nur fuer gezielte Mismatch-Tests gedacht.
 */
function insertConfirmedSnapshot(
  db: ReturnType<typeof createTestDb>,
  projectId: number,
  sessionId: number,
  overrides: Partial<{
    currentTask: string
    masterContextVersionId: number | null
    confirmationState: string
    provider: string
  }> = {}
): number {
  const sessionRow = db.prepare('SELECT provider FROM sessions WHERE id = ?').get(sessionId) as { provider: string }
  const versionRow = db
    .prepare('SELECT COALESCE(MAX(version_number), 0) AS maxVersion FROM continuation_snapshots WHERE session_id = ?')
    .get(sessionId) as { maxVersion: number }
  const result = db
    .prepare(
      `INSERT INTO continuation_snapshots
        (project_id, session_id, version_number, provider, current_task, master_context_version_id, confirmation_state, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'LEON')`
    )
    .run(
      projectId,
      sessionId,
      versionRow.maxVersion + 1,
      overrides.provider ?? sessionRow.provider,
      overrides.currentTask ?? 'Konkrete Aufgabe',
      overrides.masterContextVersionId ?? null,
      overrides.confirmationState ?? 'CONFIRMED'
    )
  return Number(result.lastInsertRowid)
}

describe('createSession', () => {
  it('legt eine ACTIVE-Sitzung erfolgreich an', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    expect(session.status).toBe('ACTIVE')
    expect(session.provider).toBe('CHATGPT')
    expect(session.projectId).toBe(project.id)
    expect(session.predecessorSessionId).toBeNull()
  })

  it('lehnt eine zweite ACTIVE-Sitzung desselben Providers ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    expect(() => createSession(db, { projectId: project.id, provider: 'CHATGPT' })).toThrow(
      AnotherActiveSessionExistsError
    )
  })

  it('erlaubt CHATGPT und CLAUDE gleichzeitig ACTIVE', () => {
    const db = createTestDb()
    const project = newProject(db)
    createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    expect(() => createSession(db, { projectId: project.id, provider: 'CLAUDE' })).not.toThrow()
  })

  it('lehnt ein archiviertes Projekt ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    archiveProject(db, project.id)
    expect(() => createSession(db, { projectId: project.id, provider: 'CHATGPT' })).toThrow(ProjectArchivedError)
  })

  it('lehnt eine projektfremde Kontextversion ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const otherProject = newProject(db, 'Anderes Projekt')
    const foreignVersion = createContextVersion(db, {
      projectId: otherProject.id,
      contentMarkdown: '# X',
      createdBy: 'LEON'
    })
    expect(() =>
      createSession(db, { projectId: project.id, provider: 'CHATGPT', masterContextVersionId: foreignVersion.id })
    ).toThrow(SessionContextMismatchError)
  })

  it('schreibt ein SESSION_CREATED-Ereignis ohne Freitext im Payload', () => {
    const db = createTestDb()
    const project = newProject(db)
    createSession(db, { projectId: project.id, provider: 'CHATGPT', title: 'Geheimer Titel' })
    const events = listEventLog(db, { projectId: project.id, type: 'SESSION_CREATED' })
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events[0].payload)).not.toContain('Geheimer Titel')
  })
})

describe('listSessions / getSessionById', () => {
  it('listet Sitzungen eines Projekts nachvollziehbar sortiert', () => {
    const db = createTestDb()
    const project = newProject(db)
    const a = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    const b = createSession(db, { projectId: project.id, provider: 'CLAUDE', status: 'PAUSED' })
    expect(listSessions(db, project.id).map((s) => s.id)).toEqual([a.id, b.id])
  })

  it('wirft SessionNotFoundError fuer eine unbekannte ID', () => {
    const db = createTestDb()
    expect(() => getSessionById(db, 9999)).toThrow(SessionNotFoundError)
  })
})

describe('Statusuebergaenge', () => {
  const validTransitions: Array<[SessionStatus, SessionStatus]> = []
  for (const [from, tos] of Object.entries(SESSION_STATUS_TRANSITIONS) as Array<
    [SessionStatus, readonly SessionStatus[]]
  >) {
    for (const to of tos) validTransitions.push([from, to])
  }

  it.each(validTransitions)('erlaubt den Uebergang von %s zu %s', (from, to) => {
    const db = createTestDb()
    const project = newProject(db)
    let session = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'ACTIVE' })
    if (from !== 'ACTIVE') {
      session = updateSession(db, { id: session.id, status: from })
    }
    const updated = updateSession(db, { id: session.id, status: to })
    expect(updated.status).toBe(to)
  })

  it.each([
    ['COMPLETED', 'ACTIVE'],
    ['COMPLETED', 'PAUSED'],
    ['ABANDONED', 'ACTIVE'],
    ['ABANDONED', 'PAUSED'],
    ['PAUSED', 'LIMIT_REACHED'],
    ['LIMIT_REACHED', 'WAITING_ON_HUMAN']
  ] as Array<[SessionStatus, SessionStatus]>)('lehnt den Uebergang von %s zu %s ab', (from, to) => {
    const db = createTestDb()
    const project = newProject(db)
    let session = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'ACTIVE' })
    if (from !== 'ACTIVE') {
      session = updateSession(db, { id: session.id, status: from })
    }
    expect(() => updateSession(db, { id: session.id, status: to })).toThrow(SessionError)
  })

  it('COMPLETED und ABANDONED sind terminal (keine erlaubten Uebergaenge)', () => {
    expect(SESSION_STATUS_TRANSITIONS.COMPLETED).toEqual([])
    expect(SESSION_STATUS_TRANSITIONS.ABANDONED).toEqual([])
  })

  it('lehnt den Wechsel zu ACTIVE ab, wenn eine andere Sitzung desselben Providers bereits aktiv ist', () => {
    const db = createTestDb()
    const project = newProject(db)
    createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const second = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    expect(() => updateSession(db, { id: second.id, status: 'ACTIVE' })).toThrow(AnotherActiveSessionExistsError)
  })

  it('setzt completed_at beim Wechsel zu COMPLETED', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const completed = updateSession(db, { id: session.id, status: 'COMPLETED' })
    expect(completed.completedAt).not.toBeNull()
  })

  it('setzt completed_at bereits bei initialem Status COMPLETED', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'COMPLETED' })
    expect(session.completedAt).not.toBeNull()
  })

  it('fuehrt bei fehlender effektiver Aenderung keinen Schreibvorgang/Event aus', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT', title: 'Titel' })
    updateSession(db, { id: session.id, title: 'Titel' })
    const events = listEventLog(db, { projectId: project.id, type: 'SESSION_UPDATED' })
    expect(events).toHaveLength(0)
  })

  it('lehnt ein Update bei archiviertem Projekt ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    archiveProject(db, project.id)
    expect(() => updateSession(db, { id: session.id, title: 'Neuer Titel' })).toThrow(ProjectArchivedError)
  })
})

describe('getSuccessorSession / listSessionChain', () => {
  it('leitet den Nachfolger korrekt ueber predecessor_session_id ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    expect(getSuccessorSession(db, first.id)).toBeNull()

    const snapshot = insertConfirmedSnapshot(db, project.id, first.id)
    const second = createContinuationSession(db, {
      fromSessionId: first.id,
      provider: 'CHATGPT',
      basedOnSnapshotId: snapshot
    })

    expect(getSuccessorSession(db, first.id)?.id).toBe(second.id)
  })

  it('liefert die vollstaendige Kette in root-to-tail-Reihenfolge, unabhaengig vom Abfragepunkt', () => {
    const db = createTestDb()
    const project = newProject(db)
    let current = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    const chainIds = [current.id]
    for (let i = 0; i < 3; i++) {
      const snapshot = insertConfirmedSnapshot(db, project.id, current.id)
      current = createContinuationSession(db, {
        fromSessionId: current.id,
        provider: 'CHATGPT',
        basedOnSnapshotId: snapshot
      })
      chainIds.push(current.id)
    }
    expect(listSessionChain(db, chainIds[1]).map((s) => s.id)).toEqual(chainIds)
    expect(listSessionChain(db, chainIds[0]).map((s) => s.id)).toEqual(chainIds)
    expect(listSessionChain(db, chainIds[3]).map((s) => s.id)).toEqual(chainIds)
  })
})

describe('createContinuationSession', () => {
  it('lehnt eine zweite direkte Nachfolgesitzung mit ContinuationError/SESSION_ALREADY_HAS_SUCCESSOR ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    const snapshotA = insertConfirmedSnapshot(db, project.id, first.id)
    createContinuationSession(db, { fromSessionId: first.id, provider: 'CHATGPT', basedOnSnapshotId: snapshotA })

    const snapshotB = insertConfirmedSnapshot(db, project.id, first.id)
    try {
      createContinuationSession(db, { fromSessionId: first.id, provider: 'CHATGPT', basedOnSnapshotId: snapshotB })
      throw new Error('haette werfen muessen')
    } catch (err) {
      expect(err).toBeInstanceOf(ContinuationError)
      expect((err as ContinuationError).code).toBe('SESSION_ALREADY_HAS_SUCCESSOR')
    }
  })

  it('lehnt ein archiviertes Projekt ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    const snapshot = insertConfirmedSnapshot(db, project.id, first.id)
    archiveProject(db, project.id)
    expect(() =>
      createContinuationSession(db, { fromSessionId: first.id, provider: 'CHATGPT', basedOnSnapshotId: snapshot })
    ).toThrow(ProjectArchivedError)
  })

  it('pausiert die Vorgaengersitzung atomar bei Same-Provider-Fortsetzung (Default PAUSED)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const snapshot = insertConfirmedSnapshot(db, project.id, first.id, {
      currentTask: 'Naechste Aufgabe',
      masterContextVersionId: null
    })
    const second = createContinuationSession(db, {
      fromSessionId: first.id,
      provider: 'CHATGPT',
      basedOnSnapshotId: snapshot
    })

    expect(getSessionById(db, first.id).status).toBe('PAUSED')
    expect(second.status).toBe('ACTIVE')
    expect(second.predecessorSessionId).toBe(first.id)
    expect(second.basedOnSnapshotId).toBe(snapshot)
    expect(second.currentTask).toBe('Naechste Aufgabe')

    const events = listEventLog(db, { projectId: project.id, type: 'SESSION_CONTINUED' })
    expect(events).toHaveLength(1)
  })

  it('erlaubt COMPLETED als expliziten Abschlussstatus bei Same-Provider-Fortsetzung', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const snapshot = insertConfirmedSnapshot(db, project.id, first.id)
    createContinuationSession(db, {
      fromSessionId: first.id,
      provider: 'CHATGPT',
      basedOnSnapshotId: snapshot,
      fromSessionFinalStatus: 'COMPLETED'
    })
    const refreshed = getSessionById(db, first.id)
    expect(refreshed.status).toBe('COMPLETED')
    expect(refreshed.completedAt).not.toBeNull()
  })

  it('veraendert bei Cross-Provider-Fortsetzung den Status der Vorgaengersitzung nicht', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const snapshot = insertConfirmedSnapshot(db, project.id, first.id)
    const second = createContinuationSession(db, {
      fromSessionId: first.id,
      provider: 'CLAUDE',
      basedOnSnapshotId: snapshot
    })

    expect(getSessionById(db, first.id).status).toBe('ACTIVE')
    expect(second.provider).toBe('CLAUDE')
    expect(second.status).toBe('ACTIVE')
  })

  it('erlaubt eine Fortsetzung von einer bereits ABANDONED-Sitzung, ohne sie zu reaktivieren', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'ABANDONED' })
    const snapshot = insertConfirmedSnapshot(db, project.id, first.id)
    const second = createContinuationSession(db, {
      fromSessionId: first.id,
      provider: 'CHATGPT',
      basedOnSnapshotId: snapshot
    })

    expect(getSessionById(db, first.id).status).toBe('ABANDONED')
    expect(second.status).toBe('ACTIVE')
  })

  it('erfordert einen bestaetigten Snapshot (ContinuationError/SNAPSHOT_NOT_CONFIRMED)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    const draft = insertConfirmedSnapshot(db, project.id, first.id, { confirmationState: 'DRAFT' })
    try {
      createContinuationSession(db, { fromSessionId: first.id, provider: 'CHATGPT', basedOnSnapshotId: draft })
      throw new Error('haette werfen muessen')
    } catch (err) {
      expect(err).toBeInstanceOf(ContinuationError)
      expect((err as ContinuationError).code).toBe('SNAPSHOT_NOT_CONFIRMED')
    }
  })

  it('lehnt einen Snapshot mit abweichendem Provider ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    const mismatched = insertConfirmedSnapshot(db, project.id, first.id, { provider: 'CLAUDE' })
    expect(() =>
      createContinuationSession(db, { fromSessionId: first.id, provider: 'CHATGPT', basedOnSnapshotId: mismatched })
    ).toThrow(SnapshotProviderMismatchError)
  })

  it('Testhelfer leitet den Provider bei einer CLAUDE-Sitzung korrekt als CLAUDE-Snapshot ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const claudeSession = createSession(db, { projectId: project.id, provider: 'CLAUDE', status: 'PAUSED' })
    const snapshotId = insertConfirmedSnapshot(db, project.id, claudeSession.id)
    const row = db.prepare('SELECT provider FROM continuation_snapshots WHERE id = ?').get(snapshotId) as {
      provider: string
    }
    expect(row.provider).toBe('CLAUDE')
  })

  it('lehnt eine projektfremde master_context_version_id im Snapshot ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const otherProject = newProject(db, 'Anderes Projekt')
    const foreignVersion = createContextVersion(db, {
      projectId: otherProject.id,
      contentMarkdown: '# X',
      createdBy: 'LEON'
    })
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    const snapshot = insertConfirmedSnapshot(db, project.id, first.id, {
      masterContextVersionId: foreignVersion.id
    })
    expect(() =>
      createContinuationSession(db, { fromSessionId: first.id, provider: 'CHATGPT', basedOnSnapshotId: snapshot })
    ).toThrow(SessionContextMismatchError)
  })

  it('lehnt einen ungueltigen Laufzeitwert fuer fromSessionFinalStatus ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const snapshot = insertConfirmedSnapshot(db, project.id, first.id)
    expect(() =>
      createContinuationSession(db, {
        fromSessionId: first.id,
        provider: 'CHATGPT',
        basedOnSnapshotId: snapshot,
        fromSessionFinalStatus: 'ABANDONED' as unknown as 'PAUSED' | 'COMPLETED'
      })
    ).toThrow(SessionError)
    // Die Vorgaengersitzung darf durch den abgelehnten Versuch nicht veraendert worden sein.
    expect(getSessionById(db, first.id).status).toBe('ACTIVE')
  })

  it('lehnt einen sitzungsfremden Snapshot ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    const otherSession = createSession(db, { projectId: project.id, provider: 'CLAUDE', status: 'PAUSED' })
    const foreignSnapshot = insertConfirmedSnapshot(db, project.id, otherSession.id)
    expect(() =>
      createContinuationSession(db, { fromSessionId: first.id, provider: 'CHATGPT', basedOnSnapshotId: foreignSnapshot })
    ).toThrow(SnapshotSessionMismatchError)
  })

  it('lehnt einen projektfremden Snapshot ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const otherProject = newProject(db, 'Anderes Projekt')
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    const otherSession = createSession(db, { projectId: otherProject.id, provider: 'CHATGPT', status: 'PAUSED' })
    const foreignSnapshot = insertConfirmedSnapshot(db, otherProject.id, otherSession.id)
    expect(() =>
      createContinuationSession(db, { fromSessionId: first.id, provider: 'CHATGPT', basedOnSnapshotId: foreignSnapshot })
    ).toThrow(SnapshotSessionMismatchError)
  })

  it('veraendert die Vorgaengersitzung nicht, wenn die Snapshot-Pruefung vorab fehlschlaegt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    expect(() =>
      createContinuationSession(db, { fromSessionId: first.id, provider: 'CHATGPT', basedOnSnapshotId: 9999 })
    ).toThrow()
    expect(getSessionById(db, first.id).status).toBe('ACTIVE')
    expect(getSuccessorSession(db, first.id)).toBeNull()
  })

  it('rollt vollstaendig zurueck, wenn der Zielprovider bereits eine andere aktive Sitzung besitzt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const first = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    createSession(db, { projectId: project.id, provider: 'CLAUDE' })
    const snapshot = insertConfirmedSnapshot(db, project.id, first.id)

    expect(() =>
      createContinuationSession(db, { fromSessionId: first.id, provider: 'CLAUDE', basedOnSnapshotId: snapshot })
    ).toThrow(AnotherActiveSessionExistsError)

    expect(getSessionById(db, first.id).status).toBe('ACTIVE')
    expect(listSessions(db, project.id)).toHaveLength(2)
    expect(listEventLog(db, { projectId: project.id, type: 'SESSION_CONTINUED' })).toHaveLength(0)
  })
})

describe('assignChatMessageToSession', () => {
  it('ordnet eine Chat-Nachricht mit gleicher Projektzugehoerigkeit korrekt zu', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const message = addChatMessage(db, { projectId: project.id, author: 'CHATGPT', content: 'Antwort' })
    const assignment = assignChatMessageToSession(db, { sessionId: session.id, chatMessageId: message.id })
    expect(assignment.sequenceNumber).toBe(1)
    expect(assignment.sessionId).toBe(session.id)
    expect(assignment.chatMessageId).toBe(message.id)
  })

  it('wirft ChatMessageNotFoundError fuer eine nicht existierende Nachricht', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    expect(() => assignChatMessageToSession(db, { sessionId: session.id, chatMessageId: 9999 })).toThrow(
      ChatMessageNotFoundError
    )
  })

  it('erzeugt bei fehlgeschlagener Zuordnung weder eine Zuordnungszeile noch ein Audit-Event', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CLAUDE' })
    const message = addChatMessage(db, { projectId: project.id, author: 'CHATGPT', content: 'Mismatch' })

    expect(() => assignChatMessageToSession(db, { sessionId: session.id, chatMessageId: message.id })).toThrow(
      ChatMessageProviderMismatchError
    )

    const row = db
      .prepare('SELECT COUNT(*) as c FROM session_chat_messages WHERE chat_message_id = ?')
      .get(message.id) as { c: number }
    expect(row.c).toBe(0)
    expect(listEventLog(db, { projectId: project.id, type: 'CHAT_MESSAGE_ASSIGNED_TO_SESSION' })).toHaveLength(0)
  })

  it('lehnt eine projektfremde Nachricht ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const otherProject = newProject(db, 'Anderes Projekt')
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const message = addChatMessage(db, { projectId: otherProject.id, author: 'CHATGPT', content: 'x' })
    expect(() => assignChatMessageToSession(db, { sessionId: session.id, chatMessageId: message.id })).toThrow(
      ChatMessageSessionProjectMismatchError
    )
  })

  it('lehnt einen Provider-Mismatch ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CLAUDE' })
    const message = addChatMessage(db, { projectId: project.id, author: 'CHATGPT', content: 'x' })
    expect(() => assignChatMessageToSession(db, { sessionId: session.id, chatMessageId: message.id })).toThrow(
      ChatMessageProviderMismatchError
    )
  })

  it.each(['LEON', 'SYSTEM'] as const)('erlaubt %s-Nachrichten bei beiden Providern', (author) => {
    const db = createTestDb()
    const project = newProject(db)
    const chatgptSession = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const claudeSession = createSession(db, { projectId: project.id, provider: 'CLAUDE' })
    const messageA = addChatMessage(db, { projectId: project.id, author, content: 'a' })
    const messageB = addChatMessage(db, { projectId: project.id, author, content: 'b' })
    expect(() =>
      assignChatMessageToSession(db, { sessionId: chatgptSession.id, chatMessageId: messageA.id })
    ).not.toThrow()
    expect(() =>
      assignChatMessageToSession(db, { sessionId: claudeSession.id, chatMessageId: messageB.id })
    ).not.toThrow()
  })

  it('lehnt eine doppelte Zuordnung ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const otherSession = createSession(db, { projectId: project.id, provider: 'CLAUDE' })
    const message = addChatMessage(db, { projectId: project.id, author: 'LEON', content: 'x' })
    assignChatMessageToSession(db, { sessionId: session.id, chatMessageId: message.id })
    expect(() => assignChatMessageToSession(db, { sessionId: otherSession.id, chatMessageId: message.id })).toThrow(
      ChatMessageAlreadyAssignedError
    )
  })

  it('vergibt Sequenznummern fortlaufend je Sitzung', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const first = addChatMessage(db, { projectId: project.id, author: 'CHATGPT', content: 'a' })
    const second = addChatMessage(db, { projectId: project.id, author: 'CHATGPT', content: 'b' })
    const a1 = assignChatMessageToSession(db, { sessionId: session.id, chatMessageId: first.id })
    const a2 = assignChatMessageToSession(db, { sessionId: session.id, chatMessageId: second.id })
    expect(a1.sequenceNumber).toBe(1)
    expect(a2.sequenceNumber).toBe(2)
  })

  it('lehnt eine Zuordnung bei archiviertem Projekt ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT', status: 'PAUSED' })
    const message = addChatMessage(db, { projectId: project.id, author: 'LEON', content: 'x' })
    archiveProject(db, project.id)
    expect(() => assignChatMessageToSession(db, { sessionId: session.id, chatMessageId: message.id })).toThrow(
      ProjectArchivedError
    )
  })
})
