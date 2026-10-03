import type { ResponseImportSelectedActions, ResponseImportSource } from '@shared/types'

// Reine, ohne React testbare Zustandslogik fuer den Import-Tab (Abschnitt 31
// der Meilenstein-2-Vorgabe). Kein React-Import, daher direkt in Vitest
// testbar - analog zu utils/requestGuard.ts.

/**
 * Eine bereits erzeugte Analyse-Vorschau gilt als veraltet, sobald sich der
 * aktuell im Textfeld stehende Rohtext ODER die ausgewaehlte Quelle
 * (ChatGPT/Claude) vom zuletzt analysierten Stand unterscheidet (RC2-
 * Korrektur, Abschnitt 6 der RC2-Vorgabe: ein Quellenwechsel nach der
 * Analyse machte die Vorschau in RC1 nicht sichtbar ungueltig, obwohl der
 * Server die spaetere Uebernahme ohnehin per Fingerprint abgelehnt haette -
 * die UI zeigte bis dahin aber irrefuehrend eine scheinbar gueltige
 * Vorschau). Rein clientseitige Sofort-Rueckmeldung fuer die Oberflaeche -
 * ersetzt NICHT die serverseitige Fingerprint-Pruefung (STALE_PREVIEW), die
 * unabhaengig davon bei jeder Uebernahme erneut laeuft.
 *
 * `analyzedSource`/`currentSource` sind optional, damit bestehende
 * Zwei-Parameter-Aufrufe unveraendert funktionieren (reine Text-Pruefung
 * ohne Quellenvergleich).
 */
export function isPreviewStale(
  analyzedRawResponse: string | null,
  currentRawResponse: string,
  analyzedSource?: ResponseImportSource | null,
  currentSource?: ResponseImportSource
): boolean {
  if (analyzedRawResponse === null) return true
  if (analyzedRawResponse !== currentRawResponse) return true
  if (analyzedSource !== undefined && currentSource !== undefined && analyzedSource !== currentSource) return true
  return false
}

/**
 * Konservative Grundregel (Abschnitt 4 der Vorgabe): die Uebernahme ist
 * gesperrt, solange keine Aktion ausgewaehlt wurde. Zusaetzlich duerfen
 * Kontext-Unterkategorien nur zaehlen, wenn "Neue Kontext-Version
 * erstellen" selbst aktiviert ist.
 */
export function hasAnySelectedAction(selected: ResponseImportSelectedActions): boolean {
  return (
    selected.saveHistory ||
    selected.changeStatus ||
    selected.changeCurrentStep ||
    selected.changeNextAction ||
    selected.changeNextActor ||
    selected.createContextVersion
  )
}

/** Mindestens ein Kontext-Bereich muss ausgewaehlt sein, wenn "Neue Kontext-Version erstellen" aktiv ist. */
export function hasContextCategorySelected(selected: ResponseImportSelectedActions): boolean {
  return (
    selected.contextIncludeCompletedWork ||
    selected.contextIncludeChangedFiles ||
    selected.contextIncludeTestResults ||
    selected.contextIncludeOpenItems ||
    selected.contextIncludeBlockers ||
    selected.contextIncludeNextStep
  )
}

export interface CanApplyOptions {
  hasAnalysis: boolean
  isStale: boolean
  isProjectArchived: boolean
  selected: ResponseImportSelectedActions
}

/**
 * Zentrale Freigabe-Entscheidung fuer den "Ausgewählte Änderungen
 * übernehmen"-Button. Rein und ohne Seiteneffekte - die eigentliche,
 * verbindliche Pruefung bleibt weiterhin serverseitig
 * (responseImportService.applyResponseImport).
 *
 * RC3-Korrektur (Abschnitt 5 der RC3-Vorgabe): blockiert jetzt zusaetzlich
 * die "versteckte" Auswahl - mindestens eine contextInclude*-Option ist
 * aktiv, waehrend createContextVersion selbst false ist. Im Normalbetrieb
 * kann dieser Zustand durch den Toggle-Reset in ImportTab.tsx (Hauptoption
 * aus -> alle Unterauswahlen sofort zuruecksetzen) gar nicht erst
 * entstehen - diese Pruefung ist die zusaetzliche, unabhaengige
 * Absicherung direkt im Guard.
 */
export function canApplySelection(options: CanApplyOptions): boolean {
  if (!options.hasAnalysis || options.isStale || options.isProjectArchived) return false
  if (!options.selected.createContextVersion && hasContextCategorySelected(options.selected)) return false
  if (!hasAnySelectedAction(options.selected)) return false
  if (options.selected.createContextVersion && !hasContextCategorySelected(options.selected)) return false
  return true
}

/**
 * RC4-Korrektur (Abschnitt 5 der RC4-Vorgabe): entscheidet, ob ein soeben
 * zurueckgekommenes Analyse-Ergebnis noch uebernommen werden darf. Rein
 * und ohne Seiteneffekte, direkt testbar - der Aufrufer (ImportTab.tsx)
 * ermittelt `isCurrentTicket` selbst ueber einen `LatestRequestGuard`
 * (siehe utils/requestGuard.ts, bereits fuer den Projektwechsel-Schutz in
 * ProjectDetailShell.tsx verwendet und dort bereits getestet - hier wird
 * nur die zusaetzliche Verknuepfung mit dem Projekt-/Quellen-/
 * Rohtext-Vergleich separat getestet).
 *
 * RC5-Korrektur (Abschnitt 3 der RC5-Vorgabe): zusaetzlich zu Ticket/
 * Quelle/Rohtext wird jetzt auch die Projekt-ID verglichen - eine
 * zusaetzliche, von der bereits bestehenden key-basierten Remount-
 * Absicherung in ProjectDetailShell.tsx UNABHAENGIGE Verteidigungsebene
 * direkt in der Guard-Logik selbst.
 *
 * Ein Ergebnis ist nur relevant, wenn ALLE vier zutreffen:
 * - das Ticket ist noch das zuletzt gestartete (keine neuere Analyse lief
 *   inzwischen an, und keine Invalidierung hat zwischenzeitlich
 *   stattgefunden)
 * - die Projekt-ID hat sich seit Start dieser Analyse nicht geaendert
 * - die Quelle hat sich seit Start dieser Analyse nicht geaendert
 * - der Rohtext hat sich seit Start dieser Analyse nicht geaendert
 */
export function isAnalysisResultRelevant(params: {
  isCurrentTicket: boolean
  requestedProjectId: number
  currentProjectId: number
  requestedSource: ResponseImportSource
  currentSource: ResponseImportSource
  requestedRawResponse: string
  currentRawResponse: string
}): boolean {
  return (
    params.isCurrentTicket &&
    params.requestedProjectId === params.currentProjectId &&
    params.requestedSource === params.currentSource &&
    params.requestedRawResponse === params.currentRawResponse
  )
}

export function createEmptySelection(): ResponseImportSelectedActions {
  return {
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
}
