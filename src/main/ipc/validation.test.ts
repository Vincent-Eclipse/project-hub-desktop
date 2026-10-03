import { describe, expect, it } from 'vitest'
import {
  CONTEXT_MARKDOWN_MAX_LENGTH,
  LOCAL_PATH_MAX_LENGTH,
  PROJECT_SHORT_FIELD_MAX_LENGTH,
  REQUIRED_FILE_DISPLAY_NAME_MAX_LENGTH,
  RESPONSE_IMPORT_MAX_LENGTH,
  SESSION_STATUSES,
  SESSION_TITLE_MAX_LENGTH,
  SNAPSHOT_LIST_ITEM_MAX_LENGTH,
  SNAPSHOT_LIST_MAX_ITEMS,
  SNAPSHOT_REASON_CODES
} from '@shared/types'
import {
  ValidationError,
  validateAddChatMessageInput,
  validateAssignChatMessageToSessionInput,
  validateConfirmSnapshotInput,
  validateCreateContextVersionInput,
  validateCreateContinuationSessionInput,
  validateCreateDraftSnapshotInput,
  validateCreateProjectInput,
  validateCreateSessionInput,
  validateDiffInput,
  validateGenerateContinuationPromptInput,
  validateGeneratePromptInput,
  validateGetContextVersionInput,
  validateGetSnapshotInput,
  validateHttpsUrl,
  validateIdInput,
  validateListSnapshotsInput,
  validateOpenExternalInput,
  validateResponseImportAnalyzeInput,
  validateResponseImportApplyInput,
  validateSessionIdInput,
  validateSessionProjectInput,
  validateUpdateProjectInput,
  validateUpdateSessionInput,
  validateUpdateSettingsInput
} from './validation'
import { IpcChannels } from '@shared/ipcChannels'
import { ResponseImportError } from '../services/responseImportErrors'
import type { ResponseImportSelectedActions } from '@shared/types'

describe('validateCreateProjectInput', () => {
  it('akzeptiert gueltige Eingaben mit allen Pflichtfeldern', () => {
    const result = validateCreateProjectInput({ name: 'Airport Career', projectType: 'Roblox', description: 'Test' })
    expect(result.name).toBe('Airport Career')
    expect(result.projectType).toBe('Roblox')
  })

  it('lehnt fehlenden Namen ab', () => {
    expect(() => validateCreateProjectInput({ projectType: 'Roblox', description: 'Test' })).toThrow(ValidationError)
  })

  it('lehnt fehlenden oder leeren Projekttyp ab', () => {
    expect(() => validateCreateProjectInput({ name: 'Test', description: '' })).toThrow(ValidationError)
    expect(() => validateCreateProjectInput({ name: 'Test', projectType: '   ', description: '' })).toThrow(
      ValidationError
    )
  })

  it('lehnt leeren Namen ab', () => {
    expect(() => validateCreateProjectInput({ name: '   ', projectType: 'Roblox', description: '' })).toThrow(
      ValidationError
    )
  })

  it('lehnt nicht-Objekt-Eingaben ab', () => {
    expect(() => validateCreateProjectInput('not an object')).toThrow(ValidationError)
    expect(() => validateCreateProjectInput(null)).toThrow(ValidationError)
    expect(() => validateCreateProjectInput(['array'])).toThrow(ValidationError)
  })

  it('lehnt HUMAN als nextActor ab (durch LEON ersetzt)', () => {
    expect(() =>
      validateCreateProjectInput({ name: 'Test', projectType: 'Typ', description: '', nextActor: 'HUMAN' })
    ).toThrow(ValidationError)
  })

  it('akzeptiert LEON als nextActor', () => {
    const result = validateCreateProjectInput({
      name: 'Test',
      projectType: 'Typ',
      description: '',
      nextActor: 'LEON'
    })
    expect(result.nextActor).toBe('LEON')
  })

  it('akzeptiert einen optionalen Projektordner-Pfad', () => {
    const result = validateCreateProjectInput({
      name: 'Test',
      projectType: 'Typ',
      description: '',
      folderPath: 'C:\\Projekte\\Airport Career'
    })
    expect(result.folderPath).toBe('C:\\Projekte\\Airport Career')
  })

  it('laesst einen fehlenden Projektordner-Pfad weg, statt einen leeren String zu erzeugen', () => {
    const result = validateCreateProjectInput({ name: 'Test', projectType: 'Typ', description: '' })
    expect(result.folderPath).toBeUndefined()
  })
})

describe('validateUpdateProjectInput', () => {
  it('lehnt ungueltige Status-Werte ab (Exploit-Schutz gegen beliebige Strings)', () => {
    expect(() => validateUpdateProjectInput({ id: 1, status: 'HACKED' })).toThrow(ValidationError)
  })

  it('akzeptiert gueltige Status-Werte', () => {
    const result = validateUpdateProjectInput({ id: 1, status: 'ACTIVE' })
    expect(result.status).toBe('ACTIVE')
  })

  it('lehnt negative oder nicht-ganzzahlige IDs ab', () => {
    expect(() => validateUpdateProjectInput({ id: -1 })).toThrow(ValidationError)
    expect(() => validateUpdateProjectInput({ id: 1.5 })).toThrow(ValidationError)
    expect(() => validateUpdateProjectInput({ id: '1' })).toThrow(ValidationError)
  })

  it('folderPath: null wird als "explizit entfernen" unterschieden von "nicht angegeben"', () => {
    const cleared = validateUpdateProjectInput({ id: 1, folderPath: null })
    expect(cleared.folderPath).toBeNull()

    const untouched = validateUpdateProjectInput({ id: 1, name: 'Neuer Name' })
    expect('folderPath' in untouched).toBe(false)
  })

  it('lehnt einen leeren String als folderPath ab (dafuer ist null vorgesehen)', () => {
    expect(() => validateUpdateProjectInput({ id: 1, folderPath: '' })).toThrow(ValidationError)
  })
})

describe('validateIdInput', () => {
  it('akzeptiert positive Ganzzahlen', () => {
    expect(validateIdInput({ id: 42 })).toBe(42)
  })
  it('lehnt 0 und negative Werte ab', () => {
    expect(() => validateIdInput({ id: 0 })).toThrow(ValidationError)
    expect(() => validateIdInput({ id: -5 })).toThrow(ValidationError)
  })
})

describe('validateAddChatMessageInput', () => {
  it('lehnt ungueltige Autoren ab', () => {
    expect(() =>
      validateAddChatMessageInput({ projectId: 1, author: 'SOMETHING_ELSE', content: 'Test' })
    ).toThrow(ValidationError)
  })

  it('lehnt HUMAN ab (durch LEON ersetzt)', () => {
    expect(() => validateAddChatMessageInput({ projectId: 1, author: 'HUMAN', content: 'Test' })).toThrow(
      ValidationError
    )
  })

  it('akzeptiert LEON, CHATGPT, CLAUDE und SYSTEM als Autor', () => {
    for (const author of ['LEON', 'CHATGPT', 'CLAUDE', 'SYSTEM']) {
      expect(validateAddChatMessageInput({ projectId: 1, author, content: 'Test' }).author).toBe(author)
    }
  })

  it('lehnt leeren Inhalt ab', () => {
    expect(() => validateAddChatMessageInput({ projectId: 1, author: 'LEON', content: '' })).toThrow(
      ValidationError
    )
  })

  it('laesst sessionId weg, wenn es fehlt', () => {
    const input = validateAddChatMessageInput({ projectId: 1, author: 'LEON', content: 'Test' })
    expect('sessionId' in input).toBe(false)
  })

  it('behaelt sessionId: null bei', () => {
    const input = validateAddChatMessageInput({ projectId: 1, author: 'LEON', content: 'Test', sessionId: null })
    expect(input.sessionId).toBeNull()
  })

  it('uebernimmt eine positive sessionId', () => {
    const input = validateAddChatMessageInput({ projectId: 1, author: 'LEON', content: 'Test', sessionId: 7 })
    expect(input.sessionId).toBe(7)
  })

  it('lehnt eine ungueltige sessionId ab', () => {
    for (const invalid of [0, -1, 1.5, 'x', {}]) {
      expect(() =>
        validateAddChatMessageInput({ projectId: 1, author: 'LEON', content: 'Test', sessionId: invalid })
      ).toThrow(ValidationError)
    }
  })
})

describe('validateCreateContextVersionInput', () => {
  it('verlangt einen gueltigen Ersteller', () => {
    expect(() =>
      validateCreateContextVersionInput({ projectId: 1, contentMarkdown: 'Text', createdBy: 'UNBEKANNT' })
    ).toThrow(ValidationError)
  })

  it('akzeptiert LEON, CHATGPT, CLAUDE und SYSTEM als Ersteller', () => {
    for (const createdBy of ['LEON', 'CHATGPT', 'CLAUDE', 'SYSTEM']) {
      const result = validateCreateContextVersionInput({ projectId: 1, contentMarkdown: 'Text', createdBy })
      expect(result.createdBy).toBe(createdBy)
    }
  })

  it('verlangt zwingend einen Ersteller (kein Default)', () => {
    expect(() => validateCreateContextVersionInput({ projectId: 1, contentMarkdown: 'Text' })).toThrow(
      ValidationError
    )
  })
})

describe('validateGetContextVersionInput', () => {
  it('verlangt sowohl projectId als auch versionId', () => {
    expect(() => validateGetContextVersionInput({ versionId: 1 })).toThrow(ValidationError)
    expect(() => validateGetContextVersionInput({ projectId: 1 })).toThrow(ValidationError)
  })

  it('akzeptiert ein gueltiges projectId/versionId-Paar', () => {
    const result = validateGetContextVersionInput({ projectId: 1, versionId: 2 })
    expect(result).toEqual({ projectId: 1, versionId: 2 })
  })

  it('lehnt nicht-Objekt-Eingaben ab', () => {
    expect(() => validateGetContextVersionInput('kein Objekt')).toThrow(ValidationError)
  })
})

describe('validateDiffInput', () => {
  it('verlangt projectId zusaetzlich zu fromVersionId und toVersionId', () => {
    expect(() => validateDiffInput({ fromVersionId: 1, toVersionId: 2 })).toThrow(ValidationError)
  })

  it('akzeptiert ein gueltiges Tripel', () => {
    const result = validateDiffInput({ projectId: 1, fromVersionId: 2, toVersionId: 3 })
    expect(result).toEqual({ projectId: 1, fromVersionId: 2, toVersionId: 3 })
  })
})

describe('validateGeneratePromptInput', () => {
  it('verlangt eine nicht leere konkrete Aufgabe', () => {
    expect(() =>
      validateGeneratePromptInput({ projectId: 1, role: 'CHATGPT', concreteTask: '' })
    ).toThrow(ValidationError)
    expect(() =>
      validateGeneratePromptInput({ projectId: 1, role: 'CHATGPT', concreteTask: '   ' })
    ).toThrow(ValidationError)
  })

  it('akzeptiert eine gueltige konkrete Aufgabe', () => {
    const result = validateGeneratePromptInput({
      projectId: 1,
      role: 'CLAUDE',
      concreteTask: 'Plane jetzt Schritt 7.'
    })
    expect(result.concreteTask).toBe('Plane jetzt Schritt 7.')
  })
})

describe('validateHttpsUrl / validateOpenExternalInput', () => {
  it('akzeptiert gueltige https-URLs', () => {
    expect(validateHttpsUrl('https://chat.openai.com', 'url')).toBe('https://chat.openai.com')
  })

  it('lehnt http (unverschluesselt) ab', () => {
    expect(() => validateHttpsUrl('http://example.com', 'url')).toThrow(ValidationError)
  })

  it('lehnt javascript:-URIs ab (Exploit-Schutz)', () => {
    expect(() => validateHttpsUrl('javascript:alert(1)', 'url')).toThrow(ValidationError)
  })

  it('lehnt file:-URIs ab (Exploit-Schutz)', () => {
    expect(() => validateHttpsUrl('file:///etc/passwd', 'url')).toThrow(ValidationError)
  })

  it('lehnt data:-URIs ab (Exploit-Schutz)', () => {
    expect(() => validateHttpsUrl('data:text/html,<script>alert(1)</script>', 'url')).toThrow(
      ValidationError
    )
  })

  it('validateOpenExternalInput verlangt ein Objekt mit url-Feld', () => {
    expect(() => validateOpenExternalInput('https://example.com')).toThrow(ValidationError)
    expect(validateOpenExternalInput({ url: 'https://claude.ai' })).toBe('https://claude.ai')
  })
})

describe('validateUpdateSettingsInput', () => {
  it('lehnt unsichere URLs in den Einstellungen ab', () => {
    expect(() => validateUpdateSettingsInput({ chatgptUrl: 'javascript:alert(1)' })).toThrow(
      ValidationError
    )
  })

  it('erlaubt Teilaktualisierungen (nur einzelne Felder)', () => {
    const result = validateUpdateSettingsInput({ claudeUrl: 'https://claude.ai' })
    expect(result.claudeUrl).toBe('https://claude.ai')
    expect(result.chatgptUrl).toBeUndefined()
  })
})

describe('validateResponseImportAnalyzeInput / validateResponseImportApplyInput - exakte Fehlercodes (RC2-Korrektur)', () => {
  const FULL_SELECTION: ResponseImportSelectedActions = {
    saveHistory: true,
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

  it('analyze: leere Antwort liefert ResponseImportError mit Code EMPTY_RESPONSE (nicht VALIDATION_ERROR)', () => {
    let caught: unknown = null
    try {
      validateResponseImportAnalyzeInput({ projectId: 1, source: 'CLAUDE', rawResponse: '   ' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('EMPTY_RESPONSE')
  })

  it('apply: leere Antwort liefert EMPTY_RESPONSE', () => {
    let caught: unknown = null
    try {
      validateResponseImportApplyInput({
        projectId: 1,
        source: 'CLAUDE',
        rawResponse: '',
        fingerprint: 'abc',
        selectedActions: FULL_SELECTION
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('EMPTY_RESPONSE')
  })

  it('analyze: zu grosse Antwort liefert RESPONSE_TOO_LARGE', () => {
    let caught: unknown = null
    try {
      validateResponseImportAnalyzeInput({ projectId: 1, source: 'CLAUDE', rawResponse: 'x'.repeat(200_001) })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('RESPONSE_TOO_LARGE')
  })

  it('apply: zu grosse Antwort liefert RESPONSE_TOO_LARGE', () => {
    let caught: unknown = null
    try {
      validateResponseImportApplyInput({
        projectId: 1,
        source: 'CLAUDE',
        rawResponse: 'x'.repeat(200_001),
        fingerprint: 'abc',
        selectedActions: FULL_SELECTION
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('RESPONSE_TOO_LARGE')
  })

  it('analyze: ungültige Quelle liefert INVALID_SOURCE', () => {
    let caught: unknown = null
    try {
      validateResponseImportAnalyzeInput({ projectId: 1, source: 'GEMINI', rawResponse: 'Status: ACTIVE' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_SOURCE')
  })

  it('apply: ungültige Quelle liefert INVALID_SOURCE', () => {
    let caught: unknown = null
    try {
      validateResponseImportApplyInput({
        projectId: 1,
        source: 'GEMINI',
        rawResponse: 'Status: ACTIVE',
        fingerprint: 'abc',
        selectedActions: FULL_SELECTION
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('INVALID_SOURCE')
  })

  it('apply: nicht-boolesches Feld in selectedActions bleibt ein generischer VALIDATION_ERROR', () => {
    let caught: unknown = null
    try {
      validateResponseImportApplyInput({
        projectId: 1,
        source: 'CLAUDE',
        rawResponse: 'Status: ACTIVE',
        fingerprint: 'abc',
        selectedActions: { ...FULL_SELECTION, saveHistory: 'yes' }
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ValidationError)
    expect(caught).not.toBeInstanceOf(ResponseImportError)
  })

  it('bleibt beim generischen VALIDATION_ERROR fuer strukturell falsche Requests (kein Objekt, falscher projectId-Typ)', () => {
    expect(() => validateResponseImportAnalyzeInput('nicht ein objekt')).toThrow(ValidationError)
    expect(() =>
      validateResponseImportAnalyzeInput({ projectId: 'eins', source: 'CLAUDE', rawResponse: 'x' })
    ).toThrow(ValidationError)
    expect(() =>
      validateResponseImportApplyInput({
        projectId: 1,
        source: 'CLAUDE',
        rawResponse: 'x',
        fingerprint: 123,
        selectedActions: FULL_SELECTION
      })
    ).toThrow(ValidationError)
  })

  it('gültige Requests bleiben unveraendert nutzbar', () => {
    const analyzeResult = validateResponseImportAnalyzeInput({
      projectId: 1,
      source: 'CLAUDE',
      rawResponse: 'Status: ACTIVE'
    })
    expect(analyzeResult).toEqual({ projectId: 1, source: 'CLAUDE', rawResponse: 'Status: ACTIVE' })

    const applyResult = validateResponseImportApplyInput({
      projectId: 1,
      source: 'CLAUDE',
      rawResponse: 'Status: ACTIVE',
      fingerprint: 'abc123',
      selectedActions: FULL_SELECTION
    })
    expect(applyResult.selectedActions).toEqual(FULL_SELECTION)
  })
})

describe('validateResponseImportApplyInput - sessionId (Meilenstein 3)', () => {
  const FULL_SELECTION: ResponseImportSelectedActions = {
    saveHistory: true,
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

  it('laesst sessionId weg, wenn es fehlt (bisheriges Verhalten)', () => {
    const input = validateResponseImportApplyInput({
      projectId: 1,
      source: 'CLAUDE',
      rawResponse: 'Status: ACTIVE',
      fingerprint: 'abc123',
      selectedActions: FULL_SELECTION
    })
    expect('sessionId' in input).toBe(false)
  })

  it('behaelt sessionId: null bei', () => {
    const input = validateResponseImportApplyInput({
      projectId: 1,
      source: 'CLAUDE',
      rawResponse: 'Status: ACTIVE',
      fingerprint: 'abc123',
      selectedActions: FULL_SELECTION,
      sessionId: null
    })
    expect(input.sessionId).toBeNull()
  })

  it('uebernimmt eine positive sessionId', () => {
    const input = validateResponseImportApplyInput({
      projectId: 1,
      source: 'CLAUDE',
      rawResponse: 'Status: ACTIVE',
      fingerprint: 'abc123',
      selectedActions: FULL_SELECTION,
      sessionId: 3
    })
    expect(input.sessionId).toBe(3)
  })

  it('lehnt eine ungueltige sessionId ab', () => {
    for (const invalid of [0, -1, 1.5, 'x', {}]) {
      expect(() =>
        validateResponseImportApplyInput({
          projectId: 1,
          source: 'CLAUDE',
          rawResponse: 'Status: ACTIVE',
          fingerprint: 'abc123',
          selectedActions: FULL_SELECTION,
          sessionId: invalid
        })
      ).toThrow(ValidationError)
    }
  })
})

describe('Zentralisierte Laengenlimits (RC4-Korrektur)', () => {
  const FULL_SELECTION_EMPTY = {
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

  it('PROJECT_SHORT_FIELD_MAX_LENGTH ist weiterhin 500', () => {
    expect(PROJECT_SHORT_FIELD_MAX_LENGTH).toBe(500)
  })

  it('CONTEXT_MARKDOWN_MAX_LENGTH und RESPONSE_IMPORT_MAX_LENGTH sind weiterhin 200.000', () => {
    expect(CONTEXT_MARKDOWN_MAX_LENGTH).toBe(200_000)
    expect(RESPONSE_IMPORT_MAX_LENGTH).toBe(200_000)
  })

  it('normale Projektvalidierung (projectType) akzeptiert weiterhin genau PROJECT_SHORT_FIELD_MAX_LENGTH Zeichen', () => {
    const value = 'x'.repeat(PROJECT_SHORT_FIELD_MAX_LENGTH)
    const input = validateCreateProjectInput({ name: 'P', projectType: value })
    expect(input.projectType).toBe(value)
  })

  it('normale Projektvalidierung (projectType) lehnt PROJECT_SHORT_FIELD_MAX_LENGTH + 1 Zeichen ab', () => {
    const value = 'x'.repeat(PROJECT_SHORT_FIELD_MAX_LENGTH + 1)
    expect(() => validateCreateProjectInput({ name: 'P', projectType: value })).toThrow(ValidationError)
  })

  it('currentStep/nextAction (projects:update) akzeptieren weiterhin genau PROJECT_SHORT_FIELD_MAX_LENGTH Zeichen', () => {
    const value = 'x'.repeat(PROJECT_SHORT_FIELD_MAX_LENGTH)
    const input = validateUpdateProjectInput({ id: 1, currentStep: value, nextAction: value })
    expect(input.currentStep).toBe(value)
    expect(input.nextAction).toBe(value)
  })

  it('currentStep/nextAction (projects:update) lehnen PROJECT_SHORT_FIELD_MAX_LENGTH + 1 Zeichen ab', () => {
    const value = 'x'.repeat(PROJECT_SHORT_FIELD_MAX_LENGTH + 1)
    expect(() => validateUpdateProjectInput({ id: 1, currentStep: value })).toThrow(ValidationError)
    expect(() => validateUpdateProjectInput({ id: 1, nextAction: value })).toThrow(ValidationError)
  })

  it('Kontextvalidierung (prompts:generate concreteTask) akzeptiert weiterhin genau CONTEXT_MARKDOWN_MAX_LENGTH Zeichen', () => {
    const value = 'x'.repeat(CONTEXT_MARKDOWN_MAX_LENGTH)
    const input = validateGeneratePromptInput({ projectId: 1, role: 'CLAUDE', concreteTask: value })
    expect(input.concreteTask).toBe(value)
  })

  it('Kontextvalidierung (prompts:generate concreteTask) lehnt CONTEXT_MARKDOWN_MAX_LENGTH + 1 Zeichen ab', () => {
    const value = 'x'.repeat(CONTEXT_MARKDOWN_MAX_LENGTH + 1)
    expect(() => validateGeneratePromptInput({ projectId: 1, role: 'CLAUDE', concreteTask: value })).toThrow(
      ValidationError
    )
  })

  it('Importvalidierung (responseImport:analyze) verwendet denselben Wert wie RESPONSE_IMPORT_MAX_LENGTH', () => {
    const ok = 'x'.repeat(RESPONSE_IMPORT_MAX_LENGTH)
    const input = validateResponseImportAnalyzeInput({ projectId: 1, source: 'CLAUDE', rawResponse: ok })
    expect(input.rawResponse).toBe(ok)

    const tooLong = 'x'.repeat(RESPONSE_IMPORT_MAX_LENGTH + 1)
    let caught: unknown = null
    try {
      validateResponseImportAnalyzeInput({ projectId: 1, source: 'CLAUDE', rawResponse: tooLong })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResponseImportError)
    expect((caught as ResponseImportError).code).toBe('RESPONSE_TOO_LARGE')
  })

  it('Importvalidierung (responseImport:apply) verwendet denselben Wert wie RESPONSE_IMPORT_MAX_LENGTH', () => {
    const ok = 'x'.repeat(RESPONSE_IMPORT_MAX_LENGTH)
    const input = validateResponseImportApplyInput({
      projectId: 1,
      source: 'CLAUDE',
      rawResponse: ok,
      fingerprint: 'abc',
      selectedActions: FULL_SELECTION_EMPTY
    })
    expect(input.rawResponse).toBe(ok)
  })
})

describe('validateSessionIdInput / validateSessionProjectInput', () => {
  it('akzeptiert eine positive Ganzzahl', () => {
    expect(validateSessionIdInput({ sessionId: 5 }).sessionId).toBe(5)
    expect(validateSessionProjectInput({ projectId: 5 }).projectId).toBe(5)
  })

  it.each([0, -1, 1.5, 'x'])('lehnt %s ab', (invalid) => {
    expect(() => validateSessionIdInput({ sessionId: invalid })).toThrow(ValidationError)
    expect(() => validateSessionProjectInput({ projectId: invalid })).toThrow(ValidationError)
  })
})

describe('validateCreateSessionInput', () => {
  it('akzeptiert ein minimales gueltiges Objekt', () => {
    const input = validateCreateSessionInput({ projectId: 1, provider: 'CHATGPT' })
    expect(input.projectId).toBe(1)
    expect(input.provider).toBe('CHATGPT')
    expect(input.title).toBeUndefined()
  })

  it('akzeptiert ein vollstaendiges gueltiges Objekt', () => {
    const input = validateCreateSessionInput({
      projectId: 1,
      provider: 'CLAUDE',
      title: 'Titel',
      status: 'PAUSED',
      currentTask: 'Aufgabe',
      notes: 'Notiz',
      masterContextVersionId: 3
    })
    expect(input).toEqual({
      projectId: 1,
      provider: 'CLAUDE',
      title: 'Titel',
      status: 'PAUSED',
      currentTask: 'Aufgabe',
      notes: 'Notiz',
      masterContextVersionId: 3
    })
  })

  it.each(['CHATGPT', 'CLAUDE'])('akzeptiert Provider %s', (provider) => {
    expect(validateCreateSessionInput({ projectId: 1, provider }).provider).toBe(provider)
  })

  it('lehnt einen unbekannten Provider ab', () => {
    expect(() => validateCreateSessionInput({ projectId: 1, provider: 'GEMINI' })).toThrow(ValidationError)
  })

  it.each(SESSION_STATUSES)('akzeptiert Status %s', (status) => {
    expect(validateCreateSessionInput({ projectId: 1, provider: 'CHATGPT', status }).status).toBe(status)
  })

  it('lehnt einen unbekannten Status ab', () => {
    expect(() =>
      validateCreateSessionInput({ projectId: 1, provider: 'CHATGPT', status: 'SLEEPING' })
    ).toThrow(ValidationError)
  })

  it('akzeptiert genau SESSION_TITLE_MAX_LENGTH Zeichen im Titel, lehnt einen Zeichen mehr ab', () => {
    const value = 'x'.repeat(SESSION_TITLE_MAX_LENGTH)
    expect(validateCreateSessionInput({ projectId: 1, provider: 'CHATGPT', title: value }).title).toBe(value)
    const tooLong = 'x'.repeat(SESSION_TITLE_MAX_LENGTH + 1)
    expect(() => validateCreateSessionInput({ projectId: 1, provider: 'CHATGPT', title: tooLong })).toThrow(
      ValidationError
    )
  })

  it('lehnt eine zu lange currentTask ab', () => {
    const value = 'x'.repeat(PROJECT_SHORT_FIELD_MAX_LENGTH + 1)
    expect(() => validateCreateSessionInput({ projectId: 1, provider: 'CHATGPT', currentTask: value })).toThrow(
      ValidationError
    )
  })

  it('lehnt zu lange notes ab', () => {
    const value = 'x'.repeat(CONTEXT_MARKDOWN_MAX_LENGTH + 1)
    expect(() => validateCreateSessionInput({ projectId: 1, provider: 'CHATGPT', notes: value })).toThrow(
      ValidationError
    )
  })

  it('akzeptiert masterContextVersionId: null', () => {
    const input = validateCreateSessionInput({ projectId: 1, provider: 'CHATGPT', masterContextVersionId: null })
    expect(input.masterContextVersionId).toBeNull()
  })

  it('akzeptiert eine positive masterContextVersionId', () => {
    const input = validateCreateSessionInput({ projectId: 1, provider: 'CHATGPT', masterContextVersionId: 9 })
    expect(input.masterContextVersionId).toBe(9)
  })

  it('lehnt eine ungueltige masterContextVersionId ab', () => {
    for (const invalid of [0, -1, 1.5, 'x']) {
      expect(() =>
        validateCreateSessionInput({ projectId: 1, provider: 'CHATGPT', masterContextVersionId: invalid })
      ).toThrow(ValidationError)
    }
  })
})

describe('validateUpdateSessionInput', () => {
  it('akzeptiert nur id', () => {
    expect(validateUpdateSessionInput({ id: 1 })).toEqual({ id: 1 })
  })

  it('uebernimmt optionale Felder korrekt', () => {
    const input = validateUpdateSessionInput({
      id: 1,
      title: 'Neu',
      currentTask: 'Aufgabe',
      notes: 'Notiz',
      status: 'PAUSED'
    })
    expect(input.title).toBe('Neu')
    expect(input.currentTask).toBe('Aufgabe')
    expect(input.notes).toBe('Notiz')
    expect(input.status).toBe('PAUSED')
  })

  it('behaelt null bei masterContextVersionId', () => {
    expect(validateUpdateSessionInput({ id: 1, masterContextVersionId: null }).masterContextVersionId).toBeNull()
  })

  it('lehnt einen ungueltigen Status ab', () => {
    expect(() => validateUpdateSessionInput({ id: 1, status: 'SLEEPING' })).toThrow(ValidationError)
  })
})

describe('validateCreateContinuationSessionInput', () => {
  it('akzeptiert den gueltigen Minimalfall', () => {
    const input = validateCreateContinuationSessionInput({
      fromSessionId: 1,
      provider: 'CHATGPT',
      basedOnSnapshotId: 2
    })
    expect(input).toEqual({ fromSessionId: 1, provider: 'CHATGPT', basedOnSnapshotId: 2 })
  })

  it('akzeptiert fromSessionFinalStatus PAUSED', () => {
    const input = validateCreateContinuationSessionInput({
      fromSessionId: 1,
      provider: 'CHATGPT',
      basedOnSnapshotId: 2,
      fromSessionFinalStatus: 'PAUSED'
    })
    expect(input.fromSessionFinalStatus).toBe('PAUSED')
  })

  it('akzeptiert fromSessionFinalStatus COMPLETED', () => {
    const input = validateCreateContinuationSessionInput({
      fromSessionId: 1,
      provider: 'CHATGPT',
      basedOnSnapshotId: 2,
      fromSessionFinalStatus: 'COMPLETED'
    })
    expect(input.fromSessionFinalStatus).toBe('COMPLETED')
  })

  it.each(['ACTIVE', 'ABANDONED', 'irgendwas'])('lehnt fromSessionFinalStatus %s ab', (value) => {
    expect(() =>
      validateCreateContinuationSessionInput({
        fromSessionId: 1,
        provider: 'CHATGPT',
        basedOnSnapshotId: 2,
        fromSessionFinalStatus: value
      })
    ).toThrow(ValidationError)
  })

  it('lehnt eine ungueltige Snapshot-/Sitzungs-ID ab', () => {
    expect(() =>
      validateCreateContinuationSessionInput({ fromSessionId: 0, provider: 'CHATGPT', basedOnSnapshotId: 2 })
    ).toThrow(ValidationError)
    expect(() =>
      validateCreateContinuationSessionInput({ fromSessionId: 1, provider: 'CHATGPT', basedOnSnapshotId: -1 })
    ).toThrow(ValidationError)
  })
})

describe('validateAssignChatMessageToSessionInput', () => {
  it('akzeptiert ein gueltiges Paar', () => {
    expect(validateAssignChatMessageToSessionInput({ sessionId: 1, chatMessageId: 2 })).toEqual({
      sessionId: 1,
      chatMessageId: 2
    })
  })

  it('lehnt ungueltige IDs ab', () => {
    expect(() => validateAssignChatMessageToSessionInput({ sessionId: 0, chatMessageId: 2 })).toThrow(
      ValidationError
    )
    expect(() => validateAssignChatMessageToSessionInput({ sessionId: 1, chatMessageId: 'x' })).toThrow(
      ValidationError
    )
  })
})

describe('IpcChannels - Snapshot-Kanaele (Vertragspruefung)', () => {
  it('definiert alle vier Snapshot-Kanaele mit den erwarteten, eindeutigen Werten', () => {
    expect(IpcChannels.snapshotsList).toBe('snapshots:list')
    expect(IpcChannels.snapshotsGet).toBe('snapshots:get')
    expect(IpcChannels.snapshotsCreateDraft).toBe('snapshots:createDraft')
    expect(IpcChannels.snapshotsConfirm).toBe('snapshots:confirm')

    const allValues = Object.values(IpcChannels)
    expect(new Set(allValues).size).toBe(allValues.length)
  })
})

describe('validateListSnapshotsInput / validateGetSnapshotInput', () => {
  it('akzeptiert gueltige IDs', () => {
    expect(validateListSnapshotsInput({ projectId: 1, sessionId: 2 })).toEqual({ projectId: 1, sessionId: 2 })
    expect(validateGetSnapshotInput({ projectId: 1, sessionId: 2, snapshotId: 3 })).toEqual({
      projectId: 1,
      sessionId: 2,
      snapshotId: 3
    })
  })

  it('lehnt fehlende IDs ab', () => {
    expect(() => validateListSnapshotsInput({ projectId: 1 })).toThrow(ValidationError)
    expect(() => validateListSnapshotsInput({ sessionId: 1 })).toThrow(ValidationError)
    expect(() => validateGetSnapshotInput({ projectId: 1, sessionId: 2 })).toThrow(ValidationError)
  })

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, '5'])(
    'lehnt %s fuer projectId, sessionId und snapshotId ab',
    (invalid) => {
      expect(() => validateListSnapshotsInput({ projectId: invalid, sessionId: 1 })).toThrow(ValidationError)
      expect(() => validateListSnapshotsInput({ projectId: 1, sessionId: invalid })).toThrow(ValidationError)
      expect(() => validateGetSnapshotInput({ projectId: invalid, sessionId: 1, snapshotId: 1 })).toThrow(
        ValidationError
      )
      expect(() => validateGetSnapshotInput({ projectId: 1, sessionId: invalid, snapshotId: 1 })).toThrow(
        ValidationError
      )
      expect(() => validateGetSnapshotInput({ projectId: 1, sessionId: 1, snapshotId: invalid })).toThrow(
        ValidationError
      )
    }
  )
})

describe('validateCreateDraftSnapshotInput', () => {
  it('akzeptiert ein minimales gueltiges Input', () => {
    const input = validateCreateDraftSnapshotInput({
      projectId: 1,
      sessionId: 2,
      provider: 'CHATGPT',
      createdBy: 'LEON'
    })
    expect(input).toEqual({ projectId: 1, sessionId: 2, provider: 'CHATGPT', createdBy: 'LEON' })
  })

  it('akzeptiert ein vollstaendiges gueltiges Input', () => {
    const input = validateCreateDraftSnapshotInput({
      projectId: 1,
      sessionId: 2,
      provider: 'CLAUDE',
      masterContextVersionId: 5,
      currentTask: 'Aufgabe',
      confirmedDone: ['a', 'b'],
      confirmedOpen: ['c'],
      blockers: ['d'],
      lastCompleteSection: 'Abschnitt',
      missingSections: ['e'],
      nextExactStep: 'Schritt',
      additionalHumanAction: 'Aktion',
      reasonCode: 'LIMIT_REACHED',
      createdBy: 'CLAUDE',
      requiredFiles: [{ displayName: 'Datei' }]
    })
    expect(input.masterContextVersionId).toBe(5)
    expect(input.currentTask).toBe('Aufgabe')
    expect(input.confirmedDone).toEqual(['a', 'b'])
    expect(input.confirmedOpen).toEqual(['c'])
    expect(input.blockers).toEqual(['d'])
    expect(input.lastCompleteSection).toBe('Abschnitt')
    expect(input.missingSections).toEqual(['e'])
    expect(input.nextExactStep).toBe('Schritt')
    expect(input.additionalHumanAction).toBe('Aktion')
    expect(input.reasonCode).toBe('LIMIT_REACHED')
    expect(input.createdBy).toBe('CLAUDE')
    expect(input.requiredFiles).toEqual([{ displayName: 'Datei' }])
  })

  it.each(['CHATGPT', 'CLAUDE'])('akzeptiert Provider %s', (provider) => {
    expect(
      validateCreateDraftSnapshotInput({ projectId: 1, sessionId: 2, provider, createdBy: 'LEON' }).provider
    ).toBe(provider)
  })

  it('lehnt einen ungueltigen Provider ab', () => {
    expect(() =>
      validateCreateDraftSnapshotInput({ projectId: 1, sessionId: 2, provider: 'GEMINI', createdBy: 'LEON' })
    ).toThrow(ValidationError)
  })

  it.each(SNAPSHOT_REASON_CODES)('akzeptiert reasonCode %s', (reasonCode) => {
    expect(
      validateCreateDraftSnapshotInput({
        projectId: 1,
        sessionId: 2,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        reasonCode
      }).reasonCode
    ).toBe(reasonCode)
  })

  it('lehnt einen ungueltigen reasonCode ab', () => {
    expect(() =>
      validateCreateDraftSnapshotInput({
        projectId: 1,
        sessionId: 2,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        reasonCode: 'UNBEKANNT'
      })
    ).toThrow(ValidationError)
  })

  it.each(['LEON', 'CHATGPT', 'CLAUDE', 'SYSTEM'])('akzeptiert Actor %s als createdBy', (actor) => {
    expect(
      validateCreateDraftSnapshotInput({ projectId: 1, sessionId: 2, provider: 'CHATGPT', createdBy: actor })
        .createdBy
    ).toBe(actor)
  })

  it('lehnt einen ungueltigen Actor als createdBy ab', () => {
    expect(() =>
      validateCreateDraftSnapshotInput({ projectId: 1, sessionId: 2, provider: 'CHATGPT', createdBy: 'HUMAN' })
    ).toThrow(ValidationError)
  })

  it('laesst masterContextVersionId weg, wenn es fehlt', () => {
    const input = validateCreateDraftSnapshotInput({
      projectId: 1,
      sessionId: 2,
      provider: 'CHATGPT',
      createdBy: 'LEON'
    })
    expect('masterContextVersionId' in input).toBe(false)
  })

  it('behaelt masterContextVersionId: null bei', () => {
    const input = validateCreateDraftSnapshotInput({
      projectId: 1,
      sessionId: 2,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      masterContextVersionId: null
    })
    expect(input.masterContextVersionId).toBeNull()
  })

  it('lehnt eine ungueltige masterContextVersionId ab', () => {
    for (const invalid of [0, -1, 1.5, 'x']) {
      expect(() =>
        validateCreateDraftSnapshotInput({
          projectId: 1,
          sessionId: 2,
          provider: 'CHATGPT',
          createdBy: 'LEON',
          masterContextVersionId: invalid
        })
      ).toThrow(ValidationError)
    }
  })

  it('akzeptiert korrekte Stringlisten, inklusive einer leeren Liste', () => {
    const input = validateCreateDraftSnapshotInput({
      projectId: 1,
      sessionId: 2,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      confirmedDone: ['a', 'b'],
      confirmedOpen: [],
      blockers: ['c'],
      missingSections: ['d']
    })
    expect(input.confirmedDone).toEqual(['a', 'b'])
    expect(input.confirmedOpen).toEqual([])
  })

  it('lehnt ein Nicht-String-Element in einer Liste ab', () => {
    expect(() =>
      validateCreateDraftSnapshotInput({
        projectId: 1,
        sessionId: 2,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        confirmedDone: ['gut', 5]
      })
    ).toThrow(ValidationError)
  })

  it('lehnt ein Nicht-Array fuer ein Listenfeld ab', () => {
    expect(() =>
      validateCreateDraftSnapshotInput({
        projectId: 1,
        sessionId: 2,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        confirmedDone: 'kein-array'
      })
    ).toThrow(ValidationError)
  })

  it('lehnt zu viele Listenelemente ab', () => {
    const tooMany = Array.from({ length: SNAPSHOT_LIST_MAX_ITEMS + 1 }, (_, i) => `Eintrag ${i}`)
    expect(() =>
      validateCreateDraftSnapshotInput({
        projectId: 1,
        sessionId: 2,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        blockers: tooMany
      })
    ).toThrow(ValidationError)
  })

  it('akzeptiert ein Textfeld bis genau zur Grenze und lehnt ein Zeichen mehr ab', () => {
    const atLimit = 'x'.repeat(SNAPSHOT_LIST_ITEM_MAX_LENGTH)
    const overLimit = 'x'.repeat(SNAPSHOT_LIST_ITEM_MAX_LENGTH + 1)
    expect(
      validateCreateDraftSnapshotInput({
        projectId: 1,
        sessionId: 2,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        currentTask: atLimit
      }).currentTask
    ).toBe(atLimit)
    expect(() =>
      validateCreateDraftSnapshotInput({
        projectId: 1,
        sessionId: 2,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        currentTask: overLimit
      })
    ).toThrow(ValidationError)
  })

  it('lehnt ein zu langes Listenelement ab', () => {
    const overLimit = 'x'.repeat(SNAPSHOT_LIST_ITEM_MAX_LENGTH + 1)
    expect(() =>
      validateCreateDraftSnapshotInput({
        projectId: 1,
        sessionId: 2,
        provider: 'CHATGPT',
        createdBy: 'LEON',
        confirmedDone: [overLimit]
      })
    ).toThrow(ValidationError)
  })
})

describe('validateCreateDraftSnapshotInput - requiredFiles', () => {
  function withFiles(requiredFiles: unknown) {
    return validateCreateDraftSnapshotInput({
      projectId: 1,
      sessionId: 2,
      provider: 'CHATGPT',
      createdBy: 'LEON',
      requiredFiles
    })
  }

  it('akzeptiert ein minimales gueltiges Required File', () => {
    const input = withFiles([{ displayName: 'Datei' }])
    expect(input.requiredFiles).toEqual([{ displayName: 'Datei' }])
  })

  it('akzeptiert ein vollstaendiges gueltiges Required File', () => {
    const file = {
      displayName: 'Logdatei',
      expectedFilename: 'log.txt',
      sha256: 'a'.repeat(64),
      purpose: 'Fehleranalyse',
      isRequired: true,
      reuploadRequired: false,
      isSensitive: false,
      localPath: 'C:\\Users\\leon\\log.txt'
    }
    const input = withFiles([file])
    expect(input.requiredFiles).toEqual([file])
  })

  it('akzeptiert mehrere Dateien', () => {
    const input = withFiles([{ displayName: 'A' }, { displayName: 'B' }])
    expect(input.requiredFiles).toHaveLength(2)
  })

  it('akzeptiert eine leere Liste', () => {
    const input = withFiles([])
    expect(input.requiredFiles).toEqual([])
  })

  it('lehnt ein fehlendes displayName ab', () => {
    expect(() => withFiles([{}])).toThrow(ValidationError)
  })

  it('lehnt ein leeres displayName ab', () => {
    expect(() => withFiles([{ displayName: '   ' }])).toThrow(ValidationError)
  })

  it('lehnt ein displayName mit falschem Typ ab', () => {
    expect(() => withFiles([{ displayName: 5 }])).toThrow(ValidationError)
  })

  it('lehnt ein zu langes displayName ab', () => {
    expect(() => withFiles([{ displayName: 'x'.repeat(REQUIRED_FILE_DISPLAY_NAME_MAX_LENGTH + 1) }])).toThrow(
      ValidationError
    )
  })

  it('akzeptiert einen gueltigen SHA-256-Wert', () => {
    const input = withFiles([{ displayName: 'Datei', sha256: 'a'.repeat(64) }])
    expect(input.requiredFiles?.[0].sha256).toBe('a'.repeat(64))
  })

  it('akzeptiert sha256: null', () => {
    const input = withFiles([{ displayName: 'Datei', sha256: null }])
    expect(input.requiredFiles?.[0].sha256).toBeNull()
  })

  it('laesst sha256 weg, wenn es fehlt', () => {
    const input = withFiles([{ displayName: 'Datei' }])
    expect('sha256' in (input.requiredFiles?.[0] ?? {})).toBe(false)
  })

  it('lehnt einen zu kurzen SHA-256-Wert ab', () => {
    expect(() => withFiles([{ displayName: 'Datei', sha256: 'a'.repeat(63) }])).toThrow(ValidationError)
  })

  it('lehnt Grossbuchstaben im SHA-256-Wert ab', () => {
    expect(() => withFiles([{ displayName: 'Datei', sha256: 'A'.repeat(64) }])).toThrow(ValidationError)
  })

  it('lehnt Nicht-Hex-Zeichen im SHA-256-Wert ab', () => {
    expect(() => withFiles([{ displayName: 'Datei', sha256: 'g'.repeat(64) }])).toThrow(ValidationError)
  })

  it.each(['isRequired', 'reuploadRequired', 'isSensitive'])(
    'lehnt einen ungueltigen Boolean-Wert fuer %s ab',
    (field) => {
      expect(() => withFiles([{ displayName: 'Datei', [field]: 'ja' }])).toThrow(ValidationError)
    }
  )

  it('akzeptiert localPath als reinen String', () => {
    const input = withFiles([{ displayName: 'Datei', localPath: 'C:\\Users\\leon\\datei.txt' }])
    expect(input.requiredFiles?.[0].localPath).toBe('C:\\Users\\leon\\datei.txt')
  })

  it('akzeptiert localPath: null und lehnt einen zu langen localPath ab', () => {
    const input = withFiles([{ displayName: 'Datei', localPath: null }])
    expect(input.requiredFiles?.[0].localPath).toBeNull()
    expect(() => withFiles([{ displayName: 'Datei', localPath: 'x'.repeat(LOCAL_PATH_MAX_LENGTH + 1) }])).toThrow(
      ValidationError
    )
  })

  it('reicht keine technischen Felder wie id, snapshotId, interventionRevisionId oder createdAt durch', () => {
    const input = withFiles([
      {
        displayName: 'Datei',
        id: 999,
        snapshotId: 111,
        interventionRevisionId: 222,
        createdAt: '2020-01-01T00:00:00.000Z'
      }
    ])
    const file = input.requiredFiles?.[0] as unknown as Record<string, unknown>
    expect('id' in file).toBe(false)
    expect('snapshotId' in file).toBe(false)
    expect('interventionRevisionId' in file).toBe(false)
    expect('createdAt' in file).toBe(false)
  })
})

describe('validateConfirmSnapshotInput', () => {
  it('akzeptiert ein minimales gueltiges Input', () => {
    const input = validateConfirmSnapshotInput({ draftSnapshotId: 1, createdBy: 'LEON' })
    expect(input).toEqual({ draftSnapshotId: 1, createdBy: 'LEON' })
    expect('corrections' in input).toBe(false)
  })

  it('akzeptiert vollstaendige Korrekturen', () => {
    const input = validateConfirmSnapshotInput({
      draftSnapshotId: 1,
      createdBy: 'LEON',
      corrections: {
        currentTask: 'Neu',
        confirmedDone: ['a'],
        confirmedOpen: ['b'],
        blockers: ['c'],
        lastCompleteSection: 'Abschnitt',
        missingSections: ['d'],
        nextExactStep: 'Schritt',
        additionalHumanAction: 'Aktion',
        requiredFiles: [{ displayName: 'Datei' }]
      }
    })
    expect(input.corrections?.currentTask).toBe('Neu')
    expect(input.corrections?.confirmedDone).toEqual(['a'])
    expect(input.corrections?.confirmedOpen).toEqual(['b'])
    expect(input.corrections?.blockers).toEqual(['c'])
    expect(input.corrections?.lastCompleteSection).toBe('Abschnitt')
    expect(input.corrections?.missingSections).toEqual(['d'])
    expect(input.corrections?.nextExactStep).toBe('Schritt')
    expect(input.corrections?.additionalHumanAction).toBe('Aktion')
    expect(input.corrections?.requiredFiles).toEqual([{ displayName: 'Datei' }])
  })

  it('laesst corrections weg, wenn es fehlt', () => {
    const input = validateConfirmSnapshotInput({ draftSnapshotId: 1, createdBy: 'LEON' })
    expect('corrections' in input).toBe(false)
  })

  it('lehnt corrections ab, wenn es kein normales Objekt ist', () => {
    expect(() =>
      validateConfirmSnapshotInput({ draftSnapshotId: 1, createdBy: 'LEON', corrections: 'nope' })
    ).toThrow(ValidationError)
    expect(() => validateConfirmSnapshotInput({ draftSnapshotId: 1, createdBy: 'LEON', corrections: [] })).toThrow(
      ValidationError
    )
  })

  it('requiredFiles bleibt undefined, wenn es in corrections fehlt', () => {
    const input = validateConfirmSnapshotInput({ draftSnapshotId: 1, createdBy: 'LEON', corrections: {} })
    expect(input.corrections).toEqual({})
    expect('requiredFiles' in (input.corrections ?? {})).toBe(false)
  })

  it('uebernimmt corrections.requiredFiles mit Eintraegen', () => {
    const input = validateConfirmSnapshotInput({
      draftSnapshotId: 1,
      createdBy: 'LEON',
      corrections: { requiredFiles: [{ displayName: 'Datei A' }, { displayName: 'Datei B' }] }
    })
    expect(input.corrections?.requiredFiles).toHaveLength(2)
  })

  it('behaelt corrections.requiredFiles als ausdruecklich leeres Array bei', () => {
    const input = validateConfirmSnapshotInput({
      draftSnapshotId: 1,
      createdBy: 'LEON',
      corrections: { requiredFiles: [] }
    })
    expect(input.corrections?.requiredFiles).toEqual([])
  })

  it('lehnt corrections.requiredFiles: null ab', () => {
    expect(() =>
      validateConfirmSnapshotInput({ draftSnapshotId: 1, createdBy: 'LEON', corrections: { requiredFiles: null } })
    ).toThrow(ValidationError)
  })

  it('reicht keine unbekannten Korrekturfelder durch', () => {
    const input = validateConfirmSnapshotInput({
      draftSnapshotId: 1,
      createdBy: 'LEON',
      corrections: { currentTask: 'Neu', unbekanntesFeld: 'sollte verschwinden' }
    })
    expect('unbekanntesFeld' in (input.corrections ?? {})).toBe(false)
  })

  it('lehnt eine ungueltige draftSnapshotId ab', () => {
    for (const invalid of [0, -1, 1.5, 'x']) {
      expect(() => validateConfirmSnapshotInput({ draftSnapshotId: invalid, createdBy: 'LEON' })).toThrow(
        ValidationError
      )
    }
  })

  it('lehnt einen ungueltigen Actor als createdBy ab', () => {
    expect(() => validateConfirmSnapshotInput({ draftSnapshotId: 1, createdBy: 'HUMAN' })).toThrow(ValidationError)
  })
})

describe('IpcChannels - Fortsetzungsprompt-Kanal (Vertragspruefung)', () => {
  it('definiert prompts:generateContinuation mit dem erwarteten, eindeutigen Wert', () => {
    expect(IpcChannels.promptsGenerateContinuation).toBe('prompts:generateContinuation')

    const allValues = Object.values(IpcChannels)
    expect(new Set(allValues).size).toBe(allValues.length)
  })
})

describe('validateGenerateContinuationPromptInput', () => {
  it('akzeptiert eine gueltige CHATGPT-Eingabe', () => {
    expect(validateGenerateContinuationPromptInput({ sessionId: 1, snapshotId: 2, provider: 'CHATGPT' })).toEqual({
      sessionId: 1,
      snapshotId: 2,
      provider: 'CHATGPT'
    })
  })

  it('akzeptiert eine gueltige CLAUDE-Eingabe', () => {
    expect(validateGenerateContinuationPromptInput({ sessionId: 1, snapshotId: 2, provider: 'CLAUDE' })).toEqual({
      sessionId: 1,
      snapshotId: 2,
      provider: 'CLAUDE'
    })
  })

  it('lehnt eine fehlende sessionId ab', () => {
    expect(() => validateGenerateContinuationPromptInput({ snapshotId: 2, provider: 'CHATGPT' })).toThrow(
      ValidationError
    )
  })

  it('lehnt eine fehlende snapshotId ab', () => {
    expect(() => validateGenerateContinuationPromptInput({ sessionId: 1, provider: 'CHATGPT' })).toThrow(
      ValidationError
    )
  })

  it('lehnt einen fehlenden provider ab', () => {
    expect(() => validateGenerateContinuationPromptInput({ sessionId: 1, snapshotId: 2 })).toThrow(ValidationError)
  })

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, '5'])(
    'lehnt %s fuer sessionId und snapshotId ab',
    (invalid) => {
      expect(() =>
        validateGenerateContinuationPromptInput({ sessionId: invalid, snapshotId: 2, provider: 'CHATGPT' })
      ).toThrow(ValidationError)
      expect(() =>
        validateGenerateContinuationPromptInput({ sessionId: 1, snapshotId: invalid, provider: 'CHATGPT' })
      ).toThrow(ValidationError)
    }
  )

  it('lehnt einen unbekannten Provider ab', () => {
    expect(() =>
      validateGenerateContinuationPromptInput({ sessionId: 1, snapshotId: 2, provider: 'GEMINI' })
    ).toThrow(ValidationError)
  })

  it('lehnt provider: null ab', () => {
    expect(() => validateGenerateContinuationPromptInput({ sessionId: 1, snapshotId: 2, provider: null })).toThrow(
      ValidationError
    )
  })

  it('reicht keine unbekannten Zusatzfelder durch', () => {
    const input = validateGenerateContinuationPromptInput({
      sessionId: 1,
      snapshotId: 2,
      provider: 'CHATGPT',
      unbekanntesFeld: 'sollte verschwinden'
    })
    expect('unbekanntesFeld' in input).toBe(false)
    expect(Object.keys(input).sort()).toEqual(['provider', 'sessionId', 'snapshotId'])
  })
})
