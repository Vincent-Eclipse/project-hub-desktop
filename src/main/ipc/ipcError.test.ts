import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FileLogger } from '../logger'
import { toIpcError } from './ipcError'
import { ValidationError } from './validation'
import { ResponseImportError } from '../services/responseImportErrors'
import { ProjectNotFoundError, ProjectArchivedError } from '../services/projectsService'
import {
  AnotherActiveSessionExistsError,
  ChatMessageNotFoundError,
  ContinuationError,
  SessionError,
  SessionNotFoundError,
  SnapshotProviderMismatchError
} from '../services/sessionErrors'

// RC4-Korrektur (Abschnitt 3 der RC4-Vorgabe): toIpcError() liegt jetzt in
// ipcError.ts, das ausschliesslich Typ-/Logger-/Fehlerklassenimporte
// enthaelt - kein Import aus 'electron'. Dieser Test laeuft deshalb in der
// normalen Node-Vitest-Umgebung, ohne ipcMain zu mocken und ohne einen
// Electron-Stub zu benoetigen (ersetzt das vorherige, nur behelfsmaessige
// RC3-registerIpc.test.ts).

let tmpDir: string
let logger: FileLogger

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-ipc-error-test-'))
  logger = new FileLogger(tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function readLog(): string {
  return fs.readFileSync(path.join(tmpDir, 'main.log'), 'utf-8')
}

describe('toIpcError - unerwartete interne Fehler werden generisch sanitisiert', () => {
  it('ein unerwarteter Fehler bei analyze liefert dem Renderer nur INTERNAL_ERROR mit fester Meldung', () => {
    const internal = new Error('SQLITE_CORRUPT: database disk image is malformed at /home/user/private/db.sqlite')
    const result = toIpcError('responseImport:analyze', internal, logger)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL_ERROR')
      expect(result.error.message).toBe('Ein interner Fehler ist aufgetreten.')
      expect(result.error.message).not.toContain('SQLITE_CORRUPT')
      expect(result.error.message).not.toContain('geheim')
    }
  })

  it('ein unerwarteter Fehler bei apply (vor der Transaktion) liefert ebenfalls nur INTERNAL_ERROR', () => {
    const internal = new TypeError("Cannot read properties of undefined (reading 'currentContextVersionId')")
    const result = toIpcError('responseImport:apply', internal, logger)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL_ERROR')
      expect(result.error.message).toBe('Ein interner Fehler ist aufgetreten.')
    }
  })

  it('der FileLogger erhaelt die echte Ursache (Nachricht UND Details) lokal', () => {
    const internal = new Error('SQLITE_CONSTRAINT: FOREIGN KEY mismatch at /pfad/db.sqlite')
    toIpcError('responseImport:apply', internal, logger)
    const content = readLog()
    expect(content).toContain('SQLITE_CONSTRAINT')
    expect(content).toContain('/pfad/db.sqlite')
  })

  it('keine internen Details im IPC-Ergebnis, auch wenn die Nachricht Rohantwort-aehnliche Inhalte enthaelt', () => {
    const internal = new Error('unexpected database error near "GEHEIME_ANTWORT_MARKIERUNG"')
    const result = toIpcError('responseImport:apply', internal, logger)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).not.toContain('GEHEIME_ANTWORT_MARKIERUNG')
    }
  })

  it('ein nicht-Error-Wert (z. B. ein geworfener String) liefert ebenfalls nur INTERNAL_ERROR mit fester Meldung', () => {
    const result = toIpcError('responseImport:analyze', 'irgendein String', logger)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL_ERROR')
      expect(result.error.message).toBe('Ein interner Fehler ist aufgetreten.')
    }
  })
})

describe('toIpcError - bekannte Fehlerklassen bleiben weiterhin sicher unterscheidbar', () => {
  it('PROJECT_NOT_FOUND bleibt weiterhin korrekt unterscheidbar (kein INTERNAL_ERROR)', () => {
    const result = toIpcError('responseImport:analyze', new ProjectNotFoundError(999), logger)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('ProjectNotFoundError')
      expect(result.error.code).not.toBe('INTERNAL_ERROR')
      expect(result.error.message).toContain('999')
    }
  })

  it('ProjectArchivedError bleibt weiterhin korrekt unterscheidbar', () => {
    const result = toIpcError('projects:update', new ProjectArchivedError(5), logger)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('ProjectArchivedError')
    }
  })

  it('ValidationError bleibt unveraendert VALIDATION_ERROR mit ihrer eigenen Meldung', () => {
    const result = toIpcError('projects:update', new ValidationError('Feld "name" muss ein Text sein.'), logger)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR')
      expect(result.error.message).toBe('Feld "name" muss ein Text sein.')
    }
  })

  it('ResponseImportError liefert weiterhin ihren exakten, bereits sicheren Code und Text', () => {
    const result = toIpcError(
      'responseImport:apply',
      new ResponseImportError('STALE_PREVIEW', 'Die Vorschau ist nicht mehr aktuell.'),
      logger
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('STALE_PREVIEW')
      expect(result.error.message).toBe('Die Vorschau ist nicht mehr aktuell.')
    }
  })

  it('ResponseImportError mit cause loggt die Ursache lokal, gibt aber nur die sichere Meldung zurueck', () => {
    const cause = new Error('SQLITE_CONSTRAINT at /geheim/pfad')
    const result = toIpcError(
      'responseImport:apply',
      new ResponseImportError(
        'IMPORT_APPLY_FAILED',
        'Die Übernahme ist fehlgeschlagen. Es wurden keine Änderungen gespeichert.',
        cause
      ),
      logger
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('IMPORT_APPLY_FAILED')
      expect(result.error.message).not.toContain('geheim')
    }
    expect(readLog()).toContain('geheim')
  })

  it('ResponseImportError ohne cause wird nur als info geloggt (kein Stack-Rauschen fuer erwartete Ablehnungen)', () => {
    toIpcError('responseImport:apply', new ResponseImportError('NO_ACTION_SELECTED', 'Es wurde keine Aktion ausgewählt.'), logger)
    const content = readLog()
    expect(content).toContain('[INFO]')
    expect(content).not.toContain('[ERROR]')
  })
})

describe('toIpcError - Sitzungs-/Fortsetzungsfehler (Meilenstein 3)', () => {
  it('SessionError liefert unveraendert den Code INVALID_SESSION_STATUS_TRANSITION', () => {
    const result = toIpcError(
      'sessions:update',
      new SessionError('INVALID_SESSION_STATUS_TRANSITION', 'Sitzungsstatus kann nicht von "COMPLETED" zu "ACTIVE" wechseln.'),
      logger
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_SESSION_STATUS_TRANSITION')
      expect(result.error.code).not.toBe('INTERNAL_ERROR')
      expect(result.error.message).toBe('Sitzungsstatus kann nicht von "COMPLETED" zu "ACTIVE" wechseln.')
    }
  })

  it('ContinuationError liefert unveraendert den Code SNAPSHOT_NOT_CONFIRMED', () => {
    const result = toIpcError(
      'sessions:createContinuation',
      new ContinuationError('SNAPSHOT_NOT_CONFIRMED', 'Snapshot 7 ist nicht bestaetigt.'),
      logger
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('SNAPSHOT_NOT_CONFIRMED')
      expect(result.error.message).toBe('Snapshot 7 ist nicht bestaetigt.')
    }
  })

  it('ContinuationError liefert unveraendert den Code SESSION_ALREADY_HAS_SUCCESSOR', () => {
    const result = toIpcError(
      'sessions:createContinuation',
      new ContinuationError('SESSION_ALREADY_HAS_SUCCESSOR', 'Sitzung 3 hat bereits eine Nachfolgesitzung.'),
      logger
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('SESSION_ALREADY_HAS_SUCCESSOR')
      expect(result.error.message).toBe('Sitzung 3 hat bereits eine Nachfolgesitzung.')
    }
  })

  it('SessionNotFoundError wird nicht als INTERNAL_ERROR gemeldet und behaelt ihre Meldung', () => {
    const result = toIpcError('sessions:get', new SessionNotFoundError(42), logger)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('SessionNotFoundError')
      expect(result.error.code).not.toBe('INTERNAL_ERROR')
      expect(result.error.message).toContain('42')
    }
  })

  it('SnapshotProviderMismatchError wird nicht als INTERNAL_ERROR gemeldet', () => {
    const result = toIpcError(
      'sessions:createContinuation',
      new SnapshotProviderMismatchError(5, 'CLAUDE', 'CHATGPT'),
      logger
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('SnapshotProviderMismatchError')
      expect(result.error.code).not.toBe('INTERNAL_ERROR')
    }
  })

  it('ChatMessageNotFoundError wird nicht als INTERNAL_ERROR gemeldet', () => {
    const result = toIpcError('sessions:assignChatMessage', new ChatMessageNotFoundError(9), logger)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('ChatMessageNotFoundError')
      expect(result.error.code).not.toBe('INTERNAL_ERROR')
    }
  })

  it('AnotherActiveSessionExistsError wird nicht als INTERNAL_ERROR gemeldet', () => {
    const result = toIpcError('sessions:create', new AnotherActiveSessionExistsError(1, 'CHATGPT'), logger)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('AnotherActiveSessionExistsError')
      expect(result.error.code).not.toBe('INTERNAL_ERROR')
    }
  })

  it('erwartete Session-/Continuation-Codefehler werden nur als info geloggt (kein Stack-Rauschen)', () => {
    toIpcError('sessions:update', new SessionError('INVALID_SESSION_STATUS_TRANSITION', 'Ungueltiger Uebergang.'), logger)
    toIpcError('sessions:createContinuation', new ContinuationError('SNAPSHOT_NOT_CONFIRMED', 'Nicht bestaetigt.'), logger)
    const content = readLog()
    expect(content).toContain('[INFO]')
    expect(content).not.toContain('[ERROR]')
  })

  it('ein unerwarteter SQLite-/Pfadfehler in einem Sitzungs-Handler bleibt lokal im Log, aber vollstaendig sanitisiert im IPC-Ergebnis', () => {
    const internal = new Error('SQLITE_CONSTRAINT: NOT NULL constraint failed: session_events.raw_response at C:\\geheim\\pfad\\db.sqlite3')
    const result = toIpcError('sessions:createContinuation', internal, logger)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL_ERROR')
      expect(result.error.message).toBe('Ein interner Fehler ist aufgetreten.')
      expect(result.error.message).not.toContain('SQLITE_CONSTRAINT')
      expect(result.error.message).not.toContain('geheim')
    }
    expect(readLog()).toContain('SQLITE_CONSTRAINT')
  })
})
