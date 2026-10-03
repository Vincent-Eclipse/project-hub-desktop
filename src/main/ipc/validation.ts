import {
  ACTORS,
  RULES_MARKDOWN_MAX_LENGTH,
  type CreateRuleVersionInput,
  AI_ROLES,
  CHAT_AUTHORS,
  CONTEXT_MARKDOWN_MAX_LENGTH,
  CONTEXT_VERSION_AUTHORS,
  LOCAL_PATH_MAX_LENGTH,
  NEXT_ACTORS,
  PROJECT_SHORT_FIELD_MAX_LENGTH,
  PROJECT_STATUSES,
  REQUIRED_FILE_DISPLAY_NAME_MAX_LENGTH,
  RESPONSE_IMPORT_MAX_LENGTH,
  SESSION_STATUSES,
  SESSION_TITLE_MAX_LENGTH,
  SNAPSHOT_LIST_ITEM_MAX_LENGTH,
  SNAPSHOT_LIST_MAX_ITEMS,
  SNAPSHOT_REASON_CODES,
  TASK_BLOCKED_REASON_MAX_LENGTH,
  TASK_MARKDOWN_MAX_LENGTH,
  TASK_MAX_DEPENDENCIES,
  TASK_PRIORITIES,
  TASK_RELEVANT_FILES_MAX_ITEMS,
  TASK_STATUSES,
  TASK_TITLE_MAX_LENGTH,
  DECISION_OPTION_KEY_MAX_LENGTH,
  DECISION_RESOLUTION_NOTE_MAX_LENGTH,
  WORK_REQUEST_INTENT_MAX_LENGTH,
  type Actor,
  type AddChatMessageInput,
  type AiRole,
  type AssignChatMessageToSessionInput,
  type ChatAuthor,
  type ConfirmSnapshotInput,
  type ContextVersionAuthor,
  type CreateContextVersionInput,
  type CreateContinuationSessionInput,
  type CreateDraftSnapshotInput,
  type CreateProjectInput,
  type CreateSessionInput,
  type CreateTaskInput,
  type GenerateContinuationPromptInput,
  type GeneratePromptInput,
  type NextActor,
  type ProjectStatus,
  type RequiredFileInput,
  type ResponseImportAnalyzeInput,
  type ResponseImportApplyInput,
  type ResponseImportSelectedActions,
  type ResponseImportSource,
  type SessionProvider,
  type SessionStatus,
  type SetRoleTemplateOverrideInput,
  type SnapshotReasonCode,
  type TaskPriority,
  type TaskStatus,
  type UpdateProjectInput,
  type UpdateSessionInput,
  type UpdateSettingsInput,
  type UpdateTaskDependenciesInput,
  type UpdateTaskInput,
  type UpdateTaskStatusInput,
  type ResolveDecisionInput,
  type UpdateWorkRequestIntentInput
} from '@shared/types'
import { validateRelevantFilesList } from '../services/taskRelevantFiles'
import { ResponseImportError } from '../services/responseImportErrors'

// Handgeschriebene, abhaengigkeitsfreie Validierung fuer den kleinen
// IPC-Kanal-Umfang von Meilenstein 1 (rund 15 Kanaele). Bewusst kein
// Schema-Validierungs-Paket (Memo Punkt 12.4): Der Umfang ist klein und
// vollstaendig auditierbar, eine zusaetzliche Abhaengigkeit lohnt sich
// fuer Meilenstein 1 nicht. Jede Funktion wirft ValidationError bei
// ungueltiger Eingabe; die IPC-Handler fangen das ab und liefern ein
// typisiertes Fehler-Ergebnis statt einer geworfenen Exception ueber die
// Prozessgrenze.

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

const MAX_NAME_LENGTH = 200
// RC4-Korrektur (Abschnitt 4 der RC4-Vorgabe): vorher zwei separate
// numerische Definitionen (hier UND in shared/types.ts als
// PROJECT_SHORT_FIELD_MAX_LENGTH/CONTEXT_MARKDOWN_MAX_LENGTH) fuer
// dieselben fachlichen Grenzen - jetzt eine einzige Quelle der Wahrheit.
// Als lokale Alias-Konstanten belassen, damit sich an keiner bestehenden
// Aufrufstelle unten irgendetwas aendern musste (identische Namen,
// identische Werte, nur die Herkunft ist jetzt zentral).
const MAX_SHORT_FIELD_LENGTH = PROJECT_SHORT_FIELD_MAX_LENGTH
const MAX_TEXT_LENGTH = CONTEXT_MARKDOWN_MAX_LENGTH
const MAX_FOLDER_PATH_LENGTH = 4096

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') throw new ValidationError(`Feld "${field}" muss ein Text sein.`)
  if (value.length > maxLength) {
    throw new ValidationError(`Feld "${field}" ist zu lang (max. ${maxLength} Zeichen).`)
  }
  return value
}

function requireNonEmptyString(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  const str = requireString(value, field, maxLength)
  if (str.trim().length === 0) throw new ValidationError(`Feld "${field}" darf nicht leer sein.`)
  return str
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`Feld "${field}" muss eine positive Ganzzahl sein.`)
  }
  return value
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`Feld "${field}" hat einen ungueltigen Wert: ${String(value)}.`)
  }
  return value as T
}

/** Optionales Textfeld: darf fehlen, aber wenn vorhanden, muss es ein String im Laengenlimit sein (leer erlaubt). */
function optionalString(value: unknown, field: string, maxLength = MAX_SHORT_FIELD_LENGTH): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, field, maxLength)
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`Feld "${field}" muss true oder false sein.`)
  return value
}

/**
 * Optionales, nullbares ID-Feld: fehlt es, wird es weggelassen (undefined),
 * ist es explizit null, bleibt es null, sonst muss es eine positive Ganzzahl
 * sein.
 */
function optionalNullablePositiveInt(
  raw: Record<string, unknown>,
  field: string
): number | null | undefined {
  if (!(field in raw)) return undefined
  const value = raw[field]
  if (value === null) return null
  return requirePositiveInt(value, field)
}

export function validateCreateProjectInput(raw: unknown): CreateProjectInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer projects:create.')
  const input: CreateProjectInput = {
    name: requireNonEmptyString(raw.name, 'name', MAX_NAME_LENGTH),
    projectType: requireNonEmptyString(raw.projectType, 'projectType', MAX_SHORT_FIELD_LENGTH),
    description: requireString(raw.description ?? '', 'description')
  }
  if (raw.folderPath !== undefined && raw.folderPath !== null) {
    input.folderPath = requireNonEmptyString(raw.folderPath, 'folderPath', MAX_FOLDER_PATH_LENGTH)
  }
  if (raw.status !== undefined) {
    input.status = requireOneOf<ProjectStatus>(raw.status, PROJECT_STATUSES, 'status')
  }
  if (raw.nextActor !== undefined) {
    input.nextActor = requireOneOf<NextActor>(raw.nextActor, NEXT_ACTORS, 'nextActor')
  }
  const currentStep = optionalString(raw.currentStep, 'currentStep', MAX_SHORT_FIELD_LENGTH)
  if (currentStep !== undefined) input.currentStep = currentStep
  const nextAction = optionalString(raw.nextAction, 'nextAction', MAX_SHORT_FIELD_LENGTH)
  if (nextAction !== undefined) input.nextAction = nextAction
  return input
}

export function validateUpdateProjectInput(raw: unknown): UpdateProjectInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer projects:update.')
  const input: UpdateProjectInput = { id: requirePositiveInt(raw.id, 'id') }
  if (raw.name !== undefined) input.name = requireNonEmptyString(raw.name, 'name', MAX_NAME_LENGTH)
  if (raw.projectType !== undefined) {
    input.projectType = requireNonEmptyString(raw.projectType, 'projectType', MAX_SHORT_FIELD_LENGTH)
  }
  if (raw.description !== undefined) input.description = requireString(raw.description, 'description')
  if (raw.status !== undefined) {
    input.status = requireOneOf<ProjectStatus>(raw.status, PROJECT_STATUSES, 'status')
  }
  if (raw.nextActor !== undefined) {
    input.nextActor = requireOneOf<NextActor>(raw.nextActor, NEXT_ACTORS, 'nextActor')
  }
  if (raw.currentStep !== undefined) {
    input.currentStep = requireString(raw.currentStep, 'currentStep', MAX_SHORT_FIELD_LENGTH)
  }
  if (raw.nextAction !== undefined) {
    input.nextAction = requireString(raw.nextAction, 'nextAction', MAX_SHORT_FIELD_LENGTH)
  }
  // folderPath: undefined = weglassen (unveraendert), null = explizit entfernen,
  // String = neuen Ordner setzen. Ein leerer String ist kein gueltiger Wert -
  // dafuer wird null verwendet.
  if ('folderPath' in raw) {
    if (raw.folderPath === null) {
      input.folderPath = null
    } else {
      input.folderPath = requireNonEmptyString(raw.folderPath, 'folderPath', MAX_FOLDER_PATH_LENGTH)
    }
  }
  return input
}

export function validateIdInput(raw: unknown): number {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe: Objekt mit "id" erwartet.')
  return requirePositiveInt(raw.id, 'id')
}

export function validateCreateContextVersionInput(raw: unknown): CreateContextVersionInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer context:createVersion.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    contentMarkdown: requireString(raw.contentMarkdown, 'contentMarkdown'),
    note: raw.note === undefined || raw.note === null ? null : requireString(raw.note, 'note', 500),
    createdBy: requireOneOf<ContextVersionAuthor>(raw.createdBy, CONTEXT_VERSION_AUTHORS, 'createdBy')
  }
}

export function validateGetContextVersionInput(raw: unknown): { projectId: number; versionId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer context:getVersion.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    versionId: requirePositiveInt(raw.versionId, 'versionId')
  }
}

export function validateCreateRuleVersionInput(raw: unknown): CreateRuleVersionInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer rules:createVersion.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    contentMarkdown: requireString(raw.contentMarkdown, 'contentMarkdown', RULES_MARKDOWN_MAX_LENGTH),
    note: raw.note == null ? null : requireString(raw.note, 'note', 500),
    createdBy: requireOneOf<Actor>(raw.createdBy, ACTORS, 'createdBy')
  }
}

export function validateGetRuleVersionInput(raw: unknown): { projectId: number; versionId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer rules:getVersion.')
  return validateGetContextVersionInput(raw)
}

export function validateRulesDiffInput(raw: unknown): { projectId: number; fromVersionId: number; toVersionId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer rules:diff.')
  return validateDiffInput(raw)
}

export function validateDiffInput(
  raw: unknown
): { projectId: number; fromVersionId: number; toVersionId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer context:diff.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    fromVersionId: requirePositiveInt(raw.fromVersionId, 'fromVersionId'),
    toVersionId: requirePositiveInt(raw.toVersionId, 'toVersionId')
  }
}

export function validateAddChatMessageInput(raw: unknown): AddChatMessageInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer chat:addMessage.')
  const input: AddChatMessageInput = {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    author: requireOneOf<ChatAuthor>(raw.author, CHAT_AUTHORS, 'author'),
    content: requireNonEmptyString(raw.content, 'content')
  }
  const sessionId = optionalNullablePositiveInt(raw, 'sessionId')
  if (sessionId !== undefined) input.sessionId = sessionId
  return input
}

export function validateCopyToClipboardInput(raw: unknown): string {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer system:copyToClipboard.')
  return requireString(raw.text, 'text')
}

export function validateRoleInput(raw: unknown): { projectId: number; role: AiRole } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe: projectId und role erwartet.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    role: requireOneOf<AiRole>(raw.role, AI_ROLES, 'role')
  }
}

export function validateGeneratePromptInput(raw: unknown): GeneratePromptInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer prompts:generate.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    role: requireOneOf<AiRole>(raw.role, AI_ROLES, 'role'),
    concreteTask: requireNonEmptyString(raw.concreteTask, 'concreteTask', MAX_TEXT_LENGTH)
  }
}

export function validateGenerateContinuationPromptInput(raw: unknown): GenerateContinuationPromptInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer prompts:generateContinuation.')
  return {
    sessionId: requirePositiveInt(raw.sessionId, 'sessionId'),
    snapshotId: requirePositiveInt(raw.snapshotId, 'snapshotId'),
    provider: requireOneOf<SessionProvider>(raw.provider, AI_ROLES, 'provider')
  }
}

export function validateSetRoleTemplateOverrideInput(raw: unknown): SetRoleTemplateOverrideInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer prompts:setOverride.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    role: requireOneOf<AiRole>(raw.role, AI_ROLES, 'role'),
    template:
      raw.template === null || raw.template === undefined
        ? null
        : requireString(raw.template, 'template')
  }
}

export function validateUpdateSettingsInput(raw: unknown): UpdateSettingsInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer settings:update.')
  const input: UpdateSettingsInput = {}
  if (raw.chatgptUrl !== undefined) input.chatgptUrl = validateHttpsUrl(raw.chatgptUrl, 'chatgptUrl')
  if (raw.claudeUrl !== undefined) input.claudeUrl = validateHttpsUrl(raw.claudeUrl, 'claudeUrl')
  if (raw.chatgptGlobalTemplate !== undefined) {
    input.chatgptGlobalTemplate = requireNonEmptyString(raw.chatgptGlobalTemplate, 'chatgptGlobalTemplate')
  }
  if (raw.claudeGlobalTemplate !== undefined) {
    input.claudeGlobalTemplate = requireNonEmptyString(raw.claudeGlobalTemplate, 'claudeGlobalTemplate')
  }
  return input
}

/**
 * Nur https://-URLs sind erlaubt (Memo Punkt 12.11). Damit werden
 * javascript:-, file:- und data:-URIs sowie Klartext-http grundsaetzlich
 * abgelehnt, bevor sie jemals an shell.openExternal uebergeben werden.
 */
export function validateHttpsUrl(raw: unknown, field: string): string {
  const str = requireNonEmptyString(raw, field, 2000)
  let parsed: URL
  try {
    parsed = new URL(str)
  } catch {
    throw new ValidationError(`Feld "${field}" ist keine gueltige URL.`)
  }
  if (parsed.protocol !== 'https:') {
    throw new ValidationError(`Feld "${field}" muss mit https:// beginnen.`)
  }
  return str
}

export function validateOpenExternalInput(raw: unknown): string {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer system:openExternal.')
  return validateHttpsUrl(raw.url, 'url')
}

// ===========================================================================
// Meilenstein 2 - Strukturierter Antwort-Import
// ===========================================================================

const RESPONSE_IMPORT_SELECTED_ACTION_FIELDS = [
  'saveHistory',
  'changeStatus',
  'changeCurrentStep',
  'changeNextAction',
  'changeNextActor',
  'createContextVersion',
  'contextIncludeCompletedWork',
  'contextIncludeChangedFiles',
  'contextIncludeTestResults',
  'contextIncludeOpenItems',
  'contextIncludeBlockers',
  'contextIncludeNextStep'
] as const

function validateSelectedActions(raw: unknown): ResponseImportSelectedActions {
  if (!isPlainObject(raw)) throw new ValidationError('Feld "selectedActions" muss ein Objekt sein.')
  const result = {} as ResponseImportSelectedActions
  for (const field of RESPONSE_IMPORT_SELECTED_ACTION_FIELDS) {
    result[field] = requireBoolean(raw[field], `selectedActions.${field}`)
  }
  return result
}

/**
 * RC2-Korrektur (Abschnitt 3 der RC2-Vorgabe): liefert bei einer
 * unbekannten Quelle den dedizierten `INVALID_SOURCE`-Code (ueber
 * ResponseImportError) statt des generischen `VALIDATION_ERROR`, den
 * `requireOneOf()` erzeugt haette. Ein grundsaetzlich falscher Datentyp
 * (kein String) bleibt bewusst ein struktureller `VALIDATION_ERROR` - das
 * ist kein in Abschnitt 24 vorgesehener Anwendungsfehler, sondern ein
 * fehlerhaft geformter Request.
 */
function requireResponseImportSource(value: unknown, field: string): ResponseImportSource {
  if (typeof value !== 'string') throw new ValidationError(`Feld "${field}" muss ein Text sein.`)
  if (!AI_ROLES.includes(value as AiRole)) {
    throw new ResponseImportError('INVALID_SOURCE', `Unbekannte Quelle: ${value}.`)
  }
  return value as ResponseImportSource
}

/**
 * RC2-Korrektur (Abschnitt 3 der RC2-Vorgabe): liefert bei leerem bzw. zu
 * langem Rohtext die dedizierten Codes `EMPTY_RESPONSE`/`RESPONSE_TOO_LARGE`
 * (ueber ResponseImportError) statt des generischen `VALIDATION_ERROR`, den
 * `requireNonEmptyString()` erzeugt haette. Ein grundsaetzlich falscher
 * Datentyp (kein String) bleibt weiterhin ein struktureller
 * `VALIDATION_ERROR`. Die Service-Ebene
 * (`responseImportService.assertNonEmptyAndWithinLimit`) prueft davon
 * unabhaengig ein zweites Mal mit denselben Codes, falls die Funktion je
 * auf einem anderen Weg als ueber IPC aufgerufen wird.
 */
function requireResponseImportRawResponse(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(`Feld "${field}" muss ein Text sein.`)
  if (value.trim().length === 0) {
    throw new ResponseImportError('EMPTY_RESPONSE', 'Die Antwort ist leer.')
  }
  if (value.length > RESPONSE_IMPORT_MAX_LENGTH) {
    // Absichtlich KEIN Ausschnitt des tatsaechlichen Antworttexts in der
    // Fehlermeldung (Abschnitt 22 der Meilenstein-2-Vorgabe).
    throw new ResponseImportError(
      'RESPONSE_TOO_LARGE',
      `Die Antwort ist zu lang (max. ${RESPONSE_IMPORT_MAX_LENGTH.toLocaleString('de-DE')} Zeichen).`
    )
  }
  return value
}

export function validateResponseImportAnalyzeInput(raw: unknown): ResponseImportAnalyzeInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer responseImport:analyze.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    source: requireResponseImportSource(raw.source, 'source'),
    rawResponse: requireResponseImportRawResponse(raw.rawResponse, 'rawResponse')
  }
}

export function validateResponseImportApplyInput(raw: unknown): ResponseImportApplyInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer responseImport:apply.')
  const input: ResponseImportApplyInput = {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    source: requireResponseImportSource(raw.source, 'source'),
    rawResponse: requireResponseImportRawResponse(raw.rawResponse, 'rawResponse'),
    fingerprint: requireNonEmptyString(raw.fingerprint, 'fingerprint', 128),
    selectedActions: validateSelectedActions(raw.selectedActions)
  }
  const sessionId = optionalNullablePositiveInt(raw, 'sessionId')
  if (sessionId !== undefined) input.sessionId = sessionId
  return input
}

// ===========================================================================
// Meilenstein 3 - Sitzungen
// ===========================================================================

const FROM_SESSION_FINAL_STATUSES = ['PAUSED', 'COMPLETED'] as const

export function validateSessionProjectInput(raw: unknown): { projectId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe: projectId erwartet.')
  return { projectId: requirePositiveInt(raw.projectId, 'projectId') }
}

export function validateSessionIdInput(raw: unknown): { sessionId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe: sessionId erwartet.')
  return { sessionId: requirePositiveInt(raw.sessionId, 'sessionId') }
}

export function validateCreateSessionInput(raw: unknown): CreateSessionInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer sessions:create.')
  const input: CreateSessionInput = {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    provider: requireOneOf<SessionProvider>(raw.provider, AI_ROLES, 'provider')
  }
  const title = optionalString(raw.title, 'title', SESSION_TITLE_MAX_LENGTH)
  if (title !== undefined) input.title = title
  if (raw.status !== undefined) {
    input.status = requireOneOf<SessionStatus>(raw.status, SESSION_STATUSES, 'status')
  }
  const currentTask = optionalString(raw.currentTask, 'currentTask', MAX_SHORT_FIELD_LENGTH)
  if (currentTask !== undefined) input.currentTask = currentTask
  const notes = optionalString(raw.notes, 'notes', MAX_TEXT_LENGTH)
  if (notes !== undefined) input.notes = notes
  const masterContextVersionId = optionalNullablePositiveInt(raw, 'masterContextVersionId')
  if (masterContextVersionId !== undefined) input.masterContextVersionId = masterContextVersionId
  return input
}

export function validateUpdateSessionInput(raw: unknown): UpdateSessionInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer sessions:update.')
  const input: UpdateSessionInput = { id: requirePositiveInt(raw.id, 'id') }
  const title = optionalString(raw.title, 'title', SESSION_TITLE_MAX_LENGTH)
  if (title !== undefined) input.title = title
  if (raw.status !== undefined) {
    input.status = requireOneOf<SessionStatus>(raw.status, SESSION_STATUSES, 'status')
  }
  const currentTask = optionalString(raw.currentTask, 'currentTask', MAX_SHORT_FIELD_LENGTH)
  if (currentTask !== undefined) input.currentTask = currentTask
  const notes = optionalString(raw.notes, 'notes', MAX_TEXT_LENGTH)
  if (notes !== undefined) input.notes = notes
  const masterContextVersionId = optionalNullablePositiveInt(raw, 'masterContextVersionId')
  if (masterContextVersionId !== undefined) input.masterContextVersionId = masterContextVersionId
  return input
}

export function validateCreateContinuationSessionInput(raw: unknown): CreateContinuationSessionInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer sessions:createContinuation.')
  const input: CreateContinuationSessionInput = {
    fromSessionId: requirePositiveInt(raw.fromSessionId, 'fromSessionId'),
    provider: requireOneOf<SessionProvider>(raw.provider, AI_ROLES, 'provider'),
    basedOnSnapshotId: requirePositiveInt(raw.basedOnSnapshotId, 'basedOnSnapshotId')
  }
  const title = optionalString(raw.title, 'title', SESSION_TITLE_MAX_LENGTH)
  if (title !== undefined) input.title = title
  if (raw.fromSessionFinalStatus !== undefined) {
    input.fromSessionFinalStatus = requireOneOf<'PAUSED' | 'COMPLETED'>(
      raw.fromSessionFinalStatus,
      FROM_SESSION_FINAL_STATUSES,
      'fromSessionFinalStatus'
    )
  }
  return input
}

export function validateAssignChatMessageToSessionInput(raw: unknown): AssignChatMessageToSessionInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer sessions:assignChatMessage.')
  return {
    sessionId: requirePositiveInt(raw.sessionId, 'sessionId'),
    chatMessageId: requirePositiveInt(raw.chatMessageId, 'chatMessageId')
  }
}

// Snapshot-Validierung

/** Optionales Listenfeld: fehlt es, wird es weggelassen; sonst muessen alle Elemente Strings innerhalb der Laengen-/Mengengrenzen sein. */
function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new ValidationError(`Feld "${field}" muss eine Liste sein.`)
  if (value.length > SNAPSHOT_LIST_MAX_ITEMS) {
    throw new ValidationError(`Feld "${field}" enthaelt zu viele Eintraege (max. ${SNAPSHOT_LIST_MAX_ITEMS}).`)
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`, SNAPSHOT_LIST_ITEM_MAX_LENGTH))
}

/** Optionales, nullbares Textfeld: fehlt es, wird es weggelassen; ist es explizit null, bleibt es null. */
function optionalNullableString(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return requireString(value, field, maxLength)
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  return requireBoolean(value, field)
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ValidationError(`Feld "${field}" muss ein 64-stelliger kleingeschriebener Hex-Wert sein.`)
  }
  return value
}

function optionalSha256(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return requireSha256(value, field)
}

/**
 * Liest ausschliesslich die fachlichen RequiredFileInput-Felder aus - id,
 * snapshotId, interventionRevisionId und createdAt werden nie entgegengenommen,
 * da sie hier nie gelesen werden. Die Secret-Erkennung bleibt Aufgabe des
 * Service (siehe continuationSnapshotService.ts) - hier wird ausschliesslich
 * Form/Typ/Laenge geprueft.
 */
function validateRequiredFileInput(raw: unknown, field: string): RequiredFileInput {
  if (!isPlainObject(raw)) throw new ValidationError(`Feld "${field}" muss ein Objekt sein.`)
  const input: RequiredFileInput = {
    displayName: requireNonEmptyString(raw.displayName, `${field}.displayName`, REQUIRED_FILE_DISPLAY_NAME_MAX_LENGTH)
  }
  const expectedFilename = optionalString(
    raw.expectedFilename,
    `${field}.expectedFilename`,
    REQUIRED_FILE_DISPLAY_NAME_MAX_LENGTH
  )
  if (expectedFilename !== undefined) input.expectedFilename = expectedFilename
  const sha256 = optionalSha256(raw.sha256, `${field}.sha256`)
  if (sha256 !== undefined) input.sha256 = sha256
  const purpose = optionalString(raw.purpose, `${field}.purpose`)
  if (purpose !== undefined) input.purpose = purpose
  const isRequired = optionalBoolean(raw.isRequired, `${field}.isRequired`)
  if (isRequired !== undefined) input.isRequired = isRequired
  const reuploadRequired = optionalBoolean(raw.reuploadRequired, `${field}.reuploadRequired`)
  if (reuploadRequired !== undefined) input.reuploadRequired = reuploadRequired
  const isSensitive = optionalBoolean(raw.isSensitive, `${field}.isSensitive`)
  if (isSensitive !== undefined) input.isSensitive = isSensitive
  const localPath = optionalNullableString(raw.localPath, `${field}.localPath`, LOCAL_PATH_MAX_LENGTH)
  if (localPath !== undefined) input.localPath = localPath
  return input
}

/**
 * undefined bleibt undefined (Feld fehlt), ein Array (auch leer) wird
 * elementweise validiert und unveraendert als Array zurueckgegeben - `[]`
 * und `undefined` duerfen hier nicht zusammenfallen, da sie fachlich
 * unterschiedliche Bedeutung haben (siehe confirmSnapshot). `null` ist
 * ungueltig, da der vorhandene Shared Type dies nicht vorsieht.
 */
function validateRequiredFilesList(value: unknown, field: string): RequiredFileInput[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new ValidationError(`Feld "${field}" muss eine Liste sein.`)
  return value.map((item, index) => validateRequiredFileInput(item, `${field}[${index}]`))
}

export function validateListSnapshotsInput(raw: unknown): { projectId: number; sessionId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer snapshots:list.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    sessionId: requirePositiveInt(raw.sessionId, 'sessionId')
  }
}

export function validateGetSnapshotInput(
  raw: unknown
): { projectId: number; sessionId: number; snapshotId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer snapshots:get.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    sessionId: requirePositiveInt(raw.sessionId, 'sessionId'),
    snapshotId: requirePositiveInt(raw.snapshotId, 'snapshotId')
  }
}

export function validateCreateDraftSnapshotInput(raw: unknown): CreateDraftSnapshotInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer snapshots:createDraft.')
  const input: CreateDraftSnapshotInput = {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    sessionId: requirePositiveInt(raw.sessionId, 'sessionId'),
    provider: requireOneOf<SessionProvider>(raw.provider, AI_ROLES, 'provider'),
    createdBy: requireOneOf<Actor>(raw.createdBy, ACTORS, 'createdBy')
  }
  const masterContextVersionId = optionalNullablePositiveInt(raw, 'masterContextVersionId')
  if (masterContextVersionId !== undefined) input.masterContextVersionId = masterContextVersionId
  const currentTask = optionalString(raw.currentTask, 'currentTask')
  if (currentTask !== undefined) input.currentTask = currentTask
  const confirmedDone = optionalStringArray(raw.confirmedDone, 'confirmedDone')
  if (confirmedDone !== undefined) input.confirmedDone = confirmedDone
  const confirmedOpen = optionalStringArray(raw.confirmedOpen, 'confirmedOpen')
  if (confirmedOpen !== undefined) input.confirmedOpen = confirmedOpen
  const blockers = optionalStringArray(raw.blockers, 'blockers')
  if (blockers !== undefined) input.blockers = blockers
  const lastCompleteSection = optionalString(raw.lastCompleteSection, 'lastCompleteSection')
  if (lastCompleteSection !== undefined) input.lastCompleteSection = lastCompleteSection
  const missingSections = optionalStringArray(raw.missingSections, 'missingSections')
  if (missingSections !== undefined) input.missingSections = missingSections
  const nextExactStep = optionalString(raw.nextExactStep, 'nextExactStep')
  if (nextExactStep !== undefined) input.nextExactStep = nextExactStep
  const additionalHumanAction = optionalString(raw.additionalHumanAction, 'additionalHumanAction')
  if (additionalHumanAction !== undefined) input.additionalHumanAction = additionalHumanAction
  if (raw.reasonCode !== undefined) {
    input.reasonCode = requireOneOf<SnapshotReasonCode>(raw.reasonCode, SNAPSHOT_REASON_CODES, 'reasonCode')
  }
  const requiredFiles = validateRequiredFilesList(raw.requiredFiles, 'requiredFiles')
  if (requiredFiles !== undefined) input.requiredFiles = requiredFiles
  return input
}

export function validateConfirmSnapshotInput(raw: unknown): ConfirmSnapshotInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer snapshots:confirm.')
  const input: ConfirmSnapshotInput = {
    draftSnapshotId: requirePositiveInt(raw.draftSnapshotId, 'draftSnapshotId'),
    createdBy: requireOneOf<Actor>(raw.createdBy, ACTORS, 'createdBy')
  }
  if (raw.corrections !== undefined) {
    if (!isPlainObject(raw.corrections)) {
      throw new ValidationError('Feld "corrections" muss ein Objekt sein.')
    }
    const correctionsRaw = raw.corrections
    const corrections: NonNullable<ConfirmSnapshotInput['corrections']> = {}
    const currentTask = optionalString(correctionsRaw.currentTask, 'corrections.currentTask')
    if (currentTask !== undefined) corrections.currentTask = currentTask
    const confirmedDone = optionalStringArray(correctionsRaw.confirmedDone, 'corrections.confirmedDone')
    if (confirmedDone !== undefined) corrections.confirmedDone = confirmedDone
    const confirmedOpen = optionalStringArray(correctionsRaw.confirmedOpen, 'corrections.confirmedOpen')
    if (confirmedOpen !== undefined) corrections.confirmedOpen = confirmedOpen
    const blockers = optionalStringArray(correctionsRaw.blockers, 'corrections.blockers')
    if (blockers !== undefined) corrections.blockers = blockers
    const lastCompleteSection = optionalString(correctionsRaw.lastCompleteSection, 'corrections.lastCompleteSection')
    if (lastCompleteSection !== undefined) corrections.lastCompleteSection = lastCompleteSection
    const missingSections = optionalStringArray(correctionsRaw.missingSections, 'corrections.missingSections')
    if (missingSections !== undefined) corrections.missingSections = missingSections
    const nextExactStep = optionalString(correctionsRaw.nextExactStep, 'corrections.nextExactStep')
    if (nextExactStep !== undefined) corrections.nextExactStep = nextExactStep
    const additionalHumanAction = optionalString(
      correctionsRaw.additionalHumanAction,
      'corrections.additionalHumanAction'
    )
    if (additionalHumanAction !== undefined) corrections.additionalHumanAction = additionalHumanAction
    const requiredFiles = validateRequiredFilesList(correctionsRaw.requiredFiles, 'corrections.requiredFiles')
    if (requiredFiles !== undefined) corrections.requiredFiles = requiredFiles
    input.corrections = corrections
  }
  return input
}

// ===========================================================================
// Meilenstein 4.2 - Aufgaben-Grundlage
// ===========================================================================

export function validateListTasksInput(raw: unknown): { projectId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer tasks:list.')
  return { projectId: requirePositiveInt(raw.projectId, 'projectId') }
}

export function validateGetTaskInput(raw: unknown): { projectId: number; taskId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer tasks:get.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    taskId: requirePositiveInt(raw.taskId, 'taskId')
  }
}

function optionalRelevantFiles(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > TASK_RELEVANT_FILES_MAX_ITEMS) {
    throw new ValidationError(`Feld "${field}" muss eine Liste mit max. ${TASK_RELEVANT_FILES_MAX_ITEMS} Eintraegen sein.`)
  }
  return validateRelevantFilesList(value)
}

export function validateCreateTaskInput(raw: unknown): CreateTaskInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer tasks:create.')
  const input: CreateTaskInput = {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    title: requireNonEmptyString(raw.title, 'title', TASK_TITLE_MAX_LENGTH),
    createdBy: requireOneOf<Actor>(raw.createdBy, ACTORS, 'createdBy')
  }
  const goalMarkdown = optionalString(raw.goalMarkdown, 'goalMarkdown', TASK_MARKDOWN_MAX_LENGTH)
  if (goalMarkdown !== undefined) input.goalMarkdown = goalMarkdown
  const descriptionMarkdown = optionalString(raw.descriptionMarkdown, 'descriptionMarkdown', TASK_MARKDOWN_MAX_LENGTH)
  if (descriptionMarkdown !== undefined) input.descriptionMarkdown = descriptionMarkdown
  if (raw.priority !== undefined) input.priority = requireOneOf<TaskPriority>(raw.priority, TASK_PRIORITIES, 'priority')
  if (raw.status !== undefined) input.status = requireOneOf<TaskStatus>(raw.status, TASK_STATUSES, 'status')
  const acceptanceCriteriaMarkdown = optionalString(
    raw.acceptanceCriteriaMarkdown,
    'acceptanceCriteriaMarkdown',
    TASK_MARKDOWN_MAX_LENGTH
  )
  if (acceptanceCriteriaMarkdown !== undefined) input.acceptanceCriteriaMarkdown = acceptanceCriteriaMarkdown
  const verificationRequirementsMarkdown = optionalString(
    raw.verificationRequirementsMarkdown,
    'verificationRequirementsMarkdown',
    TASK_MARKDOWN_MAX_LENGTH
  )
  if (verificationRequirementsMarkdown !== undefined) {
    input.verificationRequirementsMarkdown = verificationRequirementsMarkdown
  }
  const blockedReason = optionalString(raw.blockedReason, 'blockedReason', TASK_BLOCKED_REASON_MAX_LENGTH)
  if (blockedReason !== undefined) input.blockedReason = blockedReason
  const relevantFiles = optionalRelevantFiles(raw.relevantFiles, 'relevantFiles')
  if (relevantFiles !== undefined) input.relevantFiles = relevantFiles
  return input
}

export function validateUpdateTaskInput(raw: unknown): UpdateTaskInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer tasks:update.')
  const input: UpdateTaskInput = {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    id: requirePositiveInt(raw.id, 'id')
  }
  if (raw.title !== undefined) input.title = requireNonEmptyString(raw.title, 'title', TASK_TITLE_MAX_LENGTH)
  if (raw.goalMarkdown !== undefined) input.goalMarkdown = requireString(raw.goalMarkdown, 'goalMarkdown', TASK_MARKDOWN_MAX_LENGTH)
  if (raw.descriptionMarkdown !== undefined) {
    input.descriptionMarkdown = requireString(raw.descriptionMarkdown, 'descriptionMarkdown', TASK_MARKDOWN_MAX_LENGTH)
  }
  if (raw.priority !== undefined) input.priority = requireOneOf<TaskPriority>(raw.priority, TASK_PRIORITIES, 'priority')
  if (raw.acceptanceCriteriaMarkdown !== undefined) {
    input.acceptanceCriteriaMarkdown = requireString(raw.acceptanceCriteriaMarkdown, 'acceptanceCriteriaMarkdown', TASK_MARKDOWN_MAX_LENGTH)
  }
  if (raw.verificationRequirementsMarkdown !== undefined) {
    input.verificationRequirementsMarkdown = requireString(
      raw.verificationRequirementsMarkdown,
      'verificationRequirementsMarkdown',
      TASK_MARKDOWN_MAX_LENGTH
    )
  }
  if (raw.blockedReason !== undefined) {
    input.blockedReason = requireString(raw.blockedReason, 'blockedReason', TASK_BLOCKED_REASON_MAX_LENGTH)
  }
  const relevantFiles = optionalRelevantFiles(raw.relevantFiles, 'relevantFiles')
  if (relevantFiles !== undefined) input.relevantFiles = relevantFiles
  return input
}

export function validateUpdateTaskStatusInput(raw: unknown): UpdateTaskStatusInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer tasks:updateStatus.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    id: requirePositiveInt(raw.id, 'id'),
    status: requireOneOf<TaskStatus>(raw.status, TASK_STATUSES, 'status')
  }
}

export function validateUpdateTaskDependenciesInput(raw: unknown): UpdateTaskDependenciesInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer tasks:updateDependencies.')
  if (!Array.isArray(raw.dependsOnTaskIds) || raw.dependsOnTaskIds.length > TASK_MAX_DEPENDENCIES) {
    throw new ValidationError(`Feld "dependsOnTaskIds" muss eine Liste mit max. ${TASK_MAX_DEPENDENCIES} Eintraegen sein.`)
  }
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    id: requirePositiveInt(raw.id, 'id'),
    dependsOnTaskIds: raw.dependsOnTaskIds.map((value, index) => requirePositiveInt(value, `dependsOnTaskIds[${index}]`))
  }
}

// ===========================================================================
// Meilenstein 4.3 - Work Request + Automation-UX-Grundlage
//
// Nur die renderer-erlaubten Kanaele haben hier eine Validierungsfunktion -
// applyPlanningResult/replaceTaskLinks/setWorkRequestStatus sind Main/intern
// only und werden nie ueber IPC entgegengenommen. `createdBy` wird bei
// workRequests:create bewusst NICHT aus der Eingabe gelesen - der
// IPC-Handler in registerIpc.ts setzt ihn serverseitig fest auf 'LEON'
// (siehe M4.3-Vorgabe "Do NOT expose a createdBy selector in normal UI").
// ===========================================================================

export function validateListWorkRequestsInput(raw: unknown): { projectId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer workRequests:list.')
  return { projectId: requirePositiveInt(raw.projectId, 'projectId') }
}

export function validateGetWorkRequestInput(raw: unknown): { projectId: number; id: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer workRequests:get.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    id: requirePositiveInt(raw.id, 'id')
  }
}

export function validateCreateWorkRequestInput(raw: unknown): { projectId: number; intentMarkdown: string } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer workRequests:create.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    intentMarkdown: requireNonEmptyString(raw.intentMarkdown, 'intentMarkdown', WORK_REQUEST_INTENT_MAX_LENGTH)
  }
}

export function validateUpdateWorkRequestIntentInput(raw: unknown): UpdateWorkRequestIntentInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer workRequests:updateIntent.')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    id: requirePositiveInt(raw.id, 'id'),
    intentMarkdown: requireNonEmptyString(raw.intentMarkdown, 'intentMarkdown', WORK_REQUEST_INTENT_MAX_LENGTH)
  }
}

export function validateResolveDecisionInput(raw: unknown): ResolveDecisionInput {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer workRequests:resolveDecision.')
  const input: ResolveDecisionInput = {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    workRequestId: requirePositiveInt(raw.workRequestId, 'workRequestId'),
    decisionId: requirePositiveInt(raw.decisionId, 'decisionId'),
    optionKey: requireNonEmptyString(raw.optionKey, 'optionKey', DECISION_OPTION_KEY_MAX_LENGTH)
  }
  const resolutionNote = optionalString(raw.resolutionNote, 'resolutionNote', DECISION_RESOLUTION_NOTE_MAX_LENGTH)
  if (resolutionNote !== undefined) input.resolutionNote = resolutionNote
  return input
}

export function validateRepositoryInput(raw: unknown): number {
  const id = validateIdInput(raw)
  if (Object.keys(raw as object).some((key) => key !== 'id') || !Number.isSafeInteger(id)) {
    throw new ValidationError('Die Repository-Abfrage akzeptiert nur eine Projekt-ID.')
  }
  return id
}

// ===========================================================================
// Meilenstein 4.8A - Code Change Review + Exact Approval Binding.
//
// Diese vier Validatoren sind bewusst STRIKTER als die uebliche Konvention
// dieser Datei (die meisten anderen Validatoren lesen nur die erwarteten
// Felder und ignorieren stillschweigend Extra-Felder). Review-Entscheidungen
// sind ein Autoritaets-Grenzfall (siehe Vorgabe Teil O): ein Renderer/
// Agent-Aufrufer darf hier niemals `proposal`/`approved`/`fingerprint`/
// `root`/`policy`/`capabilities`/`writeScope`/`source`/`changes` oder
// irgendein anderes zusaetzliches Feld unterbringen - jedes unbekannte Feld
// wird explizit abgelehnt (Positivliste, kein Blacklist).
// ===========================================================================

function assertExactKeysStrict(raw: Record<string, unknown>, allowedKeys: readonly string[], channel: string): void {
  const allowed = new Set(allowedKeys)
  const extra = Object.keys(raw).filter((key) => !allowed.has(key))
  if (extra.length > 0) {
    throw new ValidationError(`Ungueltige Eingabe fuer ${channel}: unbekannte(s) Feld(er) ${extra.join(', ')}.`)
  }
}

export function validateCodeChangeReviewListInput(raw: unknown): { projectId: number } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer codeChangeReviews:list.')
  assertExactKeysStrict(raw, ['projectId'], 'codeChangeReviews:list')
  return { projectId: requirePositiveInt(raw.projectId, 'projectId') }
}

export function validateCodeChangeReviewGetInput(raw: unknown): { projectId: number; reviewId: string } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer codeChangeReviews:get.')
  assertExactKeysStrict(raw, ['projectId', 'reviewId'], 'codeChangeReviews:get')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    reviewId: requireNonEmptyString(raw.reviewId, 'reviewId', 128)
  }
}

export function validateCodeChangeReviewApproveInput(raw: unknown): { projectId: number; reviewId: string } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer codeChangeReviews:approve.')
  assertExactKeysStrict(raw, ['projectId', 'reviewId'], 'codeChangeReviews:approve')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    reviewId: requireNonEmptyString(raw.reviewId, 'reviewId', 128)
  }
}

export function validateCodeChangeReviewRequestChangesInput(raw: unknown): { projectId: number; reviewId: string; feedback: string } {
  if (!isPlainObject(raw)) throw new ValidationError('Ungueltige Eingabe fuer codeChangeReviews:requestChanges.')
  assertExactKeysStrict(raw, ['projectId', 'reviewId', 'feedback'], 'codeChangeReviews:requestChanges')
  return {
    projectId: requirePositiveInt(raw.projectId, 'projectId'),
    reviewId: requireNonEmptyString(raw.reviewId, 'reviewId', 128),
    // Loose IPC-layer sanity bound only - codeChangeReviewService.ts's own
    // exact UTF-8 byte-length check (8 KiB) is the authoritative limit.
    feedback: requireString(raw.feedback, 'feedback')
  }
}
