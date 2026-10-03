import type { ControllerPlan } from '@shared/types'
import { validateControllerPlan } from './controllerPlanValidation'

// Meilenstein 4.7A - Claude Code Planning Adapter. Diese Datei validiert
// AUSSCHLIESSLICH die Transport-/Ausgabeform der Claude-CLI (`--output-format
// json`-Huelle plus das darin enthaltene strukturierte Ergebnis) - sie ruft
// NIEMALS einen Prozess auf, kennt kein Dateisystem, kennt kein
// Projekt/Work-Request. Ob ein valider ControllerPlan tatsaechlich freigegeben
// ist, entscheidet diese Datei NICHT - siehe controllerPlanValidation.ts
// (Vorschlag ist niemals automatisch Autorisierung).
//
// WICHTIG: die hier verwendete `--output-format json`-Huellenform ist das
// REVIEWTE Transport-Profil fuer den TATSAECHLICH GETESTETEN Aufruf mit
// Claude Code 2.1.266 (bestaetigt durch den ersten echten Smoke-Test - siehe
// M4.7A-Review-Historie). Sie beansprucht KEINE Kompatibilitaet mit
// beliebigen zukuenftigen Claude-Code-Versionen - eine spaetere Version kann
// dieses Profil aendern und muesste erneut per Smoke-Test bestaetigt werden
// (siehe claudeCliAdapter.ts's TESTED_CLAUDE_CODE_VERSIONS).
//
// Der beobachtete Aufruf mit `--json-schema` liefert den strukturierten
// Vorschlag NICHT als JSON-Text innerhalb von `result`, sondern als eigenes
// Objekt-Feld `structured_output` auf oberster Huellen-Ebene - das war vor
// dem ersten Smoke-Test ein unbestaetigtes Kandidaten-Verhalten, ist jetzt
// aber die massgebliche, empirisch bestaetigte Quelle des Vorschlags (siehe
// extractControllerPlanProposal unten). `result`/`session_id` werden weiterhin
// als Transport-Felder auf Form geprueft, aber NIE zurueckgegeben oder fuer
// den ControllerPlan verwendet.

export type ClaudeOutputValidationErrorCode = 'INVALID_OUTPUT' | 'OUTPUT_LIMIT'

export class ClaudeOutputValidationError extends Error {
  constructor(
    public readonly code: ClaudeOutputValidationErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ClaudeOutputValidationError'
  }
}

// Derselbe Cap wie in der Vorgabe Abschnitt 14 ("validated ControllerPlan
// serialized size: 128 KiB") - geprueft NACH erfolgreicher struktureller
// Validierung, gegen exakt dasselbe serialisierte Objekt, das auch
// zurueckgegeben wird.
export const CONTROLLER_PLAN_MAX_SERIALIZED_BYTES = 128 * 1024

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}

// Strikter UTF-8-Dekoder: `fatal: true` wirft bei ungueltigen Byte-Sequenzen
// (statt sie stillschweigend durch U+FFFD zu ersetzen), `ignoreBOM: true`
// verhindert, dass eine fuehrende Byte-Order-Mark automatisch entfernt wird -
// eine vorhandene BOM bleibt dadurch im dekodierten Text sichtbar und wird
// unten explizit abgelehnt (siehe Vorgabe Abschnitt 21: "reject BOM").
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function decodeStrictUtf8(buffer: Buffer): string {
  let text: string
  try {
    text = STRICT_UTF8_DECODER.decode(buffer)
  } catch {
    throw new ClaudeOutputValidationError('INVALID_OUTPUT', 'Die Ausgabe ist keine gueltige UTF-8-Kodierung.')
  }
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    throw new ClaudeOutputValidationError(
      'INVALID_OUTPUT',
      'Eine Byte-Order-Mark (BOM) am Anfang der Ausgabe wird nicht akzeptiert.'
    )
  }
  return text
}

/**
 * Ergebnis der strukturellen Huellen-Validierung - reine Transportdaten,
 * KEINE Autorisierungs-/Erfolgs-Entscheidung. Der Aufrufer (claudeCliAdapter)
 * entscheidet anhand eines profil-eigenen Terminal-Erfolgs-Praedikats, ob
 * ueberhaupt versucht wird, structuredOutput zu interpretieren, und
 * konstruiert den aeusseren SUCCEEDED/FAILED-Status selbst (siehe Vorgabe
 * Abschnitt 23: "Hub constructs status. Claude does not."). `structuredOutput`
 * ist absichtlich `unknown` - seine Form wird ausschliesslich durch den
 * jeweiligen Proposal-Validator geprueft (siehe extractControllerPlanProposal/
 * validateCodeChangeProposal), nicht hier.
 *
 * `apiErrorStatus`/`terminalReason` (Meilenstein 4.7B.2 - siehe
 * claudeCliAdapter.ts's CODE-CHANGE-Profil): Das M4.7A-Planungsprofil
 * verwendet diese beiden Felder weiterhin bewusst NICHT (siehe dortiger
 * Kommentar zu `subtype` - dessen genauer Erfolgswert war beim ersten
 * M4.7A-Smoke-Test noch nicht bestaetigt). Der zweite, echte Smoke-Test hat
 * `api_error_status`/`terminal_reason` inzwischen als Teil des reviewten,
 * bestaetigten Terminal-Profils etabliert - das strengere M4.7B.2
 * Code-Change-Profil nutzt beide fuer seine zusaetzlichen, bestaetigten
 * Terminal-Erfolgs-Pruefungen. Beide Felder bleiben `unknown` (nicht auf
 * einen bestimmten Typ verengt) - fehlt das jeweilige optionale
 * Huellen-Feld, ist der Wert `undefined`, was jeder strengere
 * Gleichheitsvergleich (z. B. `=== null`/`=== 'completed'`) bereits
 * automatisch fail-closed behandelt.
 */
export interface ClaudeCliEnvelope {
  type: string
  subtype: string
  isError: boolean
  structuredOutput: unknown
  apiErrorStatus: unknown
  terminalReason: unknown
}

// Empirisch bestaetigte Pflichtfelder der 2.1.266-Huelle fuer dieses
// Aufrufprofil (`--output-format json --json-schema ...`). `result` und
// `session_id` bleiben Pflicht-Transportfelder (Formpruefung), werden aber
// NIE in ClaudeCliEnvelope uebernommen oder zurueckgegeben.
const ENVELOPE_REQUIRED_KEYS = ['type', 'subtype', 'is_error', 'result', 'session_id', 'structured_output'] as const

// Empirisch beobachtete, rein informative optionale Metadatenfelder der
// 2.1.266-Huelle - werden bei Vorhandensein toleriert, aber NIE in
// ClaudeCliEnvelope uebernommen, geloggt, persistiert oder an das
// Hub-Ergebnis weitergereicht (siehe Vorgabe Abschnitt 19: "Do not spread
// arbitrary CLI envelope fields into Hub output"). Reine Telemetrie-Objekte
// (modelUsage/usage/subagent_stats/permission_denials) bleiben vollstaendig
// opak - ihre innere Form wird nie geprueft, da der Hub sie nicht konsumiert.
const ENVELOPE_OPTIONAL_KEYS = [
  'api_error_status',
  'duration_api_ms',
  'duration_ms',
  'fast_mode_disabled_reason',
  'fast_mode_state',
  'first_content_frame_ms',
  'modelUsage',
  'num_turns',
  'permission_denials',
  'queued_turn_count',
  'stop_reason',
  'subagent_stats',
  'terminal_reason',
  'time_to_request_ms',
  'total_cost_usd',
  'ttft_ms',
  'ttft_stream_ms',
  'usage',
  'uuid'
] as const
const ENVELOPE_ALLOWED_KEYS: readonly string[] = [...ENVELOPE_REQUIRED_KEYS, ...ENVELOPE_OPTIONAL_KEYS]

function requireOwn(raw: Record<string, unknown>, key: string): unknown {
  if (!hasOwn(raw, key)) {
    throw new ClaudeOutputValidationError('INVALID_OUTPUT', `Die Claude-CLI-Huelle enthaelt kein Feld "${key}".`)
  }
  return raw[key]
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = requireOwn(raw, key)
  if (typeof value !== 'string') {
    throw new ClaudeOutputValidationError('INVALID_OUTPUT', `Das Huellen-Feld "${key}" muss Text sein.`)
  }
  return value
}

/**
 * Erfordert, dass `stdout` als Ganzes exakt EINEN vollstaendigen JSON-Wert
 * (mit ausschliesslich umgebendem JSON-Leerraum) darstellt - `JSON.parse`
 * lehnt fuehrende/nachgestellte Nicht-Leerraum-Zeichen (Markdown-Fences,
 * Prosa, abgeschnittenes JSON) bereits nativ ab (siehe Vorgabe Abschnitt 20:
 * kein eigener Parser noetig, solange dieselbe geparste Reprasentation
 * sowohl validiert als auch konsumiert wird). Unbekannte zukuenftige
 * Huellen-Felder fallen weiterhin fail-closed durch (siehe
 * ENVELOPE_ALLOWED_KEYS-Kommentar oben) - dieses Profil ist explizit fuer
 * die getestete 2.1.266-Version reviewt, nicht fuer beliebige spaetere
 * Versionen.
 */
export function parseClaudeCliEnvelope(stdout: Buffer): ClaudeCliEnvelope {
  const text = decodeStrictUtf8(stdout)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ClaudeOutputValidationError(
      'INVALID_OUTPUT',
      'Die Standardausgabe ist kein einzelner, vollstaendiger JSON-Wert.'
    )
  }
  if (!isPlainObject(raw)) {
    throw new ClaudeOutputValidationError('INVALID_OUTPUT', 'Die Claude-CLI-Huelle muss ein JSON-Objekt sein.')
  }
  const unknownKeys = Object.keys(raw).filter((key) => !ENVELOPE_ALLOWED_KEYS.includes(key))
  if (unknownKeys.length > 0) {
    throw new ClaudeOutputValidationError(
      'INVALID_OUTPUT',
      `Die Claude-CLI-Huelle enthaelt unbekannte(s) Feld(er): ${unknownKeys.join(', ')}.`
    )
  }

  const type = requireString(raw, 'type')
  if (type !== 'result') {
    throw new ClaudeOutputValidationError('INVALID_OUTPUT', `Unerwarteter Huellen-Typ "${type}".`)
  }
  const subtype = requireString(raw, 'subtype')
  const isErrorRaw = requireOwn(raw, 'is_error')
  if (typeof isErrorRaw !== 'boolean') {
    throw new ClaudeOutputValidationError('INVALID_OUTPUT', 'Das Huellen-Feld "is_error" muss ein boolescher Wert sein.')
  }
  // Reine Transport-Formpruefung - der Inhalt wird bewusst NIE zurueckgegeben
  // oder fuer den ControllerPlan verwendet (siehe Datei-Kommentar oben).
  requireString(raw, 'result')
  requireString(raw, 'session_id')
  const structuredOutput = requireOwn(raw, 'structured_output')
  // Beide optional (siehe ENVELOPE_OPTIONAL_KEYS) - `undefined`, wenn das
  // Huellen-Feld fehlt (siehe ClaudeCliEnvelope-Kommentar oben).
  const apiErrorStatus = hasOwn(raw, 'api_error_status') ? raw.api_error_status : undefined
  const terminalReason = hasOwn(raw, 'terminal_reason') ? raw.terminal_reason : undefined

  return { type, subtype, isError: isErrorRaw, structuredOutput, apiErrorStatus, terminalReason }
}

/**
 * Validiert `structuredOutput` (das Objekt aus der Huelle unter
 * `structured_output`, NICHT `result`) direkt mit der bestehenden,
 * unveraenderten `validateControllerPlan` - kein erneutes Stringifizieren/
 * Parsen, kein Koerzieren, kein Reparieren, keine Defaults. Die
 * Groessenpruefung laeuft NACH erfolgreicher struktureller Validierung gegen
 * exakt das validierte (nicht das rohe) Objekt.
 */
export function extractControllerPlanProposal(structuredOutput: unknown): ControllerPlan {
  let plan: ControllerPlan
  try {
    plan = validateControllerPlan(structuredOutput)
  } catch (error) {
    throw new ClaudeOutputValidationError('INVALID_OUTPUT', error instanceof Error ? error.message : String(error))
  }
  const serializedByteLength = Buffer.byteLength(JSON.stringify(plan), 'utf8')
  if (serializedByteLength > CONTROLLER_PLAN_MAX_SERIALIZED_BYTES) {
    throw new ClaudeOutputValidationError(
      'OUTPUT_LIMIT',
      `Der validierte ControllerPlan ueberschreitet das Groessenlimit von ${CONTROLLER_PLAN_MAX_SERIALIZED_BYTES} Bytes.`
    )
  }
  return plan
}
