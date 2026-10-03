import {
  PROJECT_SHORT_FIELD_MAX_LENGTH,
  type NextActor,
  type ParsedResponse,
  type ProjectStatus
} from '@shared/types'

// Reiner, deterministischer Parser fuer Meilenstein 2 (Strukturierter
// Antwort-Import). Enthaelt bewusst KEINEN Datenbank-, Electron- oder
// Netzwerkzugriff und trifft KEINE freie/KI-basierte Interpretation - nur
// feste Markdown-Ueberschriften- und Label-Erkennung nach einem festen
// deutsch/englischen Synonym-Woerterbuch (Abschnitt 6/7 der
// Meilenstein-2-Vorgabe).
//
// RC2-Korrektur: mehrdeutige, wiederholte Metadaten-Labels werden als
// Kandidatenliste gesammelt und nur bei genau einem eindeutigen Wert
// uebernommen. Codeblock-Erkennung unterstuetzt Backtick- UND
// Tilden-Fences.
//
// RC3-Korrektur (Abschnitt 4 der RC3-Vorgabe): die Fence-Erkennung
// beruecksichtigt jetzt zusaetzlich die LAENGE des oeffnenden Fences - ein
// mit vier Backticks geoeffneter Block wird nicht mehr faelschlich durch
// drei Backticks geschlossen (siehe parseResponse() unten). Ausserdem
// bleiben unbekannte Markdown-Ueberschriften jetzt selbst sichtbar unter
// "unassigned" erhalten (Abschnitt 7), und suggestedCurrentStep/
// suggestedNextAction werden gegen PROJECT_SHORT_FIELD_MAX_LENGTH geprueft
// (Abschnitt 3).
//
// Erhoeht sich die Erkennungslogik in einer Weise, die bestehende
// gespeicherte Fingerprints veraendern wuerde, MUSS PARSER_VERSION erhoeht
// werden (siehe responseImportFingerprint.ts) - alte Vorschauen werden
// dadurch automatisch als veraltet (STALE_PREVIEW) erkannt. Diese
// RC3-Korrektur AENDERT die Erkennungslogik (Fence-Laenge, unbekannte
// Ueberschriften, Laengenlimits) - PARSER_VERSION wird deshalb von 2 auf 3
// angehoben.
export const PARSER_VERSION = 3

type ContentCategory =
  | 'summary'
  | 'completedWork'
  | 'changedFiles'
  | 'testResults'
  | 'openItems'
  | 'blockers'
  | 'nextStep'

type MetadataCategory = 'status' | 'currentStep' | 'nextAction' | 'nextActor'

// Exakte, case-insensitive Synonym-Woerterbuecher. Es wird IMMER der
// vollstaendige Text vor dem ":" (bei Labels) bzw. nach den "#" (bei
// Ueberschriften) verglichen - niemals ein Teilstring- oder Praefix-
// Vergleich. Dadurch werden aehnlich beginnende Begriffe (z. B.
// "Statusbericht") nicht faelschlich als "Status" erkannt.
const CONTENT_HEADING_SYNONYMS: Record<string, ContentCategory> = {
  zusammenfassung: 'summary',
  summary: 'summary',
  erledigt: 'completedWork',
  'erledigte arbeiten': 'completedWork',
  completed: 'completedWork',
  'completed work': 'completedWork',
  done: 'completedWork',
  'geänderte dateien': 'changedFiles',
  'geaenderte dateien': 'changedFiles',
  'changed files': 'changedFiles',
  'files changed': 'changedFiles',
  tests: 'testResults',
  testergebnisse: 'testResults',
  'test results': 'testResults',
  'offene punkte': 'openItems',
  'open items': 'openItems',
  'remaining work': 'openItems',
  fehler: 'blockers',
  errors: 'blockers',
  blocker: 'blockers',
  blockers: 'blockers',
  'nächster schritt': 'nextStep',
  'naechster schritt': 'nextStep',
  'next step': 'nextStep'
}

// Labelform ("Label:" am Zeilenanfang). Dieselben Synonyme wie bei
// Ueberschriften.
const CONTENT_LABEL_SYNONYMS: Record<string, ContentCategory> = {
  ...CONTENT_HEADING_SYNONYMS
}

const METADATA_LABEL_SYNONYMS: Record<string, MetadataCategory> = {
  status: 'status',
  'project status': 'status',
  'aktueller schritt': 'currentStep',
  'current step': 'currentStep',
  'nächste aktion': 'nextAction',
  'naechste aktion': 'nextAction',
  'next action': 'nextAction',
  'nächster akteur': 'nextActor',
  'naechster akteur': 'nextActor',
  'next actor': 'nextActor'
}

// "blocked" wird ABSICHTLICH NICHT aufgenommen - es darf laut Vorgabe
// nicht automatisch zu ERROR werden.
const STATUS_ALIASES: Record<string, ProjectStatus> = {
  planning: 'PLANNING',
  active: 'ACTIVE',
  testing: 'TESTING',
  paused: 'PAUSED',
  completed: 'COMPLETED',
  done: 'COMPLETED',
  error: 'ERROR',
  'waiting on human': 'WAITING_ON_HUMAN',
  waiting_on_human: 'WAITING_ON_HUMAN'
}

const ACTOR_ALIASES: Record<string, NextActor> = {
  leon: 'LEON',
  chatgpt: 'CHATGPT',
  claude: 'CLAUDE',
  none: 'NONE',
  keiner: 'NONE',
  niemand: 'NONE'
}

export function normalizeStatus(rawValue: string): ProjectStatus | null {
  const key = rawValue.trim().toLowerCase()
  return STATUS_ALIASES[key] ?? null
}

export function normalizeActor(rawValue: string): NextActor | null {
  const key = rawValue.trim().toLowerCase()
  return ACTOR_ALIASES[key] ?? null
}

const HEADING_PATTERN = /^ {0,3}#{1,6}\s+(.+?)\s*:?\s*$/
// Label-Zeilen: kurzer, eindeutiger Text vor dem ersten Doppelpunkt.
const LABEL_PATTERN = /^ {0,3}([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß /]{0,39}):[ \t]?(.*)$/
// Fence-Zeile: mindestens drei identische Backticks ODER mindestens drei
// identische Tilden, gefolgt von beliebigem Rest (Sprachangabe beim
// Oeffnen, oder nur Whitespace bei einer gueltigen Schliessung). Gruppe 1
// haelt den vollstaendigen Zeichenlauf (Zeichen UND Laenge gemeinsam
// auswertbar), Gruppe 2 den Rest der Zeile danach.
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const LIST_MARKER_PATTERN = /^\s*(?:[-*•]|\d+[.)])\s+/

function stripListMarker(line: string): string {
  return line.replace(LIST_MARKER_PATTERN, '').trim()
}

function dedupePreserveOrder(lines: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of lines) {
    if (seen.has(line)) continue
    seen.add(line)
    result.push(line)
  }
  return result
}

/**
 * Sammelt einen rohen Metadaten-Kandidaten case-insensitiv dedupliziert
 * (identische wiederholte Werte sind zulaessig) - die zuerst gesehene
 * Schreibweise bleibt erhalten.
 */
function pushCandidate(candidates: string[], value: string): void {
  const lower = value.toLowerCase()
  if (candidates.some((c) => c.toLowerCase() === lower)) return
  candidates.push(value)
}

function emptyResult(): ParsedResponse {
  return {
    summary: [],
    completedWork: [],
    changedFiles: [],
    testResults: [],
    openItems: [],
    blockers: [],
    nextStep: [],
    suggestedStatus: null,
    suggestedStatusRaw: null,
    suggestedStatusCandidates: [],
    suggestedStatusAmbiguous: false,
    suggestedCurrentStep: null,
    suggestedCurrentStepCandidates: [],
    suggestedCurrentStepAmbiguous: false,
    suggestedCurrentStepTooLong: false,
    suggestedNextAction: null,
    suggestedNextActionCandidates: [],
    suggestedNextActionAmbiguous: false,
    suggestedNextActionTooLong: false,
    suggestedNextActor: null,
    suggestedNextActorRaw: null,
    suggestedNextActorCandidates: [],
    suggestedNextActorAmbiguous: false,
    contextAddition: '',
    unassigned: []
  }
}

/**
 * Baut den Markdown-Anhang, der bei ausgewaehlten Kontext-Aktionen an den
 * bestehenden Projekt-Kontext angehaengt wuerde. Reine Ableitung aus den
 * erkannten Kategorien - nur nicht-leere Bereiche werden eingefuegt, keine
 * leeren Ueberschriften.
 */
function buildContextAddition(sections: Record<ContentCategory, string[]>): string {
  const blocks: string[] = []
  const push = (title: string, key: ContentCategory): void => {
    const lines = sections[key]
    if (lines.length === 0) return
    blocks.push(`### ${title}\n\n${lines.map((l) => `- ${l}`).join('\n')}`)
  }
  push('Erledigte Arbeiten', 'completedWork')
  push('Geänderte Dateien', 'changedFiles')
  push('Testergebnisse', 'testResults')
  push('Offene Punkte', 'openItems')
  push('Blocker', 'blockers')
  push('Nächster Schritt', 'nextStep')
  return blocks.join('\n\n')
}

/**
 * Loest die gesammelten Rohwert-Kandidaten einer Metadatenkategorie auf:
 * kein Kandidat -> null/nicht mehrdeutig; genau ein Kandidat -> dieser Wert
 * (nach optionaler Normalisierung); mehr als ein unterschiedlicher
 * Kandidat -> mehrdeutig, KEIN Wert wird uebernommen (kein
 * Last-value-wins), die Kandidaten bleiben fuer die Vorschau sichtbar.
 */
function resolveCandidates<T>(
  candidates: string[],
  normalize: (raw: string) => T | null
): { value: T | null; raw: string | null; ambiguous: boolean } {
  if (candidates.length === 0) return { value: null, raw: null, ambiguous: false }
  if (candidates.length === 1) return { value: normalize(candidates[0]), raw: candidates[0], ambiguous: false }
  return { value: null, raw: null, ambiguous: true }
}

const identity = (raw: string): string => raw

/**
 * RC3-Korrektur (Abschnitt 3 der RC3-Vorgabe): begrenzt einen eindeutig
 * erkannten Freitext-Kandidaten (aktueller Schritt/naechste Aktion) auf
 * PROJECT_SHORT_FIELD_MAX_LENGTH - genau dieselbe Grenze, die auch die
 * normale IPC-Validierung (projects:update) durchsetzt. Ein zu langer
 * Kandidat wird NICHT als Vorschlag angeboten (value=null), bleibt aber
 * ueber die Kandidatenliste weiterhin sichtbar - die Oberflaeche kann ihn
 * dadurch verstaendlich als "zu lang" statt "nicht erkannt" darstellen.
 */
function applyShortFieldLengthLimit(resolved: {
  value: string | null
  raw: string | null
  ambiguous: boolean
}): { value: string | null; tooLong: boolean } {
  if (resolved.value !== null && resolved.value.length > PROJECT_SHORT_FIELD_MAX_LENGTH) {
    return { value: null, tooLong: true }
  }
  return { value: resolved.value, tooLong: false }
}

interface FenceMatch {
  char: string
  length: number
  rest: string
}

function matchFenceLine(line: string): FenceMatch | null {
  const m = FENCE_LINE_PATTERN.exec(line)
  if (!m) return null
  const run = m[1]
  return { char: run[0], length: run.length, rest: m[2] }
}

/**
 * Parst eine ChatGPT-/Claude-Antwort vollstaendig lokal und deterministisch.
 * Der uebergebene Rohtext wird NICHT veraendert - diese Funktion liest ihn
 * nur, das aufrufende ResponseImportRecord speichert weiterhin den
 * unveraenderten Originaltext separat.
 */
export function parseResponse(rawResponse: string): ParsedResponse {
  const sections: Record<ContentCategory, string[]> = {
    summary: [],
    completedWork: [],
    changedFiles: [],
    testResults: [],
    openItems: [],
    blockers: [],
    nextStep: []
  }
  const unassigned: string[] = []

  const statusCandidates: string[] = []
  const currentStepCandidates: string[] = []
  const nextActionCandidates: string[] = []
  const nextActorCandidates: string[] = []

  let currentSection: ContentCategory | null = null
  // null = ausserhalb eines Codeblocks; sonst Zeichen UND Laenge des
  // Fences, mit dem der aktuell offene Block eroeffnet wurde (RC3-
  // Korrektur: RC2 merkte sich nur das Zeichen, nicht die Laenge - ein mit
  // vier Backticks geoeffneter Block liess sich dadurch faelschlich mit
  // drei Backticks schliessen). Eine gueltige Schliessung braucht:
  // dasselbe Zeichen, MINDESTENS dieselbe Laenge, und ausschliesslich
  // Whitespace danach.
  let fence: { char: string; length: number } | null = null

  const rawLines = rawResponse.split(/\r\n|\r|\n/)

  for (const rawLine of rawLines) {
    const fenceCandidate = matchFenceLine(rawLine)

    if (fence === null) {
      if (fenceCandidate) {
        // Oeffnende Fence-Zeile - Zeichen und Laenge merken. Die Zeile
        // selbst (inkl. einer eventuellen Sprachangabe in "rest") wird
        // nie als Struktur oder Inhalt uebernommen.
        fence = { char: fenceCandidate.char, length: fenceCandidate.length }
        continue
      }
      // sonst: normale Zeile, faellt unten durch zur regulaeren Verarbeitung.
    } else {
      const isValidClose =
        fenceCandidate !== null &&
        fenceCandidate.char === fence.char &&
        fenceCandidate.length >= fence.length &&
        fenceCandidate.rest.trim().length === 0
      if (isValidClose) {
        fence = null
      }
      // Egal ob gueltige Schliessung oder weiterhin Codeblock-Inhalt: diese
      // Zeile wird nie als Struktur oder Inhalt uebernommen (Abschnitt 7
      // der Meilenstein-2-Vorgabe). Ein bis zum Textende nie gueltig
      // geschlossener Block haelt dadurch automatisch den gesamten
      // restlichen Text zurueck - es gibt keinen expliziten "Ende
      // erzwingen"-Schritt noetig.
      continue
    }

    const line = rawLine.trimEnd()
    if (line.trim().length === 0) continue

    const headingMatch = HEADING_PATTERN.exec(line)
    if (headingMatch) {
      const heading = headingMatch[1].trim().toLowerCase()
      const category = CONTENT_HEADING_SYNONYMS[heading]
      if (category) {
        currentSection = category
      } else {
        // RC3-Korrektur (Abschnitt 7 der RC3-Vorgabe): eine unbekannte
        // Ueberschrift verschwindet nicht mehr - sie selbst wird (in ihrer
        // sichtbaren Schreibweise inkl. "#"-Zeichen) unter "unassigned"
        // aufgenommen, danach folgender Inhalt landet ueber den normalen
        // currentSection=null-Pfad in derselben Reihenfolge ebenfalls dort.
        unassigned.push(line.trim())
        currentSection = null
      }
      continue
    }

    const labelMatch = LABEL_PATTERN.exec(line)
    if (labelMatch) {
      const label = labelMatch[1].trim().toLowerCase()
      const value = labelMatch[2].trim()

      const metadataCategory = METADATA_LABEL_SYNONYMS[label]
      if (metadataCategory) {
        if (value.length > 0) {
          switch (metadataCategory) {
            case 'status':
              pushCandidate(statusCandidates, value)
              break
            case 'currentStep':
              pushCandidate(currentStepCandidates, value)
              break
            case 'nextAction':
              pushCandidate(nextActionCandidates, value)
              break
            case 'nextActor':
              pushCandidate(nextActorCandidates, value)
              break
          }
        }
        // Metadaten-Labels sind IMMER einzeilig und starten keine
        // mehrzeilige Sektion.
        currentSection = null
        continue
      }

      const contentCategory = CONTENT_LABEL_SYNONYMS[label]
      if (contentCategory) {
        if (value.length > 0) sections[contentCategory].push(stripListMarker(value))
        currentSection = contentCategory
        continue
      }

      // Unbekanntes Label (auch nur aehnlich beginnend) - keine Struktur,
      // faellt wie normaler Text durch nach unten.
    }

    if (currentSection) {
      sections[currentSection].push(stripListMarker(line))
    } else {
      unassigned.push(stripListMarker(line))
    }
  }

  const result = emptyResult()
  result.summary = dedupePreserveOrder(sections.summary)
  result.completedWork = dedupePreserveOrder(sections.completedWork)
  result.changedFiles = dedupePreserveOrder(sections.changedFiles)
  result.testResults = dedupePreserveOrder(sections.testResults)
  result.openItems = dedupePreserveOrder(sections.openItems)
  result.blockers = dedupePreserveOrder(sections.blockers)
  result.nextStep = dedupePreserveOrder(sections.nextStep)
  result.unassigned = dedupePreserveOrder(unassigned)

  const status = resolveCandidates(statusCandidates, normalizeStatus)
  result.suggestedStatus = status.value
  result.suggestedStatusRaw = status.raw
  result.suggestedStatusCandidates = statusCandidates
  result.suggestedStatusAmbiguous = status.ambiguous

  const currentStep = resolveCandidates(currentStepCandidates, identity)
  const currentStepLimited = applyShortFieldLengthLimit(currentStep)
  result.suggestedCurrentStep = currentStepLimited.value
  result.suggestedCurrentStepCandidates = currentStepCandidates
  result.suggestedCurrentStepAmbiguous = currentStep.ambiguous
  result.suggestedCurrentStepTooLong = currentStepLimited.tooLong

  const nextAction = resolveCandidates(nextActionCandidates, identity)
  const nextActionLimited = applyShortFieldLengthLimit(nextAction)
  result.suggestedNextAction = nextActionLimited.value
  result.suggestedNextActionCandidates = nextActionCandidates
  result.suggestedNextActionAmbiguous = nextAction.ambiguous
  result.suggestedNextActionTooLong = nextActionLimited.tooLong

  const nextActor = resolveCandidates(nextActorCandidates, normalizeActor)
  result.suggestedNextActor = nextActor.value
  result.suggestedNextActorRaw = nextActor.raw
  result.suggestedNextActorCandidates = nextActorCandidates
  result.suggestedNextActorAmbiguous = nextActor.ambiguous

  result.contextAddition = buildContextAddition({
    summary: result.summary,
    completedWork: result.completedWork,
    changedFiles: result.changedFiles,
    testResults: result.testResults,
    openItems: result.openItems,
    blockers: result.blockers,
    nextStep: result.nextStep
  })

  return result
}
