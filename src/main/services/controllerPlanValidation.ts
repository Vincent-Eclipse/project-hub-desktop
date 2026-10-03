import {
  AGENT_DISPLAY_NAME_MAX_LENGTH,
  AGENT_ID_MAX_LENGTH,
  AGENT_ROLES,
  CONTROLLER_PLAN_MAX_TASK_DRAFTS,
  TASK_DRAFT_KEY_MAX_LENGTH,
  TASK_DRAFT_MAX_DEPENDS_ON_KEYS,
  TASK_MARKDOWN_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
  WORK_REQUEST_PLAN_MAX_LENGTH,
  type AgentDescriptor,
  type AgentRole,
  type ControllerPlan,
  type ControllerTaskDraft,
  type PlanningDecisionRequest,
  type PlanningResult,
  type WorkRequestOption
} from '@shared/types'
import { validateRelevantFilesList } from './taskRelevantFiles'

// Meilenstein 4.4A - Controller/Agent/Planning-Vertragsschicht. Reine
// Code-Ebene Validierung: KEINE Datenbank-Persistenz, KEINE
// IPC-Exposition, KEIN KI-Aufruf, KEINE Ausfuehrung. Validiert nur, dass ein
// ControllerPlan/ControllerTaskDraft/AgentDescriptor INHALTLICH in sich
// konsistent ist - Validierung ist NICHT Autorisierung, ein gueltiger
// Vorschlag ist NIEMALS automatisch freigegeben (siehe shared/types.ts).
//
// Diese Schicht ist bewusst FAIL-CLOSED, weil ein zukuenftiger Produzent
// dieser Vertraege KI-generiert sein wird:
//   - planningResult wird STRUKTURELL validiert (siehe
//     validateStructuralPlanningResult unten: planMarkdown/decisionRequests/
//     options muessen tatsaechlich die erwartete Form haben, kein
//     null/primitives/fehlendes Pflichtfeld) - aber OHNE die vollstaendigen
//     M4.3-Geschaeftsregeln (Options-Anzahl 2-10, Options-Schluessel-Format/
//     Eindeutigkeit, recommendedOptionKey-Mitgliedschaft) zu duplizieren.
//     Diese bleiben ausschliesslich in workRequestService.ts
//     (applyPlanningResult) massgeblich.
//   - jedes ControllerTaskDraft-Feld ist echt PFLICHT (requireOwnProperty) -
//     ein fehlendes Feld ist ein Fehler, waehrend ein vorhandener, aber
//     leerer Wert (leerer String/leeres Array) weiterhin gueltig bleibt, wo
//     der Vertrag das erlaubt. Kein stillschweigendes `?? ''`/`?? []`.
//   - unbekannte Felder (Tippfehler oder Autoritaets-Felder) werden primaer
//     ueber eine exakte Schluessel-Positivliste abgelehnt (assertExactKeys),
//     nicht nur ueber eine (zwangslaeufig unvollstaendige) Blacklist.

export class InvalidControllerPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidControllerPlanError'
  }
}

export class InvalidControllerTaskDraftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidControllerTaskDraftError'
  }
}

export class DuplicateControllerTaskDraftKeyError extends Error {
  constructor(key: string) {
    super(`ControllerTaskDraft-Schluessel "${key}" ist innerhalb dieses ControllerPlan nicht eindeutig.`)
    this.name = 'DuplicateControllerTaskDraftKeyError'
  }
}

export class ControllerTaskDraftDependencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ControllerTaskDraftDependencyError'
  }
}

export class InvalidAgentDescriptorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAgentDescriptorError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}

/**
 * Pflichtfeld statt stillschweigendem Default. Fehlt das Feld, ist das ein
 * Fehler - ein leerer String/leeres Array BLEIBT gueltig, wenn das Feld
 * tatsaechlich vorhanden ist.
 */
function requireOwnProperty(raw: Record<string, unknown>, key: string, ErrorClass: new (message: string) => Error): unknown {
  if (!hasOwn(raw, key)) {
    throw new ErrorClass(`Feld "${key}" fehlt - dieses Feld ist erforderlich (auch ein leerer Wert muss explizit angegeben werden).`)
  }
  return raw[key]
}

/**
 * Primaere Verteidigung - eine exakte Schluessel-Positivliste statt einer
 * (zwangslaeufig unvollstaendigen) Blacklist. Jedes nicht gelistete Feld
 * (Tippfehler wie "dependOnKeys" ebenso wie Autoritaets-Felder wie
 * "provider") wird abgelehnt statt stillschweigend zu verschwinden.
 */
function assertExactKeys(
  raw: Record<string, unknown>,
  allowedKeys: readonly string[],
  contextLabel: string,
  ErrorClass: new (message: string) => Error
): void {
  const allowed = new Set(allowedKeys)
  const extra = Object.keys(raw).filter((key) => !allowed.has(key))
  if (extra.length > 0) {
    throw new ErrorClass(
      `${contextLabel} enthaelt unbekannte(s) Feld(er): ${extra.join(', ')}. Erlaubt sind ausschliesslich: ${allowedKeys.join(', ')}.`
    )
  }
}

// Sekundaere, spezifischere Fehlermeldung fuer die haeufigsten Autoritaets-
// Tippfehler/-Versuche - laeuft VOR assertExactKeys, das ohnehin jedes
// unbekannte Feld ablehnt (auch diese), aber mit einer weniger spezifischen
// Meldung. Kein Ersatz fuer assertExactKeys, nur eine klarere Diagnose.
const PROHIBITED_PLANNING_FIELDS = [
  'priority',
  'agentId',
  'agent',
  'provider',
  'model',
  'executionAdapter',
  'capabilities',
  'permissions',
  'tools',
  'commands',
  'usageRemaining',
  'contextRemaining',
  'status'
] as const

const PROHIBITED_AGENT_DESCRIPTOR_FIELDS = [
  'usage',
  'contextBudget',
  'provider',
  'model',
  'cliPath',
  'apiKey',
  'command',
  'availability',
  'currentWorkload',
  'permission',
  'permissions',
  'capability',
  'capabilities'
] as const

function assertNoProhibitedFields(
  raw: Record<string, unknown>,
  prohibited: readonly string[],
  contextLabel: string,
  ErrorClass: new (message: string) => Error
): void {
  const present = prohibited.filter((field) => hasOwn(raw, field))
  if (present.length > 0) {
    throw new ErrorClass(
      `${contextLabel} darf kein Feld "${present[0]}" enthalten - Planung ist von Agent/Provider/Modell/Faehigkeiten/Berechtigungen entkoppelt (siehe Vorrangreihenfolge).`
    )
  }
}

// Deterministisches, kurzes Schluessel-Format - dieselbe Form wie
// WorkRequestOption.key (workRequestService.ts's OPTION_KEY_PATTERN): muss
// mit einem alphanumerischen Zeichen beginnen, danach nur
// Alphanumerisch/Unterstrich/Bindestrich. Wird sowohl fuer
// ControllerTaskDraft.key als auch AgentDescriptor.id verwendet - beides ist
// konzeptionell dieselbe Art von stabiler, kurzer, lokaler Identitaet.
const SLUG_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function validateSlugKey(raw: unknown, maxLength: number, fieldLabel: string, ErrorClass: new (message: string) => Error): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxLength || !SLUG_KEY_PATTERN.test(raw)) {
    throw new ErrorClass(
      `${fieldLabel} muss ein stabiler Schluessel sein (1-${maxLength} Zeichen, beginnt alphanumerisch, danach nur Buchstaben/Ziffern/"_"/"-").`
    )
  }
  return raw
}

function validateRequiredText(raw: unknown, maxLength: number, fieldLabel: string, ErrorClass: new (message: string) => Error): string {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > maxLength) {
    throw new ErrorClass(`${fieldLabel} muss 1 bis ${maxLength} Zeichen lang sein.`)
  }
  return raw
}

// Bewusst KEIN Trimmen/Umschreiben - gueltiges Markdown wird exakt erhalten
// (siehe M4.4-Vorgabe "Markdown: preserve valid Markdown exactly"), analog
// taskService.ts's validateMarkdown. Erlaubt einen leeren String (das Feld
// selbst bleibt aber ueber requireOwnProperty PFLICHT - siehe Aufrufer).
function validateBoundedMarkdown(raw: unknown, maxLength: number, fieldLabel: string, ErrorClass: new (message: string) => Error): string {
  if (typeof raw !== 'string' || raw.length > maxLength) {
    throw new ErrorClass(`Feld "${fieldLabel}" ist ungueltig (Text, max. ${maxLength} Zeichen).`)
  }
  return raw
}

const TASK_DRAFT_ALLOWED_KEYS = [
  'key',
  'title',
  'goalMarkdown',
  'descriptionMarkdown',
  'acceptanceCriteriaMarkdown',
  'verificationRequirementsMarkdown',
  'relevantFiles',
  'dependsOnKeys'
] as const

/**
 * Validiert EIN ControllerTaskDraft-Rohobjekt fuer sich (Feldformat) - prueft
 * NICHT, ob dependsOnKeys tatsaechlich auf andere Schluessel IM PLAN
 * verweisen (das braucht Kenntnis aller Schluessel und passiert in
 * validateControllerPlan). Lehnt Duplikate INNERHALB der eigenen
 * dependsOnKeys-Liste ab (einfachste, eindeutige Semantik - eine doppelte
 * Referenz ist niemals fachlich sinnvoll). Alle acht Felder sind PFLICHT -
 * kein stillschweigendes Defaulting fehlender Felder (siehe Datei-Kommentar
 * oben).
 */
export function validateControllerTaskDraft(raw: unknown): ControllerTaskDraft {
  if (!isPlainObject(raw)) throw new InvalidControllerTaskDraftError('Jedes ControllerTaskDraft muss ein Objekt sein.')
  assertNoProhibitedFields(raw, PROHIBITED_PLANNING_FIELDS, 'ControllerTaskDraft', InvalidControllerTaskDraftError)
  assertExactKeys(raw, TASK_DRAFT_ALLOWED_KEYS, 'ControllerTaskDraft', InvalidControllerTaskDraftError)

  const key = validateSlugKey(
    requireOwnProperty(raw, 'key', InvalidControllerTaskDraftError),
    TASK_DRAFT_KEY_MAX_LENGTH,
    'ControllerTaskDraft.key',
    InvalidControllerTaskDraftError
  )
  const title = validateRequiredText(
    requireOwnProperty(raw, 'title', InvalidControllerTaskDraftError),
    TASK_TITLE_MAX_LENGTH,
    'ControllerTaskDraft.title',
    InvalidControllerTaskDraftError
  )
  const goalMarkdown = validateBoundedMarkdown(
    requireOwnProperty(raw, 'goalMarkdown', InvalidControllerTaskDraftError),
    TASK_MARKDOWN_MAX_LENGTH,
    'goalMarkdown',
    InvalidControllerTaskDraftError
  )
  const descriptionMarkdown = validateBoundedMarkdown(
    requireOwnProperty(raw, 'descriptionMarkdown', InvalidControllerTaskDraftError),
    TASK_MARKDOWN_MAX_LENGTH,
    'descriptionMarkdown',
    InvalidControllerTaskDraftError
  )
  const acceptanceCriteriaMarkdown = validateBoundedMarkdown(
    requireOwnProperty(raw, 'acceptanceCriteriaMarkdown', InvalidControllerTaskDraftError),
    TASK_MARKDOWN_MAX_LENGTH,
    'acceptanceCriteriaMarkdown',
    InvalidControllerTaskDraftError
  )
  const verificationRequirementsMarkdown = validateBoundedMarkdown(
    requireOwnProperty(raw, 'verificationRequirementsMarkdown', InvalidControllerTaskDraftError),
    TASK_MARKDOWN_MAX_LENGTH,
    'verificationRequirementsMarkdown',
    InvalidControllerTaskDraftError
  )

  const relevantFilesRaw = requireOwnProperty(raw, 'relevantFiles', InvalidControllerTaskDraftError)
  let relevantFiles: string[]
  try {
    relevantFiles = validateRelevantFilesList(relevantFilesRaw)
  } catch (error) {
    throw new InvalidControllerTaskDraftError(error instanceof Error ? error.message : String(error))
  }

  const dependsOnKeysRaw = requireOwnProperty(raw, 'dependsOnKeys', InvalidControllerTaskDraftError)
  if (!Array.isArray(dependsOnKeysRaw)) {
    throw new InvalidControllerTaskDraftError('ControllerTaskDraft.dependsOnKeys muss eine Liste sein.')
  }
  if (dependsOnKeysRaw.length > TASK_DRAFT_MAX_DEPENDS_ON_KEYS) {
    throw new InvalidControllerTaskDraftError(`ControllerTaskDraft.dependsOnKeys enthaelt zu viele Eintraege (max. ${TASK_DRAFT_MAX_DEPENDS_ON_KEYS}).`)
  }
  const dependsOnKeys = dependsOnKeysRaw.map((entry) =>
    validateSlugKey(entry, TASK_DRAFT_KEY_MAX_LENGTH, 'ControllerTaskDraft.dependsOnKeys[]', InvalidControllerTaskDraftError)
  )
  if (new Set(dependsOnKeys).size !== dependsOnKeys.length) {
    throw new InvalidControllerTaskDraftError(`ControllerTaskDraft "${key}" enthaelt doppelte dependsOnKeys-Eintraege.`)
  }

  return {
    key,
    title,
    goalMarkdown,
    descriptionMarkdown,
    acceptanceCriteriaMarkdown,
    verificationRequirementsMarkdown,
    relevantFiles,
    dependsOnKeys
  }
}

// DFS-Zyklenerkennung ueber den dependsOnKeys-Graphen. Deckt sowohl direkte
// (A->B->A) als auch mehrgliedrige (A->B->C->A) Zyklen ab - Selbst-
// Abhaengigkeit wird bereits vorher separat geprueft (klareres Fehlerbild),
// eine Selbst-Referenz waere aber ohnehin auch hier als 1-Knoten-Zyklus
// erkennbar.
function findDependencyCycle(taskDrafts: readonly ControllerTaskDraft[]): string[] | null {
  const byKey = new Map(taskDrafts.map((draft) => [draft.key, draft] as const))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  function visit(key: string): string[] | null {
    const status = state.get(key)
    if (status === 'done') return null
    if (status === 'visiting') {
      const cycleStart = stack.indexOf(key)
      return [...stack.slice(cycleStart), key]
    }
    state.set(key, 'visiting')
    stack.push(key)
    const draft = byKey.get(key)
    if (draft) {
      for (const dependencyKey of draft.dependsOnKeys) {
        const found = visit(dependencyKey)
        if (found) return found
      }
    }
    stack.pop()
    state.set(key, 'done')
    return null
  }

  for (const draft of taskDrafts) {
    const found = visit(draft.key)
    if (found) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// STRUKTURELLE (nicht geschaeftliche) Validierung von PlanningResult/
// PlanningDecisionRequest/WorkRequestOption. Deckt NICHT ab: Options-Anzahl
// (2-10), Options-Schluessel-Format/Eindeutigkeit,
// recommendedOptionKey-Mitgliedschaft, Empfehlungstext-Konsistenz - all das
// bleibt ausschliesslich in workRequestService.ts
// (applyPlanningResult/validateDecisionRequest/validateOptions) massgeblich.
// Ziel ist NUR, dass der zurueckgegebene Wert tatsaechlich sicher als
// PlanningResult behandelt werden kann (kein null/primitives/fehlendes
// Pflichtfeld an beliebiger Verschachtelungstiefe).
// ---------------------------------------------------------------------------

const PLANNING_RESULT_ALLOWED_KEYS = ['planMarkdown', 'decisionRequests'] as const
const DECISION_REQUEST_ALLOWED_KEYS = ['questionMarkdown', 'options', 'recommendedOptionKey', 'recommendationMarkdown'] as const
const OPTION_ALLOWED_KEYS = ['key', 'label', 'descriptionMarkdown'] as const

function validateStructuralOption(raw: unknown): WorkRequestOption {
  if (!isPlainObject(raw)) throw new InvalidControllerPlanError('Jede Option in planningResult.decisionRequests[].options muss ein Objekt sein.')
  assertExactKeys(raw, OPTION_ALLOWED_KEYS, 'planningResult.decisionRequests[].options[]', InvalidControllerPlanError)

  const key = requireOwnProperty(raw, 'key', InvalidControllerPlanError)
  if (typeof key !== 'string') throw new InvalidControllerPlanError('planningResult.decisionRequests[].options[].key muss Text sein.')
  const label = requireOwnProperty(raw, 'label', InvalidControllerPlanError)
  if (typeof label !== 'string') throw new InvalidControllerPlanError('planningResult.decisionRequests[].options[].label muss Text sein.')

  const option: WorkRequestOption = { key, label }
  if (hasOwn(raw, 'descriptionMarkdown')) {
    if (typeof raw.descriptionMarkdown !== 'string') {
      throw new InvalidControllerPlanError('planningResult.decisionRequests[].options[].descriptionMarkdown muss Text sein.')
    }
    option.descriptionMarkdown = raw.descriptionMarkdown
  }
  return option
}

function validateStructuralDecisionRequest(raw: unknown): PlanningDecisionRequest {
  if (!isPlainObject(raw)) throw new InvalidControllerPlanError('Jeder Eintrag in planningResult.decisionRequests muss ein Objekt sein.')
  assertExactKeys(raw, DECISION_REQUEST_ALLOWED_KEYS, 'planningResult.decisionRequests[]', InvalidControllerPlanError)

  const questionMarkdown = requireOwnProperty(raw, 'questionMarkdown', InvalidControllerPlanError)
  if (typeof questionMarkdown !== 'string') {
    throw new InvalidControllerPlanError('planningResult.decisionRequests[].questionMarkdown muss Text sein.')
  }
  const optionsRaw = requireOwnProperty(raw, 'options', InvalidControllerPlanError)
  if (!Array.isArray(optionsRaw)) {
    throw new InvalidControllerPlanError('planningResult.decisionRequests[].options muss eine Liste sein.')
  }
  const options = optionsRaw.map((entry) => validateStructuralOption(entry))

  const result: PlanningDecisionRequest = { questionMarkdown, options }
  if (hasOwn(raw, 'recommendedOptionKey')) {
    const recommendedOptionKey = raw.recommendedOptionKey
    if (recommendedOptionKey !== null && typeof recommendedOptionKey !== 'string') {
      throw new InvalidControllerPlanError('planningResult.decisionRequests[].recommendedOptionKey muss Text oder null sein.')
    }
    result.recommendedOptionKey = recommendedOptionKey
  }
  if (hasOwn(raw, 'recommendationMarkdown')) {
    if (typeof raw.recommendationMarkdown !== 'string') {
      throw new InvalidControllerPlanError('planningResult.decisionRequests[].recommendationMarkdown muss Text sein.')
    }
    result.recommendationMarkdown = raw.recommendationMarkdown
  }
  return result
}

function validateStructuralPlanningResult(raw: unknown): PlanningResult {
  if (!isPlainObject(raw)) throw new InvalidControllerPlanError('ControllerPlan.planningResult muss ein Objekt sein.')
  assertExactKeys(raw, PLANNING_RESULT_ALLOWED_KEYS, 'ControllerPlan.planningResult', InvalidControllerPlanError)

  const planMarkdown = requireOwnProperty(raw, 'planMarkdown', InvalidControllerPlanError)
  // Dieselbe strukturelle Mindestregel wie workRequestService.ts's
  // validatePlanMarkdown (nicht leer/nur Leerraum, bounded) - NICHT jedoch
  // eine erneute Kopie jeder M4.3-Geschaeftsregel.
  if (typeof planMarkdown !== 'string' || planMarkdown.trim().length === 0 || planMarkdown.length > WORK_REQUEST_PLAN_MAX_LENGTH) {
    throw new InvalidControllerPlanError(
      `ControllerPlan.planningResult.planMarkdown muss 1 bis ${WORK_REQUEST_PLAN_MAX_LENGTH} Zeichen lang sein (nicht nur Leerraum).`
    )
  }
  const decisionRequestsRaw = requireOwnProperty(raw, 'decisionRequests', InvalidControllerPlanError)
  if (!Array.isArray(decisionRequestsRaw)) {
    throw new InvalidControllerPlanError('ControllerPlan.planningResult.decisionRequests muss eine Liste sein.')
  }
  const decisionRequests = decisionRequestsRaw.map((entry) => validateStructuralDecisionRequest(entry))

  return { planMarkdown, decisionRequests }
}

const CONTROLLER_PLAN_ALLOWED_KEYS = ['planningResult', 'taskDrafts'] as const

/**
 * Validiert einen vollstaendigen ControllerPlan: Container-Form (inkl.
 * struktureller planningResult-Validierung, siehe oben), jedes
 * ControllerTaskDraft einzeln, eindeutige Schluessel, und dass
 * dependsOnKeys ausschliesslich auf andere, tatsaechlich vorhandene
 * ControllerTaskDrafts DESSELBEN Plans verweisen - ohne Selbst-Abhaengigkeit
 * und ohne Zyklen (direkt oder mehrgliedrig). Persistiert/fuehrt NICHTS aus.
 */
export function validateControllerPlan(raw: unknown): ControllerPlan {
  if (!isPlainObject(raw)) throw new InvalidControllerPlanError('ControllerPlan muss ein Objekt sein.')
  assertNoProhibitedFields(raw, PROHIBITED_PLANNING_FIELDS, 'ControllerPlan', InvalidControllerPlanError)
  assertExactKeys(raw, CONTROLLER_PLAN_ALLOWED_KEYS, 'ControllerPlan', InvalidControllerPlanError)

  const planningResult = validateStructuralPlanningResult(requireOwnProperty(raw, 'planningResult', InvalidControllerPlanError))

  const taskDraftsRaw = requireOwnProperty(raw, 'taskDrafts', InvalidControllerPlanError)
  if (!Array.isArray(taskDraftsRaw)) {
    throw new InvalidControllerPlanError('ControllerPlan.taskDrafts muss eine Liste sein.')
  }
  if (taskDraftsRaw.length > CONTROLLER_PLAN_MAX_TASK_DRAFTS) {
    throw new InvalidControllerPlanError(`ControllerPlan.taskDrafts enthaelt zu viele Eintraege (max. ${CONTROLLER_PLAN_MAX_TASK_DRAFTS}).`)
  }

  const taskDrafts = taskDraftsRaw.map((entry) => validateControllerTaskDraft(entry))

  const seenKeys = new Set<string>()
  for (const draft of taskDrafts) {
    if (seenKeys.has(draft.key)) throw new DuplicateControllerTaskDraftKeyError(draft.key)
    seenKeys.add(draft.key)
  }

  for (const draft of taskDrafts) {
    if (draft.dependsOnKeys.includes(draft.key)) {
      throw new ControllerTaskDraftDependencyError(`ControllerTaskDraft "${draft.key}" darf nicht von sich selbst abhaengen.`)
    }
    for (const dependencyKey of draft.dependsOnKeys) {
      if (!seenKeys.has(dependencyKey)) {
        throw new ControllerTaskDraftDependencyError(
          `ControllerTaskDraft "${draft.key}" verweist auf die unbekannte dependsOnKeys-Referenz "${dependencyKey}".`
        )
      }
    }
  }

  const cycle = findDependencyCycle(taskDrafts)
  if (cycle) {
    throw new ControllerTaskDraftDependencyError(`ControllerTaskDraft-Abhaengigkeiten enthalten einen Zyklus: ${cycle.join(' -> ')}.`)
  }

  return { planningResult, taskDrafts }
}

const AGENT_ROLE_SET: ReadonlySet<string> = new Set(AGENT_ROLES)
const AGENT_DESCRIPTOR_ALLOWED_KEYS = ['id', 'displayName', 'roles'] as const

/**
 * Validiert ein AgentDescriptor-Rohobjekt - reine Rollen-Identitaet, KEIN
 * Laufzeitzustand (siehe shared/types.ts).
 */
export function validateAgentDescriptor(raw: unknown): AgentDescriptor {
  if (!isPlainObject(raw)) throw new InvalidAgentDescriptorError('AgentDescriptor muss ein Objekt sein.')
  assertNoProhibitedFields(raw, PROHIBITED_AGENT_DESCRIPTOR_FIELDS, 'AgentDescriptor', InvalidAgentDescriptorError)
  assertExactKeys(raw, AGENT_DESCRIPTOR_ALLOWED_KEYS, 'AgentDescriptor', InvalidAgentDescriptorError)

  const id = validateSlugKey(
    requireOwnProperty(raw, 'id', InvalidAgentDescriptorError),
    AGENT_ID_MAX_LENGTH,
    'AgentDescriptor.id',
    InvalidAgentDescriptorError
  )
  const displayName = validateRequiredText(
    requireOwnProperty(raw, 'displayName', InvalidAgentDescriptorError),
    AGENT_DISPLAY_NAME_MAX_LENGTH,
    'AgentDescriptor.displayName',
    InvalidAgentDescriptorError
  )

  const rolesRaw = requireOwnProperty(raw, 'roles', InvalidAgentDescriptorError)
  if (!Array.isArray(rolesRaw) || rolesRaw.length === 0) {
    throw new InvalidAgentDescriptorError('AgentDescriptor.roles muss eine nicht-leere Liste sein.')
  }
  const roles = rolesRaw.map((role): AgentRole => {
    if (typeof role !== 'string' || !AGENT_ROLE_SET.has(role)) {
      throw new InvalidAgentDescriptorError(`Ungueltige AgentRole: ${String(role)}.`)
    }
    return role as AgentRole
  })
  if (new Set(roles).size !== roles.length) {
    throw new InvalidAgentDescriptorError('AgentDescriptor.roles enthaelt doppelte Rollen.')
  }

  return { id, displayName, roles }
}
