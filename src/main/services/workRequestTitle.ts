import { WORK_REQUEST_TITLE_MAX_LENGTH } from '@shared/types'

// Meilenstein 4.3 - kleine, deterministische Titel-Ableitung fuer Work
// Requests. KEIN KI-Aufruf. Der Titel wird ausschliesslich fuer die
// Listenanzeige gebraucht - `intent_markdown` selbst bleibt in der Datenbank
// immer exakt der vom Nutzer gelieferte Wert (siehe workRequestService.ts:
// validateIntent() gibt den Rohwert unveraendert zurueck, diese Funktion
// wird nur separat auf den bereits validierten Wert angewendet).
//
// Regeln: umgebenden Leerraum trimmen (nur fuer die Titel-Ableitung, nicht
// fuer den gespeicherten intent_markdown), die erste nicht-leere Zeile
// nehmen, mehrfachen Leerraum innerhalb dieser Zeile zu einem Leerzeichen
// zusammenfassen, bei Bedarf auf die geteilte Maximallaenge kuerzen.
export function deriveWorkRequestTitle(intentMarkdown: string): string {
  const lines = intentMarkdown.split(/\r\n|\r|\n/)
  const firstMeaningfulLine = lines.map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  const collapsed = firstMeaningfulLine.replace(/\s+/g, ' ')
  return collapsed.length > WORK_REQUEST_TITLE_MAX_LENGTH
    ? collapsed.slice(0, WORK_REQUEST_TITLE_MAX_LENGTH)
    : collapsed
}
