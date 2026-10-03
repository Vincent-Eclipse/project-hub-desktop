import { describe, expect, it } from 'vitest'
import { createTestDb } from '../testUtils/testDb'
import {
  getRoleTemplateOverride,
  getSettings,
  setRoleTemplateOverride,
  updateSettings
} from './settingsService'
import { DEFAULT_CHATGPT_TEMPLATE } from '@shared/promptTemplates'
import { createProject, archiveProject, ProjectArchivedError } from './projectsService'
import { listEventLog } from './eventLogService'

describe('settingsService', () => {
  it('liefert sinnvolle Standardwerte, wenn noch nichts gespeichert wurde', () => {
    const db = createTestDb()
    const settings = getSettings(db)
    expect(settings.chatgptUrl).toBe('https://chat.openai.com')
    expect(settings.chatgptGlobalTemplate).toBe(DEFAULT_CHATGPT_TEMPLATE)
  })

  it('aktualisiert nur die uebergebenen Felder', () => {
    const db = createTestDb()
    updateSettings(db, { chatgptUrl: 'https://example-chatgpt.test' })
    const settings = getSettings(db)
    expect(settings.chatgptUrl).toBe('https://example-chatgpt.test')
    expect(settings.claudeUrl).toBe('https://claude.ai') // unveraendert
  })

  it('schreibt ein SETTINGS_UPDATED-Ereignis mit den geaenderten Schluesselnamen, ohne Vorlagen-Inhalte', () => {
    const db = createTestDb()
    updateSettings(db, { chatgptGlobalTemplate: 'Ein sehr langer geheimer Vorlagentext' })
    const events = listEventLog(db, { type: 'SETTINGS_UPDATED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload.changedKeys).toEqual(['chatgptGlobalTemplate'])
    expect(JSON.stringify(events[0].payload)).not.toContain('geheimer Vorlagentext')
  })

  it('role template override: null loescht das Override wieder', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
    setRoleTemplateOverride(db, project.id, 'CLAUDE', 'Individuelle Vorlage')
    expect(getRoleTemplateOverride(db, project.id, 'CLAUDE')).toBe('Individuelle Vorlage')

    setRoleTemplateOverride(db, project.id, 'CLAUDE', null)
    expect(getRoleTemplateOverride(db, project.id, 'CLAUDE')).toBeNull()
  })

  it('schreibt ein ROLE_OVERRIDE_UPDATED-Ereignis fuer das Projekt', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
    setRoleTemplateOverride(db, project.id, 'CHATGPT', 'Individuelle Vorlage')
    const events = listEventLog(db, { projectId: project.id, type: 'ROLE_OVERRIDE_UPDATED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload.role).toBe('CHATGPT')
  })

  describe('Archiv-Schreibschutz fuer Rollen-Overrides', () => {
    it('erlaubt das Setzen eines Overrides bei einem aktiven Projekt', () => {
      const db = createTestDb()
      const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
      expect(() => setRoleTemplateOverride(db, project.id, 'CLAUDE', 'Aktiv-Vorlage')).not.toThrow()
      expect(getRoleTemplateOverride(db, project.id, 'CLAUDE')).toBe('Aktiv-Vorlage')
    })

    it('erlaubt das Loeschen eines Overrides bei einem aktiven Projekt', () => {
      const db = createTestDb()
      const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
      setRoleTemplateOverride(db, project.id, 'CLAUDE', 'Aktiv-Vorlage')
      expect(() => setRoleTemplateOverride(db, project.id, 'CLAUDE', null)).not.toThrow()
      expect(getRoleTemplateOverride(db, project.id, 'CLAUDE')).toBeNull()
    })

    it('lehnt das Setzen eines Overrides bei einem archivierten Projekt ab', () => {
      const db = createTestDb()
      const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
      archiveProject(db, project.id)
      expect(() => setRoleTemplateOverride(db, project.id, 'CLAUDE', 'Sollte fehlschlagen')).toThrow(
        ProjectArchivedError
      )
    })

    it('lehnt das Loeschen eines Overrides bei einem archivierten Projekt ab', () => {
      const db = createTestDb()
      const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
      setRoleTemplateOverride(db, project.id, 'CLAUDE', 'Vor dem Archivieren gesetzt')
      archiveProject(db, project.id)
      expect(() => setRoleTemplateOverride(db, project.id, 'CLAUDE', null)).toThrow(ProjectArchivedError)
    })

    it('laesst ein bestehendes Override unveraendert, wenn die Aenderung abgelehnt wird', () => {
      const db = createTestDb()
      const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
      setRoleTemplateOverride(db, project.id, 'CLAUDE', 'Original-Vorlage')
      archiveProject(db, project.id)

      const eventsBefore = listEventLog(db, { projectId: project.id, type: 'ROLE_OVERRIDE_UPDATED' })

      expect(() => setRoleTemplateOverride(db, project.id, 'CLAUDE', 'Neuer Versuch')).toThrow(
        ProjectArchivedError
      )
      expect(getRoleTemplateOverride(db, project.id, 'CLAUDE')).toBe('Original-Vorlage')

      const eventsAfter = listEventLog(db, { projectId: project.id, type: 'ROLE_OVERRIDE_UPDATED' })
      expect(eventsAfter).toHaveLength(eventsBefore.length)
    })
  })
})
