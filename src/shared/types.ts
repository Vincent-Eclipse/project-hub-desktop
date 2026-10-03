// Gemeinsame Domain-Typen fuer Main-, Preload- und Renderer-Prozess.
// Diese Datei enthaelt bewusst keine Logik, nur Typen und feste Wertebereiche.

export const PROJECT_STATUSES = [
  'PLANNING',
  'ACTIVE',
  'WAITING_ON_HUMAN',
  'TESTING',
  'PAUSED',
  'COMPLETED',
  'ERROR'
] as const

export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const NEXT_ACTORS = ['LEON', 'CHATGPT', 'CLAUDE', 'NONE'] as const

export type NextActor = (typeof NEXT_ACTORS)[number]

export const AI_ROLES = ['CHATGPT', 'CLAUDE'] as const

export type AiRole = (typeof AI_ROLES)[number]

// Gemeinsamer Wertebereich fuer "wer hat das geschrieben/ausgeloest".
// Wird sowohl fuer Chat-Nachrichten (inkl. SYSTEM fuer automatische
// Hinweise) als auch fuer den Ersteller einer Kontext-Version verwendet.
export const ACTORS = ['LEON', 'CHATGPT', 'CLAUDE', 'SYSTEM'] as const

export type Actor = (typeof ACTORS)[number]

export const CHAT_AUTHORS = ACTORS
export type ChatAuthor = Actor

export const CONTEXT_VERSION_AUTHORS = ACTORS
export type ContextVersionAuthor = Actor

// Status eines gespeicherten Projektordners (RC4, Punkt 12). Wird NICHT in
// der Datenbank gespeichert, sondern bei Bedarf im Main-Prozess live anhand
// des Dateisystems ermittelt - ein einmal gespeicherter Ordner kann
// zwischenzeitlich verschoben, umbenannt, geloescht oder unzugaenglich
// geworden sein, ohne dass die App das automatisch "repariert".
export const FOLDER_STATUSES = ['NOT_CONFIGURED', 'AVAILABLE', 'MISSING', 'INVALID', 'INACCESSIBLE'] as const

export type FolderStatus = (typeof FOLDER_STATUSES)[number]

export const EVENT_TYPES = [
  'PROJECT_CREATED',
  'PROJECT_UPDATED',
  'PROJECT_ARCHIVED',
  'PROJECT_RESTORED',
  'CONTEXT_VERSION_CREATED',
  'PROJECT_RULES_VERSION_CREATED',
  'CHAT_MESSAGE_ADDED',
  'ROLE_OVERRIDE_UPDATED',
  'SETTINGS_UPDATED',
  // Meilenstein 2: ein strukturierter Antwort-Import wurde bestaetigt
  // uebernommen (siehe responseImportService.ts). Wird NUR beim
  // tatsaechlichen Uebernehmen geloggt, nie bei einer reinen Analyse.
  'RESPONSE_IMPORT_APPLIED',
  // Meilenstein 3: Sitzungen, Fortsetzungs-Snapshots, menschliches Eingreifen.
  'SESSION_CREATED',
  'SESSION_UPDATED',
  'SESSION_CONTINUED',
  'SESSION_EVENT_RECORDED',
  'SESSION_INTERRUPTION_REPORTED',
  'CHAT_MESSAGE_ASSIGNED_TO_SESSION',
  'SNAPSHOT_CREATED',
  'SNAPSHOT_CONFIRMED',
  'INTERVENTION_CREATED',
  'INTERVENTION_UPDATED',
  'INTERVENTION_SNOOZED',
  'INTERVENTION_RESOLVED',
  'INTERVENTION_DISMISSED',
  'PROJECT_METADATA_SUGGESTION_APPLIED',
  'PROJECT_METADATA_SUGGESTION_RESTORED',
  // Meilenstein 4.2 - Aufgaben-Grundlage (Storage + Verwaltung, KEINE Ausfuehrung).
  'TASK_CREATED',
  'TASK_UPDATED',
  'TASK_STATUS_CHANGED',
  'TASK_DEPENDENCIES_UPDATED',
  // Meilenstein 4.3 - Work Request + Automation-UX-Grundlage (Workflow-Daten
  // + UX-Grundlage, KEINE KI-Ausfuehrung).
  'WORK_REQUEST_CREATED',
  'WORK_REQUEST_INTENT_UPDATED',
  'WORK_REQUEST_PLANNED',
  'WORK_REQUEST_STATUS_CHANGED',
  'WORK_DECISION_RESOLVED',
  'WORK_REQUEST_TASKS_LINKED'
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export interface Project {
  id: number
  name: string
  slug: string
  projectType: string
  description: string
  folderPath: string | null
  folderComparisonKey: string | null
  status: ProjectStatus
  nextActor: NextActor
  currentStep: string
  nextAction: string
  isArchived: boolean
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  currentContextVersionId: number | null
  currentContextVersionNumber: number | null
}

export interface ProjectContextVersion {
  id: number
  projectId: number
  versionNumber: number
  contentMarkdown: string
  note: string | null
  createdBy: ContextVersionAuthor
  createdAt: string
}

export const RULES_MARKDOWN_MAX_LENGTH = 50_000

export interface ProjectRuleVersion {
  id: number
  projectId: number
  versionNumber: number
  contentMarkdown: string
  note: string | null
  createdBy: Actor
  createdAt: string
}

export interface CreateRuleVersionInput {
  projectId: number
  contentMarkdown: string
  note?: string | null
  createdBy: Actor
}

export interface ChatMessage {
  id: number
  projectId: number
  author: ChatAuthor
  content: string
  createdAt: string
}

export interface EventLogEntry {
  id: number
  projectId: number | null
  type: EventType
  payload: Record<string, unknown>
  createdAt: string
}

export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed'
  text: string
  oldLineNumber: number | null
  newLineNumber: number | null
}

export interface RoleTemplateInfo {
  role: AiRole
  effectiveTemplate: string
  isOverridden: boolean
  globalTemplate: string
  overrideTemplate: string | null
}

export interface AppSettings {
  chatgptUrl: string
  claudeUrl: string
  chatgptGlobalTemplate: string
  claudeGlobalTemplate: string
}

export interface GeneratedPrompt {
  role: AiRole
  promptText: string
  generatedAt: string
}

export interface AppInfo {
  appVersion: string
  dbPath: string
  logPath: string
}

// Einheitliche Antwortform aller IPC-Aufrufe. Fehler werden NICHT als
// geworfene Exceptions ueber die IPC-Bruecke geschickt (serialisieren
// unzuverlaessig), sondern als typisiertes Ergebnis zurueckgegeben.
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

export interface CreateProjectInput {
  name: string
  projectType: string
  description: string
  folderPath?: string | null
  status?: ProjectStatus
  currentStep?: string
  nextActor?: NextActor
  nextAction?: string
}

export interface UpdateProjectInput {
  id: number
  name?: string
  projectType?: string
  description?: string
  // undefined = unveraendert lassen, null = Ordner-Zuordnung entfernen,
  // string = neuen (bereits ueber den nativen Dialog ausgewaehlten) Ordner setzen.
  folderPath?: string | null
  status?: ProjectStatus
  nextActor?: NextActor
  currentStep?: string
  nextAction?: string
}

export interface CreateContextVersionInput {
  projectId: number
  contentMarkdown: string
  note?: string | null
  createdBy: ContextVersionAuthor
}

export interface AddChatMessageInput {
  projectId: number
  author: ChatAuthor
  content: string
  // Additiv, optional: ordnet die Nachricht zugleich einer bestehenden
  // Sitzung zu. undefined/null = keine Zuordnung (bestehendes Verhalten).
  sessionId?: number | null
}

export interface SetRoleTemplateOverrideInput {
  projectId: number
  role: AiRole
  template: string | null
}

export interface UpdateSettingsInput {
  chatgptUrl?: string
  claudeUrl?: string
  chatgptGlobalTemplate?: string
  claudeGlobalTemplate?: string
}

export interface GeneratePromptInput {
  projectId: number
  role: AiRole
  concreteTask: string
}

export interface SelectedFolder {
  // null bei Abbruch des nativen Ordnerdialogs - kein separates
  // "cancelled"-Flag, da der Wert eindeutig ist.
  folderPath: string | null
}

// ===========================================================================
// Meilenstein 2 - Strukturierter Antwort-Import
// ===========================================================================

// Quelle einer importierten Antwort - bewusst derselbe Wertebereich wie
// AiRole (nur ChatGPT/Claude koennen Antworten liefern, die importiert
// werden). Eigener Name, damit der Import-Kontext im Typsystem erkennbar
// bleibt, auch wenn die zugrunde liegende Menge identisch ist.
export type ResponseImportSource = AiRole

export const RESPONSE_IMPORT_MAX_LENGTH = 200_000

// RC3-Korrektur (Abschnitt 3 der RC3-Vorgabe): zentrale, von IPC-Validierung,
// Parser/Analyse, Apply-Service UND relevanter UI-Anzeige gemeinsam
// genutzte Längenlimits - vorher validierte nur der normale
// projects:update-IPC-Pfad currentStep/nextAction auf 500 Zeichen; der
// Response-Import-Service umging das, weil er projectsService.updateProject()
// direkt mit vom Parser abgeleiteten Werten aufrief.
export const PROJECT_SHORT_FIELD_MAX_LENGTH = 500
export const CONTEXT_MARKDOWN_MAX_LENGTH = 200_000

/**
 * Deterministisches Parser-Ergebnis (responseImportParser.ts, Main-Prozess).
 * Alle Listenfelder erhalten die Reihenfolge aus der Originalantwort und
 * sind bereits dedupliziert (siehe Parser-Dokumentation). `unassigned`
 * enthaelt jeden nicht eindeutig zugeordneten, nicht-leeren Absatz/Zeile.
 *
 * Metadaten (Status/aktueller Schritt/naechste Aktion/naechster Akteur):
 * kommt ein Label MEHRFACH mit unterschiedlichen Werten vor, gilt das laut
 * Vorgabe als mehrdeutig - `suggestedXxx` bleibt dann `null` (KEIN
 * Last-value-wins), waehrend `suggestedXxxCandidates` alle unterschiedlichen
 * (case-insensitiv deduplizierten) Rohwerte in Fundreihenfolge fuer die
 * Vorschau sichtbar haelt und `suggestedXxxAmbiguous` dies explizit markiert.
 * Bei genau einem gefundenen Rohwert ist `suggestedXxxCandidates` genau
 * dieses eine Element, `suggestedXxxAmbiguous` ist `false`, und
 * `suggestedStatus`/`suggestedNextActor` sind nur dann gesetzt, wenn dieser
 * eine Rohwert zusaetzlich auf einen bekannten Wert normalisiert werden
 * konnte (sonst `null`, Rohtext trotzdem in *Raw/*Candidates sichtbar -
 * Abschnitt 8/9 der Meilenstein-2-Vorgabe).
 */
export interface ParsedResponse {
  summary: string[]
  completedWork: string[]
  changedFiles: string[]
  testResults: string[]
  openItems: string[]
  blockers: string[]
  nextStep: string[]
  suggestedStatus: ProjectStatus | null
  suggestedStatusRaw: string | null
  suggestedStatusCandidates: string[]
  suggestedStatusAmbiguous: boolean
  suggestedCurrentStep: string | null
  suggestedCurrentStepCandidates: string[]
  suggestedCurrentStepAmbiguous: boolean
  // RC3-Korrektur: true, wenn genau EIN Kandidat gefunden wurde, dieser
  // aber PROJECT_SHORT_FIELD_MAX_LENGTH überschreitet - dann bleibt
  // suggestedCurrentStep bewusst null (nicht übernehmbar), der Rohtext
  // bleibt aber weiterhin über suggestedCurrentStepCandidates sichtbar,
  // damit die Oberfläche ihn verständlich als "zu lang" kennzeichnen kann
  // (statt fälschlich als "nicht erkannt" oder "mehrdeutig").
  suggestedCurrentStepTooLong: boolean
  suggestedNextAction: string | null
  suggestedNextActionCandidates: string[]
  suggestedNextActionAmbiguous: boolean
  suggestedNextActionTooLong: boolean
  suggestedNextActor: NextActor | null
  suggestedNextActorRaw: string | null
  suggestedNextActorCandidates: string[]
  suggestedNextActorAmbiguous: boolean
  // Vorberechneter Markdown-Block, der bei ausgewaehlten Kontext-Aktionen
  // an den bestehenden Kontext angehaengt wuerde (siehe Abschnitt 19 der
  // Vorgabe) - eine reine Ableitung aus den obigen Feldern, kein eigenes
  // erkanntes Label.
  contextAddition: string
  unassigned: string[]
}

export interface ResponseImportAnalyzeInput {
  projectId: number
  source: ResponseImportSource
  rawResponse: string
}

/** Momentaufnahme der aktuellen Projektmetadaten zum Analysezeitpunkt - fuer die Vorher/Nachher-Anzeige in der Vorschau. */
export interface ResponseImportProjectSnapshot {
  status: ProjectStatus
  currentStep: string
  nextAction: string
  nextActor: NextActor
}

export interface ResponseImportAnalyzeResult {
  parsedResult: ParsedResponse
  parserVersion: number
  fingerprint: string
  baseContextVersionId: number | null
  projectSnapshot: ResponseImportProjectSnapshot
}

/** Vom Nutzer einzeln ausgewaehlte Aktionen (Abschnitt 4 und 17 der Vorgabe). Standard: alles false (konservativ). */
export interface ResponseImportSelectedActions {
  saveHistory: boolean
  changeStatus: boolean
  changeCurrentStep: boolean
  changeNextAction: boolean
  changeNextActor: boolean
  createContextVersion: boolean
  contextIncludeCompletedWork: boolean
  contextIncludeChangedFiles: boolean
  contextIncludeTestResults: boolean
  contextIncludeOpenItems: boolean
  contextIncludeBlockers: boolean
  contextIncludeNextStep: boolean
}

export interface ResponseImportApplyInput {
  projectId: number
  source: ResponseImportSource
  rawResponse: string
  fingerprint: string
  selectedActions: ResponseImportSelectedActions
  // Meilenstein 3 (additiv, rueckwaertskompatibel): optionale Zuordnung der
  // beim Import ggf. gespeicherten Chat-Nachricht zu einer bestehenden
  // Sitzung. undefined/null = keine Zuordnung (bestehendes Verhalten). Wird
  // serverseitig gegen Projekt- und Provider-Zugehoerigkeit geprueft (siehe
  // chatService.ts / sessionService.ts).
  sessionId?: number | null
}

export interface ResponseImportApplyResult {
  importId: number
  project: Project
  resultContextVersionId: number | null
  historyMessageId: number | null
}

export interface ResponseImportRecord {
  id: number
  projectId: number
  source: ResponseImportSource
  rawResponse: string
  parserVersion: number
  parsedResult: ParsedResponse
  selectedActions: ResponseImportSelectedActions
  baseContextVersionId: number | null
  resultContextVersionId: number | null
  createdAt: string
  appliedAt: string
}

// ===========================================================================
// Meilenstein 3 - Sitzungen, Fortsetzungs-Snapshots, menschliches Eingreifen
// ===========================================================================

export const SESSION_STATUSES = [
  'ACTIVE',
  'PAUSED',
  'LIMIT_REACHED',
  'RESPONSE_INCOMPLETE',
  'WAITING_ON_HUMAN',
  'COMPLETED',
  'ABANDONED'
] as const

export type SessionStatus = (typeof SESSION_STATUSES)[number]

// Eigener Name fuer Klarheit im Sitzungskontext - derselbe Wertebereich wie
// AiRole (nur ChatGPT/Claude koennen eine Sitzung "besitzen"), analog
// ResponseImportSource.
export type SessionProvider = AiRole

// Verbindliche Status-Zustandsmaschine (siehe sessionService.assertValidStatusTransition).
// COMPLETED/ABANDONED sind terminal - keine ausgehenden Uebergaenge. Eine
// abgeschlossene/verworfene Sitzung wird nie reaktiviert; eine Fortsetzung
// entsteht stattdessen ueber createContinuationSession als NEUE Sitzung.
export const SESSION_STATUS_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  ACTIVE: ['PAUSED', 'LIMIT_REACHED', 'RESPONSE_INCOMPLETE', 'WAITING_ON_HUMAN', 'COMPLETED', 'ABANDONED'],
  PAUSED: ['ACTIVE', 'COMPLETED', 'ABANDONED'],
  LIMIT_REACHED: ['ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED'],
  RESPONSE_INCOMPLETE: ['ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED'],
  WAITING_ON_HUMAN: ['ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED'],
  COMPLETED: [],
  ABANDONED: []
}

export const SESSION_EVENT_TYPES = [
  'RESPONSE_INCOMPLETE',
  'LIMIT_REACHED',
  'CHAT_FULL',
  'MANUAL_PAUSE',
  'SESSION_RESUMED'
] as const

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]

// Fester Ziel-Sitzungsstatus je Unterbrechungs-Ereignistyp. reportSessionInterruption
// leitet den Zielstatus immer hieraus ab, statt ein separates, frei waehlbares
// Statusfeld entgegenzunehmen, das mit eventType in Widerspruch geraten koennte.
export const SESSION_EVENT_TARGET_STATUS: Record<SessionEventType, SessionStatus> = {
  LIMIT_REACHED: 'LIMIT_REACHED',
  RESPONSE_INCOMPLETE: 'RESPONSE_INCOMPLETE',
  CHAT_FULL: 'PAUSED',
  MANUAL_PAUSE: 'PAUSED',
  SESSION_RESUMED: 'ACTIVE'
}

export const SNAPSHOT_REASON_CODES = ['LIMIT_REACHED', 'CHAT_FULL', 'RESPONSE_TRUNCATED', 'MANUAL_PAUSE', 'OTHER'] as const

export type SnapshotReasonCode = (typeof SNAPSHOT_REASON_CODES)[number]

export const CONFIRMATION_STATES = ['DRAFT', 'CONFIRMED'] as const

export type ConfirmationState = (typeof CONFIRMATION_STATES)[number]

export const INTERVENTION_TYPES = [
  'USAGE_LIMIT_REACHED',
  'CHAT_FULL',
  'RESPONSE_TRUNCATED',
  'FILE_UPLOAD_REQUIRED',
  'LOCAL_VERIFICATION_REQUIRED',
  'PATCH_APPLY_REQUIRED',
  'SCREENSHOT_REQUIRED',
  'DECISION_REQUIRED',
  'APPROVAL_REQUIRED',
  'PROVIDER_QUESTION',
  'UNEXPECTED_ERROR'
] as const

export type InterventionType = (typeof INTERVENTION_TYPES)[number]

export const INTERVENTION_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'BLOCKING'] as const

export type InterventionPriority = (typeof INTERVENTION_PRIORITIES)[number]

export const INTERVENTION_STATUSES = ['OPEN', 'SNOOZED', 'RESOLVED', 'DISMISSED'] as const

export type InterventionStatus = (typeof INTERVENTION_STATUSES)[number]

// Zentrale Laengengrenzen (Meilenstein 3), gleiche Konvention wie die
// Meilenstein-2-Grenzen weiter oben in dieser Datei.
export const SESSION_TITLE_MAX_LENGTH = 200
export const SNAPSHOT_LIST_ITEM_MAX_LENGTH = 500
export const SNAPSHOT_LIST_MAX_ITEMS = 50
export const REQUIRED_FILE_DISPLAY_NAME_MAX_LENGTH = 200
// Rein informativer Pfad-Hinweis - wird NIE vom Main-Prozess gelesen/geoeffnet,
// nur auf Typ/Laenge/Steuerzeichen geprueft (siehe validation.ts).
export const LOCAL_PATH_MAX_LENGTH = 4096
export const CONTINUATION_PROMPT_MAX_LENGTH = 200_000
export const DEDUPE_KEY_MAX_LENGTH = 200
// Wiederverwendet dieselbe Grenze wie RESPONSE_IMPORT_MAX_LENGTH - eine
// unvollstaendige Original-Antwort ist inhaltlich dasselbe Sicherheits-/
// Groessenrisiko wie eine importierte Antwort.
export const SESSION_EVENT_RAW_RESPONSE_MAX_LENGTH = RESPONSE_IMPORT_MAX_LENGTH

export interface Session {
  id: number
  projectId: number
  provider: SessionProvider
  title: string
  status: SessionStatus
  currentTask: string
  masterContextVersionId: number | null
  predecessorSessionId: number | null
  basedOnSnapshotId: number | null
  notes: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface SessionChatMessageAssignment {
  sessionId: number
  chatMessageId: number
  sequenceNumber: number
  createdAt: string
}

export interface SessionEvent {
  id: number
  sessionId: number
  eventType: SessionEventType
  // Die exakte, unveraenderte Original-Antwort (falls vorhanden). Durchlaeuft
  // NIE den Prompt-Sicherheitsfilter und fliesst NIE automatisch in einen
  // generierten Fortsetzungs-Prompt ein - reine lokale Historie, analog
  // response_imports.rawResponse in Meilenstein 2.
  rawResponse: string | null
  chatMessageId: number | null
  responseImportId: number | null
  continuationSnapshotId: number | null
  reason: string
  createdAt: string
  createdBy: Actor
}

export interface ContinuationSnapshot {
  id: number
  projectId: number
  sessionId: number
  versionNumber: number
  provider: SessionProvider
  masterContextVersionId: number | null
  currentTask: string
  confirmedDone: string[]
  confirmedOpen: string[]
  blockers: string[]
  lastCompleteSection: string
  missingSections: string[]
  nextExactStep: string
  additionalHumanAction: string
  reasonCode: SnapshotReasonCode
  confirmationState: ConfirmationState
  derivedFromSnapshotId: number | null
  createdBy: Actor
  createdAt: string
  requiredFiles?: RequiredFile[]
}

export interface RequiredFile {
  id: number
  snapshotId: number | null
  interventionRevisionId: number | null
  displayName: string
  expectedFilename: string
  sha256: string | null
  purpose: string
  isRequired: boolean
  reuploadRequired: boolean
  isSensitive: boolean
  // Nie vom Main-Prozess gelesen/geoeffnet, nie Teil eines generierten Prompts.
  localPath: string | null
  createdAt: string
}

export interface InterventionAlert {
  id: number
  projectId: number
  sessionId: number | null
  type: InterventionType
  priority: InterventionPriority
  dedupeKey: string
  reason: string
  requiredAction: string
  nextStep: string
  responsiblePerson: string
  status: InterventionStatus
  contentVersion: number
  popupAcknowledgedVersion: number | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  snoozeUntil: string | null
  metadataSuggestionAppliedAt: string | null
  capturedPreviousStatus: ProjectStatus | null
  capturedPreviousNextActor: NextActor | null
  metadataRestoredAt: string | null
}

export interface InterventionAlertRevision {
  id: number
  interventionId: number
  contentVersion: number
  priority: InterventionPriority
  reason: string
  requiredAction: string
  nextStep: string
  createdAt: string
  createdBy: Actor
  requiredFiles?: RequiredFile[]
}

export interface SensitiveContentFinding {
  type: 'PRIVATE_KEY_BLOCK' | 'API_TOKEN_PATTERN' | 'ENV_ASSIGNMENT' | 'PASSWORD_ASSIGNMENT' | 'AUTHORIZATION_BEARER'
  field: string
  approximateLocation: string
  safeMessage: string
}

// Feste IPC-Fehlercodes fuer Sitzungen/Fortsetzungen/Warnungen, analog
// ResponseImportErrorCode. Die zugehoerigen Fehlerklassen entstehen erst mit
// den jeweiligen Services.
export type SessionErrorCode = 'INVALID_SESSION_STATUS_TRANSITION'

export type ContinuationErrorCode =
  | 'SNAPSHOT_NOT_CONFIRMED'
  | 'SESSION_ALREADY_HAS_SUCCESSOR'
  | 'SESSION_NOT_IN_PROJECT'
  | 'PROMPT_TOO_LARGE'
  | 'INVALID_SHA256'
  | 'SENSITIVE_CONTENT_DETECTED'
  | 'PROMPT_CONTAINS_SENSITIVE_CONTENT'
  | 'GENERATION_FAILED'
  | 'PROVIDER_MISMATCH'
  | 'SNAPSHOT_ALREADY_CONFIRMED'
  | 'SNAPSHOT_VERSION_CONFLICT'
  | 'INVALID_REQUIRED_FILE'

export type InterventionErrorCode =
  | 'ALERT_NOT_FOUND'
  | 'ALERT_ALREADY_RESOLVED'
  | 'ALERT_ALREADY_DISMISSED'
  | 'INVALID_SNOOZE_TIME'
  | 'SENSITIVE_CONTENT_DETECTED'
  | 'OTHER_ACTIVE_ALERT_BLOCKS_RESTORE'
  | 'METADATA_SUGGESTION_ALREADY_APPLIED'
  | 'METADATA_SUGGESTION_ALREADY_RESTORED'
  | 'METADATA_SUGGESTION_NOT_YET_APPLIED'

export interface CreateSessionInput {
  projectId: number
  provider: SessionProvider
  title?: string
  status?: SessionStatus
  currentTask?: string
  masterContextVersionId?: number | null
  notes?: string
}

export interface UpdateSessionInput {
  id: number
  title?: string
  status?: SessionStatus
  currentTask?: string
  masterContextVersionId?: number | null
  notes?: string
}

export interface CreateContinuationSessionInput {
  fromSessionId: number
  provider: SessionProvider
  title?: string
  basedOnSnapshotId: number
  // Nur beruecksichtigt bei gleichem Provider UND fromSession.status === 'ACTIVE';
  // in jedem anderen Fall folgenlos ignoriert. Default 'PAUSED'.
  fromSessionFinalStatus?: 'PAUSED' | 'COMPLETED'
}

export interface AssignChatMessageToSessionInput {
  sessionId: number
  chatMessageId: number
}

export interface RequiredFileInput {
  displayName: string
  expectedFilename?: string
  sha256?: string | null
  purpose?: string
  isRequired?: boolean
  reuploadRequired?: boolean
  isSensitive?: boolean
  localPath?: string | null
}

export interface CreateDraftSnapshotInput {
  projectId: number
  sessionId: number
  provider: SessionProvider
  masterContextVersionId?: number | null
  currentTask?: string
  confirmedDone?: string[]
  confirmedOpen?: string[]
  blockers?: string[]
  lastCompleteSection?: string
  missingSections?: string[]
  nextExactStep?: string
  additionalHumanAction?: string
  reasonCode?: SnapshotReasonCode
  createdBy: Actor
  requiredFiles?: RequiredFileInput[]
}

export interface ConfirmSnapshotInput {
  draftSnapshotId: number
  corrections?: {
    currentTask?: string
    confirmedDone?: string[]
    confirmedOpen?: string[]
    blockers?: string[]
    lastCompleteSection?: string
    missingSections?: string[]
    nextExactStep?: string
    additionalHumanAction?: string
    requiredFiles?: RequiredFileInput[]
  }
  createdBy: Actor
}

export interface CreateOrTouchInterventionInput {
  projectId: number
  sessionId?: number | null
  type: InterventionType
  priority?: InterventionPriority
  dedupeKey?: string
  reason?: string
  requiredAction?: string
  nextStep?: string
  responsiblePerson?: string
  createdBy: Actor
  requiredFiles?: RequiredFileInput[]
}

export interface SnoozeInterventionInput {
  id: number
  snoozeUntil: string
}

export interface ApplyMetadataSuggestionInput {
  id: number
}

export interface RestorePreviousMetadataSuggestionInput {
  id: number
}

// author wird NIE frei vom Aufrufer gesetzt: PROVIDER_RESPONSE leitet ihn
// zwingend aus session.provider ab, LEON_NOTE setzt ihn fest auf 'LEON'.
export type SaveAsChatMessageInput =
  | { kind: 'PROVIDER_RESPONSE'; content: string }
  | { kind: 'LEON_NOTE'; content: string }

// projectId/sessionId/provider werden nie aus den verschachtelten Eingaben
// uebernommen, sondern ausschliesslich aus der im Main-Prozess bereits
// geladenen Sitzung abgeleitet. Kein newSessionStatus - der Zielstatus wird
// immer aus eventType ueber SESSION_EVENT_TARGET_STATUS abgeleitet.
export interface ReportSessionInterruptionInput {
  sessionId: number
  eventType: SessionEventType
  rawResponse?: string
  reason: string
  saveAsChatMessage?: SaveAsChatMessageInput
  createOrTouchAlert?: Omit<CreateOrTouchInterventionInput, 'projectId' | 'sessionId'>
  draftSnapshotInput?: Omit<CreateDraftSnapshotInput, 'projectId' | 'sessionId' | 'provider'>
  // Muss bereits existieren und zum selben Projekt gehoeren - wird hier NIE angelegt.
  responseImportId?: number
}

export interface GenerateContinuationPromptInput {
  sessionId: number
  snapshotId: number
  provider: SessionProvider
}

export interface GenerateContinuationPromptResult {
  provider: SessionProvider
  promptText: string
  // Rein informativ fuer die Oberflaeche (z. B. "erzeugt um HH:MM") - NIE Teil
  // von promptText/der Platzhalterersetzung, beeinflusst also nie die
  // Byte-Gleichheit von promptText bei wiederholtem Aufruf mit identischen
  // bestaetigten Eingabedaten.
  generatedAt: string
}

export interface RepositoryFile {
  path: string
  previousPath: string | null
  index: string
  worktree: string
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
}

export interface RepositoryDiagnostics {
  detected: boolean
  root: string | null
  branch: string | null
  state: 'clean' | 'changed' | null
  files: RepositoryFile[]
}

export interface RepositoryDiff {
  unstaged: string
  staged: string
  unstagedStat: string
  stagedStat: string
  truncated: false
}

// ===========================================================================
// Meilenstein 4.2 - Aufgaben-Grundlage (Storage + Verwaltung)
//
// Eine Aufgabe beschreibt Arbeit, die spaeter ggf. von einem Agenten
// ausgefuehrt werden koennte - M4.2 legt AUSSCHLIESSLICH die Speicherung und
// Verwaltung an. Kein Ausfuehrungs-Handler, kein Agent, kein Befehl, kein
// Dateisystemzugriff ist an eine Aufgabe geknuepft. Aufgaben sind mutable
// Current-State-Datensaetze - KEINE Versionshistorie (im Unterschied zu
// Projekt-Kontext/-Regeln). Vorrangreihenfolge bleibt: Technische
// Faehigkeiten/Berechtigungen > Projekt-Regeln > Aufgaben-Anweisungen >
// Projekt-Kontext. Aufgaben tragen daher bewusst keine
// rulesVersionId/contextVersionId - ein zukuenftiger, unveraenderlicher
// Agent-Run wird die tatsaechlich verwendeten Versionen selbst festhalten.
// ===========================================================================

export const TASK_STATUSES = [
  'BACKLOG',
  'PLANNED',
  'READY',
  'RUNNING',
  'NEEDS_REVIEW',
  'CHANGES_REQUESTED',
  'BLOCKED',
  'DONE'
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export const TASK_TITLE_MAX_LENGTH = 200
export const TASK_MARKDOWN_MAX_LENGTH = 50_000
export const TASK_BLOCKED_REASON_MAX_LENGTH = 2_000
// Rein logische, projektrelative Pfadangabe - siehe taskRelevantFiles.ts.
// Niemals gegen das echte Dateisystem aufgeloest, gelesen oder geschrieben.
export const TASK_RELEVANT_FILE_PATH_MAX_LENGTH = 1_024
export const TASK_RELEVANT_FILES_MAX_ITEMS = 100
export const TASK_MAX_DEPENDENCIES = 50

export interface Task {
  id: number
  projectId: number
  title: string
  goalMarkdown: string
  descriptionMarkdown: string
  priority: TaskPriority
  status: TaskStatus
  acceptanceCriteriaMarkdown: string
  verificationRequirementsMarkdown: string
  // Projektrelative logische Pfade, reine Metadaten (keine Berechtigungen).
  relevantFiles: string[]
  blockedReason: string
  // Planungs-Metadaten - beeinflusst nie automatisch den Status dieser oder
  // einer anderen Aufgabe (siehe taskService.ts).
  dependsOnTaskIds: number[]
  createdBy: Actor
  createdAt: string
  updatedAt: string
}

export interface CreateTaskInput {
  projectId: number
  title: string
  goalMarkdown?: string
  descriptionMarkdown?: string
  priority?: TaskPriority
  status?: TaskStatus
  acceptanceCriteriaMarkdown?: string
  verificationRequirementsMarkdown?: string
  relevantFiles?: string[]
  blockedReason?: string
  createdBy: Actor
}

// Deckt alle bearbeitbaren Detailfelder ausser Status und Abhaengigkeiten ab -
// beide haben eigene, dedizierte IPC-Kanaele/Service-Funktionen mit eigener
// Audit-Semantik (TASK_STATUS_CHANGED bzw. TASK_DEPENDENCIES_UPDATED).
//
// projectId ist hier PFLICHT (nicht optional) - Aufgaben sind eine
// projekt-verschachtelte Ressource, und Lesevorgaenge (list/get) sind bereits
// projekt-skaliert. Ohne ein vom Aufrufer erwartetes projectId koennte Main
// nicht pruefen, dass eine Mutation tatsaechlich innerhalb des vom Aufrufer
// beabsichtigten Projekts stattfindet - das Ableiten von project_id
// ausschliesslich aus der Aufgaben-Zeile waere nicht ausreichend (siehe
// taskService.ts: assertTaskOwnership prueft explizit sowohl id als auch
// projectId, bevor irgendetwas geaendert wird).
export interface UpdateTaskInput {
  projectId: number
  id: number
  title?: string
  goalMarkdown?: string
  descriptionMarkdown?: string
  priority?: TaskPriority
  acceptanceCriteriaMarkdown?: string
  verificationRequirementsMarkdown?: string
  relevantFiles?: string[]
  blockedReason?: string
}

export interface UpdateTaskStatusInput {
  projectId: number
  id: number
  status: TaskStatus
}

export interface UpdateTaskDependenciesInput {
  projectId: number
  id: number
  dependsOnTaskIds: number[]
}

// ===========================================================================
// Meilenstein 4.3 - Work Request + Automation-UX-Grundlage
//
// Produktrichtung: das Hub wird automation-first. "Komplex innen, einfach
// aussen" - der Nutzer liefert eine Absicht, faellt schwierige
// Entscheidungen und gibt die finale Freigabe. Ein Work Request beschreibt
// "was der Nutzer bauen/aendern moechte"; ein Task (Meilenstein 4.2) bleibt
// das interne technische Arbeitsobjekt dazu - Work Requests ersetzen Tasks
// nicht, sie sind eine Ebene darueber.
//
// Vorrangreihenfolge (eingefroren fuer M4.3):
// Technische Faehigkeiten/Berechtigungen > Projekt-Regeln > explizite
// Nutzer-Entscheidungen > Work-Request-Absicht > aktueller Plan >
// Aufgaben-Anweisungen > Projekt-Kontext. Ein Work Request ist Absicht,
// KEINE Berechtigung - er kann Projekt-Regeln oder zukuenftige technische
// Faehigkeiten NIEMALS erweitern.
//
// M4.3 ist ausschliesslich Workflow-DATEN + UX-Grundlage - KEINE KI-Aufrufe,
// kein Agent, keine Ausfuehrung, keine automatische Task-Erzeugung, kein
// Replanning. Die vollstaendige Status-Uebergangs-Engine ist bewusst NICHT
// Teil von M4.3 - der Renderer bekommt daher auch keinen generischen
// Status-Setter (siehe setWorkRequestStatus: Main/intern only).
// ===========================================================================

export const WORK_REQUEST_STATUSES = [
  'IDEA',
  'PLANNING',
  'NEEDS_DECISION',
  'READY',
  'EXECUTING',
  'REVIEWING',
  'CHANGES_REQUIRED',
  'READY_FOR_APPROVAL',
  'DONE',
  'BLOCKED',
  'PAUSED',
  'CANCELLED'
] as const

export type WorkRequestStatus = (typeof WORK_REQUEST_STATUSES)[number]

export const WORK_DECISION_STATUSES = ['OPEN', 'RESOLVED', 'CANCELLED'] as const

export type WorkDecisionStatus = (typeof WORK_DECISION_STATUSES)[number]

// Bewusst derselbe Grenzwert wie TASK_TITLE_MAX_LENGTH ("ein geteiltes
// sinnvolles Maximum", siehe M4.3-Vorgabe) - kein eigener, unabhaengiger Wert.
export const WORK_REQUEST_TITLE_MAX_LENGTH = TASK_TITLE_MAX_LENGTH
export const WORK_REQUEST_INTENT_MAX_LENGTH = 50_000
export const WORK_REQUEST_PLAN_MAX_LENGTH = 50_000

export const DECISION_QUESTION_MAX_LENGTH = 5_000
export const DECISION_RECOMMENDATION_MAX_LENGTH = 5_000
export const DECISION_RESOLUTION_NOTE_MAX_LENGTH = 2_000
export const DECISION_OPTION_LABEL_MAX_LENGTH = 200
export const DECISION_OPTION_DESCRIPTION_MAX_LENGTH = 2_000
export const DECISION_OPTION_KEY_MAX_LENGTH = 64
export const DECISION_MIN_OPTIONS = 2
export const DECISION_MAX_OPTIONS = 10
export const WORK_REQUEST_MAX_TASK_LINKS = 200

export interface WorkRequestOption {
  key: string
  label: string
  descriptionMarkdown?: string
}

export interface WorkRequest {
  id: number
  projectId: number
  title: string
  intentMarkdown: string
  planMarkdown: string | null
  status: WorkRequestStatus
  createdBy: Actor
  createdAt: string
  updatedAt: string
}

// ChatGPT-Re-Review Fix 3: die Work-Liste braucht ausschliesslich
// Zusammenfassungs-Metadaten - intentMarkdown/planMarkdown koennen je bis zu
// 50.000 Zeichen umfassen und werden fuer die Listenansicht nie angezeigt.
// listWorkRequestsForProject() liefert deshalb bewusst DIESEN schlanken Typ
// statt WorkRequest - kein SELECT *, keine grossen Markdown-Felder ueber die
// Liste. createdBy ist bewusst NICHT enthalten, da die Work-Liste ihn aktuell
// nicht anzeigt (kein provider-/agent-/Fortschritts-Feld wurde ergaenzt).
export interface WorkRequestSummary {
  id: number
  projectId: number
  title: string
  status: WorkRequestStatus
  createdAt: string
  updatedAt: string
}

export interface WorkRequestDecision {
  id: number
  workRequestId: number
  questionMarkdown: string
  options: WorkRequestOption[]
  recommendedOptionKey: string | null
  recommendationMarkdown: string
  status: WorkDecisionStatus
  resolvedOptionKey: string | null
  resolutionNote: string
  createdAt: string
  resolvedAt: string | null
}

// Vollstaendige Detailansicht - von get/create/updateIntent/resolveDecision
// zurueckgegeben. `taskIds` sind reine interne Metadaten (siehe
// work_request_tasks) - der Renderer loest sie bei Bedarf gezielt ueber die
// bereits vorhandene tasks:get-IPC auf (siehe linkedTasks.ts, M4.3 v4),
// statt dass dieser Typ vollstaendige Task-Objekte dupliziert.
export interface WorkRequestDetail extends WorkRequest {
  decisions: WorkRequestDecision[]
  taskIds: number[]
}

export interface CreateWorkRequestInput {
  projectId: number
  intentMarkdown: string
  createdBy: Actor
}

export interface UpdateWorkRequestIntentInput {
  projectId: number
  id: number
  intentMarkdown: string
}

export interface ResolveDecisionInput {
  projectId: number
  workRequestId: number
  decisionId: number
  optionKey: string
  resolutionNote?: string
}

// ---------------------------------------------------------------------------
// Main/intern-only Operationen (KEIN IPC-Kanal, KEIN Renderer-Zugriff)
// ---------------------------------------------------------------------------

// Minimaler Code-Level-Vertrag fuer ein zukuenftiges Planungsergebnis.
// Bewusst OHNE provider/model/agent-Zuweisung/tool-Berechtigungen/commands -
// M4.3 ruft keine KI auf; das ist nur die Datenform, die ein zukuenftiger
// Controller liefern wuerde.
export interface PlanningDecisionRequest {
  questionMarkdown: string
  options: WorkRequestOption[]
  recommendedOptionKey?: string | null
  recommendationMarkdown?: string
}

export interface PlanningResult {
  planMarkdown: string
  decisionRequests: PlanningDecisionRequest[]
}

export interface ApplyPlanningResultInput {
  projectId: number
  id: number
  planningResult: PlanningResult
}

export interface ReplaceWorkRequestTaskLinksInput {
  projectId: number
  workRequestId: number
  taskIds: number[]
}

export interface SetWorkRequestStatusInput {
  projectId: number
  id: number
  status: WorkRequestStatus
}

// ===========================================================================
// Meilenstein 4.4A - Controller/Agent/Planning-Vertragsschicht
//
// Reine Code-Ebene: KEINE Datenbank-Persistenz, KEINE IPC-Exposition, KEIN
// KI-Aufruf, KEINE Ausfuehrung. Das bestehende M4.3 PlanningResult (oben)
// bleibt UNVERAENDERT die massgebliche Vertragsform fuer
// applyPlanningResult() - diese Ebene ERWEITERT und ERSETZT es NICHT, sie
// baut nur EINE Stufe darueber.
//
// WICHTIG - ControllerPlan ist trotz des Namens ein VORSCHLAG. Es bedeutet
// NICHT: freigegeben, READY, persistiert, ausfuehrbar oder autorisiert. Ein
// ControllerTaskDraft ist eine vorgeschlagene zukuenftige M4.2-Aufgabe, noch
// KEINE Datenbank-Aufgabe (bewusst NICHT "TaskDraft" genannt - TasksTab.tsx
// hat bereits ein unabhaengiges, lokales `TaskDraft` fuer UI-Formularstate
// beim Bearbeiten einer bereits PERSISTIERTEN M4.2-Aufgabe; beide Namen
// beschreiben unterschiedliche Konzepte und wuerden sonst kollidieren).
// Validierung ist NICHT Autorisierung - ein gueltiger
// Vorschlag ist NIEMALS automatisch freigegeben (siehe Vorrangreihenfolge:
// Technische Faehigkeiten/Berechtigungen > Projekt-Regeln > explizite
// Nutzer-Entscheidungen > Work-Request-Absicht > aktueller Plan >
// Aufgaben-Anweisungen > Projekt-Kontext).
//
// Agent != Provider != Model != Execution Adapter. Ein AgentDescriptor
// beschreibt NUR eine austauschbare ROLLEN-Identitaet ("wer koennte diese
// Rolle einnehmen"), NIEMALS Laufzeitzustand (Nutzung/Kontextbudget),
// Anbieter/Modell-Bindung, CLI-Pfad/API-Key oder Faehigkeiten/Berechtigungen
// - all das gehoert einer zukuenftigen Laufzeit-/Provider-/Scheduling-Schicht.
// "Controller" ist eine ROLLE, kein bestimmtes Produkt (nicht "ChatGPT",
// nicht "Claude") - es gibt daher bewusst KEINE
// ChatGPTController/ClaudeAgentManager/CodexProviderManager/QwenRunner-
// Architektur und (noch) keine vier getrennten Registry-/Manager-Klassen fuer
// Agent/Provider/Model/ExecutionAdapter, da M4.4 keine davon tatsaechlich
// braucht.
// ===========================================================================

export const CONTROLLER_PLAN_MAX_TASK_DRAFTS = 200
// Dieselbe Groessenordnung wie DECISION_OPTION_KEY_MAX_LENGTH - ein
// ControllerTaskDraft.key ist konzeptionell derselbe stabile, kurze
// Schluessel-Begriff wie ein WorkRequestOption.key, nur fuer eine andere
// Vertragsebene.
export const TASK_DRAFT_KEY_MAX_LENGTH = 64
// Dieselbe Grenze wie TASK_MAX_DEPENDENCIES (Task.dependsOnTaskIds) - ein
// ControllerTaskDraft ist eine vorgeschlagene zukuenftige Aufgabe mit
// denselben sinnvollen Abhaengigkeits-Grenzen.
export const TASK_DRAFT_MAX_DEPENDS_ON_KEYS = TASK_MAX_DEPENDENCIES

/**
 * Eine vorgeschlagene zukuenftige M4.2-Aufgabe - KEINE Datenbank-Aufgabe.
 * Beschreibt bewusst nur ARBEIT (was getan werden soll), niemals WER sie
 * ausfuehrt oder MIT WELCHEN technischen Faehigkeiten - das entscheidet eine
 * zukuenftige Scheduling-Schicht. Enthaelt daher explizit KEIN
 * priority/agentId/agent/provider/model/executionAdapter/capabilities/
 * permissions/tools/commands/usageRemaining/contextRemaining-Feld. Alle acht
 * Felder sind PFLICHT (siehe controllerPlanValidation.ts - der Validator
 * synthetisiert fehlende Felder NICHT stillschweigend mit `?? ''`/`?? []`,
 * ein fehlendes Feld ist ein Fehler, kein leerer Standardwert).
 */
export interface ControllerTaskDraft {
  key: string
  title: string
  goalMarkdown: string
  descriptionMarkdown: string
  acceptanceCriteriaMarkdown: string
  verificationRequirementsMarkdown: string
  // Projektrelative logische Pfade, reine Metadaten (keine Berechtigungen) -
  // siehe Task.relevantFiles/taskRelevantFiles.ts, hier wiederverwendet.
  relevantFiles: string[]
  // Referenziert andere ControllerTaskDraft.key-Werte INNERHALB DESSELBEN
  // ControllerPlan - keine Datenbank-IDs (die gibt es fuer einen Vorschlag
  // noch nicht).
  dependsOnKeys: string[]
}

/**
 * Ein VORSCHLAG, kein freigegebener/READY/persistierter/ausfuehrbarer/
 * autorisierter Zustand (siehe Kommentar oben). Enthaelt bewusst KEIN
 * Workflow-Status-Feld - dieser Vertrag beschreibt nur die INHALTLICHE Form
 * eines Planungsvorschlags, keine eigene Zustandsmaschine.
 */
export interface ControllerPlan {
  planningResult: PlanningResult
  taskDrafts: ControllerTaskDraft[]
}

export const AGENT_ROLES = ['CONTROLLER', 'IMPLEMENTER', 'REVIEWER', 'ANALYST'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

export const AGENT_ID_MAX_LENGTH = 64
// Dieselbe Groessenordnung wie TASK_TITLE_MAX_LENGTH - ein Anzeigename ist
// kurzer Freitext, kein eigener unabhaengiger Grenzwert noetig.
export const AGENT_DISPLAY_NAME_MAX_LENGTH = TASK_TITLE_MAX_LENGTH
export const AGENT_MAX_ROLES = AGENT_ROLES.length

/**
 * Kleinstmoeglicher provider-neutraler Vertrag fuer eine austauschbare
 * Rollen-Identitaet - KEIN Laufzeitzustand. Enthaelt daher explizit KEIN
 * usage/context-budget/provider/model/CLI-Pfad/API-Key/command/
 * availability/current-workload/permission/capability-Feld - das gehoert
 * einer zukuenftigen Laufzeit-/Provider-/Scheduling-Schicht.
 */
export interface AgentDescriptor {
  id: string
  displayName: string
  roles: AgentRole[]
}
