import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { RunPolicySnapshot, RunTrustedScope } from './runService'
import { createTestDb } from '../testUtils/testDb'
import { archiveProject, createProject, getProjectById, updateProject } from './projectsService'
import { createTask, getTaskForProject } from './taskService'
import { createWorkRequest, getWorkRequestForProject } from './workRequestService'
import { getOperationDefinition } from './runOperations'
import {
  InvalidRunRequestError,
  InvalidRunTrustedScopeError,
  runOperation,
  validateRunPolicySnapshot,
  validateRunRequest,
  validateRunTrustedScope
} from './runService'

let db: Database.Database
let temporary: string

function tempFolder(): string {
  const dir = fs.mkdtempSync(path.join(temporary, 'folder-'))
  return fs.realpathSync(dir)
}

beforeEach(() => {
  db = createTestDb()
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-run-service-test-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  db.close()
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

// Defaults to a real (empty, non-repository) temp folder so
// repository.getDiagnostics can actually run end-to-end (getDiagnostics(null)
// throws GIT_PATH_MISSING - a Run needs a resolvable folder to observe
// "no repository detected" as a successful outcome).
function project(overrides: Partial<Parameters<typeof createProject>[1]> = {}) {
  return createProject(db, { name: 'P', projectType: 'Test', description: '', folderPath: tempFolder(), ...overrides })
}

function diagnosticsRequest(projectId: number, taskId?: number): Record<string, unknown> {
  return taskId === undefined
    ? { projectId, operation: { id: 'repository.getDiagnostics', input: {} } }
    : { projectId, taskId, operation: { id: 'repository.getDiagnostics', input: {} } }
}

// The Run caller supplies ONLY what Main cannot derive itself - projectId,
// isArchived and supportedCapabilities all come from the resolved DB
// project / fixed runtime support instead (see runService.ts).
function allowPolicy(overrides: Partial<RunPolicySnapshot> = {}): RunPolicySnapshot {
  return { policy: { 'git.read': 'ALLOW' }, ruleDeniedCapabilities: [], ...overrides }
}

function readTextFilesRequest(projectId: number, relativePaths: string[], taskId?: number): Record<string, unknown> {
  const operation = { id: 'project.readTextFiles', input: { relativePaths } }
  return taskId === undefined ? { projectId, operation } : { projectId, taskId, operation }
}

function readPolicy(overrides: Partial<RunPolicySnapshot> = {}): RunPolicySnapshot {
  return { policy: { 'filesystem.read': 'ALLOW' }, ruleDeniedCapabilities: [], ...overrides }
}

function readScope(allowedRelativePaths: string[]): RunTrustedScope {
  return { operationId: 'project.readTextFiles', allowedRelativePaths }
}

describe('validateRunRequest', () => {
  it('accepts a valid repository.getDiagnostics request', () => {
    expect(validateRunRequest(diagnosticsRequest(1))).toEqual({
      projectId: 1,
      operation: { id: 'repository.getDiagnostics', input: {} }
    })
  })

  it('accepts an optional valid taskId', () => {
    expect(validateRunRequest(diagnosticsRequest(1, 2))).toEqual({
      projectId: 1,
      taskId: 2,
      operation: { id: 'repository.getDiagnostics', input: {} }
    })
  })

  it('rejects an unknown operation id', () => {
    expect(() =>
      validateRunRequest({ projectId: 1, operation: { id: 'repository.getDiff', input: {} } })
    ).toThrow(InvalidRunRequestError)
  })

  it('rejects prototype-chain operation ids (constructor/__proto__) exactly like any other unknown id', () => {
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(() => validateRunRequest({ projectId: 1, operation: { id, input: {} } })).toThrow(InvalidRunRequestError)
    }
  })

  it('rejects a missing projectId', () => {
    expect(() => validateRunRequest({ operation: { id: 'repository.getDiagnostics', input: {} } })).toThrow(
      InvalidRunRequestError
    )
  })

  it('rejects an invalid projectId', () => {
    for (const projectId of [0, -1, 1.5, '1', null]) {
      expect(() => validateRunRequest(diagnosticsRequest(projectId as never))).toThrow(InvalidRunRequestError)
    }
  })

  it('rejects an invalid taskId', () => {
    for (const taskId of [0, -1, 1.5, '2']) {
      expect(() => validateRunRequest(diagnosticsRequest(1, taskId as never))).toThrow(InvalidRunRequestError)
    }
  })

  it('rejects an extra top-level field', () => {
    expect(() => validateRunRequest({ ...diagnosticsRequest(1), notes: 'x' })).toThrow(InvalidRunRequestError)
  })

  it('rejects an extra operation field', () => {
    expect(() =>
      validateRunRequest({ projectId: 1, operation: { id: 'repository.getDiagnostics', input: {}, extra: 'x' } })
    ).toThrow(InvalidRunRequestError)
  })

  // The operation-specific validator (runOperations.ts) throws its own
  // InvalidOperationInputError internally, but validateRunRequest() is the
  // one outer boundary a caller sees - every malformed raw request, no
  // matter which inner validator actually rejected it, must surface as the
  // same InvalidRunRequestError.
  it('rejects a non-empty diagnostics input as InvalidRunRequestError', () => {
    expect(() =>
      validateRunRequest({ projectId: 1, operation: { id: 'repository.getDiagnostics', input: { path: 'x' } } })
    ).toThrow(InvalidRunRequestError)
  })

  it('rejects a missing diagnostics input as InvalidRunRequestError', () => {
    expect(() => validateRunRequest({ projectId: 1, operation: { id: 'repository.getDiagnostics' } })).toThrow(
      InvalidRunRequestError
    )
  })

  it('rejects a non-plain-object diagnostics input (array/class instance) as InvalidRunRequestError', () => {
    class Empty {}
    for (const input of [[], new Empty(), 'x', null]) {
      expect(() =>
        validateRunRequest({ projectId: 1, operation: { id: 'repository.getDiagnostics', input } })
      ).toThrow(InvalidRunRequestError)
    }
  })

  // Authority smuggling: none of these fields exist on RunRequest - a raw
  // object claiming them must be rejected outright, never silently ignored.
  it('rejects authority-smuggling fields at the top level', () => {
    for (const field of ['capabilities', 'requiredCapabilities', 'policy', 'supportedCapabilities', 'projectRoot', 'repositoryRoot', 'folder', 'approved', 'approval', 'permissions', 'provider', 'agent', 'model', 'autonomy']) {
      expect(() => validateRunRequest({ ...diagnosticsRequest(1), [field]: 'x' })).toThrow(InvalidRunRequestError)
    }
  })

  it('rejects authority-smuggling fields on the operation object', () => {
    for (const field of ['requiredCapabilities', 'handler', 'executable', 'command', 'arguments']) {
      expect(() =>
        validateRunRequest({ projectId: 1, operation: { id: 'repository.getDiagnostics', input: {}, [field]: 'x' } })
      ).toThrow(InvalidRunRequestError)
    }
  })
})

describe('validateRunPolicySnapshot', () => {
  it('accepts a valid snapshot', () => {
    expect(validateRunPolicySnapshot(allowPolicy())).toEqual(allowPolicy())
  })

  it('accepts an empty policy and empty ruleDeniedCapabilities', () => {
    expect(validateRunPolicySnapshot({ policy: {}, ruleDeniedCapabilities: [] })).toEqual({
      policy: {},
      ruleDeniedCapabilities: []
    })
  })

  // The whole point of RunPolicySnapshot is that the caller cannot supply
  // what Main derives itself.
  it('rejects projectId, isArchived and supportedCapabilities - the caller cannot supply or override technical support/identity', () => {
    for (const field of ['projectId', 'isArchived', 'supportedCapabilities']) {
      expect(() => validateRunPolicySnapshot({ ...allowPolicy(), [field]: 'x' })).toThrow(InvalidRunRequestError)
    }
  })

  it('rejects authority-smuggling fields', () => {
    for (const field of ['approved', 'capabilities', 'permissions', 'agent', 'provider', 'model', 'autonomy']) {
      expect(() => validateRunPolicySnapshot({ ...allowPolicy(), [field]: 'x' })).toThrow(InvalidRunRequestError)
    }
  })

  it('rejects an unknown policy key or invalid policy mode, consistent with M4.5', () => {
    expect(() => validateRunPolicySnapshot(allowPolicy({ policy: { 'network.access': 'ALLOW' } as never }))).toThrow(
      InvalidRunRequestError
    )
    expect(() => validateRunPolicySnapshot(allowPolicy({ policy: { 'git.read': 'MAYBE' } as never }))).toThrow(
      InvalidRunRequestError
    )
  })

  it('rejects an unknown or duplicate ruleDeniedCapabilities entry, consistent with M4.5', () => {
    expect(() => validateRunPolicySnapshot(allowPolicy({ ruleDeniedCapabilities: ['git.commit'] as never }))).toThrow(
      InvalidRunRequestError
    )
    expect(() => validateRunPolicySnapshot(allowPolicy({ ruleDeniedCapabilities: ['git.read', 'git.read'] }))).toThrow(
      InvalidRunRequestError
    )
  })
})

describe('runOperation - required capability derivation (git.read)', () => {
  it('always requires git.read even though the raw request never mentions any capability', async () => {
    const p = project()
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(outcome.capabilityEvaluations).toEqual([{ projectId: p.id, capability: 'git.read', decision: 'ALLOW', reason: 'POLICY_ALLOWED' }])
  })

  it('produces exactly one required capability evaluation', async () => {
    const p = project()
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(outcome.capabilityEvaluations).toHaveLength(1)
  })

  it('blocks before the handler runs when policy is missing entirely', async () => {
    const p = project()
    const definition = getOperationDefinition('repository.getDiagnostics')!
    const executeSpy = vi.spyOn(definition, 'execute')
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy({ policy: {} }))
    expect(outcome.status).toBe('BLOCKED')
    if (outcome.status === 'BLOCKED') expect(outcome.blockedReason).toBe('POLICY_UNSET')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('blocks on explicit DENY without invoking the handler', async () => {
    const p = project()
    const definition = getOperationDefinition('repository.getDiagnostics')!
    const executeSpy = vi.spyOn(definition, 'execute')
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy({ policy: { 'git.read': 'DENY' } }))
    expect(outcome.status).toBe('BLOCKED')
    if (outcome.status === 'BLOCKED') expect(outcome.blockedReason).toBe('POLICY_DENIED')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('blocks on REQUIRES_APPROVAL without invoking the handler - there is no approval workflow yet', async () => {
    const p = project()
    const definition = getOperationDefinition('repository.getDiagnostics')!
    const executeSpy = vi.spyOn(definition, 'execute')
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy({ policy: { 'git.read': 'REQUIRES_APPROVAL' } }))
    expect(outcome.status).toBe('BLOCKED')
    if (outcome.status === 'BLOCKED') expect(outcome.blockedReason).toBe('APPROVAL_REQUIRED')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('blocks on rule denial, even with an ALLOW policy', async () => {
    const p = project()
    const definition = getOperationDefinition('repository.getDiagnostics')!
    const executeSpy = vi.spyOn(definition, 'execute')
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy({ ruleDeniedCapabilities: ['git.read'] }))
    expect(outcome.status).toBe('BLOCKED')
    if (outcome.status === 'BLOCKED') expect(outcome.blockedReason).toBe('RULE_RESTRICTION')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('permits progression to the handler when git.read is ALLOW', async () => {
    const p = project()
    const definition = getOperationDefinition('repository.getDiagnostics')!
    const executeSpy = vi.spyOn(definition, 'execute')
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(outcome.status).toBe('SUCCEEDED')
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  // Technical support is now fixed internally to ['git.read'] - the caller
  // has no field through which to configure or override it (see
  // validateRunPolicySnapshot tests above). M4.5's own suite already covers
  // UNSUPPORTED resolver behavior directly; this is not re-created
  // artificially at the Run layer.
  it('the caller cannot supply or override which capabilities are technically supported', () => {
    expect(() => validateRunPolicySnapshot({ ...allowPolicy(), supportedCapabilities: [] })).toThrow(InvalidRunRequestError)
  })
})

describe('runOperation - project and task binding', () => {
  it('fails safely when the project does not exist', async () => {
    const outcome = await runOperation(db, diagnosticsRequest(999999), allowPolicy())
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') expect(outcome.failureCode).toBe('PROJECT_NOT_FOUND')
    expect(outcome.capabilityEvaluations).toEqual([])
  })

  it('succeeds with no task binding', async () => {
    const p = project()
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(outcome.status).toBe('SUCCEEDED')
  })

  it('succeeds when the task belongs to the same project', async () => {
    const p = project()
    const task = createTask(db, { projectId: p.id, title: 'T', createdBy: 'LEON' })
    const outcome = await runOperation(db, diagnosticsRequest(p.id, task.id), allowPolicy())
    expect(outcome.status).toBe('SUCCEEDED')
  })

  it('rejects (fails) a task from another project before execution', async () => {
    const p = project()
    const other = project({ name: 'Other', projectType: 'Test', description: '' })
    const foreignTask = createTask(db, { projectId: other.id, title: 'T', createdBy: 'LEON' })
    const definition = getOperationDefinition('repository.getDiagnostics')!
    const executeSpy = vi.spyOn(definition, 'execute')
    const outcome = await runOperation(db, diagnosticsRequest(p.id, foreignTask.id), allowPolicy())
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') expect(outcome.failureCode).toBe('TASK_NOT_FOUND_OR_MISMATCH')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('fails safely for an unknown taskId within an existing project', async () => {
    const p = project()
    const outcome = await runOperation(db, diagnosticsRequest(p.id, 999999), allowPolicy())
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') expect(outcome.failureCode).toBe('TASK_NOT_FOUND_OR_MISMATCH')
  })

  it('never changes Task status', async () => {
    const p = project()
    const task = createTask(db, { projectId: p.id, title: 'T', createdBy: 'LEON' })
    await runOperation(db, diagnosticsRequest(p.id, task.id), allowPolicy())
    expect(getTaskForProject(db, p.id, task.id)).toEqual(task)
  })

  it('never changes Work Request status', async () => {
    const p = project()
    const wr = createWorkRequest(db, { projectId: p.id, intentMarkdown: 'Do X', createdBy: 'LEON' })
    await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(getWorkRequestForProject(db, p.id, wr.id)).toEqual(wr)
  })

  // isArchived comes exclusively from the DB project, never from a
  // caller-supplied field - there is nothing for the caller to keep in sync.
  it('allows a policy-allowed read for an archived project, with no caller isArchived field to keep in sync', async () => {
    const p = project()
    archiveProject(db, p.id)
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(outcome.status).toBe('SUCCEEDED')
  })

  it('causes no database write - the project row is unchanged after a Run', async () => {
    const p = project()
    const before = getProjectById(db, p.id)
    await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(getProjectById(db, p.id)).toEqual(before)
  })
})

describe('runOperation - stale project folder association', () => {
  it('discards the result and fails with PROJECT_CHANGED when the folder association changes mid-operation', async () => {
    const folderA = tempFolder()
    const folderB = tempFolder()
    const p = project({ name: 'P', projectType: 'Test', description: '', folderPath: folderA })
    const definition = getOperationDefinition('repository.getDiagnostics')!
    let resolveExecute!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      resolveExecute = resolve
    })
    const executeSpy = vi.spyOn(definition, 'execute').mockReturnValue(pending as Promise<unknown>)

    const runPromise = runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    // The DB write below happens synchronously while runOperation() is still
    // suspended awaiting the controlled `pending` promise.
    updateProject(db, { id: p.id, folderPath: folderB })
    resolveExecute({ repositoryDetected: false, clean: null, counts: null })

    const outcome = await runPromise
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') expect(outcome.failureCode).toBe('PROJECT_CHANGED')
    expect(executeSpy).toHaveBeenCalledWith(folderA, {})
  })

  it('discards the result and fails with PROJECT_CHANGED when the project is deleted mid-operation', async () => {
    const folderA = tempFolder()
    const p = project({ name: 'P', projectType: 'Test', description: '', folderPath: folderA })
    const definition = getOperationDefinition('repository.getDiagnostics')!
    let resolveExecute!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      resolveExecute = resolve
    })
    const executeSpy = vi.spyOn(definition, 'execute').mockReturnValue(pending as Promise<unknown>)

    const runPromise = runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    // No production deleteProject() exists - this exercises the same
    // re-read-after-execute path a real deletion would take.
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id)
    resolveExecute({ repositoryDetected: true, clean: true, counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 } })

    const outcome = await runPromise
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') expect(outcome.failureCode).toBe('PROJECT_CHANGED')
    expect(executeSpy).toHaveBeenCalledWith(folderA, {})
    expect(JSON.stringify(outcome)).not.toContain('repositoryDetected')
  })

  it('succeeds normally when the folder association does not change during the operation', async () => {
    const folderA = tempFolder()
    const p = project({ name: 'P', projectType: 'Test', description: '', folderPath: folderA })
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(outcome.status).toBe('SUCCEEDED')
  })
})

describe('runOperation - terminal envelope', () => {
  it('produces finishedAt >= startedAt as ISO strings', async () => {
    const p = project()
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(new Date(outcome.finishedAt).getTime()).toBeGreaterThanOrEqual(new Date(outcome.startedAt).getTime())
  })

  it('uses an injected clock deterministically when provided', async () => {
    const p = project()
    const times = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z']
    let i = 0
    const clock = { now: () => new Date(times[Math.min(i++, times.length - 1)]) }
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy(), null, clock)
    expect(outcome.startedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(outcome.finishedAt).toBe('2026-01-01T00:00:01.000Z')
  })

  // A wall-clock adjustment must never make finishedAt appear before
  // startedAt - it clamps to startedAt instead.
  it('clamps finishedAt to startedAt if the clock appears to go backwards', async () => {
    const p = project()
    const times = ['2026-01-01T00:00:10.000Z', '2026-01-01T00:00:05.000Z']
    let i = 0
    const clock = { now: () => new Date(times[Math.min(i++, times.length - 1)]) }
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy(), null, clock)
    expect(outcome.startedAt).toBe('2026-01-01T00:00:10.000Z')
    expect(outcome.finishedAt).toBe('2026-01-01T00:00:10.000Z')
  })

  it('generates a distinct runId per Run', async () => {
    const p = project()
    const first = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    const second = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(first.runId).not.toBe(second.runId)
  })

  it('never includes a taskId field when none was supplied', async () => {
    const p = project()
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(outcome).not.toHaveProperty('taskId')
  })
})

describe('runOperation - unexpected handler error is sanitized', () => {
  it('maps a raw, non-OperationExecutionError handler throw to FAILED/OPERATION_FAILED without leaking its message', async () => {
    const p = project()
    const definition = getOperationDefinition('repository.getDiagnostics')!
    const executeSpy = vi
      .spyOn(definition, 'execute')
      .mockRejectedValueOnce(new Error('SECRET_TOKEN=abc123 C:\\private\\path'))

    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())

    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') expect(outcome.failureCode).toBe('OPERATION_FAILED')
    expect(executeSpy).toHaveBeenCalledTimes(1)
    const serialized = JSON.stringify(outcome)
    for (const secret of ['SECRET_TOKEN', 'abc123', 'private', 'C:\\']) {
      expect(serialized).not.toContain(secret)
    }
  })
})

describe('runOperation - an empty capability evaluation list can never authorize', () => {
  afterEach(() => {
    vi.doUnmock('./capabilityPolicy')
    vi.resetModules()
  })

  it('blocks safely and never invokes the handler when the resolver returns zero evaluations despite a required capability', async () => {
    vi.resetModules()
    vi.doMock('./capabilityPolicy', async () => {
      const actual = await vi.importActual<typeof import('./capabilityPolicy')>('./capabilityPolicy')
      return { ...actual, resolveCapabilityRequest: vi.fn(() => []) }
    })
    const { runOperation: freshRunOperation } = await import('./runService')
    const { getOperationDefinition: freshGetOperationDefinition } = await import('./runOperations')
    const definition = freshGetOperationDefinition('repository.getDiagnostics')!
    expect(definition.requiredCapabilities).toEqual(['git.read'])
    const executeSpy = vi.spyOn(definition, 'execute')

    const p = project()
    const outcome = await freshRunOperation(db, diagnosticsRequest(p.id), allowPolicy())

    expect(outcome.status).toBe('BLOCKED')
    expect(executeSpy).not.toHaveBeenCalled()
  })
})

describe('validateRunRequest - project.readTextFiles', () => {
  it('accepts a valid request', () => {
    expect(validateRunRequest(readTextFilesRequest(1, ['src/a.ts']))).toEqual({
      projectId: 1,
      operation: { id: 'project.readTextFiles', input: { relativePaths: ['src/a.ts'] } }
    })
  })

  it('rejects an empty relativePaths list', () => {
    expect(() => validateRunRequest(readTextFilesRequest(1, []))).toThrow(InvalidRunRequestError)
  })

  it('rejects a raw request containing "../" traversal', () => {
    expect(() => validateRunRequest(readTextFilesRequest(1, ['../secret.txt']))).toThrow(InvalidRunRequestError)
  })

  it('rejects a raw request that tries to smuggle allowedRelativePaths as an authority field', () => {
    const raw = { projectId: 1, operation: { id: 'project.readTextFiles', input: { relativePaths: ['a.ts'], allowedRelativePaths: ['a.ts'] } } }
    expect(() => validateRunRequest(raw)).toThrow(InvalidRunRequestError)
  })

  it.each([{ projectRoot: 'C:\\x' }, { policy: {} }, { capabilities: ['filesystem.write'] }, { provider: 'CLAUDE' }, { model: 'x' }])(
    'rejects a raw request input with an authority-smuggling field %o',
    (extra) => {
      const raw = { projectId: 1, operation: { id: 'project.readTextFiles', input: { relativePaths: ['a.ts'], ...extra } } }
      expect(() => validateRunRequest(raw)).toThrow(InvalidRunRequestError)
    }
  )
})

describe('validateRunTrustedScope', () => {
  it('accepts null for an operation that does not need a scope', () => {
    expect(validateRunTrustedScope(null, 'repository.getDiagnostics')).toBeNull()
    expect(validateRunTrustedScope(undefined, 'repository.getDiagnostics')).toBeNull()
  })

  it('accepts a valid scope for project.readTextFiles', () => {
    expect(validateRunTrustedScope(readScope(['src/a.ts']), 'project.readTextFiles')).toEqual({
      operationId: 'project.readTextFiles',
      allowedRelativePaths: ['src/a.ts']
    })
  })

  it('rejects a scope whose operationId does not match the requested operation', () => {
    expect(() => validateRunTrustedScope(readScope(['src/a.ts']), 'repository.getDiagnostics')).toThrow(InvalidRunTrustedScopeError)
  })

  it('rejects an unknown field (root/policy/capability/provider/model cannot be smuggled in)', () => {
    for (const extra of [{ root: 'C:\\x' }, { policy: {} }, { capabilities: [] }, { provider: 'CLAUDE' }, { model: 'x' }]) {
      expect(() =>
        validateRunTrustedScope({ operationId: 'project.readTextFiles', allowedRelativePaths: [], ...extra }, 'project.readTextFiles')
      ).toThrow(InvalidRunTrustedScopeError)
    }
  })

  it('rejects an unsafe path inside allowedRelativePaths', () => {
    expect(() => validateRunTrustedScope(readScope(['../secret.txt']), 'project.readTextFiles')).toThrow(InvalidRunTrustedScopeError)
  })

  it('rejects case-insensitive duplicate paths inside allowedRelativePaths', () => {
    expect(() => validateRunTrustedScope(readScope(['src/a.ts', 'SRC/A.TS']), 'project.readTextFiles')).toThrow(
      InvalidRunTrustedScopeError
    )
  })

  it('returns a defensive copy - mutating the input array does not change the validated result', () => {
    const input = ['src/a.ts']
    const scope = validateRunTrustedScope({ operationId: 'project.readTextFiles', allowedRelativePaths: input }, 'project.readTextFiles')
    input.push('src/b.ts')
    expect((scope as { allowedRelativePaths: string[] }).allowedRelativePaths).toEqual(['src/a.ts'])
  })
})

describe('runOperation - project.readTextFiles', () => {
  function writeSource(folder: string, relativePath: string, content: string): void {
    const full = path.join(folder, ...relativePath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }

  it('derives filesystem.read as the required capability', () => {
    const definition = getOperationDefinition('project.readTextFiles')!
    expect(definition.requiredCapabilities).toEqual(['filesystem.read'])
  })

  it('missing policy blocks (POLICY_UNSET) without invoking the handler', async () => {
    const p = project()
    writeSource(p.folderPath!, 'a.ts', 'x')
    const definition = getOperationDefinition('project.readTextFiles')!
    const executeSpy = vi.spyOn(definition, 'execute')

    const outcome = await runOperation(db, readTextFilesRequest(p.id, ['a.ts']), { policy: {}, ruleDeniedCapabilities: [] }, readScope(['a.ts']))

    expect(outcome.status).toBe('BLOCKED')
    if (outcome.status === 'BLOCKED') expect(outcome.blockedReason).toBe('POLICY_UNSET')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('explicit DENY blocks without invoking the handler', async () => {
    const p = project()
    const definition = getOperationDefinition('project.readTextFiles')!
    const executeSpy = vi.spyOn(definition, 'execute')

    const outcome = await runOperation(db, readTextFilesRequest(p.id, ['a.ts']), readPolicy({ policy: { 'filesystem.read': 'DENY' } }), readScope(['a.ts']))

    expect(outcome.status).toBe('BLOCKED')
    if (outcome.status === 'BLOCKED') expect(outcome.blockedReason).toBe('POLICY_DENIED')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('REQUIRES_APPROVAL blocks without invoking the handler', async () => {
    const p = project()
    const definition = getOperationDefinition('project.readTextFiles')!
    const executeSpy = vi.spyOn(definition, 'execute')

    const outcome = await runOperation(
      db,
      readTextFilesRequest(p.id, ['a.ts']),
      readPolicy({ policy: { 'filesystem.read': 'REQUIRES_APPROVAL' } }),
      readScope(['a.ts'])
    )

    expect(outcome.status).toBe('BLOCKED')
    if (outcome.status === 'BLOCKED') expect(outcome.blockedReason).toBe('APPROVAL_REQUIRED')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('explicit ALLOW with a valid trusted scope succeeds and returns the file content', async () => {
    const p = project()
    writeSource(p.folderPath!, 'src/a.ts', 'hello\n')
    const outcome = await runOperation(db, readTextFilesRequest(p.id, ['src/a.ts']), readPolicy(), readScope(['src/a.ts']))

    expect(outcome.status).toBe('SUCCEEDED')
    if (outcome.status === 'SUCCEEDED' && outcome.operationId === 'project.readTextFiles') {
      expect(outcome.result).toEqual([
        {
          path: 'src/a.ts',
          content: 'hello\n',
          sha256: expect.any(String),
          format: { utf8Bom: false, lineEnding: 'LF', finalNewline: true },
          identity: { dev: expect.any(String), ino: expect.any(String) }
        }
      ])
    }
  })

  it('filesystem.read does NOT imply git.read - a policy that only allows git.read still blocks project.readTextFiles', async () => {
    const p = project()
    const outcome = await runOperation(db, readTextFilesRequest(p.id, ['a.ts']), allowPolicy(), readScope(['a.ts']))
    expect(outcome.status).toBe('BLOCKED')
  })

  it('git.read does NOT imply filesystem.read - a policy that only allows filesystem.read still blocks repository.getDiagnostics', async () => {
    const p = project()
    const outcome = await runOperation(db, diagnosticsRequest(p.id), readPolicy())
    expect(outcome.status).toBe('BLOCKED')
  })

  it('missing trusted scope fails closed before the handler ever runs', async () => {
    const p = project()
    const definition = getOperationDefinition('project.readTextFiles')!
    const executeSpy = vi.spyOn(definition, 'execute')

    await expect(runOperation(db, readTextFilesRequest(p.id, ['a.ts']), readPolicy(), null)).rejects.toThrow(InvalidRunTrustedScopeError)
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('a requested path outside the trusted scope fails closed before the handler ever runs', async () => {
    const p = project()
    writeSource(p.folderPath!, 'a.ts', 'x')
    writeSource(p.folderPath!, 'b.ts', 'y')
    const definition = getOperationDefinition('project.readTextFiles')!
    const executeSpy = vi.spyOn(definition, 'execute')

    await expect(
      runOperation(db, readTextFilesRequest(p.id, ['a.ts', 'b.ts']), readPolicy(), readScope(['a.ts']))
    ).rejects.toThrow(InvalidRunTrustedScopeError)
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('rejects archived projects for project.readTextFiles (operation-specific, stricter than M4.5)', async () => {
    const p = project()
    archiveProject(db, p.id)
    const definition = getOperationDefinition('project.readTextFiles')!
    const executeSpy = vi.spyOn(definition, 'execute')

    const outcome = await runOperation(db, readTextFilesRequest(p.id, ['a.ts']), readPolicy(), readScope(['a.ts']))

    expect(outcome.status).toBe('BLOCKED')
    if (outcome.status === 'BLOCKED') expect(outcome.blockedReason).toBe('PROJECT_ARCHIVED')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('repository.getDiagnostics keeps its existing archived behavior (policy-controlled, not operation-blocked)', async () => {
    const p = project()
    archiveProject(db, p.id)
    const outcome = await runOperation(db, diagnosticsRequest(p.id), allowPolicy())
    expect(outcome.status).toBe('SUCCEEDED')
  })

  it('rejects a Task from another project before the handler runs', async () => {
    const p = project()
    const otherProject = project()
    const foreignTask = createTask(db, { projectId: otherProject.id, title: 'x', createdBy: 'LEON' })
    const definition = getOperationDefinition('project.readTextFiles')!
    const executeSpy = vi.spyOn(definition, 'execute')

    const outcome = await runOperation(db, readTextFilesRequest(p.id, ['a.ts'], foreignTask.id), readPolicy(), readScope(['a.ts']))

    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') expect(outcome.failureCode).toBe('TASK_NOT_FOUND_OR_MISMATCH')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('discards the result when the project folder association changes mid-operation', async () => {
    const p = project()
    writeSource(p.folderPath!, 'a.ts', 'x')
    const definition = getOperationDefinition('project.readTextFiles')!
    const otherFolder = tempFolder()
    vi.spyOn(definition, 'execute').mockImplementation(async () => {
      updateProject(db, { id: p.id, folderPath: otherFolder })
      return []
    })

    const outcome = await runOperation(db, readTextFilesRequest(p.id, ['a.ts']), readPolicy(), readScope(['a.ts']))

    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') expect(outcome.failureCode).toBe('PROJECT_CHANGED')
  })

  it('discards a sensitive result when the project is archived mid-operation, even though the folder path did not change', async () => {
    const p = project()
    writeSource(p.folderPath!, 'a.ts', 'secret source content')
    const definition = getOperationDefinition('project.readTextFiles')!
    vi.spyOn(definition, 'execute').mockImplementation(async () => {
      archiveProject(db, p.id)
      return [{ path: 'a.ts', content: 'secret source content', sha256: 'x', format: { utf8Bom: false, lineEnding: 'NONE', finalNewline: false } }]
    })

    const outcome = await runOperation(db, readTextFilesRequest(p.id, ['a.ts']), readPolicy(), readScope(['a.ts']))

    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') expect(outcome.failureCode).toBe('PROJECT_CHANGED')
    expect(JSON.stringify(outcome)).not.toContain('secret source content')
  })

  it('causes no database write - the project row is unchanged after a Run', async () => {
    const p = project()
    writeSource(p.folderPath!, 'a.ts', 'x')
    const before = getProjectById(db, p.id)
    await runOperation(db, readTextFilesRequest(p.id, ['a.ts']), readPolicy(), readScope(['a.ts']))
    const after = getProjectById(db, p.id)
    expect(after).toEqual(before)
  })

  it('root comes only from the DB - the raw request cannot supply a folder/root', async () => {
    const raw = { projectId: 1, operation: { id: 'project.readTextFiles', input: { relativePaths: ['a.ts'], projectRoot: 'C:\\x' } } }
    expect(() => validateRunRequest(raw)).toThrow(InvalidRunRequestError)
  })
})
