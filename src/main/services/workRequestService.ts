import type Database from 'better-sqlite3'
import {
  ACTORS,
  DECISION_MAX_OPTIONS,
  DECISION_MIN_OPTIONS,
  DECISION_OPTION_DESCRIPTION_MAX_LENGTH,
  DECISION_OPTION_KEY_MAX_LENGTH,
  DECISION_OPTION_LABEL_MAX_LENGTH,
  DECISION_QUESTION_MAX_LENGTH,
  DECISION_RECOMMENDATION_MAX_LENGTH,
  DECISION_RESOLUTION_NOTE_MAX_LENGTH,
  WORK_REQUEST_INTENT_MAX_LENGTH,
  WORK_REQUEST_MAX_TASK_LINKS,
  WORK_REQUEST_PLAN_MAX_LENGTH,
  WORK_REQUEST_STATUSES,
  type ApplyPlanningResultInput,
  type CreateWorkRequestInput,
  type PlanningDecisionRequest,
  type ReplaceWorkRequestTaskLinksInput,
  type ResolveDecisionInput,
  type SetWorkRequestStatusInput,
  type UpdateWorkRequestIntentInput,
  type WorkDecisionStatus,
  type WorkRequest,
  type WorkRequestDecision,
  type WorkRequestDetail,
  type WorkRequestOption,
  type WorkRequestStatus,
  type WorkRequestSummary
} from '@shared/types'
import { getProjectById, ProjectArchivedError } from './projectsService'
import { getTaskForProject } from './taskService'
import { logEvent } from './eventLogService'
import { deriveWorkRequestTitle } from './workRequestTitle'

// Meilenstein 4.3 - Work Request + Automation-UX-Grundlage. Workflow-DATEN +
// UX-Grundlage ONLY: kein KI-Aufruf, kein Agent, keine Ausfuehrung, keine
// automatische Task-Erzeugung, kein Replanning wird von dieser Datei
// ausgeloest. Ein Work Request ist Absicht, KEINE Berechtigung - er kann
// Projekt-Regeln oder technische Faehigkeiten nie erweitern (siehe
// Vorrangreihenfolge in shared/types.ts).
//
// Renderer-erreichbar (siehe registerIpc.ts/preload/index.ts): list, get,
// create, updateIntent, resolveDecision. Main/intern only (KEIN IPC-Kanal):
// applyPlanningResult, replaceTaskLinks, setWorkRequestStatus - der Renderer
// bekommt bewusst KEINEN generischen Status-Setter und KEINE direkte
// Kontrolle ueber Planung/Task-Verknuepfung.

interface WorkRequestRow {
  id: number
  project_id: number
  title: string
  intent_markdown: string
  plan_markdown: string | null
  status: WorkRequestStatus
  created_by: WorkRequest['createdBy']
  created_at: string
  updated_at: string
}

interface DecisionRow {
  id: number
  work_request_id: number
  question_markdown: string
  options_json: string
  recommended_option_key: string | null
  recommendation_markdown: string
  status: WorkDecisionStatus
  resolved_option_key: string | null
  resolution_note: string
  created_at: string
  resolved_at: string | null
}

function parseOptions(json: string): WorkRequestOption[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    const options: WorkRequestOption[] = []
    for (const entry of parsed) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { key?: unknown }).key !== 'string' ||
        typeof (entry as { label?: unknown }).label !== 'string'
      ) {
        continue
      }
      const option: WorkRequestOption = { key: (entry as { key: string }).key, label: (entry as { label: string }).label }
      const description = (entry as { descriptionMarkdown?: unknown }).descriptionMarkdown
      if (typeof description === 'string') option.descriptionMarkdown = description
      options.push(option)
    }
    return options
  } catch {
    return []
  }
}

function mapWorkRequestRow(row: WorkRequestRow, decisions: WorkRequestDecision[], taskIds: number[]): WorkRequestDetail {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    intentMarkdown: row.intent_markdown,
    planMarkdown: row.plan_markdown,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decisions,
    taskIds
  }
}

// ChatGPT-Re-Review Fix 3: eigene, schlanke Zeilenform fuer die Liste - die
// SQL-Abfrage in listWorkRequestsForProject() selektiert explizit NUR diese
// Spalten (kein `SELECT *`), damit intent_markdown/plan_markdown (je bis zu
// 50.000 Zeichen) nie ueber die Liste transportiert werden.
interface WorkRequestSummaryRow {
  id: number
  project_id: number
  title: string
  status: WorkRequestStatus
  created_at: string
  updated_at: string
}

function mapSummaryRow(row: WorkRequestSummaryRow): WorkRequestSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapDecisionRow(row: DecisionRow): WorkRequestDecision {
  return {
    id: row.id,
    workRequestId: row.work_request_id,
    questionMarkdown: row.question_markdown,
    options: parseOptions(row.options_json),
    recommendedOptionKey: row.recommended_option_key,
    recommendationMarkdown: row.recommendation_markdown,
    status: row.status,
    resolvedOptionKey: row.resolved_option_key,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  }
}

export class WorkRequestNotFoundError extends Error {
  constructor(id: number) {
    super(`Work Request mit ID ${id} wurde nicht gefunden.`)
    this.name = 'WorkRequestNotFoundError'
  }
}

export class WorkRequestMismatchError extends Error {
  constructor(id: number, projectId: number) {
    super(`Work Request ${id} gehoert nicht zu Projekt ${projectId}.`)
    this.name = 'WorkRequestMismatchError'
  }
}

export class InvalidWorkRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidWorkRequestError'
  }
}

export class WorkRequestNotEditableError extends Error {
  constructor(id: number) {
    // Codex-Review (v5): status IDEA war nie die vollstaendige Regel (siehe
    // assertIntentEditable) - die Meldung nennt daher den fachlichen Grund
    // ("nach Beginn der Planung"), keine interne Datenbank-Terminologie
    // (status/plan_markdown/work_request_decisions).
    super(`Das urspruengliche Anliegen von Work Request ${id} kann nach Beginn der Planung nicht mehr direkt bearbeitet werden.`)
    this.name = 'WorkRequestNotEditableError'
  }
}

export class InvalidWorkRequestStatusError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidWorkRequestStatusError'
  }
}

export class DecisionNotFoundError extends Error {
  constructor(id: number) {
    super(`Entscheidung mit ID ${id} wurde nicht gefunden.`)
    this.name = 'DecisionNotFoundError'
  }
}

export class DecisionMismatchError extends Error {
  constructor(decisionId: number, workRequestId: number) {
    super(`Entscheidung ${decisionId} gehoert nicht zu Work Request ${workRequestId}.`)
    this.name = 'DecisionMismatchError'
  }
}

export class InvalidDecisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDecisionError'
  }
}

export class DecisionResolutionConflictError extends Error {
  constructor(id: number) {
    super(`Entscheidung ${id} wurde bereits mit einer anderen Option aufgeloest.`)
    this.name = 'DecisionResolutionConflictError'
  }
}

export class TaskAlreadyLinkedError extends Error {
  constructor(taskId: number) {
    super(`Aufgabe ${taskId} ist bereits einem anderen Work Request zugeordnet.`)
    this.name = 'TaskAlreadyLinkedError'
  }
}

function getWorkRequestRow(db: Database.Database, id: number): WorkRequestRow {
  const row = db.prepare('SELECT * FROM work_requests WHERE id = ?').get(id) as WorkRequestRow | undefined
  if (!row) throw new WorkRequestNotFoundError(id)
  return row
}

function getDecisionRow(db: Database.Database, id: number): DecisionRow {
  const row = db.prepare('SELECT * FROM work_request_decisions WHERE id = ?').get(id) as DecisionRow | undefined
  if (!row) throw new DecisionNotFoundError(id)
  return row
}

/**
 * Ownership-Gate, analog taskService.assertTaskOwnership: prueft explizit
 * `workRequest.id === id UND workRequest.project_id === projectId` BEVOR
 * irgendetwas geprueft oder geaendert wird - bei Nichtuebereinstimmung immer
 * WorkRequestMismatchError, nie ein stilles Uebernehmen des tatsaechlichen
 * Projekts.
 */
function assertWorkRequestOwnership(db: Database.Database, projectId: number, id: number): WorkRequestRow {
  const row = getWorkRequestRow(db, id)
  if (row.project_id !== projectId) throw new WorkRequestMismatchError(id, projectId)
  return row
}

function listDecisionsForRequest(db: Database.Database, workRequestId: number): WorkRequestDecision[] {
  const rows = db
    .prepare('SELECT * FROM work_request_decisions WHERE work_request_id = ? ORDER BY id ASC')
    .all(workRequestId) as DecisionRow[]
  return rows.map(mapDecisionRow)
}

function getLinkedTaskIds(db: Database.Database, workRequestId: number): number[] {
  const rows = db
    .prepare('SELECT task_id FROM work_request_tasks WHERE work_request_id = ? ORDER BY position ASC')
    .all(workRequestId) as Array<{ task_id: number }>
  return rows.map((row) => row.task_id)
}

function buildDetail(db: Database.Database, row: WorkRequestRow): WorkRequestDetail {
  return mapWorkRequestRow(row, listDecisionsForRequest(db, row.id), getLinkedTaskIds(db, row.id))
}

function getWorkRequestDetailInternal(db: Database.Database, projectId: number, id: number): WorkRequestDetail {
  const row = assertWorkRequestOwnership(db, projectId, id)
  return buildDetail(db, row)
}

// Codex-Review (v5): `id ASC` als dritte Sortierstufe - SQLite garantiert bei
// gleichem updated_at KEINE bestimmte Reihenfolge, workRequestStore.ts's
// lokale sortWorkRequestSummaries() bricht diesen Fall aber bereits
// deterministisch per id auf. Ohne diese Stufe hier koennte ein frischer
// Reload theoretisch von der deterministischen lokalen Sortierung abweichen.
export function listWorkRequestsForProject(db: Database.Database, projectId: number): WorkRequestSummary[] {
  getProjectById(db, projectId)
  const rows = db
    .prepare(
      `SELECT id, project_id, title, status, created_at, updated_at FROM work_requests WHERE project_id = ?
       ORDER BY (status IN ('DONE','CANCELLED')) ASC, updated_at DESC, id ASC`
    )
    .all(projectId) as WorkRequestSummaryRow[]
  return rows.map(mapSummaryRow)
}

export function getWorkRequestForProject(db: Database.Database, projectId: number, id: number): WorkRequestDetail {
  getProjectById(db, projectId)
  return getWorkRequestDetailInternal(db, projectId, id)
}

function validateIntent(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > WORK_REQUEST_INTENT_MAX_LENGTH) {
    throw new InvalidWorkRequestError(
      `Das Anliegen muss 1 bis ${WORK_REQUEST_INTENT_MAX_LENGTH} Zeichen lang sein.`
    )
  }
  return value
}

export function createWorkRequest(db: Database.Database, input: CreateWorkRequestInput): WorkRequestDetail {
  const intentMarkdown = validateIntent(input.intentMarkdown)
  if (!ACTORS.includes(input.createdBy)) throw new InvalidWorkRequestError('Ungueltiger Ersteller.')
  const title = deriveWorkRequestTitle(intentMarkdown)

  return db.transaction(() => {
    const project = getProjectById(db, input.projectId)
    if (project.isArchived) throw new ProjectArchivedError(input.projectId)
    const result = db
      .prepare(
        `INSERT INTO work_requests (project_id, title, intent_markdown, status, created_by)
         VALUES (?, ?, ?, 'IDEA', ?)`
      )
      .run(input.projectId, title, intentMarkdown, input.createdBy)
    const id = Number(result.lastInsertRowid)
    logEvent(db, {
      projectId: input.projectId,
      type: 'WORK_REQUEST_CREATED',
      payload: { workRequestId: id, createdBy: input.createdBy }
    })
    return getWorkRequestDetailInternal(db, input.projectId, id)
  })()
}

/**
 * ChatGPT-Re-Review Fix 1 (v4): das urspruengliche Anliegen darf nur
 * bearbeitet werden, solange NOCH KEINE Planungshistorie existiert - status
 * ALLEIN reicht nicht, weil setWorkRequestStatus() bewusst ein roher
 * Main/intern-Setter ohne Uebergangsvalidierung ist (siehe dortiger
 * Kommentar) und einen bereits geplanten Work Request stillschweigend
 * zurueck auf IDEA setzen koennte. Die Autoritaet liegt hier im Service, NICHT
 * in der UI: bearbeitbar ist nur, wenn status === IDEA UND plan_markdown IS
 * NULL UND keine work_request_decisions-Zeilen existieren (Projekt nicht
 * archiviert wird separat geprueft). Sobald geplant wurde, wuerde ein
 * stilles Aendern des Anliegens Plan/Entscheidungen entwerten. Ein
 * zukuenftiges Replanning/Change-Request ist bewusst NICHT Teil von M4.3 -
 * dies ist keine Uebergangs-Engine, nur eine Bearbeitbarkeits-Pruefung.
 */
function assertIntentEditable(db: Database.Database, row: WorkRequestRow): void {
  if (row.status !== 'IDEA' || row.plan_markdown !== null) {
    throw new WorkRequestNotEditableError(row.id)
  }
  const decisionCount = db
    .prepare('SELECT COUNT(*) AS c FROM work_request_decisions WHERE work_request_id = ?')
    .get(row.id) as { c: number }
  if (decisionCount.c > 0) {
    throw new WorkRequestNotEditableError(row.id)
  }
}

export function updateWorkRequestIntent(db: Database.Database, input: UpdateWorkRequestIntentInput): WorkRequestDetail {
  const existing = assertWorkRequestOwnership(db, input.projectId, input.id)
  const project = getProjectById(db, existing.project_id)
  if (project.isArchived) throw new ProjectArchivedError(existing.project_id)
  // Die Planungshistorie-Pruefung MUSS vor dem no-op-Vergleich laufen: ein
  // bereits geplanter Work Request bleibt nicht bearbeitbar, selbst wenn der
  // eingereichte Text zufaellig mit dem aktuellen Anliegen uebereinstimmt.
  assertIntentEditable(db, existing)

  const intentMarkdown = validateIntent(input.intentMarkdown)
  if (intentMarkdown === existing.intent_markdown) {
    // Effektiv unveraendert - kein Schreibvorgang, kein Zeitstempel, kein Audit-Event.
    return buildDetail(db, existing)
  }
  const title = deriveWorkRequestTitle(intentMarkdown)

  db.transaction(() => {
    db.prepare(
      "UPDATE work_requests SET intent_markdown = ?, title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(intentMarkdown, title, existing.id)
    logEvent(db, {
      projectId: existing.project_id,
      type: 'WORK_REQUEST_INTENT_UPDATED',
      payload: { workRequestId: existing.id }
    })
  })()

  return getWorkRequestDetailInternal(db, existing.project_id, existing.id)
}

// ---------------------------------------------------------------------------
// Decision-Optionen-Validierung (fuer applyPlanningResult - Main/intern only)
// ---------------------------------------------------------------------------

const OPTION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateOption(raw: unknown): WorkRequestOption {
  if (!isPlainObject(raw)) throw new InvalidDecisionError('Jede Option muss ein Objekt sein.')
  const key = raw.key
  if (typeof key !== 'string' || key.length === 0 || key.length > DECISION_OPTION_KEY_MAX_LENGTH || !OPTION_KEY_PATTERN.test(key)) {
    throw new InvalidDecisionError('Ungueltiger Options-Schluessel (stabiler Schluessel erforderlich, keine Array-Position).')
  }
  const label = raw.label
  if (typeof label !== 'string' || label.trim().length === 0 || label.length > DECISION_OPTION_LABEL_MAX_LENGTH) {
    throw new InvalidDecisionError(`Options-Label muss 1 bis ${DECISION_OPTION_LABEL_MAX_LENGTH} Zeichen lang sein.`)
  }
  const option: WorkRequestOption = { key, label }
  if (raw.descriptionMarkdown !== undefined) {
    if (typeof raw.descriptionMarkdown !== 'string' || raw.descriptionMarkdown.length > DECISION_OPTION_DESCRIPTION_MAX_LENGTH) {
      throw new InvalidDecisionError(
        `Options-Beschreibung ist ungueltig (Text, max. ${DECISION_OPTION_DESCRIPTION_MAX_LENGTH} Zeichen).`
      )
    }
    option.descriptionMarkdown = raw.descriptionMarkdown
  }
  return option
}

function validateOptions(raw: unknown): WorkRequestOption[] {
  if (!Array.isArray(raw) || raw.length < DECISION_MIN_OPTIONS || raw.length > DECISION_MAX_OPTIONS) {
    throw new InvalidDecisionError(
      `Eine Entscheidung braucht ${DECISION_MIN_OPTIONS} bis ${DECISION_MAX_OPTIONS} Optionen.`
    )
  }
  const options = raw.map((entry) => validateOption(entry))
  const uniqueKeys = new Set(options.map((option) => option.key))
  if (uniqueKeys.size !== options.length) {
    throw new InvalidDecisionError('Options-Schluessel muessen innerhalb einer Entscheidung eindeutig sein.')
  }
  return options
}

interface ValidatedDecisionRequest {
  questionMarkdown: string
  options: WorkRequestOption[]
  recommendedOptionKey: string | null
  recommendationMarkdown: string
}

function validateDecisionRequest(raw: PlanningDecisionRequest): ValidatedDecisionRequest {
  if (
    typeof raw.questionMarkdown !== 'string' ||
    raw.questionMarkdown.trim().length === 0 ||
    raw.questionMarkdown.length > DECISION_QUESTION_MAX_LENGTH
  ) {
    throw new InvalidDecisionError(`Entscheidungsfrage muss 1 bis ${DECISION_QUESTION_MAX_LENGTH} Zeichen lang sein.`)
  }
  const options = validateOptions(raw.options)

  let recommendedOptionKey: string | null = null
  if (raw.recommendedOptionKey !== undefined && raw.recommendedOptionKey !== null) {
    if (typeof raw.recommendedOptionKey !== 'string' || !options.some((option) => option.key === raw.recommendedOptionKey)) {
      throw new InvalidDecisionError('recommendedOptionKey muss dem Schluessel einer vorhandenen Option entsprechen.')
    }
    recommendedOptionKey = raw.recommendedOptionKey
  }

  let recommendationMarkdown = ''
  if (raw.recommendationMarkdown !== undefined) {
    if (typeof raw.recommendationMarkdown !== 'string' || raw.recommendationMarkdown.length > DECISION_RECOMMENDATION_MAX_LENGTH) {
      throw new InvalidDecisionError(
        `Empfehlung ist ungueltig (Text, max. ${DECISION_RECOMMENDATION_MAX_LENGTH} Zeichen).`
      )
    }
    recommendationMarkdown = raw.recommendationMarkdown
  }

  return { questionMarkdown: raw.questionMarkdown, options, recommendedOptionKey, recommendationMarkdown }
}

// ChatGPT-Re-Review Fix 2: ein PlanningResult muss einen tatsaechlich
// aussagekraeftigen Plan enthalten. Ein leerer/nur-Leerraum-Plan wuerde
// status=READY setzen, waehrend die Oberflaeche gleichzeitig "Plan wurde
// noch nicht erstellt." anzeigen muesste - ein widerspruechlicher Zustand.
// Ein bereits GUELTIGER Plan wird weiterhin exakt unveraendert uebernommen
// (kein Trimmen/Umschreiben) - nur eine leere/reine Leerraum-Eingabe wird
// abgelehnt.
function validatePlanMarkdown(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > WORK_REQUEST_PLAN_MAX_LENGTH) {
    throw new InvalidWorkRequestError(
      `Plan muss 1 bis ${WORK_REQUEST_PLAN_MAX_LENGTH} Zeichen lang sein (nicht nur Leerraum).`
    )
  }
  return value
}

/**
 * Main/intern only - KEIN IPC-Kanal. Wendet ein PlanningResult (siehe
 * shared/types.ts - bewusst ohne provider/model/agent/tool-Felder, M4.3
 * ruft keine KI auf) atomar an: Projekt-/Work-Request-Zugehoerigkeit
 * pruefen, Plan/Entscheidungen validieren, Plan persistieren, Decision
 * Requests anlegen, Status setzen. Nur aus IDEA/PLANNING zulaessig - ein
 * allgemeines Replanning ist bewusst nicht Teil von M4.3. Erzeugt (noch)
 * keine Tasks - das ist auf den zukuenftigen Controller-/Agent-Vertrag
 * verschoben.
 */
export function applyPlanningResult(db: Database.Database, input: ApplyPlanningResultInput): WorkRequestDetail {
  const existing = assertWorkRequestOwnership(db, input.projectId, input.id)
  const project = getProjectById(db, existing.project_id)
  if (project.isArchived) throw new ProjectArchivedError(existing.project_id)
  if (existing.status !== 'IDEA' && existing.status !== 'PLANNING') {
    throw new InvalidWorkRequestStatusError(
      `Ein Planungsergebnis kann nur aus IDEA/PLANNING angewendet werden (aktueller Status: ${existing.status}).`
    )
  }
  // ChatGPT-Re-Review Fix 2: der Status-Check allein reicht nicht aus, um
  // Replanning zu verhindern - setWorkRequestStatus ist bewusst ein roher
  // Main/intern-Setter ohne Uebergangsvalidierung (siehe dortiger
  // Kommentar), koennte also einen bereits geplanten Work Request wieder
  // auf PLANNING zuruecksetzen. Diese Pruefung ist daher UNABHAENGIG vom
  // Status: eine bereits erfolgreich abgeschlossene initiale Planung (Plan
  // gesetzt ODER mindestens eine Decision-Zeile vorhanden) macht jeden
  // weiteren applyPlanningResult-Aufruf ungueltig, unabhaengig davon, was
  // der aktuelle Status gerade ist. Ein allgemeines Replanning bleibt
  // bewusst nicht Teil von M4.3.
  if (existing.plan_markdown !== null) {
    throw new InvalidWorkRequestStatusError(
      `Work Request ${existing.id} wurde bereits initial geplant - erneutes Planen (Replanning) ist in M4.3 nicht vorgesehen.`
    )
  }
  const existingDecisionCount = db
    .prepare('SELECT COUNT(*) AS c FROM work_request_decisions WHERE work_request_id = ?')
    .get(existing.id) as { c: number }
  if (existingDecisionCount.c > 0) {
    throw new InvalidWorkRequestStatusError(
      `Work Request ${existing.id} hat bereits Entscheidungen - erneutes Planen (Replanning) ist in M4.3 nicht vorgesehen.`
    )
  }

  const planMarkdown = validatePlanMarkdown(input.planningResult.planMarkdown)
  if (!Array.isArray(input.planningResult.decisionRequests)) {
    throw new InvalidDecisionError('decisionRequests muss eine Liste sein.')
  }
  const decisionRequests = input.planningResult.decisionRequests.map((entry) => validateDecisionRequest(entry))
  const newStatus: WorkRequestStatus = decisionRequests.length > 0 ? 'NEEDS_DECISION' : 'READY'
  const oldStatus = existing.status

  db.transaction(() => {
    db.prepare(
      "UPDATE work_requests SET plan_markdown = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(planMarkdown, newStatus, existing.id)
    for (const decision of decisionRequests) {
      db.prepare(
        `INSERT INTO work_request_decisions
          (work_request_id, question_markdown, options_json, recommended_option_key, recommendation_markdown)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        existing.id,
        decision.questionMarkdown,
        JSON.stringify(decision.options),
        decision.recommendedOptionKey,
        decision.recommendationMarkdown
      )
    }
    logEvent(db, {
      projectId: existing.project_id,
      type: 'WORK_REQUEST_PLANNED',
      payload: { workRequestId: existing.id, decisionCount: decisionRequests.length, newStatus }
    })
    // oldStatus is always IDEA/PLANNING here (checked above) and newStatus is
    // always READY/NEEDS_DECISION - these never coincide, so applying a
    // planning result always logs a status change alongside WORK_REQUEST_PLANNED.
    logEvent(db, {
      projectId: existing.project_id,
      type: 'WORK_REQUEST_STATUS_CHANGED',
      payload: { workRequestId: existing.id, oldStatus, newStatus }
    })
  })()

  return getWorkRequestDetailInternal(db, existing.project_id, existing.id)
}

/**
 * Renderer-erreichbar. Loest eine OFFENE Entscheidung auf. Wird die letzte
 * OFFENE Entscheidung eines Work Requests aufgeloest, der aktuell in
 * NEEDS_DECISION steht, wechselt der Work Request deterministisch zu READY
 * (in M4.3 ausdruecklich erlaubter Automatik-Uebergang) - danach wird KEINE
 * KI aufgerufen.
 */
export function resolveDecision(db: Database.Database, input: ResolveDecisionInput): WorkRequestDetail {
  const workRequest = assertWorkRequestOwnership(db, input.projectId, input.workRequestId)
  const project = getProjectById(db, workRequest.project_id)
  if (project.isArchived) throw new ProjectArchivedError(workRequest.project_id)

  const decision = getDecisionRow(db, input.decisionId)
  if (decision.work_request_id !== workRequest.id) throw new DecisionMismatchError(decision.id, workRequest.id)

  if (typeof input.optionKey !== 'string' || input.optionKey.length === 0) {
    throw new InvalidDecisionError('optionKey ist erforderlich.')
  }
  const resolutionNote =
    input.resolutionNote === undefined
      ? ''
      : (() => {
          if (typeof input.resolutionNote !== 'string' || input.resolutionNote.length > DECISION_RESOLUTION_NOTE_MAX_LENGTH) {
            throw new InvalidDecisionError(
              `Notiz ist ungueltig (Text, max. ${DECISION_RESOLUTION_NOTE_MAX_LENGTH} Zeichen).`
            )
          }
          return input.resolutionNote
        })()

  if (decision.status === 'CANCELLED') {
    throw new InvalidDecisionError('Eine abgebrochene Entscheidung kann nicht aufgeloest werden.')
  }
  if (decision.status === 'RESOLVED') {
    if (decision.resolved_option_key === input.optionKey) {
      // Bereits mit genau dieser Option aufgeloest - idempotenter No-op, kein Audit-Event.
      return buildDetail(db, workRequest)
    }
    throw new DecisionResolutionConflictError(decision.id)
  }

  const options = parseOptions(decision.options_json)
  if (!options.some((option) => option.key === input.optionKey)) {
    throw new InvalidDecisionError(`Option "${input.optionKey}" existiert nicht fuer diese Entscheidung.`)
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE work_request_decisions
         SET status = 'RESOLVED', resolved_option_key = ?, resolution_note = ?,
             resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).run(input.optionKey, resolutionNote, decision.id)
    logEvent(db, {
      projectId: workRequest.project_id,
      type: 'WORK_DECISION_RESOLVED',
      payload: { workRequestId: workRequest.id, decisionId: decision.id, optionKey: input.optionKey }
    })

    const remainingOpen = db
      .prepare("SELECT COUNT(*) AS c FROM work_request_decisions WHERE work_request_id = ? AND status = 'OPEN'")
      .get(workRequest.id) as { c: number }
    const becomesReady = remainingOpen.c === 0 && workRequest.status === 'NEEDS_DECISION'
    if (becomesReady) {
      // ChatGPT-Re-Review Fix 4: ein einziges UPDATE deckt Status- UND
      // updated_at-Aenderung ab statt eines separaten Zeitstempel-UPDATEs.
      db.prepare(
        "UPDATE work_requests SET status = 'READY', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
      ).run(workRequest.id)
      logEvent(db, {
        projectId: workRequest.project_id,
        type: 'WORK_REQUEST_STATUS_CHANGED',
        payload: { workRequestId: workRequest.id, oldStatus: 'NEEDS_DECISION', newStatus: 'READY' }
      })
    } else {
      // ChatGPT-Re-Review Fix 4: das Aufloesen einer NICHT-letzten offenen
      // Entscheidung aendert bedeutsamen Work-Request-Kindzustand - der
      // Elternzeitstempel muss das widerspiegeln (Sortierung, "Zuletzt
      // geaendert"), auch ohne Statuswechsel.
      db.prepare("UPDATE work_requests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(
        workRequest.id
      )
    }
  })()

  return getWorkRequestDetailInternal(db, workRequest.project_id, workRequest.id)
}

function sameOrderedIdArray(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

/**
 * Main/intern only - KEIN IPC-Kanal. Ersetzt die vollstaendige Menge
 * verknuepfter Tasks (Reihenfolge ist bedeutsam - `position` steuert die
 * Anzeige, anders als task_dependencies, das eine reine Menge ist). Eine
 * Aufgabe kann zu hoechstens einem Work Request gehoeren (siehe Migration
 * 006) - ein Versuch, eine bereits woanders verknuepfte Aufgabe zu
 * uebernehmen, wird abgelehnt statt sie stillschweigend umzuhaengen. Keine
 * Ausfuehrungs-Semantik, keine automatische Task-Statusaenderung.
 */
export function replaceTaskLinks(db: Database.Database, input: ReplaceWorkRequestTaskLinksInput): WorkRequestDetail {
  const workRequest = assertWorkRequestOwnership(db, input.projectId, input.workRequestId)
  const project = getProjectById(db, workRequest.project_id)
  if (project.isArchived) throw new ProjectArchivedError(workRequest.project_id)

  if (!Array.isArray(input.taskIds)) throw new InvalidWorkRequestError('taskIds muss eine Liste sein.')
  if (input.taskIds.length > WORK_REQUEST_MAX_TASK_LINKS) {
    throw new InvalidWorkRequestError(`Zu viele verknuepfte Aufgaben (max. ${WORK_REQUEST_MAX_TASK_LINKS}).`)
  }

  // Deterministische Reihenfolge: erste Fundstelle je Duplikat gewinnt, die
  // Eingabereihenfolge des Aufrufers bleibt sonst erhalten (Position ist hier
  // fachlich bedeutsam, anders als bei Task-Abhaengigkeiten).
  const seen = new Set<number>()
  const uniqueTaskIds: number[] = []
  for (const taskId of input.taskIds) {
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new InvalidWorkRequestError('Jede Task-ID muss eine positive Ganzzahl sein.')
    }
    if (!seen.has(taskId)) {
      seen.add(taskId)
      uniqueTaskIds.push(taskId)
    }
  }

  for (const taskId of uniqueTaskIds) {
    getTaskForProject(db, workRequest.project_id, taskId) // wirft TaskNotFoundError/TaskMismatchError (Fremdprojekt)
    const existingLink = db.prepare('SELECT work_request_id FROM work_request_tasks WHERE task_id = ?').get(taskId) as
      | { work_request_id: number }
      | undefined
    if (existingLink && existingLink.work_request_id !== workRequest.id) {
      throw new TaskAlreadyLinkedError(taskId)
    }
  }

  const currentTaskIds = getLinkedTaskIds(db, workRequest.id)
  if (sameOrderedIdArray(uniqueTaskIds, currentTaskIds)) {
    // Effektiv unveraendert - kein Schreibvorgang, kein Audit-Event.
    return buildDetail(db, workRequest)
  }

  db.transaction(() => {
    db.prepare('DELETE FROM work_request_tasks WHERE work_request_id = ?').run(workRequest.id)
    uniqueTaskIds.forEach((taskId, index) => {
      db.prepare('INSERT INTO work_request_tasks (task_id, work_request_id, position) VALUES (?, ?, ?)').run(
        taskId,
        workRequest.id,
        index
      )
    })
    // ChatGPT-Re-Review Fix 4: eine echte Aenderung der verknuepften Tasks
    // aendert bedeutsamen Work-Request-Kindzustand - der Elternzeitstempel
    // muss das widerspiegeln, in derselben Transaktion wie Link-Ersatz +
    // Audit (Rollback bei Audit-Fehler nimmt auch diesen Zeitstempel zurueck).
    db.prepare("UPDATE work_requests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(
      workRequest.id
    )
    logEvent(db, {
      projectId: workRequest.project_id,
      type: 'WORK_REQUEST_TASKS_LINKED',
      payload: { workRequestId: workRequest.id, taskCount: uniqueTaskIds.length }
    })
  })()

  return getWorkRequestDetailInternal(db, workRequest.project_id, workRequest.id)
}

/**
 * Main/intern only - KEIN IPC-Kanal. M4.3 implementiert bewusst KEINE
 * vollstaendige Uebergangs-Engine - dies ist nur der rohe Setter fuer den
 * zukuenftigen Workflow-Vertrag, ohne Uebergangsvalidierung ausser dem
 * Wertebereich selbst.
 */
export function setWorkRequestStatus(db: Database.Database, input: SetWorkRequestStatusInput): WorkRequestDetail {
  const existing = assertWorkRequestOwnership(db, input.projectId, input.id)
  const project = getProjectById(db, existing.project_id)
  if (project.isArchived) throw new ProjectArchivedError(existing.project_id)
  if (typeof input.status !== 'string' || !WORK_REQUEST_STATUSES.includes(input.status)) {
    throw new InvalidWorkRequestError(`Ungueltiger Status: ${String(input.status)}.`)
  }

  if (input.status !== existing.status) {
    db.transaction(() => {
      db.prepare(
        "UPDATE work_requests SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
      ).run(input.status, existing.id)
      logEvent(db, {
        projectId: existing.project_id,
        type: 'WORK_REQUEST_STATUS_CHANGED',
        payload: { workRequestId: existing.id, oldStatus: existing.status, newStatus: input.status }
      })
    })()
  }

  return getWorkRequestDetailInternal(db, existing.project_id, existing.id)
}
