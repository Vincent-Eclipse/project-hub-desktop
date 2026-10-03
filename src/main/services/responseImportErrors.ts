// Meilenstein 2 (Abschnitt 24 der Vorgabe) verlangt eine feste Liste
// literaler Fehlercodes (EMPTY_RESPONSE, STALE_PREVIEW, ...). Das bestehende
// registerIpc.ts leitet Fehlercodes normalerweise aus dem Klassennamen ab
// (siehe KNOWN_ERROR_NAMES) - das wuerde z. B. "ResponseImportError" statt
// "STALE_PREVIEW" liefern. ResponseImportError traegt den Code deshalb
// bewusst als eigenes Feld (wie die renderer-seitige ApiError in
// api/client.ts), registerIpc.ts liest dieses Feld vorrangig aus (siehe
// DECISIONS.md fuer die vollstaendige Begruendung dieser bewussten
// Abweichung vom Klassennamen-Schema).
//
// RC2-Korrektur (Abschnitt 4 der RC2-Vorgabe): `cause` traegt optional den
// urspruenglichen, moeglicherweise interne Details enthaltenden Fehler -
// AUSSCHLIESSLICH fuer die lokale FileLogger-Protokollierung in
// registerIpc.ts. `message` selbst enthaelt IMMER nur den bereits sicheren,
// fuer den Renderer bestimmten Text; `cause` verlaesst den Main-Prozess nie.
//
// RC2-Korrektur: drei Codes fuer bisher still uebersprungene, jetzt
// explizit abgelehnte Auswahl-Inkonsistenzen.
//
// RC3-Korrektur (Abschnitt 2/3 der RC3-Vorgabe): NO_EFFECTIVE_CHANGE fuer
// ausgewaehlte, aber wirkungslose Metadatenaenderungen (Wert entspricht
// bereits dem aktuellen Projektwert); CONTEXT_TOO_LARGE fuer eine
// resultierende Kontext-Version, die CONTEXT_MARKDOWN_MAX_LENGTH
// ueberschreiten wuerde.
export type ResponseImportErrorCode =
  | 'EMPTY_RESPONSE'
  | 'RESPONSE_TOO_LARGE'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_ARCHIVED'
  | 'STALE_PREVIEW'
  | 'INVALID_SOURCE'
  | 'INVALID_STATUS'
  | 'INVALID_ACTOR'
  | 'INVALID_CURRENT_STEP'
  | 'INVALID_NEXT_ACTION'
  | 'INVALID_SELECTION'
  | 'NO_ACTION_SELECTED'
  | 'NO_EFFECTIVE_CHANGE'
  | 'CONTEXT_SELECTION_EMPTY'
  | 'CONTEXT_TOO_LARGE'
  | 'IMPORT_APPLY_FAILED'

export class ResponseImportError extends Error {
  code: ResponseImportErrorCode
  /**
   * Nur fuer lokale Diagnosezwecke (FileLogger) - wird NIE ueber IPC an den
   * Renderer weitergegeben. Siehe registerIpc.ts toIpcError().
   */
  cause?: unknown

  constructor(code: ResponseImportErrorCode, message: string, cause?: unknown) {
    super(message)
    this.code = code
    this.name = 'ResponseImportError'
    this.cause = cause
  }
}
