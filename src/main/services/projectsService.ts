import type Database from 'better-sqlite3'
import type {
  CreateProjectInput,
  FolderStatus,
  NextActor,
  Project,
  ProjectStatus,
  UpdateProjectInput
} from '@shared/types'
import { resolveExistingFolder, pathsPointToSameLocation, checkFolderStatus } from '../pathNormalization'
import { generateUniqueSlug } from './slugService'
import { logEvent } from './eventLogService'

interface ProjectRow {
  id: number
  name: string
  slug: string
  project_type: string
  description: string
  folder_path: string | null
  folder_comparison_key: string | null
  status: string
  next_actor: string
  current_step: string
  next_action: string
  archived_at: string | null
  current_context_version_id: number | null
  created_at: string
  updated_at: string
  ctx_version_number: number | null
}

const SELECT_PROJECT_BASE = `
  SELECT
    p.id, p.name, p.slug, p.project_type, p.description,
    p.folder_path, p.folder_comparison_key,
    p.status, p.next_actor, p.current_step, p.next_action,
    p.archived_at, p.current_context_version_id, p.created_at, p.updated_at,
    v.version_number AS ctx_version_number
  FROM projects p
  LEFT JOIN project_context_versions v ON v.id = p.current_context_version_id
`

function mapRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    projectType: row.project_type,
    description: row.description,
    folderPath: row.folder_path,
    folderComparisonKey: row.folder_comparison_key,
    status: row.status as ProjectStatus,
    nextActor: row.next_actor as NextActor,
    currentStep: row.current_step,
    nextAction: row.next_action,
    isArchived: row.archived_at !== null,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentContextVersionId: row.current_context_version_id,
    currentContextVersionNumber: row.ctx_version_number
  }
}

export class ProjectNotFoundError extends Error {
  constructor(id: number) {
    super(`Projekt mit ID ${id} wurde nicht gefunden.`)
    this.name = 'ProjectNotFoundError'
  }
}

export class ProjectArchivedError extends Error {
  constructor(id: number) {
    super(`Projekt mit ID ${id} ist archiviert und kann nicht bearbeitet werden.`)
    this.name = 'ProjectArchivedError'
  }
}

export class DuplicateFolderError extends Error {
  constructor(folderPath: string) {
    super(`Der Ordner "${folderPath}" wird bereits von einem anderen Projekt verwendet.`)
    this.name = 'DuplicateFolderError'
  }
}

export function listProjects(db: Database.Database, includeArchived: boolean): Project[] {
  const sql = includeArchived
    ? `${SELECT_PROJECT_BASE} ORDER BY (p.archived_at IS NOT NULL) ASC, p.updated_at DESC`
    : `${SELECT_PROJECT_BASE} WHERE p.archived_at IS NULL ORDER BY p.updated_at DESC`
  const rows = db.prepare(sql).all() as ProjectRow[]
  return rows.map(mapRow)
}

export function getProjectById(db: Database.Database, id: number): Project {
  const row = db.prepare(`${SELECT_PROJECT_BASE} WHERE p.id = ?`).get(id) as
    | ProjectRow
    | undefined
  if (!row) throw new ProjectNotFoundError(id)
  return mapRow(row)
}

function touch(db: Database.Database, id: number): void {
  db.prepare(`UPDATE projects SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(
    id
  )
}

/**
 * Validiert einen vom Benutzer (ueber den nativen Ordnerdialog) gewaehlten
 * Projektordner: muss ein tatsaechlich existierendes Verzeichnis sein und
 * darf (ueber den realpath-/Vergleichsschluessel) noch von keinem anderen
 * Projekt verwendet werden. Gibt die kanonische Anzeige- und
 * Vergleichsform zurueck.
 */
function validateFolderForProject(
  db: Database.Database,
  rawFolderPath: string,
  excludeProjectId: number | null
): { display: string; comparisonKey: string } {
  const resolved = resolveExistingFolder(rawFolderPath)

  const others = db
    .prepare(
      excludeProjectId === null
        ? 'SELECT id, folder_path FROM projects WHERE folder_comparison_key IS NOT NULL'
        : 'SELECT id, folder_path FROM projects WHERE folder_comparison_key IS NOT NULL AND id != ?'
    )
    .all(...(excludeProjectId === null ? [] : [excludeProjectId])) as Array<{
    id: number
    folder_path: string | null
  }>

  const isDuplicate = others.some(
    (other) => other.folder_path !== null && pathsPointToSameLocation(other.folder_path, resolved.display)
  )
  if (isDuplicate) throw new DuplicateFolderError(resolved.display)

  return resolved
}

export function createProject(db: Database.Database, input: CreateProjectInput): Project {
  const slug = generateUniqueSlug(db, input.name)
  const folder = input.folderPath ? validateFolderForProject(db, input.folderPath, null) : null

  const projectId = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO projects
          (name, slug, project_type, description, folder_path, folder_comparison_key,
           status, next_actor, current_step, next_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.name.trim(),
        slug,
        input.projectType.trim(),
        input.description.trim(),
        folder?.display ?? null,
        folder?.comparisonKey ?? null,
        input.status ?? 'PLANNING',
        input.nextActor ?? 'LEON',
        input.currentStep?.trim() ?? '',
        input.nextAction?.trim() ?? ''
      )

    const newId = Number(result.lastInsertRowid)
    logEvent(db, {
      projectId: newId,
      type: 'PROJECT_CREATED',
      payload: { name: input.name.trim(), slug, projectType: input.projectType.trim() }
    })
    return newId
  })()

  return getProjectById(db, projectId)
}

/** Wirft ProjectArchivedError, wenn versucht wird, ein archiviertes Projekt zu aendern. */
function assertNotArchived(db: Database.Database, id: number): Project {
  const project = getProjectById(db, id)
  if (project.isArchived) throw new ProjectArchivedError(id)
  return project
}

export function updateProject(db: Database.Database, input: UpdateProjectInput): Project {
  assertNotArchived(db, input.id)

  const fields: string[] = []
  const values: unknown[] = []
  const changedFieldNames: string[] = []

  if (input.name !== undefined) {
    fields.push('name = ?')
    values.push(input.name.trim())
    changedFieldNames.push('name')
    // Der Slug wird bewusst NIE angefasst - eine Umbenennung darf den
    // Slug nicht ungefragt veraendern.
  }
  if (input.projectType !== undefined) {
    fields.push('project_type = ?')
    values.push(input.projectType.trim())
    changedFieldNames.push('projectType')
  }
  if (input.description !== undefined) {
    fields.push('description = ?')
    values.push(input.description.trim())
    changedFieldNames.push('description')
  }
  if (input.status !== undefined) {
    fields.push('status = ?')
    values.push(input.status)
    changedFieldNames.push('status')
  }
  if (input.nextActor !== undefined) {
    fields.push('next_actor = ?')
    values.push(input.nextActor)
    changedFieldNames.push('nextActor')
  }
  if (input.currentStep !== undefined) {
    fields.push('current_step = ?')
    values.push(input.currentStep.trim())
    changedFieldNames.push('currentStep')
  }
  if (input.nextAction !== undefined) {
    fields.push('next_action = ?')
    values.push(input.nextAction.trim())
    changedFieldNames.push('nextAction')
  }
  if (input.folderPath !== undefined) {
    if (input.folderPath === null) {
      fields.push('folder_path = NULL, folder_comparison_key = NULL')
      changedFieldNames.push('folderPath')
    } else {
      const folder = validateFolderForProject(db, input.folderPath, input.id)
      fields.push('folder_path = ?, folder_comparison_key = ?')
      values.push(folder.display, folder.comparisonKey)
      changedFieldNames.push('folderPath')
    }
  }

  if (fields.length > 0) {
    values.push(input.id)
    db.transaction(() => {
      db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
      touch(db, input.id)
      logEvent(db, {
        projectId: input.id,
        type: 'PROJECT_UPDATED',
        payload: { changedFields: changedFieldNames }
      })
    })()
  }

  return getProjectById(db, input.id)
}

export function archiveProject(db: Database.Database, id: number): Project {
  getProjectById(db, id) // wirft ProjectNotFoundError falls unbekannt
  db.transaction(() => {
    db.prepare(
      `UPDATE projects SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(id)
    logEvent(db, { projectId: id, type: 'PROJECT_ARCHIVED', payload: {} })
  })()
  return getProjectById(db, id)
}

export function restoreProject(db: Database.Database, id: number): Project {
  getProjectById(db, id)
  db.transaction(() => {
    db.prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(id)
    touch(db, id)
    logEvent(db, { projectId: id, type: 'PROJECT_RESTORED', payload: {} })
  })()
  return getProjectById(db, id)
}

/**
 * Ermittelt den LIVE-Status des gespeicherten Projektordners (RC4, Punkt
 * 12). Reine Abfrage - veraendert weder das Projekt noch den Dateisystem-
 * Zustand, erstellt und loescht nichts automatisch. Wird typischerweise
 * beim Oeffnen/Aktualisieren eines Projekts im Renderer aufgerufen, nicht
 * durch einen permanenten Hintergrund-Watcher.
 */
export function getProjectFolderStatus(db: Database.Database, id: number): FolderStatus {
  const project = getProjectById(db, id)
  if (project.folderPath === null) return 'NOT_CONFIGURED'
  return checkFolderStatus(project.folderPath)
}
