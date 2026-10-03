import type { IpcResult } from '@shared/types'
import type { FileLogger } from '../logger'
import { ValidationError } from './validation'
import { GitError } from '../services/gitErrors'
import { ResponseImportError } from '../services/responseImportErrors'
import { ContinuationError, SessionError } from '../services/sessionErrors'
import { CodeChangeReviewError } from '../services/codeChangeReviewService'

// RC4-Korrektur (Abschnitt 3 der RC4-Vorgabe): diese Datei enthaelt
// AUSSCHLIESSLICH Typ-/Logger-/Fehlerklassenimporte - kein Import aus
// 'electron', kein Import von registerIpc.ts. registerIpc.ts (das
// clipboard/dialog/ipcMain/shell aus 'electron' importiert) importiert
// toIpcError() umgekehrt von HIER, nicht andersherum.
//
// Grund: die bestehende Vitest-Konfiguration laeuft in einer normalen
// Node-Umgebung ohne echten Electron-Prozess. Ein Test, der toIpcError()
// direkt (ohne ipcMain-Mocking) pruefen will, darf deshalb keine Datei
// importieren, die transitiv 'electron' laedt - sonst schlaegt der
// Testlauf mit einem Modul-Aufloesungsfehler fehl. Die vorherige RC3-
// Loesung (ein testinterner Electron-Stub) war nur ein Behelf fuer eine
// isolierte Verifikation ausserhalb der echten Teststruktur, kein
// architektonisch sauberer Zustand fuer die echte Test-Suite.

export const KNOWN_ERROR_NAMES = [
  'ProjectNotFoundError',
  'ProjectArchivedError',
  'DuplicateFolderError',
  'FolderNotFoundError',
  'ContextVersionNotFoundError',
  'ContextVersionMismatchError',
  'ContextIntegrityError',
  'ProjectArchivedForContextError',
  'RuleVersionNotFoundError',
  'RuleVersionMismatchError',
  'InvalidRuleVersionError',
  'RulesDiffTooLargeError',
  'SessionNotFoundError',
  'SnapshotNotFoundError',
  'SnapshotSessionMismatchError',
  'SessionContextMismatchError',
  'AnotherActiveSessionExistsError',
  'ChatMessageAlreadyAssignedError',
  'ChatMessageSessionProjectMismatchError',
  'ChatMessageProviderMismatchError',
  'ChatMessageNotFoundError',
  'SnapshotProviderMismatchError',
  'TaskNotFoundError',
  'TaskMismatchError',
  'InvalidTaskError',
  'InvalidTaskDependencyError',
  'InvalidRelevantFileError',
  'WorkRequestNotFoundError',
  'WorkRequestMismatchError',
  'InvalidWorkRequestError',
  'WorkRequestNotEditableError',
  'InvalidWorkRequestStatusError',
  'DecisionNotFoundError',
  'DecisionMismatchError',
  'InvalidDecisionError',
  'DecisionResolutionConflictError',
  'TaskAlreadyLinkedError'
]

/**
 * Bildet einen im Main-Prozess geworfenen Fehler auf ein sicheres
 * IpcResult ab. Electron-frei und deshalb direkt in einer normalen
 * Node-/Vitest-Umgebung testbar (siehe ipcError.test.ts) - kein
 * ipcMain-Mocking, kein Electron-Stub noetig.
 */
export function toIpcError(channel: string, error: unknown, logger: FileLogger): IpcResult<never> {
  if (error instanceof GitError) {
    logger.info('Repository-Abfrage abgelehnt', { channel, code: error.code })
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  if (error instanceof ValidationError) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: error.message } }
  }
  // Meilenstein 2 (Abschnitt 24 der Vorgabe): ResponseImportError traegt
  // ihren Code bereits als eigenes Feld (siehe responseImportErrors.ts) -
  // die literalen Codes (EMPTY_RESPONSE, STALE_PREVIEW, ...) werden
  // deshalb bewusst VOR der generischen Klassennamen-Ableitung unten
  // ausgewertet, damit sie unveraendert beim Renderer ankommen.
  if (error instanceof ResponseImportError) {
    // RC2-Korrektur (Abschnitt 4 der RC2-Vorgabe): `error.message` ist bei
    // ResponseImportError IMMER bereits der sichere, fuer den Renderer
    // bestimmte Text (siehe responseImportService.ts) - er wird
    // unveraendert zurueckgegeben. Ein optional mitgegebener `cause` (nur
    // bei IMPORT_APPLY_FAILED gesetzt) enthaelt die eigentliche interne
    // Fehlerursache und wird AUSSCHLIESSLICH lokal geloggt, nie an den
    // Renderer weitergegeben. Erwartete, "normale" Ablehnungen (kein
    // `cause`, z. B. STALE_PREVIEW oder NO_ACTION_SELECTED) werden nur als
    // info geloggt, ohne Stack-Rauschen im Log zu erzeugen.
    if (error.cause !== undefined) {
      logger.error(`IPC-Handler "${channel}": interner Fehler beim Antwort-Import`, error.cause)
    } else {
      logger.info(`IPC-Handler "${channel}": strukturierter Antwort-Import abgelehnt`, { code: error.code })
    }
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  // SessionError/ContinuationError tragen ihren Code bereits als eigenes
  // Feld (siehe sessionErrors.ts), analog ResponseImportError - beide werden
  // deshalb ebenfalls vor der generischen Klassennamen-Ableitung ausgewertet.
  // message ist bei beiden immer bereits der sichere, renderer-taugliche
  // Text; geloggt wird nur der Code, nie Freitext aus Sitzungen/Snapshots.
  if (error instanceof SessionError || error instanceof ContinuationError) {
    logger.info(`IPC-Handler "${channel}": Sitzungsvorgang abgelehnt`, { code: error.code })
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  // Meilenstein 4.8A - CodeChangeReviewError traegt ihren Code bereits als
  // eigenes Feld (siehe codeChangeReviewService.ts), analog Session-/
  // ResponseImportError. message ist bereits der feste, renderer-taugliche
  // Text - niemals Rohquelle/absolute Pfade/Fingerprint-Interna.
  if (error instanceof CodeChangeReviewError) {
    logger.info(`IPC-Handler "${channel}": Review-Entscheidung abgelehnt`, { code: error.code })
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  if (error instanceof Error) {
    logger.error(`IPC-Handler "${channel}" fehlgeschlagen`, error)
    // Bekannte, per Name unterscheidbare Fehlerklassen bekommen einen
    // sprechenden Code UND ihre eigene, bereits als sicher/anzeigefaehig
    // verfasste Meldung (z. B. ProjectNotFoundError - siehe
    // projectsService.ts). Alles andere ist ein UNERWARTETER Fehler.
    //
    // RC3-Korrektur (Abschnitt 1 der RC3-Vorgabe): fuer diesen
    // unerwarteten Fall wird `error.message` NICHT mehr an den Renderer
    // weitergegeben (das haette z. B. SQL-, Pfad- oder Constraint-Details
    // preisgeben koennen - besonders relevant, seit
    // loadProjectForImport() unerwartete DB-Fehler bewusst weiterlaufen
    // laesst, siehe responseImportService.ts). Der Renderer erhaelt
    // ausschliesslich den festen, generischen Text; die tatsaechliche
    // Fehlermeldung samt Stacktrace wurde bereits oben vollstaendig lokal
    // ueber den FileLogger protokolliert.
    const isKnown = KNOWN_ERROR_NAMES.includes(error.constructor.name)
    const code = isKnown ? error.constructor.name : 'INTERNAL_ERROR'
    const message = isKnown ? error.message : 'Ein interner Fehler ist aufgetreten.'
    return { ok: false, error: { code, message } }
  }
  logger.error(`IPC-Handler "${channel}" fehlgeschlagen mit unbekanntem Fehlertyp`, error)
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Ein interner Fehler ist aufgetreten.' } }
}
