import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createTestDb } from '../testUtils/testDb'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, MigrationIntegrityError, runMigrations } from '../db/migrations'
import { archiveProject, createProject, getProjectById, ProjectArchivedError, ProjectNotFoundError } from './projectsService'
import { createContextVersion, getCurrentContextVersion } from './contextService'
import { listEventLog } from './eventLogService'
import { createRuleVersion, getCurrentProjectRules, getRulesDiffForProject, getRuleVersionForProject,
  InvalidRuleVersionError, listRuleVersions, RuleVersionMismatchError, RuleVersionNotFoundError, RulesDiffTooLargeError } from './rulesService'

let db: ReturnType<typeof createTestDb>
let projectId: number
beforeEach(() => {
  db = createTestDb()
  projectId = createProject(db, { name: 'Rules', projectType: 'Test', description: '' }).id
})
afterEach(() => db.close())
const input = (id: number, contentMarkdown = '# Security\nKeep verification required.') => ({ projectId: id, contentMarkdown, createdBy: 'LEON' as const })

describe('Project Rules versions', () => {
  it('starts empty and creates version 1 with exact Markdown, author and note', () => {
    expect(getCurrentProjectRules(db, projectId)).toBeNull()
    expect(listRuleVersions(db, projectId)).toEqual([])
    const version = createRuleVersion(db, { ...input(projectId, '  # Rules\r\n\n'), note: 'Initial' })
    expect(version).toMatchObject({ projectId, versionNumber: 1, contentMarkdown: '  # Rules\r\n\n', createdBy: 'LEON', note: 'Initial' })
    expect(version.createdAt).toMatch(/^\d{4}-/)
    expect(getCurrentProjectRules(db, projectId)).toEqual(version)
  })

  it('progresses sequentially, preserves history and permits duplicate content', () => {
    const first = createRuleVersion(db, input(projectId))
    const second = createRuleVersion(db, input(projectId))
    const third = createRuleVersion(db, input(projectId, 'Next'))
    expect([first.versionNumber, second.versionNumber, third.versionNumber]).toEqual([1, 2, 3])
    expect(listRuleVersions(db, projectId)).toEqual([third, second, first])
    expect(getRuleVersionForProject(db, projectId, first.id)).toEqual(first)
    expect(getCurrentProjectRules(db, projectId)).toEqual(third)
  })

  it('rejects SQL updates and direct deletes but preserves project cascade semantics', () => {
    const version = createRuleVersion(db, input(projectId))
    expect(() => db.prepare('UPDATE project_rule_versions SET content_markdown = ? WHERE id = ?').run('changed', version.id)).toThrow('immutable')
    expect(() => db.prepare('DELETE FROM project_rule_versions WHERE id = ?').run(version.id)).toThrow('append-only')
    expect(getRuleVersionForProject(db, projectId, version.id)).toEqual(version)
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    expect(db.prepare('SELECT * FROM project_rule_versions').all()).toEqual([])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('enforces project FK, positive versions and unique project/version pairs', () => {
    createRuleVersion(db, input(projectId))
    const insert = db.prepare("INSERT INTO project_rule_versions (project_id, version_number, content_markdown, created_by) VALUES (?, ?, '', 'LEON')")
    expect(() => insert.run(99999, 1)).toThrow()
    expect(() => insert.run(projectId, 0)).toThrow()
    expect(() => insert.run(projectId, 1)).toThrow()
  })

  it('isolates project reads and both sides of diffs', () => {
    const otherId = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const a = createRuleVersion(db, input(projectId, 'A'))
    const b = createRuleVersion(db, input(otherId, 'B'))
    expect(b.versionNumber).toBe(1)
    expect(listRuleVersions(db, projectId)).toEqual([a])
    expect(getCurrentProjectRules(db, otherId)).toEqual(b)
    expect(() => getRuleVersionForProject(db, projectId, b.id)).toThrow(RuleVersionMismatchError)
    expect(() => getRulesDiffForProject(db, projectId, a.id, b.id)).toThrow(RuleVersionMismatchError)
    expect(() => getRulesDiffForProject(db, projectId, b.id, a.id)).toThrow(RuleVersionMismatchError)
  })

  it('rejects missing projects and missing versions', () => {
    expect(() => listRuleVersions(db, 99999)).toThrow(ProjectNotFoundError)
    expect(() => getCurrentProjectRules(db, 99999)).toThrow(ProjectNotFoundError)
    expect(() => createRuleVersion(db, input(99999))).toThrow(ProjectNotFoundError)
    expect(() => getRuleVersionForProject(db, 99999, 1)).toThrow(ProjectNotFoundError)
    expect(() => getRuleVersionForProject(db, projectId, 99999)).toThrow(RuleVersionNotFoundError)
  })

  it('keeps archived history and diff readable, but rejects creation', () => {
    const v = createRuleVersion(db, input(projectId))
    archiveProject(db, projectId)
    expect(listRuleVersions(db, projectId)).toEqual([v])
    expect(getCurrentProjectRules(db, projectId)).toEqual(v)
    expect(getRulesDiffForProject(db, projectId, v.id, v.id).every((line) => line.type === 'unchanged')).toBe(true)
    expect(() => createRuleVersion(db, input(projectId))).toThrow(ProjectArchivedError)
  })

  it('accepts 50000 characters and rejects larger content before writing', () => {
    createRuleVersion(db, input(projectId, 'x'.repeat(50_000)))
    expect(() => createRuleVersion(db, input(projectId, 'x'.repeat(50_001)))).toThrow(InvalidRuleVersionError)
    expect(() => createRuleVersion(db, input(projectId, '😀'.repeat(25_001)))).toThrow(InvalidRuleVersionError)
    expect(listRuleVersions(db, projectId)).toHaveLength(1)
  })

  it('logs only identifiers and author metadata, never Markdown or free-text notes', () => {
    const v = createRuleVersion(db, { ...input(projectId), note: 'Private note' })
    const events = listEventLog(db, { projectId, type: 'PROJECT_RULES_VERSION_CREATED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ versionId: v.id, versionNumber: 1, createdBy: 'LEON' })
    expect(JSON.stringify(events)).not.toContain(v.contentMarkdown)
    expect(JSON.stringify(events)).not.toContain('Private note')
  })

  it.each(['\n', '\r'])('bounds diff allocation for valid Markdown with many short lines (%j)', (newline) => {
    const a = createRuleVersion(db, input(projectId, newline.repeat(49_999)))
    const b = createRuleVersion(db, input(projectId, newline.repeat(49_998)))
    expect(() => getRulesDiffForProject(db, projectId, a.id, b.id)).toThrow(RulesDiffTooLargeError)
    expect(getRuleVersionForProject(db, projectId, a.id)).toEqual(a)
  })

  it('rolls back version creation if audit logging fails', () => {
    db.exec("CREATE TRIGGER fail_rules_event BEFORE INSERT ON event_log_entries WHEN NEW.type = 'PROJECT_RULES_VERSION_CREATED' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    expect(() => createRuleVersion(db, input(projectId))).toThrow('test failure')
    expect(listRuleVersions(db, projectId)).toEqual([])
    db.exec('DROP TRIGGER fail_rules_event')
    expect(createRuleVersion(db, input(projectId)).versionNumber).toBe(1)
  })

  it('diffs additions and removals without changing current rules or context', () => {
    const context = createContextVersion(db, input(projectId, 'Curated state'))
    const before = getProjectById(db, projectId)
    const a = createRuleVersion(db, input(projectId, 'Keep\nOld'))
    const b = createRuleVersion(db, input(projectId, 'Keep\nNew'))
    const diff = getRulesDiffForProject(db, projectId, a.id, b.id)
    expect(diff).toContainEqual({ type: 'removed', text: 'Old', oldLineNumber: 2, newLineNumber: null })
    expect(diff).toContainEqual({ type: 'added', text: 'New', oldLineNumber: null, newLineNumber: 2 })
    expect(getCurrentProjectRules(db, projectId)).toEqual(b)
    expect(getCurrentContextVersion(db, projectId)).toEqual(context)
    expect(getProjectById(db, projectId)).toEqual(before)
  })
})

describe('Migration 004 upgrade and integrity', () => {
  it('upgrades the actual 001–003 schema without rewriting existing Context', () => {
    const old = openDatabase(':memory:')
    try {
      old.exec('CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL)')
      for (const migration of MIGRATIONS.filter((m) => m.version < 4)) {
        old.exec(migration.sql)
        old.prepare('INSERT INTO _migrations VALUES (?, ?, ?)').run(migration.version, migration.name, createHash('sha256').update(migration.sql).digest('hex'))
      }
      const p = createProject(old, { name: 'Existing', projectType: 'Test', description: '' })
      const context = createContextVersion(old, input(p.id, '  Existing\r\nMarkdown'))
      // Diese Datenbank hat nur Migrationen 1-3 als angewendet vermerkt - der
      // naechste Lauf zieht daher Migration 4 (Rules) sowie die inzwischen
      // hinzugekommenen Migrationen 5 (Tasks, Meilenstein 4.2), 6 (Work
      // Requests, Meilenstein 4.3) und 7 (Apply Batches, Meilenstein 4.8B.2B) nach.
      expect(runMigrations(old).applied).toEqual([4, 5, 6, 7])
      expect(getCurrentContextVersion(old, p.id)).toEqual(context)
      expect(getCurrentProjectRules(old, p.id)).toBeNull()
      expect(runMigrations(old).applied).toEqual([])
      old.prepare("UPDATE _migrations SET checksum = 'tampered' WHERE version = 4").run()
      expect(() => runMigrations(old)).toThrow(MigrationIntegrityError)
    } finally { old.close() }
  })
})
