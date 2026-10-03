import { describe, expect, it } from 'vitest'
import { createTestDb } from '../testUtils/testDb'
import { createProject, getProjectById, archiveProject } from './projectsService'
import {
  ContextIntegrityError,
  ContextVersionMismatchError,
  ProjectArchivedForContextError,
  createContextVersion,
  getContextDiffForProject,
  getContextVersionForProject,
  getCurrentContextVersion,
  listContextVersions
} from './contextService'
import { listEventLog } from './eventLogService'

function newProject(db: ReturnType<typeof createTestDb>, name = 'Projekt') {
  return createProject(db, { name, projectType: 'Typ', description: '' })
}

describe('contextService', () => {
  it('die erste Version bekommt Versionsnummer 1, einen Ersteller und wird zur aktuellen Version', () => {
    const db = createTestDb()
    const project = newProject(db)
    const version = createContextVersion(db, {
      projectId: project.id,
      contentMarkdown: '# Start',
      createdBy: 'LEON'
    })
    expect(version.versionNumber).toBe(1)
    expect(version.createdBy).toBe('LEON')

    const updatedProject = getProjectById(db, project.id)
    expect(updatedProject.currentContextVersionId).toBe(version.id)
    expect(updatedProject.currentContextVersionNumber).toBe(1)
  })

  it('erlaubt CHATGPT, CLAUDE und SYSTEM als Ersteller einer Version', () => {
    const db = createTestDb()
    const project = newProject(db)
    for (const author of ['CHATGPT', 'CLAUDE', 'SYSTEM'] as const) {
      const version = createContextVersion(db, {
        projectId: project.id,
        contentMarkdown: `Von ${author}`,
        createdBy: author
      })
      expect(version.createdBy).toBe(author)
    }
  })

  it('ist append-only: eine neue Version ueberschreibt keine alte, Historie bleibt vollstaendig', () => {
    const db = createTestDb()
    const project = newProject(db)
    createContextVersion(db, { projectId: project.id, contentMarkdown: 'Version 1', createdBy: 'LEON' })
    createContextVersion(db, { projectId: project.id, contentMarkdown: 'Version 2', createdBy: 'LEON' })
    createContextVersion(db, { projectId: project.id, contentMarkdown: 'Version 3', createdBy: 'LEON' })

    const versions = listContextVersions(db, project.id)
    expect(versions).toHaveLength(3)
    expect(versions.map((v) => v.contentMarkdown)).toEqual(['Version 3', 'Version 2', 'Version 1'])
    expect(versions.map((v) => v.versionNumber)).toEqual([3, 2, 1])
  })

  it('vergibt Versionsnummern sequentiell 1, 2, 3 ...', () => {
    const db = createTestDb()
    const project = newProject(db)
    const v1 = createContextVersion(db, { projectId: project.id, contentMarkdown: 'A', createdBy: 'LEON' })
    const v2 = createContextVersion(db, { projectId: project.id, contentMarkdown: 'B', createdBy: 'LEON' })
    const v3 = createContextVersion(db, { projectId: project.id, contentMarkdown: 'C', createdBy: 'LEON' })
    expect([v1.versionNumber, v2.versionNumber, v3.versionNumber]).toEqual([1, 2, 3])
  })

  it('bestimmt die naechste Versionsnummer ueber MAX(version_number), nicht ueber einen Zaehler', () => {
    // Simuliert einen Zustand, in dem project.current_context_version_id NICHT
    // auf die zuletzt angelegte Version zeigt (z.B. durch aeltere/kaputte
    // Daten) - die naechste Versionsnummer muss trotzdem korrekt aus der
    // project_context_versions-Tabelle selbst berechnet werden.
    const db = createTestDb()
    const project = newProject(db)
    const v1 = createContextVersion(db, { projectId: project.id, contentMarkdown: 'A', createdBy: 'LEON' })
    createContextVersion(db, { projectId: project.id, contentMarkdown: 'B', createdBy: 'LEON' })

    // current_context_version_id absichtlich auf die AELTERE Version
    // "zurueckbiegen", um einen veralteten/kaputten Zustand zu simulieren.
    db.prepare('UPDATE projects SET current_context_version_id = ? WHERE id = ?').run(v1.id, project.id)

    const v3 = createContextVersion(db, { projectId: project.id, contentMarkdown: 'C', createdBy: 'LEON' })
    expect(v3.versionNumber).toBe(3)
  })

  it('"aktuell" bedeutet immer die hoechste Versionsnummer', () => {
    const db = createTestDb()
    const project = newProject(db)
    createContextVersion(db, { projectId: project.id, contentMarkdown: 'Alt', createdBy: 'LEON' })
    createContextVersion(db, { projectId: project.id, contentMarkdown: 'Neu', createdBy: 'LEON' })

    const current = getCurrentContextVersion(db, project.id)
    expect(current?.contentMarkdown).toBe('Neu')
    expect(current?.versionNumber).toBe(2)
  })

  it('das blosse Anzeigen (Abrufen) einer alten Version veraendert die aktuelle Version NICHT', () => {
    const db = createTestDb()
    const project = newProject(db)
    const v1 = createContextVersion(db, { projectId: project.id, contentMarkdown: 'Alt', createdBy: 'LEON' })
    createContextVersion(db, { projectId: project.id, contentMarkdown: 'Neu', createdBy: 'LEON' })

    // Alte Version mehrfach lesend abrufen ("anklicken und anzeigen")
    getContextVersionForProject(db, project.id, v1.id)
    getContextVersionForProject(db, project.id, v1.id)

    const current = getCurrentContextVersion(db, project.id)
    expect(current?.contentMarkdown).toBe('Neu')
    expect(current?.versionNumber).toBe(2)
  })

  it('gibt null zurueck, wenn noch keine Version existiert', () => {
    const db = createTestDb()
    const project = newProject(db)
    expect(getCurrentContextVersion(db, project.id)).toBeNull()
  })

  it('verhindert neue Kontext-Versionen fuer archivierte Projekte', () => {
    const db = createTestDb()
    const project = newProject(db)
    archiveProject(db, project.id)
    expect(() =>
      createContextVersion(db, { projectId: project.id, contentMarkdown: 'Sollte fehlschlagen', createdBy: 'LEON' })
    ).toThrow(ProjectArchivedForContextError)
  })

  it('schreibt ein CONTEXT_VERSION_CREATED-Ereignis ohne den vollen Inhalt im Payload', () => {
    const db = createTestDb()
    const project = newProject(db)
    createContextVersion(db, {
      projectId: project.id,
      contentMarkdown: 'Sehr langer, sensibler Kontext-Inhalt der nicht geloggt werden soll',
      createdBy: 'LEON'
    })
    const events = listEventLog(db, { projectId: project.id, type: 'CONTEXT_VERSION_CREATED' })
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events[0].payload)).not.toContain('sensibler Kontext-Inhalt')
    expect(events[0].payload.versionNumber).toBe(1)
  })

  describe('projektspezifische Zuordnung (getContextVersionForProject)', () => {
    it('liefert eine Version, die tatsaechlich zum angegebenen Projekt gehoert', () => {
      const db = createTestDb()
      const project = newProject(db)
      const version = createContextVersion(db, { projectId: project.id, contentMarkdown: 'A', createdBy: 'LEON' })
      const loaded = getContextVersionForProject(db, project.id, version.id)
      expect(loaded.id).toBe(version.id)
    })

    it('lehnt eine Version ab, die zu einem ANDEREN Projekt gehoert', () => {
      const db = createTestDb()
      const projectA = newProject(db, 'Projekt A')
      const projectB = newProject(db, 'Projekt B')
      const versionOfA = createContextVersion(db, {
        projectId: projectA.id,
        contentMarkdown: 'Nur fuer A',
        createdBy: 'LEON'
      })

      expect(() => getContextVersionForProject(db, projectB.id, versionOfA.id)).toThrow(
        ContextVersionMismatchError
      )
    })
  })

  describe('projektspezifischer Diff (getContextDiffForProject)', () => {
    it('vergleicht zwei Versionen desselben Projekts erfolgreich', () => {
      const db = createTestDb()
      const project = newProject(db)
      const v1 = createContextVersion(db, { projectId: project.id, contentMarkdown: 'Zeile 1', createdBy: 'LEON' })
      const v2 = createContextVersion(db, {
        projectId: project.id,
        contentMarkdown: 'Zeile 1\nZeile 2',
        createdBy: 'LEON'
      })

      const diff = getContextDiffForProject(db, project.id, v1.id, v2.id)
      expect(diff.some((line) => line.type === 'added')).toBe(true)
    })

    it('lehnt einen Diff ueber zwei VERSCHIEDENE Projekte hinweg ab', () => {
      const db = createTestDb()
      const projectA = newProject(db, 'Projekt A')
      const projectB = newProject(db, 'Projekt B')
      const versionOfA = createContextVersion(db, { projectId: projectA.id, contentMarkdown: 'A', createdBy: 'LEON' })
      const versionOfB = createContextVersion(db, { projectId: projectB.id, contentMarkdown: 'B', createdBy: 'LEON' })

      expect(() => getContextDiffForProject(db, projectA.id, versionOfA.id, versionOfB.id)).toThrow(
        ContextVersionMismatchError
      )
    })
  })

  describe('Integritaetspruefung von current_context_version_id (getCurrentContextVersion)', () => {
    it('erkennt eine current_context_version_id, die auf eine FREMDE Projekt-Version zeigt', () => {
      const db = createTestDb()
      const projectA = newProject(db, 'Projekt A')
      const projectB = newProject(db, 'Projekt B')
      const versionOfB = createContextVersion(db, { projectId: projectB.id, contentMarkdown: 'B', createdBy: 'LEON' })

      // Direkter, bewusst fehlerhafter DB-Zustand: projectA zeigt auf eine
      // Version von projectB - das kann die FK-Constraint allein nicht
      // verhindern (sie garantiert nur Existenz, nicht Projektzugehoerigkeit).
      db.prepare('UPDATE projects SET current_context_version_id = ? WHERE id = ?').run(
        versionOfB.id,
        projectA.id
      )

      expect(() => getCurrentContextVersion(db, projectA.id)).toThrow(ContextIntegrityError)
    })
  })
})
