import type Database from 'better-sqlite3'
import type {
  ContinuationSnapshot,
  GenerateContinuationPromptInput,
  GenerateContinuationPromptResult,
  RequiredFile,
  SensitiveContentFinding
} from '@shared/types'
import { CONTINUATION_PROMPT_MAX_LENGTH } from '@shared/types'
import { getProjectById } from './projectsService'
import { getSessionById } from './sessionService'
import { getSnapshot } from './continuationSnapshotService'
import { ContinuationError } from './sessionErrors'
import { getCurrentProjectRules } from './rulesService'

// ===========================================================================
// Sensible Inhalte
// ===========================================================================
// Erkennt dieselben konservativen, false-positive-armen Secret-Muster wie
// beim Schreiben eines Snapshots, damit ein erzeugter Prompt nie unbemerkt
// einen Geheimwert enthaelt.

const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const AUTHORIZATION_HEADER_PATTERN = /\bAuthorization\s*:\s*Bearer\s+\S+/i
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{16,}/
const KNOWN_TOKEN_PREFIX_PATTERN = /\b(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/

const SENSITIVE_ASSIGNMENT_NAMES = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'private_key',
  'client_secret',
  'authorization'
] as const

function isPlaceholderValue(rawValue: string): boolean {
  const value = rawValue.replace(/^["']|["']$/g, '').trim()
  if (value.length === 0) return true
  if (/^<.+>$/.test(value)) return true
  if (/^\{\{.+\}\}$/.test(value)) return true
  if (/^(your[_-]?api[_-]?key|changeme|xxx+|todo|example|sample|placeholder|set[_-]?locally)$/i.test(value)) {
    return true
  }
  return false
}

function assignmentFindingType(name: string): SensitiveContentFinding['type'] {
  if (name === 'password' || name === 'passwd') return 'PASSWORD_ASSIGNMENT'
  if (name === 'authorization') return 'AUTHORIZATION_BEARER'
  return 'ENV_ASSIGNMENT'
}

function scanForSensitiveContent(field: string, text: string): SensitiveContentFinding | null {
  if (PRIVATE_KEY_BLOCK_PATTERN.test(text)) {
    return {
      type: 'PRIVATE_KEY_BLOCK',
      field,
      approximateLocation: field,
      safeMessage: `Feld "${field}" enthaelt einen privaten Schluessel und wurde abgelehnt.`
    }
  }
  if (AUTHORIZATION_HEADER_PATTERN.test(text) || BEARER_TOKEN_PATTERN.test(text)) {
    return {
      type: 'AUTHORIZATION_BEARER',
      field,
      approximateLocation: field,
      safeMessage: `Feld "${field}" enthaelt einen Authorization-/Bearer-Wert und wurde abgelehnt.`
    }
  }
  if (KNOWN_TOKEN_PREFIX_PATTERN.test(text)) {
    return {
      type: 'API_TOKEN_PATTERN',
      field,
      approximateLocation: field,
      safeMessage: `Feld "${field}" enthaelt ein bekanntes API-Token-Muster und wurde abgelehnt.`
    }
  }
  for (const name of SENSITIVE_ASSIGNMENT_NAMES) {
    const pattern = new RegExp(`\\b${name}\\b\\s*[:=]\\s*["']?([^\\s"',;]+)`, 'i')
    const match = pattern.exec(text)
    const value = match?.[1]
    if (value !== undefined && !isPlaceholderValue(value)) {
      return {
        type: assignmentFindingType(name),
        field,
        approximateLocation: field,
        safeMessage: `Feld "${field}" enthaelt eine sensible Zuweisung ("${name}") und wurde abgelehnt.`
      }
    }
  }
  return null
}

/** Wirft PROMPT_CONTAINS_SENSITIVE_CONTENT - der gefundene Wert selbst ist nie Teil der Fehlermeldung. */
function assertFieldNotSensitiveForPrompt(field: string, text: string): void {
  const finding = scanForSensitiveContent(field, text)
  if (finding) throw new ContinuationError('PROMPT_CONTAINS_SENSITIVE_CONTENT', finding.safeMessage)
}

/** sha256 wird bewusst nie gescannt - es ist bereits als 64-stelliger kleingeschriebener Hex-Wert validiert, kein Freitext. */
function assertPromptContentSafe(projectName: string, snapshot: ContinuationSnapshot): void {
  assertFieldNotSensitiveForPrompt('projectName', projectName)
  assertFieldNotSensitiveForPrompt('currentTask', snapshot.currentTask)
  assertFieldNotSensitiveForPrompt('lastCompleteSection', snapshot.lastCompleteSection)
  assertFieldNotSensitiveForPrompt('nextExactStep', snapshot.nextExactStep)
  assertFieldNotSensitiveForPrompt('additionalHumanAction', snapshot.additionalHumanAction)
  snapshot.confirmedDone.forEach((item, index) => assertFieldNotSensitiveForPrompt(`confirmedDone[${index}]`, item))
  snapshot.confirmedOpen.forEach((item, index) => assertFieldNotSensitiveForPrompt(`confirmedOpen[${index}]`, item))
  snapshot.blockers.forEach((item, index) => assertFieldNotSensitiveForPrompt(`blockers[${index}]`, item))
  snapshot.missingSections.forEach((item, index) =>
    assertFieldNotSensitiveForPrompt(`missingSections[${index}]`, item)
  )
  ;(snapshot.requiredFiles ?? []).forEach((file, index) => {
    assertFieldNotSensitiveForPrompt(`requiredFiles[${index}].displayName`, file.displayName)
    assertFieldNotSensitiveForPrompt(`requiredFiles[${index}].expectedFilename`, file.expectedFilename)
    assertFieldNotSensitiveForPrompt(`requiredFiles[${index}].purpose`, file.purpose)
  })
}

// ===========================================================================
// Feste, deterministische Abschnittsreihenfolge
// ===========================================================================

function formatTextField(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : 'Keine'
}

function formatListField(items: string[]): string {
  if (items.length === 0) return 'Keine'
  return items.map((item) => `- ${item}`).join('\n')
}

/** localPath erscheint nie im Prompt - es ist ein ungeprueftes Feld und wird nie gelesen oder aufgeloest. */
function formatRequiredFiles(files: RequiredFile[]): string {
  if (files.length === 0) return 'Keine'
  return files
    .map((file, index) => {
      const marker = file.isSensitive ? ' [SENSIBEL]' : ''
      return [
        `${index + 1}. ${file.displayName}${marker}`,
        `   Erwarteter Dateiname: ${file.expectedFilename.length > 0 ? file.expectedFilename : '(nicht angegeben)'}`,
        `   SHA-256: ${file.sha256 ?? '(nicht angegeben)'}`,
        `   Zweck: ${file.purpose.length > 0 ? file.purpose : '(nicht angegeben)'}`,
        `   Pflichtdatei: ${file.isRequired ? 'ja' : 'nein'}`,
        `   Erneuter Upload erforderlich: ${file.reuploadRequired ? 'ja' : 'nein'}`,
        `   Sensibel: ${file.isSensitive ? 'ja' : 'nein'}`
      ].join('\n')
    })
    .join('\n')
}

// Gemeinsame Sicherheitsregeln - identisch fuer beide Provider, daher als
// eigene Konstante extrahiert statt in beiden Regellisten zu duplizieren.
const COMMON_SAFETY_RULES = [
  'Aendere keine bereits eingefrorenen/abgeschlossenen Arbeitsphasen ohne zwingenden technischen Grund.',
  'Beginne keine spaeteren, noch nicht freigegebenen Phasen.',
  'Nenne ausschliesslich tatsaechlich beobachtete Ergebnisse und Arbeitsstaende - keine erfundenen Testergebnisse oder Arbeitsstaende.'
]

const CHATGPT_WORK_RULES = [
  'Fruehrer Chatverlauf steht in dieser Sitzung nicht zur Verfuegung und darf nicht als vorhanden angenommen werden.',
  'Ausschliesslich der oben angegebene, bestaetigte Snapshot gilt als verbindlicher aktueller Stand.',
  'Bearbeite vorrangig die oben genannte "Aktuelle Aufgabe" und den "Naechsten exakten Schritt".',
  ...COMMON_SAFETY_RULES
]
  .map((line) => `- ${line}`)
  .join('\n')

const CLAUDE_WORK_RULES = [
  'Halte klare Dateigrenzen ein: bearbeite ausschliesslich Dateien, die fuer die oben genannte Aufgabe tatsaechlich erforderlich sind.',
  'Lies vorhandene Dateien zuerst vollstaendig, bevor du Aenderungen vornimmst.',
  'Veraendere keine Dateien, die fuer diese Aufgabe nicht ausdruecklich erlaubt sind.',
  'Fuehre Pruefungen ausschliesslich tatsaechlich aus und melde nur tatsaechlich beobachtete Ergebnisse.',
  'Stoppe nach dem verlangten Arbeitsblock und warte auf weitere Anweisung.',
  ...COMMON_SAFETY_RULES
]
  .map((line) => `- ${line}`)
  .join('\n')

function buildPromptText(
  projectName: string,
  provider: GenerateContinuationPromptInput['provider'],
  snapshot: ContinuationSnapshot
): string {
  const workRules = provider === 'CHATGPT' ? CHATGPT_WORK_RULES : CLAUDE_WORK_RULES
  const sections = [
    `## 1. Projekt und Provider\nProjekt: ${projectName}\nProvider: ${provider}`,
    `## 2. Aktuelle Aufgabe\n${formatTextField(snapshot.currentTask)}`,
    `## 3. Bestaetigt erledigt\n${formatListField(snapshot.confirmedDone)}`,
    `## 4. Noch offen\n${formatListField(snapshot.confirmedOpen)}`,
    `## 5. Blocker\n${formatListField(snapshot.blockers)}`,
    `## 6. Letzter vollstaendiger Abschnitt\n${formatTextField(snapshot.lastCompleteSection)}`,
    `## 7. Fehlende Abschnitte\n${formatListField(snapshot.missingSections)}`,
    `## 8. Naechster exakter Schritt\n${formatTextField(snapshot.nextExactStep)}`,
    `## 9. Zusaetzliche menschliche Handlung\n${formatTextField(snapshot.additionalHumanAction)}`,
    `## 10. Benoetigte Dateien\n${formatRequiredFiles(snapshot.requiredFiles ?? [])}`,
    `## 11. Arbeitsregeln fuer die Fortsetzung\n${workRules}`
  ]
  return sections.join('\n\n')
}

// ===========================================================================
// Oeffentliche Funktion
// ===========================================================================

/**
 * Erzeugt einen sicheren, deterministischen, provider-spezifischen
 * Fortsetzungsprompt aus einem bereits bestaetigten Snapshot. Rein lesend -
 * es wird nichts in der Datenbank veraendert, keine Datei geoeffnet, kein
 * lokaler Pfad aufgeloest. promptText besteht ausschliesslich aus
 * kuratierten Feldern und festen Textbausteinen, ohne Zeitstempel oder
 * Zufallswerte, daher erzeugen identische Eingaben bei unveraenderten
 * Projekt-Regeln byte-identischen Text -
 * generatedAt ist ein separates, rein informatives Ergebnisfeld.
 */
export function generateContinuationPrompt(
  db: Database.Database,
  input: GenerateContinuationPromptInput
): GenerateContinuationPromptResult {
  const session = getSessionById(db, input.sessionId)
  const snapshot = getSnapshot(db, session.projectId, input.sessionId, input.snapshotId)

  if (input.provider !== session.provider) {
    throw new ContinuationError(
      'PROVIDER_MISMATCH',
      'Angegebener Provider entspricht nicht dem Provider der Sitzung.'
    )
  }
  if (snapshot.confirmationState !== 'CONFIRMED') {
    throw new ContinuationError('SNAPSHOT_NOT_CONFIRMED', `Snapshot ${snapshot.id} ist nicht bestaetigt.`)
  }

  const project = getProjectById(db, session.projectId)

  assertPromptContentSafe(project.name, snapshot)

  const currentRules = getCurrentProjectRules(db, project.id)
  let promptText = buildPromptText(project.name, input.provider, snapshot)
  if (currentRules !== null) {
    assertFieldNotSensitiveForPrompt('projectRules', currentRules.contentMarkdown)
    promptText = `PROJECT RULES\nRegeln bestimmen das erwartete Verhalten und haben bei Widerspruechen Vorrang vor Aufgaben und Projekt-Kontext. Sie erteilen keine Datei-, Befehls-, Git- oder Netzwerkberechtigungen und erweitern keine technischen Faehigkeiten.\n\n${currentRules.contentMarkdown}\n\n---\n\n${promptText}`
  }

  // Abschliessende Pruefung ueber den fertigen Text, damit ein spaeter neu
  // hinzugefuegtes Promptfeld nicht versehentlich ungeprueft bliebe.
  assertFieldNotSensitiveForPrompt('promptText', promptText)

  if (promptText.length > CONTINUATION_PROMPT_MAX_LENGTH) {
    throw new ContinuationError(
      'PROMPT_TOO_LARGE',
      `Der erzeugte Prompt ueberschreitet die maximale Laenge von ${CONTINUATION_PROMPT_MAX_LENGTH} Zeichen.`
    )
  }

  return {
    provider: input.provider,
    promptText,
    generatedAt: new Date().toISOString()
  }
}
