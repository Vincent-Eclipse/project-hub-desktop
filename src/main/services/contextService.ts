import type Database from 'better-sqlite3'
import type { ContextVersionAuthor, DiffLine, ProjectContextVersion } from '@shared/types'
import { getProjectById } from './projectsService'
import { logEvent } from './eventLogService'
import { diffLines } from '../utils/diff'

interface ContextVersionRow {
  id: number
  project_id: number
  version_number: number
  content_markdown: string
  note: string | null
  created_by: string
  created_at: string
}

function mapRow(row: ContextVersionRow): ProjectContextVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    contentMarkdown: row.content_markdown,
    note: row.note,
    createdBy: row.created_by as ContextVersionAuthor,
    createdAt: row.created_at
  }
}

export class ContextVersionNotFoundError extends Error {
  constructor(id: number) {
    super(`Kontext-Version mit ID ${id} wurde nicht gefunden.`)
    this.name = 'ContextVersionNotFoundError'
  }
}

/**
 * Wird geworfen, wenn ueber die IPC-Grenze eine Kontext-Version angefragt
 * wird, die zwar existiert, aber nachweislich zu einem ANDEREN Projekt
 * gehoert als dem angegebenen projectId. Liefert absichtlich KEINE
 * Kontextinhalte in diesem Fall - siehe getContextVersionForProject().
 */
export class ContextVersionMismatchError extends Error {
  constructor(versionId: number, projectId: number) {
    super(`Kontext-Version ${versionId} gehoert nicht zu Projekt ${projectId}.`)
    this.name = 'ContextVersionMismatchError'
  }
}

/**
 * Wird geworfen, wenn projects.current_context_version_id intern auf eine
 * Version zeigt, die zu einem ANDEREN Projekt gehoert. Das kann durch die
 * Datenbank-Fremdschluessel-Constraint auf current_context_version_id nicht
 * verhindert werden (der FK garantiert nur, dass die ID ueberhaupt
 * existiert, nicht dass sie zum richtigen Projekt gehoert) - das ist ein
 * interner Integritaetsfehler, kein normaler Anwendungsfehler.
 */
export class ContextIntegrityError extends Error {
  constructor(projectId: number, versionId: number) {
    super(
      `Integritaetsfehler: Projekt ${projectId} verweist auf Kontext-Version ${versionId}, ` +
        `die zu einem anderen Projekt gehoert.`
    )
    this.name = 'ContextIntegrityError'
  }
}

export class ProjectArchivedForContextError extends Error {
  constructor(projectId: number) {
    super(`Projekt ${projectId} ist archiviert - es koennen keine neuen Kontext-Versionen angelegt werden.`)
    this.name = 'ProjectArchivedForContextError'
  }
}

function getContextVersionRowById(db: Database.Database, id: number): ContextVersionRow {
  const row = db.prepare('SELECT * FROM project_context_versions WHERE id = ?').get(id) as
    | ContextVersionRow
    | undefined
  if (!row) throw new ContextVersionNotFoundError(id)
  return row
}

export function listContextVersions(db: Database.Database, projectId: number): ProjectContextVersion[] {
  getProjectById(db, projectId)
  const rows = db
    .prepare(
      'SELECT * FROM project_context_versions WHERE project_id = ? ORDER BY version_number DESC'
    )
    .all(projectId) as ContextVersionRow[]
  return rows.map(mapRow)
}

/**
 * Liefert eine bestimmte Kontext-Version NUR, wenn sie tatsaechlich zum
 * angegebenen Projekt gehoert. Das ist der einzige Weg, wie IPC-Aufrufe
 * (context:getVersion) an eine Kontext-Version kommen - so wird verhindert,
 * dass ein falsch zugeordnetes/verwechseltes projectId+versionId-Paar aus
 * dem Renderer versehentlich Inhalte eines FREMDEN Projekts liefert.
 * Bei falscher Zuordnung: sprechender Fehler, keine Kontextinhalte, kein
 * stiller Fallback.
 */
export function getContextVersionForProject(
  db: Database.Database,
  projectId: number,
  versionId: number
): ProjectContextVersion {
  getProjectById(db, projectId) // wirft ProjectNotFoundError falls unbekannt
  const row = getContextVersionRowById(db, versionId) // wirft ContextVersionNotFoundError falls unbekannt
  if (row.project_id !== projectId) {
    throw new ContextVersionMismatchError(versionId, projectId)
  }
  return mapRow(row)
}

/**
 * Vergleicht zwei Kontext-Versionen desselben Projekts. Wirft
 * ContextVersionMismatchError, wenn eine der beiden Versionen nicht zum
 * angegebenen Projekt gehoert (auch wenn beide Versionen fuer sich
 * existieren, aber aus unterschiedlichen Projekten stammen).
 */
export function getContextDiffForProject(
  db: Database.Database,
  projectId: number,
  fromVersionId: number,
  toVersionId: number
): DiffLine[] {
  const from = getContextVersionForProject(db, projectId, fromVersionId)
  const to = getContextVersionForProject(db, projectId, toVersionId)
  return diffLines(from.contentMarkdown, to.contentMarkdown)
}

/**
 * Liefert die aktuelle Kontext-Version eines Projekts. Prueft zusaetzlich
 * zur reinen Existenz (durch die current_context_version_id-Fremdschluessel-
 * Constraint bereits auf DB-Ebene garantiert), dass die referenzierte
 * Version tatsaechlich zu DIESEM Projekt gehoert. Zeigt
 * current_context_version_id auf eine fremde Version, wird ein
 * ContextIntegrityError geworfen statt stillschweigend falsche/fremde
 * Kontextinhalte zurueckzugeben.
 */
export function getCurrentContextVersion(
  db: Database.Database,
  projectId: number
): ProjectContextVersion | null {
  const project = getProjectById(db, projectId)
  if (project.currentContextVersionId === null) return null

  const row = getContextVersionRowById(db, project.currentContextVersionId)
  if (row.project_id !== projectId) {
    throw new ContextIntegrityError(projectId, project.currentContextVersionId)
  }
  return mapRow(row)
}

/**
 * Legt eine neue Kontext-Version an. Kontext-Versionen sind append-only:
 * es wird nie eine bestehende Zeile ueberschrieben, sondern immer eine neue
 * Versionsnummer vergeben. "Aktuell" bedeutet ausschliesslich "hoechste
 * Versionsnummer" - der Editor zeigt standardmaessig diese Version, die
 * Historie bleibt vollstaendig und unveraendert einsehbar.
 *
 * Die naechste Versionsnummer wird bewusst NICHT aus dem (moeglicherweise
 * veralteten oder beschaedigten) project.currentContextVersionNumber
 * abgeleitet, sondern innerhalb derselben Transaktion per
 * SELECT COALESCE(MAX(version_number), 0) + 1 direkt aus der
 * project_context_versions-Tabelle berechnet - das bleibt auch dann
 * korrekt, wenn current_context_version_id aus irgendeinem Grund nicht mehr
 * mit dem tatsaechlich hoechsten Versionsstand uebereinstimmt.
 */
export function createContextVersion(
  db: Database.Database,
  input: {
    projectId: number
    contentMarkdown: string
    note?: string | null
    createdBy: ContextVersionAuthor
  }
): ProjectContextVersion {
  const project = getProjectById(db, input.projectId)
  if (project.isArchived) throw new ProjectArchivedForContextError(input.projectId)

  const newVersionId = db.transaction(() => {
    const maxRow = db
      .prepare('SELECT COALESCE(MAX(version_number), 0) AS maxVersion FROM project_context_versions WHERE project_id = ?')
      .get(input.projectId) as { maxVersion: number }
    const nextVersionNumber = maxRow.maxVersion + 1

    const result = db
      .prepare(
        'INSERT INTO project_context_versions (project_id, version_number, content_markdown, note, created_by) VALUES (?, ?, ?, ?, ?)'
      )
      .run(input.projectId, nextVersionNumber, input.contentMarkdown, input.note ?? null, input.createdBy)

    const versionId = Number(result.lastInsertRowid)

    db.prepare(
      `UPDATE projects SET current_context_version_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(versionId, input.projectId)

    logEvent(db, {
      projectId: input.projectId,
      type: 'CONTEXT_VERSION_CREATED',
      payload: { versionId, versionNumber: nextVersionNumber, createdBy: input.createdBy }
    })

    return versionId
  })()

  return getContextVersionForProject(db, input.projectId, newVersionId)
}
