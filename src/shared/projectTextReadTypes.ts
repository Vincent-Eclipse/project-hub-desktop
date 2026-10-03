// Meilenstein 4.7B.1 - Vertrag fuer die neue project.readTextFiles Run-
// Operation (siehe runTypes.ts). Reine Typen/Konstanten, keine Logik.
//
// Diese Operation liest AUSSCHLIESSLICH bereits explizit freigegebene,
// projekt-relative Textdateien - niemals einen Ordner, niemals rekursiv,
// niemals per Glob/Muster. Das Ergebnis enthaelt bewusst NUR, was eine
// zukuenftige Main-Orchestrierung tatsaechlich braucht: keine absoluten
// Dateisystempfade, keine Dateisystem-Fehlermeldungen.

export const PROJECT_TEXT_READ_MAX_FILES = 8
export const PROJECT_TEXT_READ_MAX_INDIVIDUAL_BYTES = 16 * 1024
export const PROJECT_TEXT_READ_MAX_AGGREGATE_BYTES = 48 * 1024

/** Rohe, unvalidierte Operations-Eingabe - `relativePaths` ist NIEMALS Autorisierung (siehe runService.ts's RunTrustedScope). */
export interface ProjectTextReadRequest {
  relativePaths: string[]
}

export const LINE_ENDINGS = ['LF', 'CRLF', 'NONE'] as const
export type LineEnding = (typeof LINE_ENDINGS)[number]

/**
 * Format-Metadaten, die eine spaetere Apply-Logik (M4.7B.2/M4.8) braucht, um
 * eine vorgeschlagene MODIFY-Aenderung formtreu anzuwenden (BOM-Praesenz,
 * Zeilenumbruch-Stil, abschliessender Zeilenumbruch). Eine leere Datei
 * erhaelt lineEnding 'NONE' (es gibt keine Zeilenumbrueche zu erkennen).
 */
export interface ProjectTextFileFormat {
  utf8Bom: boolean
  lineEnding: LineEnding
  finalNewline: boolean
}

/**
 * Meilenstein 4.8A Teil B - kleine, ehrliche Dateisystem-IDENTITAETS-EVIDENZ
 * (keine kryptografische/atomare Garantie) fuer die spaetere Erkennung von
 * "gleicher Textpfad, aber anderes Dateisystem-Objekt" (M4.8B). Stammt aus
 * einem `stat({ bigint: true })`-Aufruf auf DEMSELBEN bereits geoeffneten
 * Datei-Handle, das der vertrauenswuerdige Leser fuer den eigentlichen
 * Lesevorgang verwendet (siehe projectTextReadService.ts's readOneFile) -
 * niemals ein spaeterer, unabhaengiger Stat-Aufruf. BigInt-Werte werden als
 * String serialisiert (JSON/structured clone verlieren sonst Praezision).
 * `null` bedeutet ehrlich "auf dieser Plattform/in diesem Fall nicht
 * verfuegbar" - niemals eine erfundene Identitaet.
 */
export interface ProjectTextFileIdentityEvidence {
  dev: string | null
  ino: string | null
}

export interface ProjectTextFileResult {
  path: string
  content: string
  sha256: string
  format: ProjectTextFileFormat
  identity: ProjectTextFileIdentityEvidence
}
