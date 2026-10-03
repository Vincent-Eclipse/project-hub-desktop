import { describe, expect, it } from 'vitest'
import { createTestDb } from '../testUtils/testDb'
import { logEvent, listEventLog } from './eventLogService'

/**
 * Legt einen minimalen Projekt-Datensatz DIREKT per SQL an, ohne
 * projectsService.createProject() zu verwenden. createProject() schreibt
 * absichtlich und korrekt automatisch ein PROJECT_CREATED-Ereignis in das
 * Event-Log (siehe projectsService.test.ts fuer den dazugehoerigen Test) -
 * fuer diese Testdatei, die ausschliesslich eventLogService isoliert
 * pruefen soll, wuerde das jeden Event-Log-Test um ein zusaetzliches,
 * fachlich nicht relevantes Ereignis verfaelschen. Nur die fuer die
 * Fremdschluessel-Constraint mindestens erforderlichen Felder werden
 * gesetzt, der Rest nutzt die Schema-Defaults.
 */
function insertProjectFixture(db: ReturnType<typeof createTestDb>): number {
  const result = db
    .prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)')
    .run('Projekt', 'projekt', 'Typ')
  return Number(result.lastInsertRowid)
}

describe('eventLogService', () => {
  it('speichert und liest ein Ereignis inklusive Payload zurueck', () => {
    const db = createTestDb()
    const projectId = insertProjectFixture(db)
    logEvent(db, { projectId, type: 'PROJECT_UPDATED', payload: { changedFields: ['name'] } })

    const events = listEventLog(db, { projectId })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('PROJECT_UPDATED')
    expect(events[0].payload).toEqual({ changedFields: ['name'] })
  })

  it('erlaubt project_id = null fuer globale Ereignisse (z. B. Einstellungen)', () => {
    const db = createTestDb()
    logEvent(db, { projectId: null, type: 'SETTINGS_UPDATED', payload: { changedKeys: ['chatgptUrl'] } })
    const events = listEventLog(db, { type: 'SETTINGS_UPDATED' })
    expect(events).toHaveLength(1)
    expect(events[0].projectId).toBeNull()
  })

  it('filtert nach Ereignistyp', () => {
    const db = createTestDb()
    const projectId = insertProjectFixture(db)
    logEvent(db, { projectId, type: 'PROJECT_UPDATED', payload: {} })
    logEvent(db, { projectId, type: 'CHAT_MESSAGE_ADDED', payload: {} })

    expect(listEventLog(db, { projectId, type: 'PROJECT_UPDATED' })).toHaveLength(1)
    expect(listEventLog(db, { projectId })).toHaveLength(2)
  })

  it('liefert eine leere Liste, wenn nichts protokolliert wurde', () => {
    const db = createTestDb()
    expect(listEventLog(db)).toEqual([])
  })

  it('speichert ungueltiges JSON nicht - payload wird immer als valides JSON serialisiert/deserialisiert', () => {
    const db = createTestDb()
    logEvent(db, { projectId: null, type: 'PROJECT_CREATED', payload: { nested: { a: 1, b: [1, 2, 3] } } })
    const events = listEventLog(db)
    expect(events[0].payload).toEqual({ nested: { a: 1, b: [1, 2, 3] } })
  })
})
