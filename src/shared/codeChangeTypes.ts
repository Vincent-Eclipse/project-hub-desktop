// Meilenstein 4.7B.1 - provider-neutraler V1-Vertrag fuer einen von Claude
// (oder einem zukuenftigen anderen Provider) vorgeschlagenen Code-Aenderungs-
// Vorschlag. Reine Typen/Konstanten, keine Logik (siehe shared/types.ts's
// Datei-Kommentar-Konvention).
//
// KRITISCH: ein CodeChangeProposal ist ein VORSCHLAG, KEINE Autorisierung,
// KEINE Dateisystem-Mutation, KEINE Freigabe. Claude VERFASST CODE. Main
// MUTIERT DATEIEN. Das sind unterschiedliche Autoritaeten (siehe M4.7B.1-
// Vorgabe "FROZEN WRITER MODEL"). Dieser Vertrag enthaelt daher bewusst KEIN
// vom Modell geliefertes: baseSha256, approval, approved, permissions,
// capabilities, commands, testsToRun, provider, model, agent, projectRoot,
// executable, Git-Argumente, Session-IDs. Main haengt vertrauenswuerdige
// Quell-Provenienz (z. B. baseSha256 aus dem trusted Source Reader) SPAETER
// selbst an - niemals vom Modell uebernommen.
//
// V1 unterstuetzt ausschliesslich MODIFY und CREATE. DELETE/RENAME/binaere
// Aenderungen/Verzeichnis-Erstellung/Datei-Modus-Aenderungen sind bewusst
// zurueckgestellt (M4.7B.1-Vorgabe Teil A).

export const CODE_FILE_CHANGE_TYPES = ['MODIFY', 'CREATE'] as const
export type CodeFileChangeType = (typeof CODE_FILE_CHANGE_TYPES)[number]

export interface CodeFileChangeModify {
  type: 'MODIFY'
  path: string
  content: string
}

export interface CodeFileChangeCreate {
  type: 'CREATE'
  path: string
  content: string
}

export type CodeFileChange = CodeFileChangeModify | CodeFileChangeCreate

export interface CodeChangeProposal {
  summary: string
  changes: CodeFileChange[]
  warnings: string[]
}

// ---------------------------------------------------------------------------
// V1-Grenzwerte (siehe M4.7B.1-Vorgabe Teil B "CONTENT LIMITS") - konservativ,
// UTF-8-BYTE-Laengen, keine JS-String-Laengen.
// ---------------------------------------------------------------------------

export const CODE_CHANGE_MAX_MODIFY_ENTRIES = 8
export const CODE_CHANGE_MAX_CREATE_ENTRIES = 2
export const CODE_CHANGE_MAX_TOTAL_CHANGES = 10

export const CODE_CHANGE_MAX_CONTENT_BYTES_PER_FILE = 32 * 1024
export const CODE_CHANGE_MAX_TOTAL_CONTENT_BYTES = 64 * 1024
export const CODE_CHANGE_MAX_SERIALIZED_PROPOSAL_BYTES = 128 * 1024

export const CODE_CHANGE_MAX_SUMMARY_BYTES = 8 * 1024
export const CODE_CHANGE_MAX_WARNINGS = 20
export const CODE_CHANGE_MAX_WARNING_BYTES = 4 * 1024
