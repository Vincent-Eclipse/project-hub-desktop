import type { IpcResult } from '@shared/types'

export class ApiError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ApiError'
  }
}

/**
 * Entpackt das IpcResult<T> aus der Preload-Bruecke. Bei einem
 * Fehler-Ergebnis wird eine ApiError geworfen, damit Komponenten
 * normale try/catch- bzw. async-Fehlerbehandlung nutzen koennen, statt
 * bei jedem Aufruf manuell auf `.ok` zu pruefen.
 */
export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise
  if (result.ok) return result.data
  throw new ApiError(result.error.code, result.error.message)
}

/**
 * Liefert einen kurzen, sicheren Zusatztext " (Detail)" fuer eine
 * Fehlermeldung, oder einen leeren String, falls kein sinnvoller Text
 * vorliegt. `err.message` stammt bei einer ApiError bereits aus der
 * validierten, serverseitig gepruesten Main-Prozess-Fehlermeldung (siehe
 * IpcResult) - dort landen nie vollstaendige Prompt- oder
 * Chat-Nachrichteninhalte, nur sprechende, generische Fehlertexte.
 */
export function errorDetail(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return ` (${err.message})`
  return ''
}
