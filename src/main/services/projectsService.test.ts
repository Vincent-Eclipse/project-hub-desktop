import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDb } from '../testUtils/testDb'
import {
  DuplicateFolderError,
  ProjectArchivedError,
  ProjectNotFoundError,
  archiveProject,
  createProject,
  getProjectById,
  getProjectFolderStatus,
  listProjects,
  restoreProject,
  updateProject
} from './projectsService'
import { listEventLog } from './eventLogService'
import { FolderNotFoundError } from '../pathNormalization'

describe('projectsService - Grundfelder', () => {
  it('legt ein Projekt mit allen verbindlichen Feldern an', () => {
    const db = createTestDb()
    const project = createProject(db, {
      name: 'Airport Career',
      projectType: 'Roblox',
      description: 'Roblox-Tycoon-Projekt',
      status: 'PAUSED',
      currentStep: 'Schritt 7 - ManagerCardSystem Basis',
      nextActor: 'LEON',
      nextAction: 'Warten auf Wiederaufnahme'
    })

    expect(project.slug).toBe('airport-career')
    expect(project.projectType).toBe('Roblox')
    expect(project.status).toBe('PAUSED')
    expect(project.currentStep).toBe('Schritt 7 - ManagerCardSystem Basis')
    expect(project.nextActor).toBe('LEON')
    expect(project.nextAction).toBe('Warten auf Wiederaufnahme')
    expect(project.folderPath).toBeNull()
    expect(project.isArchived).toBe(false)
    expect(project.archivedAt).toBeNull()
  })

  it('verwendet sinnvolle Standardwerte, wenn optionale Felder fehlen', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Atlas', projectType: 'Sonstiges', description: '' })
    expect(project.status).toBe('PLANNING')
    expect(project.nextActor).toBe('LEON')
    expect(project.currentStep).toBe('')
    expect(project.nextAction).toBe('')
  })

  it('zwei Projekte mit unterschiedlichen Namen bleiben strikt getrennt', () => {
    const db = createTestDb()
    const a = createProject(db, { name: 'Airport Career', projectType: 'Roblox', description: '' })
    const b = createProject(db, { name: 'Atlas', projectType: 'Sonstiges', description: '' })
    expect(a.id).not.toBe(b.id)
    expect(a.slug).not.toBe(b.slug)
    const all = listProjects(db, true)
    expect(all.map((p) => p.name).sort()).toEqual(['Airport Career', 'Atlas'])
  })

  it('schreibt ein PROJECT_CREATED-Ereignis in das Event-Log', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Airport Career', projectType: 'Roblox', description: '' })
    const events = listEventLog(db, { projectId: project.id })
    expect(events.some((e) => e.type === 'PROJECT_CREATED')).toBe(true)
  })
})

describe('projectsService - Archivierung ueber archived_at', () => {
  it('listProjects blendet archivierte Projekte standardmaessig aus', () => {
    const db = createTestDb()
    const p1 = createProject(db, { name: 'Projekt A', projectType: 'Typ', description: '' })
    createProject(db, { name: 'Projekt B', projectType: 'Typ', description: '' })
    archiveProject(db, p1.id)

    const activeOnly = listProjects(db, false)
    expect(activeOnly.map((p) => p.name)).toEqual(['Projekt B'])

    const all = listProjects(db, true)
    expect(all).toHaveLength(2)
  })

  it('archiveProject setzt archived_at auf einen Zeitstempel, isArchived wird true', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
    const archived = archiveProject(db, project.id)
    expect(archived.archivedAt).not.toBeNull()
    expect(archived.isArchived).toBe(true)
  })

  it('restoreProject setzt archived_at zurueck auf null', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
    archiveProject(db, project.id)
    const restored = restoreProject(db, project.id)
    expect(restored.archivedAt).toBeNull()
    expect(restored.isArchived).toBe(false)
  })

  it('getProjectById wirft ProjectNotFoundError fuer unbekannte IDs', () => {
    const db = createTestDb()
    expect(() => getProjectById(db, 999)).toThrow(ProjectNotFoundError)
  })

  it('archivierte Projekte sind schreibgeschuetzt (updateProject wirft ProjectArchivedError)', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Airport Career', projectType: 'Roblox', description: '' })
    archiveProject(db, project.id)
    expect(() => updateProject(db, { id: project.id, name: 'Neuer Name' })).toThrow(ProjectArchivedError)
  })

  it('archivieren/wiederherstellen loescht und veraendert keine anderen Felder', () => {
    const db = createTestDb()
    const project = createProject(db, {
      name: 'Wird archiviert',
      projectType: 'Roblox',
      description: 'Bleibt erhalten',
      currentStep: 'Schritt 5'
    })
    const archived = archiveProject(db, project.id)
    expect(archived.name).toBe('Wird archiviert')
    expect(archived.description).toBe('Bleibt erhalten')
    expect(archived.currentStep).toBe('Schritt 5')

    const restored = restoreProject(db, project.id)
    expect(restored.name).toBe('Wird archiviert')
    expect(restored.currentStep).toBe('Schritt 5')
  })
})

describe('projectsService - Slug bleibt bei Umbenennung stabil', () => {
  it('updateProject aendert den slug NICHT, auch wenn sich der Name aendert', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Airport Career', projectType: 'Roblox', description: '' })
    const updated = updateProject(db, { id: project.id, name: 'Airport Career Neu' })
    expect(updated.name).toBe('Airport Career Neu')
    expect(updated.slug).toBe('airport-career')
  })
})

describe('projectsService - Projektordner', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-projects-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('akzeptiert einen existierenden Ordner beim Anlegen', () => {
    const db = createTestDb()
    const project = createProject(db, {
      name: 'Airport Career',
      projectType: 'Roblox',
      description: '',
      folderPath: tmpDir
    })
    expect(project.folderPath).not.toBeNull()
    expect(project.folderComparisonKey).not.toBeNull()
  })

  it('lehnt einen nicht existierenden Ordner ab', () => {
    const db = createTestDb()
    const missing = path.join(tmpDir, 'existiert-nicht')
    expect(() =>
      createProject(db, { name: 'Projekt', projectType: 'Typ', description: '', folderPath: missing })
    ).toThrow(FolderNotFoundError)
  })

  it('verhindert, dass zwei Projekte denselben Ordner verwenden', () => {
    const db = createTestDb()
    createProject(db, { name: 'Projekt A', projectType: 'Typ', description: '', folderPath: tmpDir })
    expect(() =>
      createProject(db, { name: 'Projekt B', projectType: 'Typ', description: '', folderPath: tmpDir })
    ).toThrow(DuplicateFolderError)
  })

  it('erkennt denselben Windows-Ordner in unterschiedlicher Schreibweise als Duplikat (simuliert ueber Vergleichsschluessel-Kollision ist hier nicht direkt pruefbar, da echte fs-Aufrufe genutzt werden - siehe pathNormalization.test.ts fuer die reine Normalisierungslogik)', () => {
    const db = createTestDb()
    createProject(db, { name: 'Projekt A', projectType: 'Typ', description: '', folderPath: tmpDir })
    // Trailing separator sollte denselben Ordner ergeben.
    expect(() =>
      createProject(db, {
        name: 'Projekt B',
        projectType: 'Typ',
        description: '',
        folderPath: tmpDir + path.sep
      })
    ).toThrow(DuplicateFolderError)
  })

  it('erlaubt ein Projekt ohne Ordner weiterhin', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
    expect(project.folderPath).toBeNull()
    expect(project.folderComparisonKey).toBeNull()
  })

  it('updateProject kann den Ordner setzen, aendern und wieder entfernen', () => {
    const db = createTestDb()
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-projects-test-2-'))
    try {
      const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
      const withFolder = updateProject(db, { id: project.id, folderPath: tmpDir })
      expect(withFolder.folderPath).not.toBeNull()

      const changed = updateProject(db, { id: project.id, folderPath: otherDir })
      expect(changed.folderPath).toContain(path.basename(otherDir))

      const removed = updateProject(db, { id: project.id, folderPath: null })
      expect(removed.folderPath).toBeNull()
      expect(removed.folderComparisonKey).toBeNull()
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('das erneute Setzen des eigenen bereits zugewiesenen Ordners blockiert sich nicht selbst', () => {
    const db = createTestDb()
    const project = createProject(db, {
      name: 'Projekt',
      projectType: 'Typ',
      description: '',
      folderPath: tmpDir
    })
    // Die Duplikat-Pruefung schliesst das eigene Projekt aus - erneutes
    // Setzen desselben Ordners auf sich selbst darf nicht als Duplikat gelten.
    expect(() => updateProject(db, { id: project.id, folderPath: tmpDir })).not.toThrow()
  })
})

describe('projectsService - Projektordner-Status (RC4)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-folder-status-service-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('NOT_CONFIGURED, wenn kein Ordner gesetzt ist', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
    expect(getProjectFolderStatus(db, project.id)).toBe('NOT_CONFIGURED')
  })

  it('AVAILABLE, wenn der gespeicherte Ordner tatsaechlich existiert', () => {
    const db = createTestDb()
    const project = createProject(db, {
      name: 'Projekt',
      projectType: 'Typ',
      description: '',
      folderPath: tmpDir
    })
    expect(getProjectFolderStatus(db, project.id)).toBe('AVAILABLE')
  })

  it('MISSING, wenn der Ordner nach dem Speichern geloescht wurde', () => {
    const db = createTestDb()
    const project = createProject(db, {
      name: 'Projekt',
      projectType: 'Typ',
      description: '',
      folderPath: tmpDir
    })
    fs.rmSync(tmpDir, { recursive: true, force: true })
    expect(getProjectFolderStatus(db, project.id)).toBe('MISSING')
  })

  it('INVALID, wenn an der gespeicherten Stelle inzwischen eine Datei statt eines Ordners liegt', () => {
    const db = createTestDb()
    const project = createProject(db, {
      name: 'Projekt',
      projectType: 'Typ',
      description: '',
      folderPath: tmpDir
    })
    // Simuliert "Ordner wurde durch eine gleichnamige Datei ersetzt": Ordner
    // entfernen und stattdessen eine Datei mit demselben Pfad anlegen.
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.writeFileSync(tmpDir, 'jetzt eine Datei')
    try {
      expect(getProjectFolderStatus(db, project.id)).toBe('INVALID')
    } finally {
      fs.rmSync(tmpDir, { force: true })
    }
  })

  it('die Statusabfrage selbst veraendert das Projekt nicht (reine Abfrage)', () => {
    const db = createTestDb()
    const project = createProject(db, {
      name: 'Projekt',
      projectType: 'Typ',
      description: '',
      folderPath: tmpDir
    })
    const before = getProjectById(db, project.id)
    getProjectFolderStatus(db, project.id)
    const after = getProjectById(db, project.id)
    expect(after).toEqual(before)
  })

  it('wirft ProjectNotFoundError fuer eine unbekannte projectId', () => {
    const db = createTestDb()
    expect(() => getProjectFolderStatus(db, 999)).toThrow(ProjectNotFoundError)
  })
})
