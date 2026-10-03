import { describe, expect, it } from 'vitest'
import type { RequiredFileInput } from '@shared/types'
import { createTestDb } from '../testUtils/testDb'
import { createProject, archiveProject, ProjectArchivedError } from './projectsService'
import { createContextVersion } from './contextService'
import { createSession } from './sessionService'
import {
  ContinuationError,
  SessionContextMismatchError,
  SessionNotFoundError,
  SnapshotNotFoundError,
  SnapshotSessionMismatchError
} from './sessionErrors'
import { confirmSnapshot, createDraftSnapshot, getSnapshot, listSnapshots } from './continuationSnapshotService'

function newProject(db: ReturnType<typeof createTestDb>, name = 'Projekt') {
  return createProject(db, { name, projectType: 'Typ', description: '' })
}

function newSession(db: ReturnType<typeof createTestDb>, projectId: number, provider: 'CHATGPT' | 'CLAUDE' = 'CHATGPT') {
  return createSession(db, { projectId, provider })
}

describe('createDraftSnapshot - Grundfunktionen', () => {
  it('erstellt einen Entwurf erfolgreich', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const snapshot = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      currentTask: 'Naechster Schritt',
      createdBy: 'LEON'
    })
    expect(snapshot.confirmationState).toBe('DRAFT')
    expect(snapshot.versionNumber).toBe(1)
    expect(snapshot.projectId).toBe(project.id)
    expect(snapshot.sessionId).toBe(session.id)
    expect(snapshot.provider).toBe('CHATGPT')
    expect(snapshot.currentTask).toBe('Naechster Schritt')
    expect(snapshot.derivedFromSnapshotId).toBeNull()
    expect(snapshot.requiredFiles).toEqual([])
  })

  it('liefert mehrere Versionen innerhalb derselben Sitzung mit steigender Versionsnummer', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const first = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    const second = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    expect(first.versionNumber).toBe(1)
    expect(second.versionNumber).toBe(2)
  })

  it('vergibt an verschiedene Sitzungen unabhaengige Versionsreihen', () => {
    const db = createTestDb()
    const project = newProject(db)
    const sessionA = newSession(db, project.id, 'CHATGPT')
    const sessionB = newSession(db, project.id, 'CLAUDE')
    const snapshotA = createDraftSnapshot(db, { projectId: project.id, sessionId: sessionA.id, provider: 'CHATGPT', createdBy: 'LEON' })
    const snapshotB = createDraftSnapshot(db, { projectId: project.id, sessionId: sessionB.id, provider: 'CLAUDE', createdBy: 'LEON' })
    expect(snapshotA.versionNumber).toBe(1)
    expect(snapshotB.versionNumber).toBe(1)
  })
})

describe('getSnapshot / listSnapshots - Grundfunktionen', () => {
  it('ruft einen gespeicherten Snapshot ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const created = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    const loaded = getSnapshot(db, project.id, session.id, created.id)
    expect(loaded).toEqual(created)
  })

  it('listet Snapshots einer Sitzung in stabiler Reihenfolge (nach Versionsnummer)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const first = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    const second = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    const list = listSnapshots(db, project.id, session.id)
    expect(list.map((s) => s.id)).toEqual([first.id, second.id])
    expect(list.map((s) => s.versionNumber)).toEqual([1, 2])
  })

  it('liefert Required Files als Teil des Snapshots zurueck', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const snapshot = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      requiredFiles: [{ displayName: 'Logdatei' }]
    })
    expect(snapshot.requiredFiles).toHaveLength(1)
    expect(snapshot.requiredFiles?.[0].displayName).toBe('Logdatei')

    const loaded = getSnapshot(db, project.id, session.id, snapshot.id)
    expect(loaded.requiredFiles).toHaveLength(1)

    const listed = listSnapshots(db, project.id, session.id)
    expect(listed[0].requiredFiles).toHaveLength(1)
  })
})

describe('Fehler und Zugehoerigkeit', () => {
  it('wirft SessionNotFoundError, wenn die Sitzung nicht existiert', () => {
    const db = createTestDb()
    const project = newProject(db)
    expect(() => createDraftSnapshot(db, { projectId: project.id, sessionId: 9999, provider: 'CHATGPT', createdBy: 'LEON' })).toThrow(
      SessionNotFoundError
    )
    expect(() => listSnapshots(db, project.id, 9999)).toThrow(SessionNotFoundError)
    expect(() => getSnapshot(db, project.id, 9999, 1)).toThrow(SessionNotFoundError)
  })

  it('lehnt eine Sitzung ab, die nicht zum angegebenen Projekt gehoert', () => {
    const db = createTestDb()
    const project = newProject(db)
    const otherProject = newProject(db, 'Anderes Projekt')
    const session = newSession(db, project.id)
    try {
      listSnapshots(db, otherProject.id, session.id)
      throw new Error('haette werfen muessen')
    } catch (err) {
      expect(err).toBeInstanceOf(ContinuationError)
      expect((err as ContinuationError).code).toBe('SESSION_NOT_IN_PROJECT')
    }
  })

  it('wirft SnapshotNotFoundError fuer eine unbekannte Snapshot-ID', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    expect(() => getSnapshot(db, project.id, session.id, 9999)).toThrow(SnapshotNotFoundError)
  })

  it('lehnt einen Snapshot ab, der zu einer anderen Sitzung gehoert', () => {
    const db = createTestDb()
    const project = newProject(db)
    const sessionA = newSession(db, project.id, 'CHATGPT')
    const sessionB = newSession(db, project.id, 'CLAUDE')
    const snapshot = createDraftSnapshot(db, { projectId: project.id, sessionId: sessionA.id, provider: 'CHATGPT', createdBy: 'LEON' })
    expect(() => getSnapshot(db, project.id, sessionB.id, snapshot.id)).toThrow(SnapshotSessionMismatchError)
  })

  it('lehnt einen Snapshot ab, der zu einem anderen Projekt gehoert', () => {
    const db = createTestDb()
    const project = newProject(db)
    const otherProject = newProject(db, 'Anderes Projekt')
    const session = newSession(db, project.id)
    const otherSession = newSession(db, otherProject.id)
    const snapshot = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    expect(() => getSnapshot(db, otherProject.id, otherSession.id, snapshot.id)).toThrow(SnapshotSessionMismatchError)
  })

  it('lehnt createDraftSnapshot bei archiviertem Projekt ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    archiveProject(db, project.id)
    expect(() =>
      createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    ).toThrow(ProjectArchivedError)
  })

  it('lehnt confirmSnapshot bei archiviertem Projekt ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    archiveProject(db, project.id)
    expect(() => confirmSnapshot(db, { draftSnapshotId: draft.id, createdBy: 'LEON' })).toThrow(ProjectArchivedError)
  })

  it('lehnt einen Provider-Mismatch bei createDraftSnapshot ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CLAUDE')
    try {
      createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
      throw new Error('haette werfen muessen')
    } catch (err) {
      expect(err).toBeInstanceOf(ContinuationError)
      expect((err as ContinuationError).code).toBe('PROVIDER_MISMATCH')
    }
  })

  it('lehnt eine projektfremde masterContextVersionId ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const otherProject = newProject(db, 'Anderes Projekt')
    const session = newSession(db, project.id)
    const foreignVersion = createContextVersion(db, { projectId: otherProject.id, contentMarkdown: '# X', createdBy: 'LEON' })
    expect(() =>
      createDraftSnapshot(db, {
        projectId: project.id,
        sessionId: session.id,
        provider: 'CHATGPT',
        masterContextVersionId: foreignVersion.id,
        createdBy: 'LEON'
      })
    ).toThrow(SessionContextMismatchError)
  })

  it('erkennt eine inkonsistente Ausgangssnapshot-Zuordnung bei confirmSnapshot (Datenintegritaet)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const otherProject = newProject(db, 'Anderes Projekt')
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    // Simuliert eine beschaedigte Zeile (project_id weicht von der tatsaechlichen
    // Projektzugehoerigkeit der Sitzung ab) - kann ueber den Service selbst nicht
    // entstehen, muss aber als Integritaetspruefung dennoch abgefangen werden.
    db.prepare('UPDATE continuation_snapshots SET project_id = ? WHERE id = ?').run(otherProject.id, draft.id)
    expect(() => confirmSnapshot(db, { draftSnapshotId: draft.id, createdBy: 'LEON' })).toThrow(SnapshotSessionMismatchError)
  })
})

describe('Required Files', () => {
  it('speichert gueltige Required Files', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const snapshot = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      requiredFiles: [
        {
          displayName: 'Exportierte Logdatei',
          expectedFilename: 'log.txt',
          sha256: 'a'.repeat(64),
          purpose: 'Fehleranalyse',
          isRequired: true,
          reuploadRequired: false,
          isSensitive: false,
          localPath: 'C:\\Users\\leon\\log.txt'
        }
      ]
    })
    expect(snapshot.requiredFiles).toHaveLength(1)
    const file = snapshot.requiredFiles?.[0]
    expect(file?.displayName).toBe('Exportierte Logdatei')
    expect(file?.expectedFilename).toBe('log.txt')
    expect(file?.sha256).toBe('a'.repeat(64))
    expect(file?.isRequired).toBe(true)
    expect(file?.reuploadRequired).toBe(false)
    expect(file?.isSensitive).toBe(false)
    expect(file?.localPath).toBe('C:\\Users\\leon\\log.txt')
    expect(file?.snapshotId).toBe(snapshot.id)
    expect(file?.interventionRevisionId).toBeNull()
  })

  it('speichert mehrere Required Files in stabiler Reihenfolge', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const snapshot = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      requiredFiles: [{ displayName: 'Datei A' }, { displayName: 'Datei B' }, { displayName: 'Datei C' }]
    })
    expect(snapshot.requiredFiles?.map((f) => f.displayName)).toEqual(['Datei A', 'Datei B', 'Datei C'])
  })

  it('lehnt einen ungueltigen SHA-256-Wert ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    try {
      createDraftSnapshot(db, {
        projectId: project.id,
        sessionId: session.id,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        requiredFiles: [{ displayName: 'Datei', sha256: 'nicht-hex' }]
      })
      throw new Error('haette werfen muessen')
    } catch (err) {
      expect(err).toBeInstanceOf(ContinuationError)
      expect((err as ContinuationError).code).toBe('INVALID_SHA256')
    }
  })

  it('lehnt einen ungueltigen Pflichtwert ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const invalidFiles = [{ displayName: 'Datei', isRequired: 'ja' }] as unknown as RequiredFileInput[]
    try {
      createDraftSnapshot(db, {
        projectId: project.id,
        sessionId: session.id,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        requiredFiles: invalidFiles
      })
      throw new Error('haette werfen muessen')
    } catch (err) {
      expect(err).toBeInstanceOf(ContinuationError)
      expect((err as ContinuationError).code).toBe('INVALID_REQUIRED_FILE')
    }
  })

  it('lehnt einen ungueltigen Sensitivitaetswert ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const invalidFiles = [{ displayName: 'Datei', isSensitive: 'nein' }] as unknown as RequiredFileInput[]
    try {
      createDraftSnapshot(db, {
        projectId: project.id,
        sessionId: session.id,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        requiredFiles: invalidFiles
      })
      throw new Error('haette werfen muessen')
    } catch (err) {
      expect(err).toBeInstanceOf(ContinuationError)
      expect((err as ContinuationError).code).toBe('INVALID_REQUIRED_FILE')
    }
  })

  it('rollt vollstaendig zurueck, wenn ein Required File ungueltig ist - kein Snapshot, keine Teilzeile', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    expect(() =>
      createDraftSnapshot(db, {
        projectId: project.id,
        sessionId: session.id,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        requiredFiles: [{ displayName: 'Gueltige Datei' }, { displayName: 'Ungueltig', sha256: 'x' }]
      })
    ).toThrow(ContinuationError)

    const snapshotCount = db.prepare('SELECT COUNT(*) as c FROM continuation_snapshots').get() as { c: number }
    expect(snapshotCount.c).toBe(0)
    const fileCount = db.prepare('SELECT COUNT(*) as c FROM continuation_required_files').get() as { c: number }
    expect(fileCount.c).toBe(0)
  })

  it('setzt den Besitzer jeder gespeicherten Zeile immer auf den Snapshot, nie auf eine Intervention', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const snapshot = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      requiredFiles: [{ displayName: 'Datei' }]
    })
    const row = db
      .prepare('SELECT snapshot_id, intervention_revision_id FROM continuation_required_files WHERE id = ?')
      .get(snapshot.requiredFiles?.[0].id) as { snapshot_id: number | null; intervention_revision_id: number | null }
    expect(row.snapshot_id).toBe(snapshot.id)
    expect(row.intervention_revision_id).toBeNull()
  })
})

describe('confirmSnapshot', () => {
  it('bestaetigt einen Entwurf erfolgreich', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      currentTask: 'Entwurfsaufgabe',
      createdBy: 'LEON'
    })
    const confirmed = confirmSnapshot(db, { draftSnapshotId: draft.id, createdBy: 'LEON' })
    expect(confirmed.confirmationState).toBe('CONFIRMED')
    expect(confirmed.currentTask).toBe('Entwurfsaufgabe')
  })

  it('erzeugt eine neue Snapshot-Zeile mit korrekter Versionsnummer und derivedFromSnapshotId', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    const confirmed = confirmSnapshot(db, { draftSnapshotId: draft.id, createdBy: 'LEON' })
    expect(confirmed.id).not.toBe(draft.id)
    expect(confirmed.versionNumber).toBe(2)
    expect(confirmed.derivedFromSnapshotId).toBe(draft.id)
  })

  it('laesst den urspruenglichen Entwurf nach der Bestaetigung unveraendert', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      currentTask: 'Original',
      createdBy: 'LEON'
    })
    confirmSnapshot(db, { draftSnapshotId: draft.id, createdBy: 'LEON', corrections: { currentTask: 'Korrigiert' } })
    const reloadedDraft = getSnapshot(db, project.id, session.id, draft.id)
    expect(reloadedDraft).toEqual(draft)
    expect(reloadedDraft.currentTask).toBe('Original')
    expect(reloadedDraft.confirmationState).toBe('DRAFT')
  })

  it('uebernimmt Korrekturen in den bestaetigten Snapshot', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      confirmedDone: ['Altes Element'],
      createdBy: 'LEON'
    })
    const confirmed = confirmSnapshot(db, {
      draftSnapshotId: draft.id,
      createdBy: 'LEON',
      corrections: { confirmedDone: ['Neues Element'] }
    })
    expect(confirmed.confirmedDone).toEqual(['Neues Element'])
  })

  it('speichert Required Files des bestaetigten Snapshots korrekt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    const confirmed = confirmSnapshot(db, {
      draftSnapshotId: draft.id,
      createdBy: 'LEON',
      corrections: { requiredFiles: [{ displayName: 'Bestaetigte Datei' }] }
    })
    expect(confirmed.requiredFiles).toHaveLength(1)
    expect(confirmed.requiredFiles?.[0].displayName).toBe('Bestaetigte Datei')
    expect(confirmed.requiredFiles?.[0].snapshotId).toBe(confirmed.id)
  })

  it('lehnt die Bestaetigung eines bereits bestaetigten Snapshots ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    const confirmed = confirmSnapshot(db, { draftSnapshotId: draft.id, createdBy: 'LEON' })
    try {
      confirmSnapshot(db, { draftSnapshotId: confirmed.id, createdBy: 'LEON' })
      throw new Error('haette werfen muessen')
    } catch (err) {
      expect(err).toBeInstanceOf(ContinuationError)
      expect((err as ContinuationError).code).toBe('SNAPSHOT_ALREADY_CONFIRMED')
    }
  })

  it('lehnt eine zweite Bestaetigung desselben Entwurfs ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    confirmSnapshot(db, { draftSnapshotId: draft.id, createdBy: 'LEON' })
    try {
      confirmSnapshot(db, { draftSnapshotId: draft.id, createdBy: 'LEON' })
      throw new Error('haette werfen muessen')
    } catch (err) {
      expect(err).toBeInstanceOf(ContinuationError)
      expect((err as ContinuationError).code).toBe('SNAPSHOT_ALREADY_CONFIRMED')
    }
  })

  it('wirft SnapshotNotFoundError fuer einen unbekannten Entwurf', () => {
    const db = createTestDb()
    expect(() => confirmSnapshot(db, { draftSnapshotId: 9999, createdBy: 'LEON' })).toThrow(SnapshotNotFoundError)
  })

  it('rollt vollstaendig zurueck, wenn die Bestaetigung an sensiblen Inhalten scheitert', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
    expect(() =>
      confirmSnapshot(db, {
        draftSnapshotId: draft.id,
        createdBy: 'LEON',
        corrections: { currentTask: 'password: EchtesGeheimnis123' }
      })
    ).toThrow(ContinuationError)

    const count = db.prepare('SELECT COUNT(*) as c FROM continuation_snapshots').get() as { c: number }
    expect(count.c).toBe(1)
    const stillDraft = getSnapshot(db, project.id, session.id, draft.id)
    expect(stillDraft.confirmationState).toBe('DRAFT')
  })
})

describe('confirmSnapshot - Required-File-Vererbung', () => {
  it('uebernimmt die Required Files des Entwurfs, wenn corrections.requiredFiles fehlt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      requiredFiles: [{ displayName: 'Datei A' }, { displayName: 'Datei B' }]
    })
    const confirmed = confirmSnapshot(db, { draftSnapshotId: draft.id, createdBy: 'LEON' })

    expect(confirmed.requiredFiles?.map((f) => f.displayName)).toEqual(['Datei A', 'Datei B'])
    expect(confirmed.requiredFiles?.every((f) => f.snapshotId === confirmed.id)).toBe(true)

    const draftIds = draft.requiredFiles?.map((f) => f.id) ?? []
    const confirmedIds = confirmed.requiredFiles?.map((f) => f.id) ?? []
    expect(confirmedIds.some((id) => draftIds.includes(id))).toBe(false)

    const reloadedDraft = getSnapshot(db, project.id, session.id, draft.id)
    expect(reloadedDraft.requiredFiles).toEqual(draft.requiredFiles)
  })

  it('uebernimmt Required Files auch dann, wenn ausschliesslich andere Felder korrigiert werden', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      requiredFiles: [{ displayName: 'Datei A' }]
    })
    const confirmed = confirmSnapshot(db, {
      draftSnapshotId: draft.id,
      createdBy: 'LEON',
      corrections: { currentTask: 'Korrigierte Aufgabe' }
    })
    expect(confirmed.currentTask).toBe('Korrigierte Aufgabe')
    expect(confirmed.requiredFiles?.map((f) => f.displayName)).toEqual(['Datei A'])
  })

  it('ersetzt die Entwurfsliste vollstaendig, wenn corrections.requiredFiles neue Eintraege enthaelt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      requiredFiles: [{ displayName: 'Datei A' }, { displayName: 'Datei B' }]
    })
    const confirmed = confirmSnapshot(db, {
      draftSnapshotId: draft.id,
      createdBy: 'LEON',
      corrections: { requiredFiles: [{ displayName: 'Datei C' }] }
    })
    expect(confirmed.requiredFiles?.map((f) => f.displayName)).toEqual(['Datei C'])

    const reloadedDraft = getSnapshot(db, project.id, session.id, draft.id)
    expect(reloadedDraft.requiredFiles?.map((f) => f.displayName)).toEqual(['Datei A', 'Datei B'])
  })

  it('entfernt die Required Files des bestaetigten Snapshots bei ausdruecklich leerem Array', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      requiredFiles: [{ displayName: 'Datei A' }]
    })
    const confirmed = confirmSnapshot(db, {
      draftSnapshotId: draft.id,
      createdBy: 'LEON',
      corrections: { requiredFiles: [] }
    })
    expect(confirmed.requiredFiles).toEqual([])

    const reloadedDraft = getSnapshot(db, project.id, session.id, draft.id)
    expect(reloadedDraft.requiredFiles?.map((f) => f.displayName)).toEqual(['Datei A'])
  })

  it('rollt vollstaendig zurueck, wenn die Ersatzliste einen ungueltigen Eintrag enthaelt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const draft = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      requiredFiles: [{ displayName: 'Datei A' }]
    })

    expect(() =>
      confirmSnapshot(db, {
        draftSnapshotId: draft.id,
        createdBy: 'LEON',
        corrections: { requiredFiles: [{ displayName: 'Ungueltig', sha256: 'nicht-hex' }] }
      })
    ).toThrow(ContinuationError)

    const confirmedCount = db
      .prepare("SELECT COUNT(*) as c FROM continuation_snapshots WHERE confirmation_state = 'CONFIRMED'")
      .get() as { c: number }
    expect(confirmedCount.c).toBe(0)

    const reloadedDraft = getSnapshot(db, project.id, session.id, draft.id)
    expect(reloadedDraft).toEqual(draft)
    expect(reloadedDraft.requiredFiles?.map((f) => f.displayName)).toEqual(['Datei A'])
  })
})

describe('Sensible Inhalte - erkannte Muster', () => {
  function expectRejected(currentTask: string) {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    let caught: unknown = null
    try {
      createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', currentTask, createdBy: 'LEON' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ContinuationError)
    expect((caught as ContinuationError).code).toBe('SENSITIVE_CONTENT_DETECTED')
    expect((caught as ContinuationError).message).not.toContain(currentTask)
    const count = db.prepare('SELECT COUNT(*) as c FROM continuation_snapshots').get() as { c: number }
    expect(count.c).toBe(0)
    return caught as ContinuationError
  }

  it('lehnt einen Private-Key-Block ab', () => {
    expectRejected('-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEpQIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----')
  })

  it('lehnt einen Authorization-Header ab', () => {
    expectRejected('Authorization: Bearer abcdefghijklmnop1234567890')
  })

  it('lehnt einen blossen Bearer-Token ab', () => {
    expectRejected('Bitte folgenden Header verwenden: Bearer abcdefghijklmnopqrstuvwxyz123456')
  })

  it('lehnt eine Passwortzuweisung ab', () => {
    expectRejected('password: EchtesGeheimnis123')
  })

  it('lehnt eine API-Key-Zuweisung ab', () => {
    expectRejected('api_' + 'key: mEchterSchluesselWert987')
  })

  it('lehnt eine Environment-Zuweisung mit sensiblem Namen ab', () => {
    expectRejected('CLIENT_SECRET=echtesGeheimnisAbc123')
  })

  it('lehnt ein markantes bekanntes Token-Praefix ab', () => {
    expectRejected('Zugangsdaten: sk-' + 'abcdefghijklmnopqrstuvwx')
  })

  it('enthaelt den tatsaechlichen Secret-Wert niemals in der Fehlermeldung', () => {
    const error = expectRejected('password: NiemalsSichtbaresGeheimnis999')
    expect(error.message).not.toContain('NiemalsSichtbaresGeheimnis999')
  })
})

describe('Sensible Inhalte - erlaubte, harmlose Werte', () => {
  function expectAllowed(currentTask: string) {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id)
    const snapshot = createDraftSnapshot(db, {
      projectId: project.id,
      sessionId: session.id,
      provider: 'CHATGPT',
      currentTask,
      createdBy: 'LEON'
    })
    expect(snapshot.currentTask).toBe(currentTask)
  }

  it('erlaubt einen SHA-256-Wert', () => {
    expectAllowed(`Referenz-Hash: ${'a'.repeat(64)}`)
  })

  it('erlaubt einen Windows-Pfad', () => {
    expectAllowed('Datei liegt unter C:\\Users\\leon\\Dokumente\\projekt\\datei.txt')
  })

  it('erlaubt einen Unix-Pfad', () => {
    expectAllowed('Datei liegt unter /home/user/projekte/datei.txt')
  })

  it('erlaubt einen normalen Dateinamen', () => {
    expectAllowed('Siehe EclipseProjectHub-Milestone2.1-Verified-20260803-Normalized.zip')
  })

  it('erlaubt eine harmlose lange ID', () => {
    expectAllowed('Ticket-Referenz: 550e8400-e29b-41d4-a716-446655440000')
  })

  it('erlaubt einen klar erkennbaren Platzhalterwert', () => {
    expectAllowed('Konfiguration: API_KEY=<SET_LOCALLY> und token: <TOKEN>')
  })

  it('erlaubt das normale Wort "token" ohne Zuweisung', () => {
    expectAllowed('Wir muessen das Token-System noch dokumentieren.')
  })

  it('erlaubt Dokumentation ueber Secrets ohne tatsaechlichen Wert', () => {
    expectAllowed('Erinnerung: Passwoerter und API-Schluessel duerfen nie im Klartext gespeichert werden.')
  })

  it('erlaubt Quellcode-Bezeichner wie tokenCount oder passwordField', () => {
    expectAllowed('Im Code: const tokenCount = 5; interface Foo { passwordField: string }')
  })
})
