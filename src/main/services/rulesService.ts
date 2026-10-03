import type Database from 'better-sqlite3'
import { ACTORS, RULES_MARKDOWN_MAX_LENGTH, type CreateRuleVersionInput, type DiffLine, type ProjectRuleVersion } from '@shared/types'
import { getProjectById, ProjectArchivedError } from './projectsService'
import { logEvent } from './eventLogService'
import { diffLines } from '../utils/diff'

interface RuleVersionRow {
  id: number
  project_id: number
  version_number: number
  content_markdown: string
  note: string | null
  created_by: ProjectRuleVersion['createdBy']
  created_at: string
}

function mapRow(row: RuleVersionRow): ProjectRuleVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    contentMarkdown: row.content_markdown,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at
  }
}

export class RuleVersionNotFoundError extends Error {
  constructor(id: number) {
    super(`Regel-Version mit ID ${id} wurde nicht gefunden.`)
    this.name = 'RuleVersionNotFoundError'
  }
}

export class RuleVersionMismatchError extends Error {
  constructor(versionId: number, projectId: number) {
    super(`Regel-Version ${versionId} gehoert nicht zu Projekt ${projectId}.`)
    this.name = 'RuleVersionMismatchError'
  }
}

export class InvalidRuleVersionError extends Error {
  constructor() {
    super('Ungueltige Regel-Version: Markdown darf maximal 50000 Zeichen, die Notiz maximal 500 Zeichen enthalten; ein gueltiger Ersteller ist erforderlich.')
    this.name = 'InvalidRuleVersionError'
  }
}

export class RulesDiffTooLargeError extends Error {
  constructor() {
    super('Diese Regel-Versionen enthalten zu viele Zeilen fuer einen Diff. Bitte die Versionen einzeln ansehen.')
    this.name = 'RulesDiffTooLargeError'
  }
}

export function listRuleVersions(db: Database.Database, projectId: number): ProjectRuleVersion[] {
  getProjectById(db, projectId)
  const rows = db.prepare(
    'SELECT * FROM project_rule_versions WHERE project_id = ? ORDER BY version_number DESC'
  ).all(projectId) as RuleVersionRow[]
  return rows.map(mapRow)
}

export function getRuleVersionForProject(db: Database.Database, projectId: number, versionId: number): ProjectRuleVersion {
  getProjectById(db, projectId)
  const row = db.prepare('SELECT * FROM project_rule_versions WHERE id = ?').get(versionId) as RuleVersionRow | undefined
  if (!row) throw new RuleVersionNotFoundError(versionId)
  if (row.project_id !== projectId) throw new RuleVersionMismatchError(versionId, projectId)
  return mapRow(row)
}

export function getCurrentProjectRules(db: Database.Database, projectId: number): ProjectRuleVersion | null {
  getProjectById(db, projectId)
  const row = db.prepare(
    'SELECT * FROM project_rule_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1'
  ).get(projectId) as RuleVersionRow | undefined
  return row ? mapRow(row) : null
}

export function getRulesDiffForProject(
  db: Database.Database, projectId: number, fromVersionId: number, toVersionId: number
): DiffLine[] {
  const from = getRuleVersionForProject(db, projectId, fromVersionId)
  const to = getRuleVersionForProject(db, projectId, toVersionId)
  // The shared LCS diff allocates a matrix; a character limit alone does
  // not bound its memory use for Markdown containing many short lines.
  const fromLines = from.contentMarkdown.split(/\r\n|\r|\n/).length + 1
  const toLines = to.contentMarkdown.split(/\r\n|\r|\n/).length + 1
  if (fromLines * toLines > 4_000_000) throw new RulesDiffTooLargeError()
  return diffLines(from.contentMarkdown, to.contentMarkdown)
}

export function createRuleVersion(db: Database.Database, input: CreateRuleVersionInput): ProjectRuleVersion {
  if (
    typeof input.contentMarkdown !== 'string' || input.contentMarkdown.length > RULES_MARKDOWN_MAX_LENGTH ||
    (input.note != null && (typeof input.note !== 'string' || input.note.length > 500)) ||
    !ACTORS.includes(input.createdBy)
  ) throw new InvalidRuleVersionError()

  return db.transaction(() => {
    const project = getProjectById(db, input.projectId)
    if (project.isArchived) throw new ProjectArchivedError(input.projectId)
    const row = db.prepare(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS nextVersion FROM project_rule_versions WHERE project_id = ?'
    ).get(input.projectId) as { nextVersion: number }
    const result = db.prepare(
      'INSERT INTO project_rule_versions (project_id, version_number, content_markdown, note, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(input.projectId, row.nextVersion, input.contentMarkdown, input.note ?? null, input.createdBy)
    const versionId = Number(result.lastInsertRowid)
    logEvent(db, {
      projectId: input.projectId,
      type: 'PROJECT_RULES_VERSION_CREATED',
      payload: { versionId, versionNumber: row.nextVersion, createdBy: input.createdBy }
    })
    return getRuleVersionForProject(db, input.projectId, versionId)
  }).immediate()
}
