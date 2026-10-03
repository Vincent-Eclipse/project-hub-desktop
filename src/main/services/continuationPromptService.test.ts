import { describe, expect, it, vi } from 'vitest'
import { CONTINUATION_PROMPT_MAX_LENGTH, type RequiredFileInput } from '@shared/types'
import { createRuleVersion } from './rulesService'
import { toIpcError } from '../ipc/ipcError'
import type { FileLogger } from '../logger'
import { createTestDb } from '../testUtils/testDb'
import { createProject } from './projectsService'
import { createSession } from './sessionService'
import { confirmSnapshot, createDraftSnapshot } from './continuationSnapshotService'
import { ContinuationError, SessionNotFoundError, SnapshotNotFoundError, SnapshotSessionMismatchError } from './sessionErrors'
import { generateContinuationPrompt } from './continuationPromptService'

type TestDb = ReturnType<typeof createTestDb>

function newProject(db: TestDb, name = 'Projekt') {
  return createProject(db, { name, projectType: 'Typ', description: '' })
}

function newSession(db: TestDb, projectId: number, provider: 'CHATGPT' | 'CLAUDE' = 'CHATGPT') {
  return createSession(db, { projectId, provider })
}

interface SnapshotOverrides {
  currentTask?: string
  confirmedDone?: string[]
  confirmedOpen?: string[]
  blockers?: string[]
  lastCompleteSection?: string
  missingSections?: string[]
  nextExactStep?: string
  additionalHumanAction?: string
  requiredFiles?: RequiredFileInput[]
}

/** Legt einen Snapshot ueber die bestehenden Service-Funktionen an und bestaetigt ihn sofort unveraendert. */
function newConfirmedSnapshot(
  db: TestDb,
  projectId: number,
  sessionId: number,
  provider: 'CHATGPT' | 'CLAUDE',
  overrides: SnapshotOverrides = {}
) {
  const draft = createDraftSnapshot(db, {
    projectId,
    sessionId,
    provider,
    createdBy: 'LEON',
    ...overrides
  })
  return confirmSnapshot(db, { draftSnapshotId: draft.id, createdBy: 'LEON' })
}

/** Fuegt einen CONFIRMED-Snapshot direkt per SQL ein, weil createDraftSnapshot/confirmSnapshot ein Secret in currentTask/additionalHumanAction gar nicht erst durchlassen wuerden. */
function insertConfirmedSnapshotDirectly(
  db: TestDb,
  projectId: number,
  sessionId: number,
  provider: 'CHATGPT' | 'CLAUDE',
  fields: { currentTask?: string; additionalHumanAction?: string } = {}
): number {
  const result = db
    .prepare(
      `INSERT INTO continuation_snapshots
        (project_id, session_id, version_number, provider, current_task, additional_human_action, confirmation_state, created_by)
       VALUES (?, ?, 1, ?, ?, ?, 'CONFIRMED', 'LEON')`
    )
    .run(projectId, sessionId, provider, fields.currentTask ?? '', fields.additionalHumanAction ?? '')
  return Number(result.lastInsertRowid)
}

describe('generateContinuationPrompt - Erfolgsfaelle', () => {
  it('erzeugt einen CHATGPT-Prompt erfolgreich', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', { currentTask: 'Naechste Aufgabe' })

    const result = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })

    expect(result.provider).toBe('CHATGPT')
    expect(result.promptText).toContain('## 1. Projekt und Provider')
    expect(result.promptText).toContain('Provider: CHATGPT')
    expect(result.promptText).toContain('Fruehrer Chatverlauf steht in dieser Sitzung nicht zur Verfuegung')
    expect(typeof result.generatedAt).toBe('string')
  })

  it('erzeugt einen CLAUDE-Prompt erfolgreich', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CLAUDE')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CLAUDE', { currentTask: 'Naechste Aufgabe' })

    const result = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CLAUDE' })

    expect(result.provider).toBe('CLAUDE')
    expect(result.promptText).toContain('Provider: CLAUDE')
    expect(result.promptText).toContain('Halte klare Dateigrenzen ein')
  })

  it('erzeugt bei identischen Eingaben identischen Prompttext', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', {
      currentTask: 'Aufgabe',
      confirmedDone: ['Eins', 'Zwei'],
      blockers: ['Blocker A']
    })

    const first = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
    const second = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })

    expect(first.promptText).toBe(second.promptText)
  })

  it('promptText enthaelt keine Zeitstempel oder zufaelligen Werte', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT')

    const first = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
    const second = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })

    expect(first.promptText).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    expect(first.promptText).toBe(second.promptText)
  })
})

describe('generateContinuationPrompt - Abschnittsinhalte', () => {
  it('fuehrt alle kuratierten Snapshot-Felder korrekt im Prompt auf', () => {
    const db = createTestDb()
    const project = newProject(db, 'Mein Projekt')
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', {
      currentTask: 'AUFGABE_MARKER',
      confirmedDone: ['ERLEDIGT_MARKER'],
      confirmedOpen: ['OFFEN_MARKER'],
      blockers: ['BLOCKER_MARKER'],
      lastCompleteSection: 'ABSCHNITT_MARKER',
      missingSections: ['FEHLEND_MARKER'],
      nextExactStep: 'SCHRITT_MARKER',
      additionalHumanAction: 'MENSCHLICH_MARKER'
    })

    const result = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })

    expect(result.promptText).toContain('Mein Projekt')
    expect(result.promptText).toContain('## 2. Aktuelle Aufgabe\nAUFGABE_MARKER')
    expect(result.promptText).toContain('## 3. Bestaetigt erledigt\n- ERLEDIGT_MARKER')
    expect(result.promptText).toContain('## 4. Noch offen\n- OFFEN_MARKER')
    expect(result.promptText).toContain('## 5. Blocker\n- BLOCKER_MARKER')
    expect(result.promptText).toContain('## 6. Letzter vollstaendiger Abschnitt\nABSCHNITT_MARKER')
    expect(result.promptText).toContain('## 7. Fehlende Abschnitte\n- FEHLEND_MARKER')
    expect(result.promptText).toContain('## 8. Naechster exakter Schritt\nSCHRITT_MARKER')
    expect(result.promptText).toContain('## 9. Zusaetzliche menschliche Handlung\nMENSCHLICH_MARKER')
  })

  it('behandelt leere optionale Abschnitte konsistent als "Keine"', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT')

    const result = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })

    expect(result.promptText).toContain('## 2. Aktuelle Aufgabe\nKeine')
    expect(result.promptText).toContain('## 3. Bestaetigt erledigt\nKeine')
    expect(result.promptText).toContain('## 4. Noch offen\nKeine')
    expect(result.promptText).toContain('## 5. Blocker\nKeine')
    expect(result.promptText).toContain('## 6. Letzter vollstaendiger Abschnitt\nKeine')
    expect(result.promptText).toContain('## 7. Fehlende Abschnitte\nKeine')
    expect(result.promptText).toContain('## 8. Naechster exakter Schritt\nKeine')
    expect(result.promptText).toContain('## 9. Zusaetzliche menschliche Handlung\nKeine')
    expect(result.promptText).toContain('## 10. Benoetigte Dateien\nKeine')
  })

  it('CHATGPT- und CLAUDE-Prompt unterscheiden sich nur in den vorgesehenen Provider-Regeln', () => {
    const db = createTestDb()
    const project = newProject(db)
    const chatgptSession = newSession(db, project.id, 'CHATGPT')
    const claudeSession = newSession(db, project.id, 'CLAUDE')
    const sharedFields: SnapshotOverrides = {
      currentTask: 'Gemeinsame Aufgabe',
      confirmedDone: ['Gemeinsam erledigt'],
      blockers: ['Gemeinsamer Blocker']
    }
    const chatgptSnapshot = newConfirmedSnapshot(db, project.id, chatgptSession.id, 'CHATGPT', sharedFields)
    const claudeSnapshot = newConfirmedSnapshot(db, project.id, claudeSession.id, 'CLAUDE', sharedFields)

    const chatgptResult = generateContinuationPrompt(db, {
      sessionId: chatgptSession.id,
      snapshotId: chatgptSnapshot.id,
      provider: 'CHATGPT'
    })
    const claudeResult = generateContinuationPrompt(db, {
      sessionId: claudeSession.id,
      snapshotId: claudeSnapshot.id,
      provider: 'CLAUDE'
    })

    const chatgptBeforeRules = chatgptResult.promptText.split('## 11. Arbeitsregeln fuer die Fortsetzung')[0]
    const claudeBeforeRules = claudeResult.promptText.split('## 11. Arbeitsregeln fuer die Fortsetzung')[0]
    const normalize = (text: string): string => text.replace('Provider: CHATGPT', 'Provider: X').replace('Provider: CLAUDE', 'Provider: X')

    expect(normalize(chatgptBeforeRules)).toBe(normalize(claudeBeforeRules))
    expect(chatgptResult.promptText).not.toBe(claudeResult.promptText)
  })

  it('enthaelt in beiden Provider-Varianten die gemeinsamen Sicherheitsregeln', () => {
    const db = createTestDb()
    const project = newProject(db)
    const chatgptSession = newSession(db, project.id, 'CHATGPT')
    const claudeSession = newSession(db, project.id, 'CLAUDE')
    const chatgptSnapshot = newConfirmedSnapshot(db, project.id, chatgptSession.id, 'CHATGPT')
    const claudeSnapshot = newConfirmedSnapshot(db, project.id, claudeSession.id, 'CLAUDE')

    const chatgptResult = generateContinuationPrompt(db, {
      sessionId: chatgptSession.id,
      snapshotId: chatgptSnapshot.id,
      provider: 'CHATGPT'
    })
    const claudeResult = generateContinuationPrompt(db, {
      sessionId: claudeSession.id,
      snapshotId: claudeSnapshot.id,
      provider: 'CLAUDE'
    })

    for (const result of [chatgptResult, claudeResult]) {
      expect(result.promptText).toContain('Aendere keine bereits eingefrorenen/abgeschlossenen Arbeitsphasen')
      expect(result.promptText).toContain('Beginne keine spaeteren, noch nicht freigegebenen Phasen.')
      expect(result.promptText).toContain('keine erfundenen Testergebnisse oder Arbeitsstaende')
    }
  })
})

describe('generateContinuationPrompt - Required Files', () => {
  it('fuehrt Required Files ausschliesslich als Metadaten auf und markiert sensible Dateien', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', {
      requiredFiles: [
        {
          displayName: 'Konfigurationsdatei',
          expectedFilename: 'config.json',
          sha256: 'a'.repeat(64),
          purpose: 'Enthaelt Laufzeiteinstellungen',
          isRequired: true,
          reuploadRequired: false,
          isSensitive: false
        },
        {
          displayName: 'Zugangsdaten-Export',
          expectedFilename: 'creds.json',
          purpose: 'Enthaelt Zugangsdaten',
          isRequired: true,
          reuploadRequired: true,
          isSensitive: true,
          localPath: 'C:\\Nicht\\Vorhanden\\pfad-existiert-nicht-xyz.json'
        }
      ]
    })

    const result = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })

    expect(result.promptText).toContain('Konfigurationsdatei')
    expect(result.promptText).toContain('config.json')
    expect(result.promptText).toContain('a'.repeat(64))
    expect(result.promptText).toContain('Enthaelt Laufzeiteinstellungen')
    expect(result.promptText).toContain('Pflichtdatei: ja')
    expect(result.promptText).toContain('Erneuter Upload erforderlich: nein')

    expect(result.promptText).toContain('Zugangsdaten-Export [SENSIBEL]')
    expect(result.promptText).toContain('Sensibel: ja')
    expect(result.promptText).not.toContain('Konfigurationsdatei [SENSIBEL]')

    // Niemals der lokale Pfad, unabhaengig davon, ob die Datei sensibel ist.
    expect(result.promptText).not.toContain('pfad-existiert-nicht-xyz.json')
    expect(result.promptText).not.toContain('C:\\Nicht\\Vorhanden')
  })

  it('liest oder oeffnet keine Dateien und loest ueber localPath keinen Dateisystemzugriff aus', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const bogusPath = 'Z:\\definitiv\\nicht\\existierender\\pfad\\datei.bin'
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', {
      requiredFiles: [{ displayName: 'Datei', localPath: bogusPath }]
    })

    expect(() =>
      generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
    ).not.toThrow()

    const result = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
    expect(result.promptText).not.toContain(bogusPath)
  })
})

describe('generateContinuationPrompt - Fehler und Zugehoerigkeit', () => {
  it('wirft SessionNotFoundError, wenn die Sitzung nicht existiert', () => {
    const db = createTestDb()
    expect(() => generateContinuationPrompt(db, { sessionId: 9999, snapshotId: 1, provider: 'CHATGPT' })).toThrow(
      SessionNotFoundError
    )
  })

  it('wirft SnapshotNotFoundError, wenn der Snapshot nicht existiert', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    expect(() =>
      generateContinuationPrompt(db, { sessionId: session.id, snapshotId: 9999, provider: 'CHATGPT' })
    ).toThrow(SnapshotNotFoundError)
  })

  it('wirft SnapshotSessionMismatchError, wenn der Snapshot zu einer anderen Sitzung gehoert', () => {
    const db = createTestDb()
    const project = newProject(db)
    const sessionA = newSession(db, project.id, 'CHATGPT')
    const sessionB = newSession(db, project.id, 'CLAUDE')
    const snapshotA = newConfirmedSnapshot(db, project.id, sessionA.id, 'CHATGPT')

    expect(() =>
      generateContinuationPrompt(db, { sessionId: sessionB.id, snapshotId: snapshotA.id, provider: 'CLAUDE' })
    ).toThrow(SnapshotSessionMismatchError)
  })

  it('wirft SnapshotSessionMismatchError, wenn Sitzung und Snapshot zu unterschiedlichen Projekten gehoeren', () => {
    const db = createTestDb()
    const projectA = newProject(db, 'Projekt A')
    const projectB = newProject(db, 'Projekt B')
    const sessionInProjectA = newSession(db, projectA.id, 'CHATGPT')
    const sessionInProjectB = newSession(db, projectB.id, 'CHATGPT')
    const snapshotInProjectA = newConfirmedSnapshot(db, projectA.id, sessionInProjectA.id, 'CHATGPT')

    expect(() =>
      generateContinuationPrompt(db, {
        sessionId: sessionInProjectB.id,
        snapshotId: snapshotInProjectA.id,
        provider: 'CHATGPT'
      })
    ).toThrow(SnapshotSessionMismatchError)
  })

  it('wirft ContinuationError(PROVIDER_MISMATCH), wenn der angegebene Provider nicht zur Sitzung passt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT')

    let caught: unknown
    try {
      generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CLAUDE' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ContinuationError)
    expect((caught as ContinuationError).code).toBe('PROVIDER_MISMATCH')
  })

  it('lehnt einen Entwurfs-Snapshot (nicht bestaetigt) mit SNAPSHOT_NOT_CONFIRMED ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const draft = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })

    let caught: unknown
    try {
      generateContinuationPrompt(db, { sessionId: session.id, snapshotId: draft.id, provider: 'CHATGPT' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ContinuationError)
    expect((caught as ContinuationError).code).toBe('SNAPSHOT_NOT_CONFIRMED')
  })
})

describe('generateContinuationPrompt - Sicherheit', () => {
  it('lehnt einen Snapshot mit einem erkennbaren API-Token-Muster sicher ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const secretToken = 'sk-' + 'testSecretValue1234567890ABCDEF'
    const snapshotId = insertConfirmedSnapshotDirectly(db, project.id, session.id, 'CHATGPT', {
      currentTask: secretToken
    })

    let caught: unknown
    try {
      generateContinuationPrompt(db, { sessionId: session.id, snapshotId, provider: 'CHATGPT' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ContinuationError)
    expect((caught as ContinuationError).code).toBe('PROMPT_CONTAINS_SENSITIVE_CONTENT')
  })

  it('die Fehlermeldung des Sicherheitsfehlers enthaelt den Geheimwert selbst nicht', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const secretValue = 'hunter2superSecretValue'
    const snapshotId = insertConfirmedSnapshotDirectly(db, project.id, session.id, 'CHATGPT', {
      additionalHumanAction: `password: ${secretValue}`
    })

    let caught: unknown
    try {
      generateContinuationPrompt(db, { sessionId: session.id, snapshotId, provider: 'CHATGPT' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ContinuationError)
    expect((caught as Error).message).not.toContain(secretValue)
    expect((caught as Error).message).toContain('additionalHumanAction')
  })

  it('lehnt einen zu grossen erzeugten Prompt mit PROMPT_TOO_LARGE ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', {
      currentTask: 'A'.repeat(250_000)
    })

    let caught: unknown
    try {
      generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ContinuationError)
    expect((caught as ContinuationError).code).toBe('PROMPT_TOO_LARGE')
  })

  it('lehnt einen Bearer-Token im Projektnamen sicher ab', () => {
    const db = createTestDb()
    const project = newProject(db, 'Bearer abcdefghijklmnop1234567890')
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT')

    let caught: unknown
    try {
      generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ContinuationError)
    expect((caught as ContinuationError).code).toBe('PROMPT_CONTAINS_SENSITIVE_CONTENT')
  })

  it('die Fehlermeldung enthaelt den Geheimwert aus dem Projektnamen nicht', () => {
    const db = createTestDb()
    const secretInName = 'Bearer abcdefghijklmnop1234567890'
    const project = newProject(db, secretInName)
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT')

    let caught: unknown
    try {
      generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).not.toContain(secretInName)
    expect((caught as Error).message).toContain('projectName')
  })

  it('lehnt ein Token-Muster in requiredFiles.expectedFilename sicher ab', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', {
      requiredFiles: [{ displayName: 'Datei', expectedFilename: 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456' }]
    })

    let caught: unknown
    try {
      generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ContinuationError)
    expect((caught as ContinuationError).code).toBe('PROMPT_CONTAINS_SENSITIVE_CONTENT')
  })

  it('die Fehlermeldung enthaelt den Wert aus expectedFilename nicht', () => {
    const db = createTestDb()
    const secretFilename = 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456'
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', {
      requiredFiles: [{ displayName: 'Datei', expectedFilename: secretFilename }]
    })

    let caught: unknown
    try {
      generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).not.toContain(secretFilename)
    expect((caught as Error).message).toContain('expectedFilename')
  })

  it('gibt ein unauffaelliges expectedFilename weiterhin unveraendert als Metadatum aus', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', {
      requiredFiles: [{ displayName: 'Datei', expectedFilename: 'bericht.pdf' }]
    })

    const result = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
    expect(result.promptText).toContain('bericht.pdf')
  })

  it('localPath erscheint weiterhin niemals im Prompt', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = newSession(db, project.id, 'CHATGPT')
    const localPath = 'D:\\pfad\\der\\nicht\\ausgegeben\\werden\\darf.txt'
    const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', {
      requiredFiles: [{ displayName: 'Datei', localPath }]
    })

    const result = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
    expect(result.promptText).not.toContain(localPath)
  })
})


describe('generateContinuationPrompt - current Project Rules', () => {
  it.each(['CHATGPT', 'CLAUDE'] as const)('prepends exact newest Rules for %s without changing the historical snapshot', (provider) => {
    const db = createTestDb()
    try {
      const project = newProject(db)
      const session = newSession(db, project.id, provider)
      createRuleVersion(db, { projectId: project.id, contentMarkdown: 'OLD_RULES_MARKER password: obsoleteTestOnlyValue', createdBy: 'LEON' })
      const snapshot = newConfirmedSnapshot(db, project.id, session.id, provider, { currentTask: 'HISTORICAL_TASK' })
      const storedSnapshot = db.prepare('SELECT * FROM continuation_snapshots WHERE id = ?').get(snapshot.id)
      const rules = '  # Governance\r\nKeep {{projectName}} literal.\nDo not change the schema.\n\n'
      createRuleVersion(db, { projectId: project.id, contentMarkdown: rules, createdBy: 'LEON' })
      const input = { sessionId: session.id, snapshotId: snapshot.id, provider }
      const before = db.serialize()
      const first = generateContinuationPrompt(db, input).promptText
      expect(first).toMatch(/^PROJECT RULES\n/)
      expect(first).toContain(`\n\n${rules}\n\n---\n\n## 1. Projekt und Provider`)
      expect(first).not.toContain('OLD_RULES_MARKER')
      expect(first).toContain('HISTORICAL_TASK')
      expect(first).toContain('Sie erteilen keine Datei-, Befehls-, Git- oder Netzwerkberechtigungen und erweitern keine technischen Faehigkeiten.')
      expect(generateContinuationPrompt(db, input).promptText).toBe(first)
      expect(db.serialize().equals(before)).toBe(true)
      expect(db.prepare('SELECT * FROM continuation_snapshots WHERE id = ?').get(snapshot.id)).toEqual(storedSnapshot)
      for (const table of ['sessions', 'continuation_snapshots']) {
        const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>
        expect(columns.map((column) => column.name)).not.toContain('rules_version_id')
        expect(columns.map((column) => column.name)).not.toContain('rulesVersionId')
      }
    } finally { db.close() }
  })

  it('preserves exact legacy output with no Rules, including when another project has Rules', () => {
    const db = createTestDb()
    try {
      const project = newProject(db)
      const session = newSession(db, project.id)
      const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT')
      const input = { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' as const }
      const legacy = generateContinuationPrompt(db, input).promptText
      expect(legacy).toBe([
        '## 1. Projekt und Provider\nProjekt: Projekt\nProvider: CHATGPT',
        '## 2. Aktuelle Aufgabe\nKeine',
        '## 3. Bestaetigt erledigt\nKeine',
        '## 4. Noch offen\nKeine',
        '## 5. Blocker\nKeine',
        '## 6. Letzter vollstaendiger Abschnitt\nKeine',
        '## 7. Fehlende Abschnitte\nKeine',
        '## 8. Naechster exakter Schritt\nKeine',
        '## 9. Zusaetzliche menschliche Handlung\nKeine',
        '## 10. Benoetigte Dateien\nKeine',
        '## 11. Arbeitsregeln fuer die Fortsetzung\n' +
          '- Fruehrer Chatverlauf steht in dieser Sitzung nicht zur Verfuegung und darf nicht als vorhanden angenommen werden.\n' +
          '- Ausschliesslich der oben angegebene, bestaetigte Snapshot gilt als verbindlicher aktueller Stand.\n' +
          '- Bearbeite vorrangig die oben genannte "Aktuelle Aufgabe" und den "Naechsten exakten Schritt".\n' +
          '- Aendere keine bereits eingefrorenen/abgeschlossenen Arbeitsphasen ohne zwingenden technischen Grund.\n' +
          '- Beginne keine spaeteren, noch nicht freigegebenen Phasen.\n' +
          '- Nenne ausschliesslich tatsaechlich beobachtete Ergebnisse und Arbeitsstaende - keine erfundenen Testergebnisse oder Arbeitsstaende.'
      ].join('\n\n'))
      const other = newProject(db, 'Other')
      createRuleVersion(db, { projectId: other.id, contentMarkdown: 'OTHER_PROJECT_RULES', createdBy: 'LEON' })
      expect(generateContinuationPrompt(db, input).promptText).toBe(legacy)
      createRuleVersion(db, { projectId: project.id, contentMarkdown: '', createdBy: 'LEON' })
      const withEmptyRules = generateContinuationPrompt(db, input).promptText
      expect(withEmptyRules).toMatch(/^PROJECT RULES\n/)
      expect(withEmptyRules).toContain(`\n\n\n\n---\n\n${legacy}`)
      expect(withEmptyRules).not.toContain('# Architecture')
    } finally { db.close() }
  })

  it.each([
    'sk-' + 'testSecretValue1234567890ABCDEF',
    'password: testOnlySensitiveValue',
    'Authorization: Bearer testOnlyToken1234567890',
    '-----BEGIN ' + 'PRIVATE KEY-----'
  ])('rejects sensitive current Rules safely (%#)', (sensitiveRules) => {
    const db = createTestDb()
    try {
      const project = newProject(db)
      const session = newSession(db, project.id)
      const snapshot = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT')
      createRuleVersion(db, { projectId: project.id, contentMarkdown: sensitiveRules, createdBy: 'LEON' })
      const before = db.serialize()
      let caught: unknown
      try {
        generateContinuationPrompt(db, { sessionId: session.id, snapshotId: snapshot.id, provider: 'CHATGPT' })
      } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(ContinuationError)
      expect(caught).toMatchObject({ code: 'PROMPT_CONTAINS_SENSITIVE_CONTENT' })
      expect((caught as Error).message).toContain('projectRules')
      expect((caught as Error).message).not.toContain(sensitiveRules)
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      const mapped = toIpcError('prompts:generateContinuation', caught, logger as unknown as FileLogger)
      expect(mapped).toMatchObject({ ok: false, error: { code: 'PROMPT_CONTAINS_SENSITIVE_CONTENT' } })
      expect(JSON.stringify([mapped, logger.info.mock.calls, logger.error.mock.calls])).not.toContain(sensitiveRules)
      expect(db.serialize().equals(before)).toBe(true)
    } finally { db.close() }
  })

  it('includes all 50000 Rules characters at the exact final limit and rejects one character over it', () => {
    const db = createTestDb()
    try {
      const project = newProject(db)
      const session = newSession(db, project.id)
      const rules = 'RULES_START' + 'R'.repeat(50_000 - 'RULES_START'.length - 'RULES_END!'.length) + 'RULES_END!'
      expect(rules.length).toBe(50_000)
      createRuleVersion(db, { projectId: project.id, contentMarkdown: rules, createdBy: 'LEON' })
      const seed = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', { currentTask: 'X' })
      const seedText = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: seed.id, provider: 'CHATGPT' }).promptText
      const taskLength = CONTINUATION_PROMPT_MAX_LENGTH - seedText.length + 1
      const boundary = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', { currentTask: 'X'.repeat(taskLength) })
      const exact = generateContinuationPrompt(db, { sessionId: session.id, snapshotId: boundary.id, provider: 'CHATGPT' }).promptText
      expect(exact.length).toBe(CONTINUATION_PROMPT_MAX_LENGTH)
      expect(exact).toContain(`\n\n${rules}\n\n---\n\n`)
      const oversized = newConfirmedSnapshot(db, project.id, session.id, 'CHATGPT', { currentTask: 'X'.repeat(taskLength + 1) })
      const before = db.serialize()
      expect(() => generateContinuationPrompt(db, { sessionId: session.id, snapshotId: oversized.id, provider: 'CHATGPT' }))
        .toThrow(expect.objectContaining({ code: 'PROMPT_TOO_LARGE' }))
      expect(db.serialize().equals(before)).toBe(true)
    } finally { db.close() }
  })

  it('keeps provider and confirmation rejection ahead of Rules inclusion', () => {
    const db = createTestDb()
    try {
      const project = newProject(db)
      const session = newSession(db, project.id)
      const draft = createDraftSnapshot(db, { projectId: project.id, sessionId: session.id, provider: 'CHATGPT', createdBy: 'LEON' })
      createRuleVersion(db, { projectId: project.id, contentMarkdown: 'password: testOnlyValue', createdBy: 'LEON' })
      expect(() => generateContinuationPrompt(db, { sessionId: session.id, snapshotId: draft.id, provider: 'CLAUDE' }))
        .toThrow(expect.objectContaining({ code: 'PROVIDER_MISMATCH' }))
      expect(() => generateContinuationPrompt(db, { sessionId: session.id, snapshotId: draft.id, provider: 'CHATGPT' }))
        .toThrow(expect.objectContaining({ code: 'SNAPSHOT_NOT_CONFIRMED' }))
    } finally { db.close() }
  })
})
