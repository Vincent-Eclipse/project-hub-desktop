import type Database from 'better-sqlite3'
import {
  ACTORS,
  TASK_MAX_DEPENDENCIES,
  TASK_BLOCKED_REASON_MAX_LENGTH,
  TASK_MARKDOWN_MAX_LENGTH,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TITLE_MAX_LENGTH,
  type CreateTaskInput,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type UpdateTaskDependenciesInput,
  type UpdateTaskInput,
  type UpdateTaskStatusInput
} from '@shared/types'
import { getProjectById, ProjectArchivedError } from './projectsService'
import { logEvent } from './eventLogService'
import { validateRelevantFilesList } from './taskRelevantFiles'

// Meilenstein 4.2 - Aufgaben-Grundlage. Storage + Verwaltung ONLY: keine
// Ausfuehrung, kein Agent, kein Befehl, kein Dateisystemzugriff wird von
// dieser Datei ausgeloest. Aufgaben sind mutable Current-State-Datensaetze -
// KEINE Versionshistorie (im Unterschied zu rulesService.ts/contextService.ts).
// Abhaengigkeiten sind reine Planungs-Metadaten und veraendern nie
// automatisch den Status einer Aufgabe (kein Ausfuehrungs-Gate).

interface TaskRow {
  id: number
  project_id: number
  title: string
  goal_markdown: string
  description_markdown: string
  priority: TaskPriority
  status: TaskStatus
  acceptance_criteria_markdown: string
  verification_requirements_markdown: string
  relevant_files_json: string
  blocked_reason: string
  created_by: Task['createdBy']
  created_at: string
  updated_at: string
}

function parseRelevantFiles(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function mapRow(row: TaskRow, dependsOnTaskIds: number[]): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    goalMarkdown: row.goal_markdown,
    descriptionMarkdown: row.description_markdown,
    priority: row.priority,
    status: row.status,
    acceptanceCriteriaMarkdown: row.acceptance_criteria_markdown,
    verificationRequirementsMarkdown: row.verification_requirements_markdown,
    relevantFiles: parseRelevantFiles(row.relevant_files_json),
    blockedReason: row.blocked_reason,
    dependsOnTaskIds,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class TaskNotFoundError extends Error {
  constructor(id: number) {
    super(`Aufgabe mit ID ${id} wurde nicht gefunden.`)
    this.name = 'TaskNotFoundError'
  }
}

export class TaskMismatchError extends Error {
  constructor(taskId: number, projectId: number) {
    super(`Aufgabe ${taskId} gehoert nicht zu Projekt ${projectId}.`)
    this.name = 'TaskMismatchError'
  }
}

export class InvalidTaskError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTaskError'
  }
}

export class InvalidTaskDependencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTaskDependencyError'
  }
}

function getDependsOnIds(db: Database.Database, taskId: number): number[] {
  const rows = db
    .prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id ASC')
    .all(taskId) as Array<{ depends_on_task_id: number }>
  return rows.map((row) => row.depends_on_task_id)
}

function getTaskRow(db: Database.Database, id: number): TaskRow {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  if (!row) throw new TaskNotFoundError(id)
  return row
}

/**
 * Ownership-Gate fuer alle Mutationen (update/updateStatus/updateDependencies).
 * Aufgaben sind eine projekt-verschachtelte Ressource - Lesevorgaenge
 * (list/get) sind bereits projekt-skaliert, daher muessen es auch Mutationen
 * sein: ein Aufrufer, der lediglich eine Aufgaben-ID aus einem FREMDEN
 * Projekt kennt, darf diese NICHT veraendern koennen, nur weil die Aufgabe
 * existiert. Prueft explizit `task.id === id UND task.project_id === projectId`
 * BEVOR irgendetwas (auch der Archiviert-Status) geprueft oder geaendert wird -
 * bei Nichtuebereinstimmung immer TaskMismatchError, nie ein stilles
 * Uebernehmen des tatsaechlichen Projekts der Aufgabe.
 */
function assertTaskOwnership(db: Database.Database, projectId: number, taskId: number): TaskRow {
  const row = getTaskRow(db, taskId)
  if (row.project_id !== projectId) throw new TaskMismatchError(taskId, projectId)
  return row
}

export function listTasksForProject(db: Database.Database, projectId: number): Task[] {
  getProjectById(db, projectId)
  const rows = db
    .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC, id ASC')
    .all(projectId) as TaskRow[]
  return rows.map((row) => mapRow(row, getDependsOnIds(db, row.id)))
}

export function getTaskForProject(db: Database.Database, projectId: number, taskId: number): Task {
  getProjectById(db, projectId)
  const row = getTaskRow(db, taskId)
  if (row.project_id !== projectId) throw new TaskMismatchError(taskId, projectId)
  return mapRow(row, getDependsOnIds(db, row.id))
}

function validateTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > TASK_TITLE_MAX_LENGTH) {
    throw new InvalidTaskError(`Aufgaben-Titel muss 1 bis ${TASK_TITLE_MAX_LENGTH} Zeichen lang sein.`)
  }
  return value.trim()
}

function validateMarkdown(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > TASK_MARKDOWN_MAX_LENGTH) {
    throw new InvalidTaskError(`Feld "${field}" ist ungueltig (Text, max. ${TASK_MARKDOWN_MAX_LENGTH} Zeichen).`)
  }
  return value
}

function validateBlockedReason(value: unknown): string {
  if (typeof value !== 'string' || value.length > TASK_BLOCKED_REASON_MAX_LENGTH) {
    throw new InvalidTaskError(`Feld "blockedReason" ist ungueltig (Text, max. ${TASK_BLOCKED_REASON_MAX_LENGTH} Zeichen).`)
  }
  return value
}

function validatePriority(value: unknown): TaskPriority {
  if (typeof value !== 'string' || !TASK_PRIORITIES.includes(value as TaskPriority)) {
    throw new InvalidTaskError(`Ungueltige Prioritaet: ${String(value)}.`)
  }
  return value as TaskPriority
}

function validateStatus(value: unknown): TaskStatus {
  if (typeof value !== 'string' || !TASK_STATUSES.includes(value as TaskStatus)) {
    throw new InvalidTaskError(`Ungueltiger Status: ${String(value)}.`)
  }
  return value as TaskStatus
}

export function createTask(db: Database.Database, input: CreateTaskInput): Task {
  const title = validateTitle(input.title)
  const goalMarkdown = validateMarkdown(input.goalMarkdown ?? '', 'goalMarkdown')
  const descriptionMarkdown = validateMarkdown(input.descriptionMarkdown ?? '', 'descriptionMarkdown')
  const acceptanceCriteriaMarkdown = validateMarkdown(input.acceptanceCriteriaMarkdown ?? '', 'acceptanceCriteriaMarkdown')
  const verificationRequirementsMarkdown = validateMarkdown(
    input.verificationRequirementsMarkdown ?? '',
    'verificationRequirementsMarkdown'
  )
  const blockedReason = validateBlockedReason(input.blockedReason ?? '')
  const relevantFiles = validateRelevantFilesList(input.relevantFiles ?? [])
  const priority = validatePriority(input.priority ?? 'MEDIUM')
  const status = validateStatus(input.status ?? 'BACKLOG')
  if (!ACTORS.includes(input.createdBy)) throw new InvalidTaskError('Ungueltiger Ersteller.')

  return db.transaction(() => {
    const project = getProjectById(db, input.projectId)
    if (project.isArchived) throw new ProjectArchivedError(input.projectId)
    const result = db
      .prepare(
        `INSERT INTO tasks
          (project_id, title, goal_markdown, description_markdown, priority, status,
           acceptance_criteria_markdown, verification_requirements_markdown, relevant_files_json,
           blocked_reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.projectId,
        title,
        goalMarkdown,
        descriptionMarkdown,
        priority,
        status,
        acceptanceCriteriaMarkdown,
        verificationRequirementsMarkdown,
        JSON.stringify(relevantFiles),
        blockedReason,
        input.createdBy
      )
    const taskId = Number(result.lastInsertRowid)
    logEvent(db, {
      projectId: input.projectId,
      type: 'TASK_CREATED',
      payload: { taskId, status, priority, createdBy: input.createdBy }
    })
    return getTaskForProject(db, input.projectId, taskId)
  })()
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

/**
 * Baut die tatsaechlich zu schreibenden Felder fuer updateTaskDetails().
 * ChatGPT-Review Fix 5: jedes gelieferte Feld wird zuerst validiert/
 * normalisiert und DANN gegen den persistierten Wert verglichen - nur ein
 * Feld, dessen NORMALISIERTER Wert sich tatsaechlich vom persistierten Wert
 * unterscheidet, landet in `fields`/`values`/`changedFieldNames`. Ein
 * erneutes Speichern eines unveraenderten Formulars darf weder `updated_at`
 * noch ein TASK_UPDATED-Ereignis erzeugen. Relevant Files werden als
 * normalisierte Arrays verglichen (nicht als rohe JSON-Zeichenketten), damit
 * z. B. eine reine Backslash-Normalisierung ohne inhaltliche Aenderung
 * ebenfalls korrekt als "keine Aenderung" erkannt wird.
 */
function buildTaskDetailChanges(
  input: UpdateTaskInput,
  existing: TaskRow
): { fields: string[]; values: unknown[]; changedFieldNames: string[] } {
  const fields: string[] = []
  const values: unknown[] = []
  const changedFieldNames: string[] = []

  if (input.title !== undefined) {
    const title = validateTitle(input.title)
    if (title !== existing.title) {
      fields.push('title = ?')
      values.push(title)
      changedFieldNames.push('title')
    }
  }
  if (input.goalMarkdown !== undefined) {
    const goalMarkdown = validateMarkdown(input.goalMarkdown, 'goalMarkdown')
    if (goalMarkdown !== existing.goal_markdown) {
      fields.push('goal_markdown = ?')
      values.push(goalMarkdown)
      changedFieldNames.push('goalMarkdown')
    }
  }
  if (input.descriptionMarkdown !== undefined) {
    const descriptionMarkdown = validateMarkdown(input.descriptionMarkdown, 'descriptionMarkdown')
    if (descriptionMarkdown !== existing.description_markdown) {
      fields.push('description_markdown = ?')
      values.push(descriptionMarkdown)
      changedFieldNames.push('descriptionMarkdown')
    }
  }
  if (input.priority !== undefined) {
    const priority = validatePriority(input.priority)
    if (priority !== existing.priority) {
      fields.push('priority = ?')
      values.push(priority)
      changedFieldNames.push('priority')
    }
  }
  if (input.acceptanceCriteriaMarkdown !== undefined) {
    const acceptanceCriteriaMarkdown = validateMarkdown(input.acceptanceCriteriaMarkdown, 'acceptanceCriteriaMarkdown')
    if (acceptanceCriteriaMarkdown !== existing.acceptance_criteria_markdown) {
      fields.push('acceptance_criteria_markdown = ?')
      values.push(acceptanceCriteriaMarkdown)
      changedFieldNames.push('acceptanceCriteriaMarkdown')
    }
  }
  if (input.verificationRequirementsMarkdown !== undefined) {
    const verificationRequirementsMarkdown = validateMarkdown(
      input.verificationRequirementsMarkdown,
      'verificationRequirementsMarkdown'
    )
    if (verificationRequirementsMarkdown !== existing.verification_requirements_markdown) {
      fields.push('verification_requirements_markdown = ?')
      values.push(verificationRequirementsMarkdown)
      changedFieldNames.push('verificationRequirementsMarkdown')
    }
  }
  if (input.relevantFiles !== undefined) {
    const relevantFiles = validateRelevantFilesList(input.relevantFiles)
    const existingRelevantFiles = parseRelevantFiles(existing.relevant_files_json)
    if (!sameStringArray(relevantFiles, existingRelevantFiles)) {
      fields.push('relevant_files_json = ?')
      values.push(JSON.stringify(relevantFiles))
      changedFieldNames.push('relevantFiles')
    }
  }
  if (input.blockedReason !== undefined) {
    const blockedReason = validateBlockedReason(input.blockedReason)
    if (blockedReason !== existing.blocked_reason) {
      fields.push('blocked_reason = ?')
      values.push(blockedReason)
      changedFieldNames.push('blockedReason')
    }
  }

  return { fields, values, changedFieldNames }
}

export function updateTaskDetails(db: Database.Database, input: UpdateTaskInput): Task {
  const existing = assertTaskOwnership(db, input.projectId, input.id)
  const project = getProjectById(db, existing.project_id)
  if (project.isArchived) throw new ProjectArchivedError(existing.project_id)

  const { fields, values, changedFieldNames } = buildTaskDetailChanges(input, existing)

  if (fields.length > 0) {
    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    values.push(input.id)
    db.transaction(() => {
      db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
      logEvent(db, {
        projectId: existing.project_id,
        type: 'TASK_UPDATED',
        payload: { taskId: input.id, changedFields: changedFieldNames }
      })
    })()
  }

  return getTaskForProject(db, existing.project_id, input.id)
}

export function updateTaskStatus(db: Database.Database, input: UpdateTaskStatusInput): Task {
  const existing = assertTaskOwnership(db, input.projectId, input.id)
  const project = getProjectById(db, existing.project_id)
  if (project.isArchived) throw new ProjectArchivedError(existing.project_id)
  const status = validateStatus(input.status)

  if (status !== existing.status) {
    db.transaction(() => {
      db.prepare("UPDATE tasks SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(
        status,
        input.id
      )
      logEvent(db, {
        projectId: existing.project_id,
        type: 'TASK_STATUS_CHANGED',
        payload: { taskId: input.id, oldStatus: existing.status, newStatus: status }
      })
    })()
  }

  return getTaskForProject(db, existing.project_id, input.id)
}

/**
 * Prueft, ob das Setzen von `proposedDependsOn` als ausgehende Kanten von
 * `taskId` einen Zyklus im gesamten Projekt-Abhaengigkeitsgraphen erzeugen
 * wuerde. Reine Anwendungslogik (siehe Kommentar in 005_tasks.ts) - baut den
 * bestehenden Graphen des Projekts nach, ersetzt darin nur die Kanten von
 * `taskId` durch den Vorschlag und sucht per DFS einen Weg zurueck zu `taskId`.
 */
function assertNoCycle(db: Database.Database, projectId: number, taskId: number, proposedDependsOn: number[]): void {
  const rows = db
    .prepare(
      `SELECT td.task_id, td.depends_on_task_id FROM task_dependencies td
       JOIN tasks t ON t.id = td.task_id WHERE t.project_id = ?`
    )
    .all(projectId) as Array<{ task_id: number; depends_on_task_id: number }>

  const adjacency = new Map<number, number[]>()
  for (const row of rows) {
    if (row.task_id === taskId) continue
    const list = adjacency.get(row.task_id) ?? []
    list.push(row.depends_on_task_id)
    adjacency.set(row.task_id, list)
  }
  adjacency.set(taskId, proposedDependsOn)

  const visited = new Set<number>()
  const stack: number[] = [...proposedDependsOn]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === taskId) {
      throw new InvalidTaskDependencyError('Abhaengigkeiten duerfen keinen Zyklus bilden.')
    }
    if (visited.has(current)) continue
    visited.add(current)
    for (const next of adjacency.get(current) ?? []) stack.push(next)
  }
}

function sameIdArray(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

export function updateTaskDependencies(db: Database.Database, input: UpdateTaskDependenciesInput): Task {
  const existing = assertTaskOwnership(db, input.projectId, input.id)
  const project = getProjectById(db, existing.project_id)
  if (project.isArchived) throw new ProjectArchivedError(existing.project_id)

  if (!Array.isArray(input.dependsOnTaskIds)) {
    throw new InvalidTaskDependencyError('dependsOnTaskIds muss eine Liste sein.')
  }
  if (input.dependsOnTaskIds.length > TASK_MAX_DEPENDENCIES) {
    throw new InvalidTaskDependencyError(`Zu viele Abhaengigkeiten (max. ${TASK_MAX_DEPENDENCIES}).`)
  }

  // Abhaengigkeiten sind ein SATZ, keine geordnete Abfolge (ChatGPT-Review
  // Fix 5) - Eingabereihenfolge und Duplikate sind fachlich bedeutungslos.
  // Aufsteigend sortiert, konsistent mit der von getDependsOnIds()
  // zurueckgelieferten Reihenfolge, damit ein reiner Vergleich beider
  // (bereits sortierter) Arrays ausreicht, um echte Gleichheit zu erkennen.
  const normalizedIds = Array.from(new Set(input.dependsOnTaskIds)).sort((a, b) => a - b)
  for (const dependsOnId of normalizedIds) {
    if (!Number.isInteger(dependsOnId) || dependsOnId <= 0) {
      throw new InvalidTaskDependencyError('Jede Abhaengigkeit muss eine positive Ganzzahl-ID sein.')
    }
    if (dependsOnId === input.id) {
      throw new InvalidTaskDependencyError('Eine Aufgabe kann nicht von sich selbst abhaengen.')
    }
    const dependency = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(dependsOnId) as
      | { id: number; project_id: number }
      | undefined
    if (!dependency) throw new InvalidTaskDependencyError(`Abhaengigkeit ${dependsOnId} existiert nicht.`)
    if (dependency.project_id !== existing.project_id) {
      throw new InvalidTaskDependencyError('Abhaengigkeiten muessen zum selben Projekt gehoeren wie die Aufgabe.')
    }
  }

  const currentIds = getDependsOnIds(db, input.id)
  if (sameIdArray(normalizedIds, currentIds)) {
    // Effektiv unveraendert (gleiche Menge, ggf. andere Eingabereihenfolge
    // oder Duplikate) - kein DB-Schreibvorgang, kein Zeitstempel, kein Audit-Event.
    return getTaskForProject(db, existing.project_id, input.id)
  }

  assertNoCycle(db, existing.project_id, input.id, normalizedIds)

  db.transaction(() => {
    db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(input.id)
    for (const dependsOnId of normalizedIds) {
      db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)').run(
        input.id,
        dependsOnId
      )
    }
    db.prepare("UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(input.id)
    logEvent(db, {
      projectId: existing.project_id,
      type: 'TASK_DEPENDENCIES_UPDATED',
      payload: { taskId: input.id, oldDependencyIds: currentIds, newDependencyIds: normalizedIds }
    })
  })()

  return getTaskForProject(db, existing.project_id, input.id)
}
