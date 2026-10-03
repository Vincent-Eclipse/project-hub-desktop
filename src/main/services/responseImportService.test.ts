import { describe, expect, it } from 'vitest'
import { createTestDb } from '../testUtils/testDb'
import { createProject, archiveProject, getProjectById } from './projectsService'
import { createContextVersion, listContextVersions } from './contextService'
import { listChatMessages } from './chatService'
import { listEventLog } from './eventLogService'
import { analyzeResponseImport, applyResponseImport, getResponseImportById } from './responseImportService'
import { ResponseImportError } from './responseImportErrors'
import { createSession } from './sessionService'
import type { ResponseImportSelectedActions } from '@shared/types'
import { createRuleVersion, listRuleVersions } from './rulesService'

function newProject(db: ReturnType<typeof createTestDb>, name = 'Projekt') {
  return createProject(db, { name, projectType: 'Typ', description: '' })
}

const NO_ACTIONS: ResponseImportSelectedActions = {
  saveHistory: false,
  changeStatus: false,
  changeCurrentStep: false,
  changeNextAction: false,
  changeNextActor: false,
  createContextVersion: false,
  contextIncludeCompletedWork: false,
  contextIncludeChangedFiles: false,
  contextIncludeTestResults: false,
  contextIncludeOpenItems: false,
  contextIncludeBlockers: false,
  contextIncludeNextStep: false
}

const SAMPLE_RESPONSE = [
  '## Erledigt',
  '- ManagerCardSystem Basis',
  '',
  '## Geänderte Dateien',
  '- src/ManagerCardSystem.lua',
  '',
  '## Tests',
  '- 8 von 8 bestanden',
  '',
  '## Offene Punkte',
  '- Balancing pruefen',
  '',
  'Status: TESTING',
  'Nächster Akteur: Leon'
].join('\n')

describe('analyzeResponseImport', () => {
  it('keeps explicitly managed Rules unchanged when importing AI content into Context', () => {
    const db = createTestDb()
    try {
      const project = newProject(db)
      const rules = createRuleVersion(db, { projectId: project.id, contentMarkdown: '# Security\nRequire verification.', createdBy: 'LEON' })
      const input = { projectId: project.id, source: 'CLAUDE' as const, rawResponse: SAMPLE_RESPONSE }
      const preview = analyzeResponseImport(db, input)
      const result = applyResponseImport(db, { ...input, fingerprint: preview.fingerprint,
        selectedActions: { ...NO_ACTIONS, createContextVersion: true, contextIncludeCompletedWork: true } })
      expect(result.resultContextVersionId).not.toBeNull()
      expect(listRuleVersions(db, project.id)).toEqual([rules])
    } finally { db.close() }
  })
  it('speichert nichts (keine neuen Tabellenzeilen, kein Event, kein Verlauf)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const beforeEvents = listEventLog(db).length

    analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    expect(listEventLog(db).length).toBe(beforeEvents)
    expect(listChatMessages(db, project.id)).toEqual([])
    expect(listContextVersions(db, project.id)).toEqual([])
    const count = db.prepare('SELECT COUNT(*) as c FROM response_imports').get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('erzeugt einen Fingerprint', () => {
    const db = createTestDb()
    const project = newProject(db)
    const result = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })
    expect(typeof result.fingerprint).toBe('string')
    expect(result.fingerprint.length).toBeGreaterThan(10)
  })

  it('gleicher Input erzeugt denselben Fingerprint', () => {
    const db = createTestDb()
    const project = newProject(db)
    const a = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })
    const b = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('geaenderter Rohtext erzeugt einen anderen Fingerprint', () => {
    const db = createTestDb()
    const project = newProject(db)
    const a = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })
    const b = analyzeResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: SAMPLE_RESPONSE + '\nnoch etwas Text'
    })
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('anderes Projekt erzeugt einen anderen Fingerprint bei gleichem Text', () => {
    const db = createTestDb()
    const projectA = newProject(db, 'A')
    const projectB = newProject(db, 'B')
    const a = analyzeResponseImport(db, { projectId: projectA.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })
    const b = analyzeResponseImport(db, { projectId: projectB.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('eine geaenderte Kontextbasis erzeugt einen anderen Fingerprint', () => {
    const db = createTestDb()
    const project = newProject(db)
    const before = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })
    createContextVersion(db, { projectId: project.id, contentMarkdown: '# Kontext', createdBy: 'LEON' })
    const after = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })
    expect(before.fingerprint).not.toBe(after.fingerprint)
    expect(before.baseContextVersionId).toBeNull()
    expect(after.baseContextVersionId).not.toBeNull()
  })

  it('lehnt eine ungueltige Quelle ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    expect(() =>
      // @ts-expect-error absichtlich ungueltiger Wert fuer den Test
      analyzeResponseImport(db, { projectId: project.id, source: 'GEMINI', rawResponse: 'Status: ACTIVE' })
    ).toThrow(ResponseImportError)
  })

  it('lehnt eine leere Antwort ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    expect(() => analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: '   ' })).toThrow(
      ResponseImportError
    )
  })

  it('lehnt eine zu grosse Antwort ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const tooLong = 'x'.repeat(200_001)
    let caught: unknown = null
    try {
      analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: tooLong })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('RESPONSE_TOO_LARGE')
  })

  it('meldet PROJECT_NOT_FOUND fuer ein unbekanntes Projekt', () => {
    const db = createTestDb()
    let caught: unknown = null
    try {
      analyzeResponseImport(db, { projectId: 9999, source: 'CLAUDE', rawResponse: 'Status: ACTIVE' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('PROJECT_NOT_FOUND')
  })
})

describe('applyResponseImport - keine Aktion / Grundvalidierung', () => {
  it('lehnt die Uebernahme ohne ausgewaehlte Aktion ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })
    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: SAMPLE_RESPONSE,
        fingerprint: analysis.fingerprint,
        selectedActions: NO_ACTIONS
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('NO_ACTION_SELECTED')
  })

  it('meldet PROJECT_NOT_FOUND fuer ein unbekanntes Projekt', () => {
    const db = createTestDb()
    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: 9999,
        source: 'CLAUDE',
        rawResponse: SAMPLE_RESPONSE,
        fingerprint: 'irrelevant',
        selectedActions: { ...NO_ACTIONS, saveHistory: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('PROJECT_NOT_FOUND')
  })

  it('meldet PROJECT_ARCHIVED und uebernimmt nichts fuer ein archiviertes Projekt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })
    archiveProject(db, project.id)

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: SAMPLE_RESPONSE,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, saveHistory: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('PROJECT_ARCHIVED')
    expect(listChatMessages(db, project.id)).toEqual([])
  })

  it('meldet STALE_PREVIEW, wenn der Rohtext nach der Analyse abweicht', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: SAMPLE_RESPONSE + '\nmanipuliert',
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, saveHistory: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('STALE_PREVIEW')
  })

  it('meldet STALE_PREVIEW, wenn sich die Kontextbasis zwischen Analyse und Uebernahme geaendert hat', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })
    createContextVersion(db, { projectId: project.id, contentMarkdown: '# Neu', createdBy: 'LEON' })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: SAMPLE_RESPONSE,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, saveHistory: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('STALE_PREVIEW')
  })
})

describe('applyResponseImport - nur Verlauf', () => {
  it('speichert ausschliesslich die unveraenderte Originalantwort im Verlauf', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: SAMPLE_RESPONSE,
      fingerprint: analysis.fingerprint,
      selectedActions: { ...NO_ACTIONS, saveHistory: true }
    })

    const messages = listChatMessages(db, project.id)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe(SAMPLE_RESPONSE)
    expect(messages[0].author).toBe('CLAUDE')
    expect(result.historyMessageId).toBe(messages[0].id)
    expect(result.resultContextVersionId).toBeNull()
    expect(listContextVersions(db, project.id)).toEqual([])
    // Metadaten unveraendert, da keine Metadaten-Aktion ausgewaehlt war.
    expect(result.project.status).toBe('PLANNING')
  })
})

describe('applyResponseImport - Sitzungszuordnung (Meilenstein 3)', () => {
  it('ordnet die importierte Originalantwort bei saveHistory atomar der gewaehlten Sitzung zu', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CLAUDE' })
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: SAMPLE_RESPONSE,
      fingerprint: analysis.fingerprint,
      selectedActions: { ...NO_ACTIONS, saveHistory: true },
      sessionId: session.id
    })

    const row = db
      .prepare('SELECT session_id FROM session_chat_messages WHERE chat_message_id = ?')
      .get(result.historyMessageId) as { session_id: number } | undefined
    expect(row?.session_id).toBe(session.id)
  })

  it('rollt den gesamten Import zurueck, wenn die Sitzungszuordnung an einem Provider-Mismatch scheitert', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    expect(() =>
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: SAMPLE_RESPONSE,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, saveHistory: true },
        sessionId: session.id
      })
    ).toThrow(ResponseImportError)

    expect(listChatMessages(db, project.id)).toHaveLength(0)
    const count = db.prepare('SELECT COUNT(*) as c FROM response_imports').get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('verhaelt sich ohne sessionId unveraendert wie in Meilenstein 2', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: SAMPLE_RESPONSE,
      fingerprint: analysis.fingerprint,
      selectedActions: { ...NO_ACTIONS, saveHistory: true }
    })

    const row = db
      .prepare('SELECT COUNT(*) as c FROM session_chat_messages WHERE chat_message_id = ?')
      .get(result.historyMessageId) as { c: number }
    expect(row.c).toBe(0)
  })

  it('erzeugt keine Sitzungszuordnung, wenn saveHistory nicht ausgewaehlt ist', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CLAUDE' })
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: SAMPLE_RESPONSE,
      fingerprint: analysis.fingerprint,
      selectedActions: { ...NO_ACTIONS, changeStatus: true },
      sessionId: session.id
    })

    expect(result.historyMessageId).toBeNull()
    const count = db.prepare('SELECT COUNT(*) as c FROM session_chat_messages').get() as { c: number }
    expect(count.c).toBe(0)
  })
})

describe('applyResponseImport - nur Projektstatus', () => {
  it('aendert ausschliesslich den Status, keine weiteren Metadaten', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: SAMPLE_RESPONSE,
      fingerprint: analysis.fingerprint,
      selectedActions: { ...NO_ACTIONS, changeStatus: true }
    })

    expect(result.project.status).toBe('TESTING')
    expect(result.project.nextActor).toBe('LEON') // Standardwert, NICHT durch changeNextActor geaendert
    expect(listChatMessages(db, project.id)).toEqual([])
  })

  it('meldet INVALID_STATUS, wenn kein erkennbarer Status vorliegt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: 'Status: irgendwas-unbekanntes'
    })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: 'Status: irgendwas-unbekanntes',
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeStatus: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_STATUS')
    expect(getProjectById(db, project.id).status).toBe('PLANNING')
  })

  it('meldet INVALID_ACTOR, wenn kein erkennbarer Akteur vorliegt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = 'Nächster Akteur: Bob'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeNextActor: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_ACTOR')
  })
})

describe('applyResponseImport - mehrere Metadaten gleichzeitig', () => {
  it('aendert Status, aktuellen Schritt, naechste Aktion und naechsten Akteur gemeinsam', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = ['Status: ACTIVE', 'Aktueller Schritt: Schritt 9', 'Nächste Aktion: Review', 'Nächster Akteur: ChatGPT'].join(
      '\n'
    )
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: raw,
      fingerprint: analysis.fingerprint,
      selectedActions: {
        ...NO_ACTIONS,
        changeStatus: true,
        changeCurrentStep: true,
        changeNextAction: true,
        changeNextActor: true
      }
    })

    expect(result.project.status).toBe('ACTIVE')
    expect(result.project.currentStep).toBe('Schritt 9')
    expect(result.project.nextAction).toBe('Review')
    expect(result.project.nextActor).toBe('CHATGPT')
  })
})

describe('applyResponseImport - Kontext-Version', () => {
  it('erzeugt eine neue Kontext-Version nur mit den ausgewaehlten, nicht-leeren Bereichen', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: SAMPLE_RESPONSE,
      fingerprint: analysis.fingerprint,
      selectedActions: {
        ...NO_ACTIONS,
        createContextVersion: true,
        contextIncludeCompletedWork: true,
        contextIncludeChangedFiles: true
        // Tests/Offene Punkte bewusst NICHT ausgewaehlt
      }
    })

    expect(result.resultContextVersionId).not.toBeNull()
    const versions = listContextVersions(db, project.id)
    expect(versions).toHaveLength(1)
    expect(versions[0].contentMarkdown).toContain('ManagerCardSystem Basis')
    expect(versions[0].contentMarkdown).toContain('src/ManagerCardSystem.lua')
    expect(versions[0].contentMarkdown).not.toContain('8 von 8 bestanden')
    expect(versions[0].contentMarkdown).not.toContain('Balancing pruefen')
  })

  it('die bestehende Kontext-Version bleibt unveraendert (append-only)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const original = createContextVersion(db, { projectId: project.id, contentMarkdown: '# Ursprung', createdBy: 'LEON' })
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: SAMPLE_RESPONSE,
      fingerprint: analysis.fingerprint,
      selectedActions: { ...NO_ACTIONS, createContextVersion: true, contextIncludeCompletedWork: true }
    })

    const versions = listContextVersions(db, project.id)
    const untouchedOriginal = versions.find((v) => v.id === original.id)
    expect(untouchedOriginal?.contentMarkdown).toBe('# Ursprung')
    expect(versions).toHaveLength(2)
  })

  it('RC4: meldet INVALID_SELECTION (nicht CONTEXT_SELECTION_EMPTY), wenn eine ausgewaehlte Kontext-Kategorie leer ist (Fall B)', () => {
    // Korrigierter Test (RC4, Abschnitt 1 der RC4-Vorgabe): dieser Fall -
    // mindestens eine contextInclude-Unterkategorie ist ausgewaehlt, die
    // entsprechende Parser-Kategorie ist aber leer - ist Fall B der
    // verbindlichen Semantik und muss INVALID_SELECTION liefern. Der
    // urspruengliche RC3-Test erwartete hier faelschlich
    // CONTEXT_SELECTION_EMPTY, was einem spaeteren, fachlich korrekten
    // RC3-Test fuer denselben Input widersprach (siehe DECISIONS.md).
    const db = createTestDb()
    const project = newProject(db)
    const raw = 'Status: ACTIVE' // keine Kontext-Kategorien enthalten
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, createContextVersion: true, contextIncludeCompletedWork: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_SELECTION')
    expect(listContextVersions(db, project.id)).toEqual([])
  })

  it('RC4: meldet CONTEXT_SELECTION_EMPTY, wenn createContextVersion aktiv ist, aber wirklich KEINE einzige Kontext-Kategorie ausgewaehlt wurde (Fall A)', () => {
    // Fall A der verbindlichen Semantik: createContextVersion=true, aber
    // ALLE sechs contextInclude*-Felder sind false - das ist kein
    // widerspruechlicher/inkonsistenter Auswahlzustand (Fall B), sondern
    // schlicht "nichts fuer den Kontext ausgewaehlt".
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: SAMPLE_RESPONSE,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, createContextVersion: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('CONTEXT_SELECTION_EMPTY')
    expect(listContextVersions(db, project.id)).toEqual([])
  })

  it('RC4: liefert INVALID_SELECTION auch dann, wenn AUSSER der versteckten contextInclude-Option gar keine andere Aktion ausgewaehlt ist', () => {
    // Das ist genau der in Abschnitt 2 der RC4-Vorgabe bestaetigte Fehler:
    // hasAnySelectedAction() zaehlt contextInclude*-Felder bewusst NICHT
    // als eigene Top-Level-Aktion. Vor der RC4-Korrektur wurde dieser Fall
    // deshalb faelschlich als NO_ACTION_SELECTED gemeldet, obwohl eine
    // strukturell widerspruechliche Auswahl vorliegt.
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: SAMPLE_RESPONSE,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, contextIncludeCompletedWork: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_SELECTION')
    expect((caught as ResponseImportError).code).not.toBe('NO_ACTION_SELECTED')
    expect(listChatMessages(db, project.id)).toEqual([])
    expect(listContextVersions(db, project.id)).toEqual([])
    const count = db.prepare('SELECT COUNT(*) as c FROM response_imports').get() as { c: number }
    expect(count.c).toBe(0)
    const events = listEventLog(db, { projectId: project.id, type: 'RESPONSE_IMPORT_APPLIED' })
    expect(events).toHaveLength(0)
  })

  it('RC4: eine wirklich vollstaendig leere Auswahl bleibt NO_ACTION_SELECTED, keine Nebenwirkungen', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: SAMPLE_RESPONSE,
        fingerprint: analysis.fingerprint,
        selectedActions: NO_ACTIONS
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('NO_ACTION_SELECTED')
    expect(listChatMessages(db, project.id)).toEqual([])
    expect(listContextVersions(db, project.id)).toEqual([])
    const count = db.prepare('SELECT COUNT(*) as c FROM response_imports').get() as { c: number }
    expect(count.c).toBe(0)
  })
  it('RC2: lehnt eine contextInclude*-Auswahl ohne createContextVersion explizit ab (INVALID_SELECTION), statt sie stillschweigend zu ignorieren', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: SAMPLE_RESPONSE,
        fingerprint: analysis.fingerprint,
        selectedActions: {
          ...NO_ACTIONS,
          saveHistory: true,
          createContextVersion: false,
          contextIncludeCompletedWork: true
        }
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_SELECTION')
    // Nichts wurde geschrieben - auch saveHistory (das fuer sich allein
    // gueltig gewesen waere) wurde durch die widerspruechliche Gesamtauswahl
    // mit abgelehnt, keine Teiluebernahme.
    expect(listContextVersions(db, project.id)).toEqual([])
    expect(listChatMessages(db, project.id)).toEqual([])
  })
})

describe('applyResponseImport - RC2: mehrdeutige Metadaten werden abgelehnt statt geraten', () => {
  it('lehnt changeStatus bei widerspruechlichen Statuswerten ab (INVALID_STATUS)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = 'Status: ACTIVE\nStatus: PAUSED'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeStatus: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_STATUS')
    expect(getProjectById(db, project.id).status).toBe('PLANNING')
  })

  it('lehnt changeNextActor bei widerspruechlichen Akteuren ab (INVALID_ACTOR)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = 'Nächster Akteur: Leon\nNächster Akteur: Claude'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeNextActor: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_ACTOR')
  })

  it('lehnt changeCurrentStep bei widerspruechlichem aktuellem Schritt ab (INVALID_CURRENT_STEP)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = 'Aktueller Schritt: Schritt 2\nAktueller Schritt: Schritt 3'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeCurrentStep: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_CURRENT_STEP')
    expect(getProjectById(db, project.id).currentStep).toBe('')
  })

  it('lehnt changeNextAction bei widerspruechlicher naechster Aktion ab (INVALID_NEXT_ACTION)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = 'Nächste Aktion: Tests starten\nNächste Aktion: Release erstellen'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeNextAction: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_NEXT_ACTION')
  })

  it('lehnt changeCurrentStep ab, wenn ueberhaupt kein Wert erkannt wurde (RC1s dokumentierte Luecke ist geschlossen)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = 'Status: ACTIVE' // kein "Aktueller Schritt:"-Label enthalten
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeCurrentStep: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_CURRENT_STEP')
    // Kein Importprotokoll-Eintrag, kein Event - keine "funktional leere" Uebernahme mehr.
    const count = db.prepare('SELECT COUNT(*) as c FROM response_imports').get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('eine Kombination aus gueltiger und ungueltiger Auswahl fuehrt zu KEINER Teiluebernahme', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = ['Status: ACTIVE\nStatus: PAUSED', '## Erledigt', '- Sache A'].join('\n')
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        // saveHistory waere fuer sich allein gueltig - changeStatus ist es
        // wegen des widerspruechlichen Status nicht. Die gesamte Uebernahme
        // muss abgelehnt werden, keine Teilausfuehrung von saveHistory.
        selectedActions: { ...NO_ACTIONS, saveHistory: true, changeStatus: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_STATUS')
    expect(listChatMessages(db, project.id)).toEqual([])
    const count = db.prepare('SELECT COUNT(*) as c FROM response_imports').get() as { c: number }
    expect(count.c).toBe(0)
    const events = listEventLog(db, { projectId: project.id, type: 'RESPONSE_IMPORT_APPLIED' })
    expect(events).toHaveLength(0)
  })
})

describe('applyResponseImport - Importprotokoll und Event Log', () => {
  it('speichert das Importprotokoll korrekt (Quelle, Rohtext, Parser-Ergebnis, ausgewaehlte Aktionen, Kontextbasis)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    const selected: ResponseImportSelectedActions = { ...NO_ACTIONS, saveHistory: true, changeStatus: true }
    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: SAMPLE_RESPONSE,
      fingerprint: analysis.fingerprint,
      selectedActions: selected
    })

    const record = getResponseImportById(db, result.importId)
    expect(record).not.toBeNull()
    expect(record?.projectId).toBe(project.id)
    expect(record?.source).toBe('CLAUDE')
    expect(record?.rawResponse).toBe(SAMPLE_RESPONSE)
    expect(record?.selectedActions).toEqual(selected)
    expect(record?.parsedResult.suggestedStatus).toBe('TESTING')
    expect(record?.baseContextVersionId).toBeNull()
  })

  it('schreibt ein RESPONSE_IMPORT_APPLIED-Ereignis ohne den Rohtext in der Payload', () => {
    const db = createTestDb()
    const project = newProject(db)
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: SAMPLE_RESPONSE })

    applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: SAMPLE_RESPONSE,
      fingerprint: analysis.fingerprint,
      selectedActions: { ...NO_ACTIONS, saveHistory: true }
    })

    const events = listEventLog(db, { projectId: project.id, type: 'RESPONSE_IMPORT_APPLIED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload.source).toBe('CLAUDE')
    expect(JSON.stringify(events[0].payload)).not.toContain('ManagerCardSystem')
  })
})

describe('applyResponseImport - Rollback bei Fehler', () => {
  it('bei INVALID_STATUS bleibt die gesamte Uebernahme wirkungslos, auch wenn saveHistory ebenfalls ausgewaehlt war', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = 'Status: kaputt\nStatus faellt nicht in bekannte Werte'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, saveHistory: true, changeStatus: true }
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ResponseImportError)
    // Die Validierung (inkl. INVALID_STATUS) laeuft VOR der Transaktion -
    // es wurde also gar nicht erst geschrieben. Zusaetzlich zur reinen
    // Fehlerpruefung wird hier auch die tatsaechliche Nebenwirkungsfreiheit
    // verifiziert (kein Verlaufseintrag, keine Importzeile).
    expect(listChatMessages(db, project.id)).toEqual([])
    const count = db.prepare('SELECT COUNT(*) as c FROM response_imports').get() as { c: number }
    expect(count.c).toBe(0)
  })
})

describe('applyResponseImport - RC2: Originalantwort bleibt exakt erhalten (ueber den Service)', () => {
  it('response_imports.raw_response und chat_messages.content stimmen exakt mit dem Eingabestring ueberein (inkl. Whitespace)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = '\n  Antwort mit Einrückung  \n'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })
    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: raw,
      fingerprint: analysis.fingerprint,
      selectedActions: { ...NO_ACTIONS, saveHistory: true }
    })

    const record = getResponseImportById(db, result.importId)
    expect(record?.rawResponse).toBe(raw)

    const messages = listChatMessages(db, project.id)
    expect(messages[0].content).toBe(raw)
  })
})

describe('applyResponseImport - RC2: keine internen Fehlerdetails an den Renderer', () => {
  it('sanitisiert einen unerwarteten Transaktionsfehler: sichere Meldung nach aussen, echte Ursache nur als cause, vollstaendiger Rollback', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = 'Status: ACTIVE\n## Erledigt\n- GEHEIMNIS_MARKER Sache A'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    // Simuliert ein unerwartetes SQL-/Constraint-Problem genau an der
    // Stelle, an der die response_imports-Zeile eingefuegt wird - NACH
    // Metadaten-Update und Verlaufseintrag innerhalb derselben Transaktion,
    // um echten Rollback bereits "erfolgreich" ausgefuehrter Teilschritte
    // zu erzwingen und zu verifizieren.
    const originalPrepare = db.prepare.bind(db)
    let sawInsert = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(db as any).prepare = (sql: string) => {
      if (sql.includes('INSERT INTO response_imports')) {
        sawInsert = true
        throw new Error('SQLITE_CONSTRAINT: FOREIGN KEY constraint failed at /home/user/private/path/db.sqlite')
      }
      return originalPrepare(sql)
    }

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, saveHistory: true, changeStatus: true }
      })
    } catch (err) {
      caught = err
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(db as any).prepare = originalPrepare
    }

    expect(sawInsert).toBe(true)
    expect(caught).toBeInstanceOf(ResponseImportError)
    const err = caught as ResponseImportError
    expect(err.code).toBe('IMPORT_APPLY_FAILED')

    // Die fuer den Renderer bestimmte Meldung ist die feste, sichere -
    // KEINE SQL-/Pfad-Details, KEINE Rohantwort.
    expect(err.message).toBe('Die Übernahme ist fehlgeschlagen. Es wurden keine Änderungen gespeichert.')
    expect(err.message).not.toContain('geheimer/pfad')
    expect(err.message).not.toContain('CONSTRAINT')
    expect(err.message).not.toContain('GEHEIMNIS_MARKER')

    // Die echte Ursache ist ausschliesslich ueber `cause` erreichbar (fuer
    // die lokale FileLogger-Protokollierung in registerIpc.ts).
    expect(err.cause).toBeInstanceOf(Error)
    expect((err.cause as Error).message).toContain('private/path')

    // Vollstaendiger Rollback: weder Statusaenderung noch Verlaufseintrag
    // noch Importzeile, obwohl beide ersten Schritte vor dem simulierten
    // Fehler "erfolgreich" liefen.
    expect(getProjectById(db, project.id).status).toBe('PLANNING')
    expect(listChatMessages(db, project.id)).toEqual([])
    const count = db.prepare('SELECT COUNT(*) as c FROM response_imports').get() as { c: number }
    expect(count.c).toBe(0)
  })
})

describe('applyResponseImport / analyzeResponseImport - RC2: unerwartete Fehler werden nicht faelschlich als PROJECT_NOT_FOUND gemeldet', () => {
  it('ein unerwarteter Datenbankfehler beim Laden des Projekts propagiert unveraendert (kein ResponseImportError)', () => {
    const db = createTestDb()
    const project = newProject(db)
    db.close() // erzwingt einen echten, unerwarteten better-sqlite3-Fehler (kein ProjectNotFoundError)

    let caught: unknown = null
    try {
      analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: 'Status: ACTIVE' })
    } catch (err) {
      caught = err
    }

    expect(caught).not.toBeNull()
    expect(caught).not.toBeInstanceOf(ResponseImportError)
  })
})

describe('applyResponseImport - RC3: nur tatsaechlich wirksame Metadatenaenderungen', () => {
  it('ACTIVE zu ACTIVE ist wirkungslos -> NO_EFFECTIVE_CHANGE, keine Datenbankaenderung', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'P', projectType: 'T', description: '', status: 'ACTIVE' })
    const raw = 'Status: ACTIVE'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeStatus: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('NO_EFFECTIVE_CHANGE')
    expect(getProjectById(db, project.id).status).toBe('ACTIVE')
    const count = db.prepare('SELECT COUNT(*) as c FROM response_imports').get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('LEON zu LEON ist wirkungslos -> NO_EFFECTIVE_CHANGE', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'P', projectType: 'T', description: '', nextActor: 'LEON' })
    const raw = 'Nächster Akteur: Leon'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeNextActor: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('NO_EFFECTIVE_CHANGE')
  })

  it('identischer currentStep ist wirkungslos -> NO_EFFECTIVE_CHANGE', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'P', projectType: 'T', description: '', currentStep: 'Schritt 5' })
    const raw = 'Aktueller Schritt: Schritt 5'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeCurrentStep: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('NO_EFFECTIVE_CHANGE')
  })

  it('identische nextAction ist wirkungslos -> NO_EFFECTIVE_CHANGE', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'P', projectType: 'T', description: '', nextAction: 'Warten' })
    const raw = 'Nächste Aktion: Warten'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeNextAction: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('NO_EFFECTIVE_CHANGE')
  })

  it('No-Op kombiniert mit saveHistory fuehrt zu vollstaendiger Ablehnung, keinerlei Teiluebernahme', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'P', projectType: 'T', description: '', status: 'ACTIVE' })
    const raw = 'Status: ACTIVE'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, saveHistory: true, changeStatus: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('NO_EFFECTIVE_CHANGE')
    expect(listChatMessages(db, project.id)).toEqual([])
    const events = listEventLog(db, { projectId: project.id, type: 'RESPONSE_IMPORT_APPLIED' })
    expect(events).toHaveLength(0)
  })
})

describe('applyResponseImport - RC3: Längenlimits für abgeleitete Importwerte', () => {
  it('currentStep mit genau 500 Zeichen wird uebernommen', () => {
    const db = createTestDb()
    const project = newProject(db)
    const value = 'x'.repeat(500)
    const raw = `Aktueller Schritt: ${value}`
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: raw,
      fingerprint: analysis.fingerprint,
      selectedActions: { ...NO_ACTIONS, changeCurrentStep: true }
    })
    expect(result.project.currentStep).toBe(value)
  })

  it('currentStep mit 501 Zeichen wird abgelehnt (INVALID_CURRENT_STEP), keine Aenderung', () => {
    const db = createTestDb()
    const project = newProject(db)
    const value = 'x'.repeat(501)
    const raw = `Aktueller Schritt: ${value}`
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeCurrentStep: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_CURRENT_STEP')
    expect(getProjectById(db, project.id).currentStep).toBe('')
  })

  it('nextAction mit genau 500 Zeichen wird uebernommen, 501 wird abgelehnt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const ok = 'y'.repeat(500)
    const rawOk = `Nächste Aktion: ${ok}`
    const analysisOk = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: rawOk })
    const resultOk = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: rawOk,
      fingerprint: analysisOk.fingerprint,
      selectedActions: { ...NO_ACTIONS, changeNextAction: true }
    })
    expect(resultOk.project.nextAction).toBe(ok)

    const tooLong = 'y'.repeat(501)
    const rawTooLong = `Nächste Aktion: ${tooLong}`
    const analysisTooLong = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: rawTooLong })
    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: rawTooLong,
        fingerprint: analysisTooLong.fingerprint,
        selectedActions: { ...NO_ACTIONS, changeNextAction: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_NEXT_ACTION')
  })

  it('ein bestehender Kontext knapp unter dem Limit plus ein kleiner Import bleibt erlaubt', () => {
    const db = createTestDb()
    const project = newProject(db)
    createContextVersion(db, { projectId: project.id, contentMarkdown: 'x'.repeat(199_000), createdBy: 'LEON' })
    const raw = '## Erledigt\n- kurz'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: raw,
      fingerprint: analysis.fingerprint,
      selectedActions: { ...NO_ACTIONS, createContextVersion: true, contextIncludeCompletedWork: true }
    })
    expect(result.resultContextVersionId).not.toBeNull()
  })

  it('ein resultierender Kontext ueber dem Limit wird vollstaendig abgelehnt (CONTEXT_TOO_LARGE), kein Teil-Commit', () => {
    const db = createTestDb()
    const project = newProject(db)
    createContextVersion(db, { projectId: project.id, contentMarkdown: 'x'.repeat(199_990), createdBy: 'LEON' })
    const raw = ['Status: ACTIVE', '## Erledigt', '- ' + 'y'.repeat(200)].join('\n')
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: {
          ...NO_ACTIONS,
          saveHistory: true,
          changeStatus: true,
          createContextVersion: true,
          contextIncludeCompletedWork: true
        }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('CONTEXT_TOO_LARGE')
    // Vollstaendiger Rollback / gar kein erster Schritt: weder Status noch
    // Verlauf noch eine zweite Kontext-Version wurden erzeugt.
    expect(getProjectById(db, project.id).status).toBe('PLANNING')
    expect(listChatMessages(db, project.id)).toEqual([])
    expect(listContextVersions(db, project.id)).toHaveLength(1)
  })
})

describe('applyResponseImport - RC3: jede ausgewaehlte Kontextkategorie muss wirksam sein', () => {
  it('eine einzelne ausgewaehlte leere Kategorie wird abgelehnt (INVALID_SELECTION)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = 'Status: ACTIVE' // keine changedFiles im Text
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: { ...NO_ACTIONS, createContextVersion: true, contextIncludeChangedFiles: true }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_SELECTION')
  })

  it('eine gefuellte PLUS eine leere ausgewaehlte Kategorie fuehrt zu vollstaendiger Ablehnung (auch die gefuellte wird nicht uebernommen)', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = '## Erledigt\n- Sache A' // keine changedFiles im Text
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    let caught: unknown = null
    try {
      applyResponseImport(db, {
        projectId: project.id,
        source: 'CLAUDE',
        rawResponse: raw,
        fingerprint: analysis.fingerprint,
        selectedActions: {
          ...NO_ACTIONS,
          createContextVersion: true,
          contextIncludeCompletedWork: true,
          contextIncludeChangedFiles: true
        }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_SELECTION')
    expect(listContextVersions(db, project.id)).toEqual([])
  })

  it('mehrere ausgewaehlte, alle gefuellte Kategorien bleiben zulaessig', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = ['## Erledigt', '- Sache A', '## Geänderte Dateien', '- datei.ts'].join('\n')
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })

    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: raw,
      fingerprint: analysis.fingerprint,
      selectedActions: {
        ...NO_ACTIONS,
        createContextVersion: true,
        contextIncludeCompletedWork: true,
        contextIncludeChangedFiles: true
      }
    })
    expect(result.resultContextVersionId).not.toBeNull()
    const versions = listContextVersions(db, project.id)
    expect(versions[0].contentMarkdown).toContain('Sache A')
    expect(versions[0].contentMarkdown).toContain('datei.ts')
  })

  it('selected_actions_json enthaelt bei einer erfolgreichen Uebernahme nur die tatsaechlich uebermittelte, fachlich konsistente Auswahl', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = '## Erledigt\n- Sache A'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })
    const selected = { ...NO_ACTIONS, createContextVersion: true, contextIncludeCompletedWork: true }

    const result = applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: raw,
      fingerprint: analysis.fingerprint,
      selectedActions: selected
    })
    const record = getResponseImportById(db, result.importId)
    expect(record?.selectedActions).toEqual(selected)
  })

  it('keine leeren Ueberschriften in der erzeugten Kontext-Version', () => {
    const db = createTestDb()
    const project = newProject(db)
    const raw = '## Erledigt\n- Sache A'
    const analysis = analyzeResponseImport(db, { projectId: project.id, source: 'CLAUDE', rawResponse: raw })
    applyResponseImport(db, {
      projectId: project.id,
      source: 'CLAUDE',
      rawResponse: raw,
      fingerprint: analysis.fingerprint,
      selectedActions: { ...NO_ACTIONS, createContextVersion: true, contextIncludeCompletedWork: true }
    })
    const versions = listContextVersions(db, project.id)
    expect(versions[0].contentMarkdown).not.toContain('### Geänderte Dateien')
    expect(versions[0].contentMarkdown).not.toContain('### Testergebnisse')
    expect(versions[0].contentMarkdown).not.toContain('### Blocker')
  })
})
