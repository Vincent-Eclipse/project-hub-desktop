import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createTestDb } from '../testUtils/testDb'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, MigrationIntegrityError, runMigrations } from '../db/migrations'
import { archiveProject, createProject, ProjectArchivedError, ProjectNotFoundError } from './projectsService'
import { createContextVersion, getCurrentContextVersion } from './contextService'
import { createRuleVersion, getCurrentProjectRules } from './rulesService'
import { listEventLog } from './eventLogService'
import { InvalidRelevantFileError } from './taskRelevantFiles'
import {
  createTask,
  getTaskForProject,
  InvalidTaskDependencyError,
  InvalidTaskError,
  listTasksForProject,
  TaskMismatchError,
  TaskNotFoundError,
  updateTaskDependencies,
  updateTaskDetails,
  updateTaskStatus
} from './taskService'

let db: ReturnType<typeof createTestDb>
let projectId: number
beforeEach(() => {
  db = createTestDb()
  projectId = createProject(db, { name: 'Tasks', projectType: 'Test', description: '' }).id
})
afterEach(() => db.close())

const input = (id: number, title = 'Implement feature') => ({ projectId: id, title, createdBy: 'LEON' as const })

describe('creating and reading Tasks', () => {
  it('creates a Task with defaults and exact Markdown/field preservation', () => {
    expect(listTasksForProject(db, projectId)).toEqual([])
    const task = createTask(db, {
      ...input(projectId),
      goalMarkdown: '  # Goal\r\n\n',
      descriptionMarkdown: 'Description text',
      acceptanceCriteriaMarkdown: '- criterion',
      verificationRequirementsMarkdown: '- run tests',
      relevantFiles: ['src/main/example.ts']
    })
    expect(task).toMatchObject({
      projectId,
      title: 'Implement feature',
      status: 'BACKLOG',
      priority: 'MEDIUM',
      goalMarkdown: '  # Goal\r\n\n',
      descriptionMarkdown: 'Description text',
      acceptanceCriteriaMarkdown: '- criterion',
      verificationRequirementsMarkdown: '- run tests',
      relevantFiles: ['src/main/example.ts'],
      blockedReason: '',
      dependsOnTaskIds: [],
      createdBy: 'LEON'
    })
    expect(task.createdAt).toMatch(/^\d{4}-/)
    expect(task.updatedAt).toBe(task.createdAt)
    expect(getTaskForProject(db, projectId, task.id)).toEqual(task)
    expect(listTasksForProject(db, projectId)).toEqual([task])
  })

  it('trims the title and accepts explicit status/priority', () => {
    const task = createTask(db, { ...input(projectId, '  Trimmed  '), status: 'READY', priority: 'HIGH' })
    expect(task.title).toBe('Trimmed')
    expect(task.status).toBe('READY')
    expect(task.priority).toBe('HIGH')
  })

  it('isolates Tasks per project', () => {
    const otherId = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(otherId, 'B'))
    expect(listTasksForProject(db, projectId)).toEqual([a])
    expect(listTasksForProject(db, otherId)).toEqual([b])
    expect(() => getTaskForProject(db, projectId, b.id)).toThrow(TaskMismatchError)
    expect(() => getTaskForProject(db, otherId, a.id)).toThrow(TaskMismatchError)
  })

  it('rejects missing projects and missing Tasks', () => {
    expect(() => listTasksForProject(db, 99999)).toThrow(ProjectNotFoundError)
    expect(() => createTask(db, input(99999))).toThrow(ProjectNotFoundError)
    expect(() => getTaskForProject(db, 99999, 1)).toThrow(ProjectNotFoundError)
    expect(() => getTaskForProject(db, projectId, 99999)).toThrow(TaskNotFoundError)
  })

  it('rejects creation and mutation for archived projects but keeps reads working', () => {
    const task = createTask(db, input(projectId))
    archiveProject(db, projectId)
    expect(() => createTask(db, input(projectId))).toThrow(ProjectArchivedError)
    expect(() => updateTaskDetails(db, { projectId, id: task.id, title: 'New title' })).toThrow(ProjectArchivedError)
    expect(() => updateTaskStatus(db, { projectId, id: task.id, status: 'READY' })).toThrow(ProjectArchivedError)
    expect(() => updateTaskDependencies(db, { projectId, id: task.id, dependsOnTaskIds: [] })).toThrow(
      ProjectArchivedError
    )
    expect(listTasksForProject(db, projectId)).toEqual([task])
    expect(getTaskForProject(db, projectId, task.id)).toEqual(task)
  })

  it('rejects an empty or overlong title', () => {
    expect(() => createTask(db, input(projectId, ''))).toThrow(InvalidTaskError)
    expect(() => createTask(db, input(projectId, '   '))).toThrow(InvalidTaskError)
    expect(() => createTask(db, input(projectId, 'x'.repeat(201)))).toThrow(InvalidTaskError)
    expect(createTask(db, input(projectId, 'x'.repeat(200)))).toBeTruthy()
  })

  it('rejects invalid priority, status and createdBy', () => {
    expect(() => createTask(db, { ...input(projectId), priority: 'URGENT' as never })).toThrow(InvalidTaskError)
    expect(() => createTask(db, { ...input(projectId), status: 'UNKNOWN' as never })).toThrow(InvalidTaskError)
    expect(() => createTask(db, { ...input(projectId), createdBy: 'ANONYMOUS' as never })).toThrow(InvalidTaskError)
  })

  it('rejects overlong Markdown fields', () => {
    expect(() => createTask(db, { ...input(projectId), goalMarkdown: 'x'.repeat(50_001) })).toThrow(InvalidTaskError)
    expect(createTask(db, { ...input(projectId), goalMarkdown: 'x'.repeat(50_000) })).toBeTruthy()
  })

  it('rejects unsafe relevant file paths without touching the filesystem', () => {
    expect(() => createTask(db, { ...input(projectId), relevantFiles: ['../secrets.env'] })).toThrow(
      InvalidRelevantFileError
    )
    expect(() => createTask(db, { ...input(projectId), relevantFiles: ['C:\\Windows\\System32'] })).toThrow(
      InvalidRelevantFileError
    )
    expect(() => createTask(db, { ...input(projectId), relevantFiles: ['/etc/passwd'] })).toThrow(
      InvalidRelevantFileError
    )
    expect(listTasksForProject(db, projectId)).toEqual([])
  })

  it('logs only identifiers and metadata on create, never Markdown or titles', () => {
    const task = createTask(db, { ...input(projectId, 'Secret title'), goalMarkdown: 'Secret goal' })
    const events = listEventLog(db, { projectId, type: 'TASK_CREATED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ taskId: task.id, status: 'BACKLOG', priority: 'MEDIUM', createdBy: 'LEON' })
    expect(JSON.stringify(events)).not.toContain('Secret title')
    expect(JSON.stringify(events)).not.toContain('Secret goal')
  })

  it('rolls back Task creation if audit logging fails', () => {
    db.exec("CREATE TRIGGER fail_task_event BEFORE INSERT ON event_log_entries WHEN NEW.type = 'TASK_CREATED' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    expect(() => createTask(db, input(projectId))).toThrow('test failure')
    expect(listTasksForProject(db, projectId)).toEqual([])
    db.exec('DROP TRIGGER fail_task_event')
    expect(createTask(db, input(projectId)).title).toBe('Implement feature')
  })
})

describe('updating Task details', () => {
  it('updates only provided fields, bumps updatedAt and logs changed field names', () => {
    const task = createTask(db, input(projectId))
    const updated = updateTaskDetails(db, { projectId, id: task.id, title: 'Renamed', priority: 'CRITICAL' })
    expect(updated.title).toBe('Renamed')
    expect(updated.priority).toBe('CRITICAL')
    expect(updated.descriptionMarkdown).toBe(task.descriptionMarkdown)
    expect(updated.updatedAt >= task.updatedAt).toBe(true)

    const events = listEventLog(db, { projectId, type: 'TASK_UPDATED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ taskId: task.id, changedFields: ['title', 'priority'] })
  })

  it('preserves exact Markdown including CRLF and trailing whitespace', () => {
    const task = createTask(db, input(projectId))
    const updated = updateTaskDetails(db, {
      projectId,
      id: task.id,
      descriptionMarkdown: '  Line one\r\nLine two  \n',
      relevantFiles: ['src\\main\\index.ts', 'README.md']
    })
    expect(updated.descriptionMarkdown).toBe('  Line one\r\nLine two  \n')
    expect(updated.relevantFiles).toEqual(['src/main/index.ts', 'README.md'])
  })

  it('rejects unknown Task ids', () => {
    expect(() => updateTaskDetails(db, { projectId, id: 99999, title: 'X' })).toThrow(TaskNotFoundError)
  })

  it('does not write or log anything when no fields are provided', () => {
    const task = createTask(db, input(projectId))
    const unchanged = updateTaskDetails(db, { projectId, id: task.id })
    expect(unchanged).toEqual(task)
    expect(listEventLog(db, { projectId, type: 'TASK_UPDATED' })).toEqual([])
  })

  it('rolls back an update if audit logging fails, leaving the Task unchanged', () => {
    const task = createTask(db, input(projectId))
    db.exec("CREATE TRIGGER fail_task_update_event BEFORE INSERT ON event_log_entries WHEN NEW.type = 'TASK_UPDATED' BEGIN SELECT RAISE(ABORT, 'update failure'); END")
    expect(() => updateTaskDetails(db, { projectId, id: task.id, title: 'Should not persist' })).toThrow(
      'update failure'
    )
    db.exec('DROP TRIGGER fail_task_update_event')
    expect(getTaskForProject(db, projectId, task.id).title).toBe(task.title)
  })

  // ChatGPT review fix 5 - resaving the exact same (normalized) values must
  // be a true no-op: no row rewrite, no updatedAt change, no TASK_UPDATED.
  it('does not rewrite the row or emit TASK_UPDATED when every supplied value equals the persisted value', () => {
    const task = createTask(db, {
      ...input(projectId),
      goalMarkdown: 'Goal',
      descriptionMarkdown: 'Description',
      acceptanceCriteriaMarkdown: 'Criteria',
      verificationRequirementsMarkdown: 'Verification',
      blockedReason: 'Reason',
      relevantFiles: ['src/main/index.ts']
    })
    const unchanged = updateTaskDetails(db, {
      projectId,
      id: task.id,
      title: task.title,
      priority: task.priority,
      goalMarkdown: task.goalMarkdown,
      descriptionMarkdown: task.descriptionMarkdown,
      acceptanceCriteriaMarkdown: task.acceptanceCriteriaMarkdown,
      verificationRequirementsMarkdown: task.verificationRequirementsMarkdown,
      blockedReason: task.blockedReason,
      relevantFiles: [...task.relevantFiles]
    })
    expect(unchanged).toEqual(task)
    expect(listEventLog(db, { projectId, type: 'TASK_UPDATED' })).toEqual([])
  })

  it('treats a submitted relevantFiles value as unchanged when it normalizes to the same array (backslash form)', () => {
    const task = createTask(db, { ...input(projectId), relevantFiles: ['src/main/index.ts'] })
    const unchanged = updateTaskDetails(db, { projectId, id: task.id, relevantFiles: ['src\\main\\index.ts'] })
    expect(unchanged).toEqual(task)
    expect(listEventLog(db, { projectId, type: 'TASK_UPDATED' })).toEqual([])
  })

  it('reports exactly one changed field in a partial save where only that field truly changed', () => {
    const task = createTask(db, { ...input(projectId), descriptionMarkdown: 'Original' })
    const updated = updateTaskDetails(db, {
      projectId,
      id: task.id,
      title: task.title, // resubmitted, unchanged
      descriptionMarkdown: 'Changed' // actually different
    })
    expect(updated.descriptionMarkdown).toBe('Changed')
    const events = listEventLog(db, { projectId, type: 'TASK_UPDATED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ taskId: task.id, changedFields: ['descriptionMarkdown'] })
  })
})

describe('updating Task status', () => {
  it('changes status, bumps updatedAt and logs old/new status', () => {
    const task = createTask(db, input(projectId))
    const updated = updateTaskStatus(db, { projectId, id: task.id, status: 'RUNNING' })
    expect(updated.status).toBe('RUNNING')
    const events = listEventLog(db, { projectId, type: 'TASK_STATUS_CHANGED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ taskId: task.id, oldStatus: 'BACKLOG', newStatus: 'RUNNING' })
  })

  it('is a no-op (no event, no updatedAt change) when the status is unchanged', () => {
    const task = createTask(db, input(projectId))
    const result = updateTaskStatus(db, { projectId, id: task.id, status: 'BACKLOG' })
    expect(result).toEqual(task)
    expect(listEventLog(db, { projectId, type: 'TASK_STATUS_CHANGED' })).toEqual([])
  })

  it('rejects an invalid status value', () => {
    const task = createTask(db, input(projectId))
    expect(() => updateTaskStatus(db, { projectId, id: task.id, status: 'DONE_ISH' as never })).toThrow(
      InvalidTaskError
    )
  })

  it('does not automatically change status based on dependencies', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id] })
    expect(getTaskForProject(db, projectId, a.id).status).toBe('BACKLOG')
    updateTaskStatus(db, { projectId, id: b.id, status: 'DONE' })
    expect(getTaskForProject(db, projectId, a.id).status).toBe('BACKLOG')
  })

  // ChatGPT review fix 5 - a status change must roll back atomically with
  // its audit event, exactly like detail and dependency updates already did.
  it('rolls back a status change if audit logging fails, leaving the persisted status unchanged', () => {
    const task = createTask(db, input(projectId))
    db.exec(
      "CREATE TRIGGER fail_task_status_event BEFORE INSERT ON event_log_entries WHEN NEW.type = 'TASK_STATUS_CHANGED' BEGIN SELECT RAISE(ABORT, 'status failure'); END"
    )
    expect(() => updateTaskStatus(db, { projectId, id: task.id, status: 'RUNNING' })).toThrow('status failure')
    db.exec('DROP TRIGGER fail_task_status_event')
    expect(getTaskForProject(db, projectId, task.id).status).toBe('BACKLOG')
    expect(getTaskForProject(db, projectId, task.id).updatedAt).toBe(task.updatedAt)
  })
})

describe('updating Task Dependencies', () => {
  it('accepts a valid same-project dependency and logs old/new dependency ids', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    const updated = updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id] })
    expect(updated.dependsOnTaskIds).toEqual([b.id])
    const events = listEventLog(db, { projectId, type: 'TASK_DEPENDENCIES_UPDATED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ taskId: a.id, oldDependencyIds: [], newDependencyIds: [b.id] })
  })

  it('replaces the full dependency set on repeated calls', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    const c = createTask(db, input(projectId, 'C'))
    updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id] })
    const updated = updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [c.id] })
    expect(updated.dependsOnTaskIds).toEqual([c.id])
  })

  it('deduplicates repeated ids in the input', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    const updated = updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id, b.id] })
    expect(updated.dependsOnTaskIds).toEqual([b.id])
  })

  it('rejects self-dependency', () => {
    const a = createTask(db, input(projectId, 'A'))
    expect(() => updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [a.id] })).toThrow(
      InvalidTaskDependencyError
    )
  })

  it('rejects a dependency on a Task from another project', () => {
    const otherId = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const a = createTask(db, input(projectId, 'A'))
    const foreign = createTask(db, input(otherId, 'Foreign'))
    expect(() => updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [foreign.id] })).toThrow(
      InvalidTaskDependencyError
    )
  })

  it('rejects a dependency on a Task that does not exist', () => {
    const a = createTask(db, input(projectId, 'A'))
    expect(() => updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [99999] })).toThrow(
      InvalidTaskDependencyError
    )
  })

  it('rejects a direct two-cycle', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id] })
    expect(() => updateTaskDependencies(db, { projectId, id: b.id, dependsOnTaskIds: [a.id] })).toThrow(
      InvalidTaskDependencyError
    )
  })

  it('rejects a longer indirect cycle (A->B->C->A)', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    const c = createTask(db, input(projectId, 'C'))
    updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id] })
    updateTaskDependencies(db, { projectId, id: b.id, dependsOnTaskIds: [c.id] })
    expect(() => updateTaskDependencies(db, { projectId, id: c.id, dependsOnTaskIds: [a.id] })).toThrow(
      InvalidTaskDependencyError
    )
    // The valid chain itself must remain intact after the rejected attempt.
    expect(getTaskForProject(db, projectId, c.id).dependsOnTaskIds).toEqual([])
    expect(getTaskForProject(db, projectId, b.id).dependsOnTaskIds).toEqual([c.id])
  })

  it('allows diamond dependencies (not a cycle)', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    const c = createTask(db, input(projectId, 'C'))
    const d = createTask(db, input(projectId, 'D'))
    updateTaskDependencies(db, { projectId, id: b.id, dependsOnTaskIds: [a.id] })
    updateTaskDependencies(db, { projectId, id: c.id, dependsOnTaskIds: [a.id] })
    expect(() => updateTaskDependencies(db, { projectId, id: d.id, dependsOnTaskIds: [b.id, c.id] })).not.toThrow()
  })

  it('rejects more than the maximum number of dependencies', () => {
    const a = createTask(db, input(projectId, 'A'))
    const others = Array.from({ length: 51 }, (_, i) => createTask(db, input(projectId, `T${i}`)).id)
    expect(() => updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: others })).toThrow(
      InvalidTaskDependencyError
    )
  })

  it('rolls back a dependency update if audit logging fails', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    db.exec(
      "CREATE TRIGGER fail_task_dep_event BEFORE INSERT ON event_log_entries WHEN NEW.type = 'TASK_DEPENDENCIES_UPDATED' BEGIN SELECT RAISE(ABORT, 'dep failure'); END"
    )
    expect(() => updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id] })).toThrow('dep failure')
    db.exec('DROP TRIGGER fail_task_dep_event')
    expect(getTaskForProject(db, projectId, a.id).dependsOnTaskIds).toEqual([])
  })

  // ChatGPT review fix 5 - rollback must also work when there is a
  // NON-EMPTY existing dependency set being replaced (not just the
  // empty-to-nonempty case above).
  it('rolls back a dependency REPLACEMENT if audit logging fails, leaving the original dependency intact', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    const c = createTask(db, input(projectId, 'C'))
    updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id] })
    expect(getTaskForProject(db, projectId, a.id).dependsOnTaskIds).toEqual([b.id])

    db.exec(
      "CREATE TRIGGER fail_task_dep_replace_event BEFORE INSERT ON event_log_entries WHEN NEW.type = 'TASK_DEPENDENCIES_UPDATED' BEGIN SELECT RAISE(ABORT, 'dep replace failure'); END"
    )
    expect(() => updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [c.id] })).toThrow(
      'dep replace failure'
    )
    db.exec('DROP TRIGGER fail_task_dep_replace_event')
    expect(getTaskForProject(db, projectId, a.id).dependsOnTaskIds).toEqual([b.id])
  })

  // ChatGPT review fix 5 - dependencies are a SET: an equivalent submission
  // (same ids, reordered, or with duplicates) must be a true no-op.
  it('treats a resubmission of the same dependency set (identical order) as a no-op', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    const c = createTask(db, input(projectId, 'C'))
    const first = updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id, c.id] })
    const before = getTaskForProject(db, projectId, a.id)
    const result = updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id, c.id] })
    expect(result).toEqual(first)
    expect(result.updatedAt).toBe(before.updatedAt)
    expect(listEventLog(db, { projectId, type: 'TASK_DEPENDENCIES_UPDATED' })).toHaveLength(1)
  })

  it('treats a resubmission with reordered ids as a no-op', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    const c = createTask(db, input(projectId, 'C'))
    updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id, c.id] })
    const before = getTaskForProject(db, projectId, a.id)
    const result = updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [c.id, b.id] })
    expect(result.dependsOnTaskIds).toEqual([b.id, c.id].sort((x, y) => x - y))
    expect(result.updatedAt).toBe(before.updatedAt)
    expect(listEventLog(db, { projectId, type: 'TASK_DEPENDENCIES_UPDATED' })).toHaveLength(1)
  })

  it('treats a resubmission with duplicate ids resolving to the same effective set as a no-op', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id] })
    const before = getTaskForProject(db, projectId, a.id)
    const result = updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id, b.id, b.id] })
    expect(result.dependsOnTaskIds).toEqual([b.id])
    expect(result.updatedAt).toBe(before.updatedAt)
    expect(listEventLog(db, { projectId, type: 'TASK_DEPENDENCIES_UPDATED' })).toHaveLength(1)
  })

  it('does not touch task_dependencies rows (created_at) when a resubmission is a no-op', () => {
    const a = createTask(db, input(projectId, 'A'))
    const b = createTask(db, input(projectId, 'B'))
    updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id] })
    const before = db
      .prepare('SELECT created_at FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?')
      .get(a.id, b.id) as { created_at: string }
    updateTaskDependencies(db, { projectId, id: a.id, dependsOnTaskIds: [b.id] })
    const after = db
      .prepare('SELECT created_at FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?')
      .get(a.id, b.id) as { created_at: string }
    expect(after).toEqual(before)
  })
})

// ===========================================================================
// ChatGPT review fix 1 - all Task mutations must be project-scoped, exactly
// like the existing project-scoped reads (list/get). A caller that only
// knows a Task ID belonging to a DIFFERENT project must never be able to
// mutate it just because that Task happens to exist somewhere.
// ===========================================================================
describe('project-scoped Task mutations (cross-project rejection)', () => {
  it('rejects updateTaskDetails for project A + a Task that belongs to project B', () => {
    const projectA = projectId
    const projectB = createProject(db, { name: 'B', projectType: 'Test', description: '' }).id
    const taskInB = createTask(db, input(projectB, 'Owned by B'))
    expect(() => updateTaskDetails(db, { projectId: projectA, id: taskInB.id, title: 'Hijacked' })).toThrow(
      TaskMismatchError
    )
  })

  it('rejects updateTaskStatus for project A + a Task that belongs to project B', () => {
    const projectA = projectId
    const projectB = createProject(db, { name: 'B', projectType: 'Test', description: '' }).id
    const taskInB = createTask(db, input(projectB, 'Owned by B'))
    expect(() => updateTaskStatus(db, { projectId: projectA, id: taskInB.id, status: 'DONE' })).toThrow(
      TaskMismatchError
    )
  })

  it('rejects updateTaskDependencies for project A + a Task that belongs to project B', () => {
    const projectA = projectId
    const projectB = createProject(db, { name: 'B', projectType: 'Test', description: '' }).id
    const taskInB = createTask(db, input(projectB, 'Owned by B'))
    const otherTaskInB = createTask(db, input(projectB, 'Other in B'))
    expect(() =>
      updateTaskDependencies(db, { projectId: projectA, id: taskInB.id, dependsOnTaskIds: [otherTaskInB.id] })
    ).toThrow(TaskMismatchError)
  })

  it('leaves the foreign Task completely unchanged after every rejected cross-project write attempt', () => {
    const projectA = projectId
    const projectB = createProject(db, { name: 'B', projectType: 'Test', description: '' }).id
    const before = createTask(db, {
      ...input(projectB, 'Owned by B'),
      descriptionMarkdown: 'Original description',
      priority: 'LOW'
    })

    expect(() => updateTaskDetails(db, { projectId: projectA, id: before.id, title: 'Hijacked' })).toThrow(
      TaskMismatchError
    )
    expect(() => updateTaskStatus(db, { projectId: projectA, id: before.id, status: 'DONE' })).toThrow(
      TaskMismatchError
    )
    expect(() => updateTaskDependencies(db, { projectId: projectA, id: before.id, dependsOnTaskIds: [] })).toThrow(
      TaskMismatchError
    )

    const after = getTaskForProject(db, projectB, before.id)
    expect(after).toEqual(before)
  })

  it('writes no audit event to either project for a rejected cross-project write attempt', () => {
    const projectA = projectId
    const projectB = createProject(db, { name: 'B', projectType: 'Test', description: '' }).id
    const taskInB = createTask(db, input(projectB, 'Owned by B'))

    expect(() => updateTaskDetails(db, { projectId: projectA, id: taskInB.id, title: 'Hijacked' })).toThrow(
      TaskMismatchError
    )
    expect(() => updateTaskStatus(db, { projectId: projectA, id: taskInB.id, status: 'DONE' })).toThrow(
      TaskMismatchError
    )
    expect(() =>
      updateTaskDependencies(db, { projectId: projectA, id: taskInB.id, dependsOnTaskIds: [] })
    ).toThrow(TaskMismatchError)

    expect(listEventLog(db, { projectId: projectA, type: 'TASK_UPDATED' })).toEqual([])
    expect(listEventLog(db, { projectId: projectA, type: 'TASK_STATUS_CHANGED' })).toEqual([])
    expect(listEventLog(db, { projectId: projectA, type: 'TASK_DEPENDENCIES_UPDATED' })).toEqual([])
    // Only the TASK_CREATED event from setting up the fixture may exist for project B.
    expect(listEventLog(db, { projectId: projectB, type: 'TASK_UPDATED' })).toEqual([])
    expect(listEventLog(db, { projectId: projectB, type: 'TASK_STATUS_CHANGED' })).toEqual([])
    expect(listEventLog(db, { projectId: projectB, type: 'TASK_DEPENDENCIES_UPDATED' })).toEqual([])
  })

  it('still allows valid same-project mutations after a cross-project attempt was rejected', () => {
    const projectA = projectId
    const projectB = createProject(db, { name: 'B', projectType: 'Test', description: '' }).id
    const taskInA = createTask(db, input(projectA, 'Owned by A'))
    const taskInB = createTask(db, input(projectB, 'Owned by B'))

    expect(() => updateTaskDetails(db, { projectId: projectA, id: taskInB.id, title: 'Hijacked' })).toThrow(
      TaskMismatchError
    )

    const updated = updateTaskDetails(db, { projectId: projectA, id: taskInA.id, title: 'Legitimate rename' })
    expect(updated.title).toBe('Legitimate rename')
    const statusUpdated = updateTaskStatus(db, { projectId: projectA, id: taskInA.id, status: 'READY' })
    expect(statusUpdated.status).toBe('READY')
    const depsUpdated = updateTaskDependencies(db, { projectId: projectB, id: taskInB.id, dependsOnTaskIds: [] })
    expect(depsUpdated.dependsOnTaskIds).toEqual([])
  })

  it('keeps archived-project rejection behavior unchanged for correctly-scoped mutations', () => {
    const task = createTask(db, input(projectId))
    archiveProject(db, projectId)
    expect(() => updateTaskDetails(db, { projectId, id: task.id, title: 'X' })).toThrow(ProjectArchivedError)
    expect(() => updateTaskStatus(db, { projectId, id: task.id, status: 'READY' })).toThrow(ProjectArchivedError)
    expect(() => updateTaskDependencies(db, { projectId, id: task.id, dependsOnTaskIds: [] })).toThrow(
      ProjectArchivedError
    )
  })

  it('keeps unknown-Task behavior controlled regardless of which projectId is supplied', () => {
    expect(() => updateTaskDetails(db, { projectId, id: 99999, title: 'X' })).toThrow(TaskNotFoundError)
    expect(() => updateTaskStatus(db, { projectId, id: 99999, status: 'READY' })).toThrow(TaskNotFoundError)
    expect(() => updateTaskDependencies(db, { projectId, id: 99999, dependsOnTaskIds: [] })).toThrow(TaskNotFoundError)
    expect(() => updateTaskDetails(db, { projectId: 99999, id: 99999, title: 'X' })).toThrow(TaskNotFoundError)
  })
})

describe('Migration 005 upgrade and integrity', () => {
  // Strengthened per Codex re-review: the previous version of this test
  // never actually created any Context/Rules content before applying
  // Migration 005, so it could not meaningfully prove that upgrading
  // preserves existing M4.1 data - it only proved the upgrade doesn't
  // crash. This version creates REAL, representative Context and Rules
  // content on the pre-Migration-5 schema, applies only the pending
  // Migration 005, and then asserts the exact same content (including exact
  // Markdown, version numbers, note and author) is still readable
  // afterwards - proving Migration 005 does not touch, rewrite or lose any
  // pre-existing project_context_versions/project_rule_versions data.
  it('upgrades the actual 001-004 schema while leaving existing Context and Rules content byte-for-byte intact', () => {
    const old = openDatabase(':memory:')
    try {
      old.exec('CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL)')
      for (const migration of MIGRATIONS.filter((m) => m.version < 5)) {
        old.exec(migration.sql)
        old
          .prepare('INSERT INTO _migrations VALUES (?, ?, ?)')
          .run(migration.version, migration.name, createHash('sha256').update(migration.sql).digest('hex'))
      }

      const p = createProject(old, { name: 'Existing', projectType: 'Test', description: '' })
      const context = createContextVersion(old, {
        projectId: p.id,
        contentMarkdown: '  # Current State\r\nExisting M4.1 context\n',
        note: 'Pre-upgrade note',
        createdBy: 'LEON'
      })
      const rules = createRuleVersion(old, {
        projectId: p.id,
        contentMarkdown: '# Security\nKeep verification required.',
        note: 'Pre-upgrade rules',
        createdBy: 'CHATGPT'
      })

      // This database has only migrations 1-4 recorded as applied, so the
      // next run also pulls in the now-existing Migration 6 (Work Requests,
      // Meilenstein 4.3) and Migration 7 (Apply Batches, Meilenstein 4.8B.2B)
      // alongside Migration 5.
      expect(runMigrations(old).applied).toEqual([5, 6, 7])

      // Existing Context/Rules content must be exactly unchanged after the
      // Migration 005 upgrade - same id, version number, Markdown (including
      // CRLF), note and author.
      expect(getCurrentContextVersion(old, p.id)).toEqual(context)
      expect(getCurrentProjectRules(old, p.id)).toEqual(rules)

      expect(listTasksForProject(old, p.id)).toEqual([])
      const task = createTask(old, { projectId: p.id, title: 'Post-upgrade Task', createdBy: 'LEON' })
      expect(task.title).toBe('Post-upgrade Task')

      // Creating a Task after the upgrade must not have touched Context/Rules either.
      expect(getCurrentContextVersion(old, p.id)).toEqual(context)
      expect(getCurrentProjectRules(old, p.id)).toEqual(rules)

      expect(runMigrations(old).applied).toEqual([])
      old.prepare("UPDATE _migrations SET checksum = 'tampered' WHERE version = 5").run()
      expect(() => runMigrations(old)).toThrow(MigrationIntegrityError)
    } finally {
      old.close()
    }
  })
})
