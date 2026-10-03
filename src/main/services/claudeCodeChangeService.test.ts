import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../testUtils/testDb'
import { archiveProject, createProject, updateProject } from './projectsService'
import { createContextVersion } from './contextService'
import { createRuleVersion } from './rulesService'
import { createTask, updateTaskDetails } from './taskService'
import { listEventLog } from './eventLogService'
import { createWorkRequest, replaceTaskLinks, updateWorkRequestIntent } from './workRequestService'
import { __setTestHookAfterStatBefore } from './projectTextReadService'
import type { RunPolicySnapshot, RunTrustedScope } from './runService'
import { CODE_CHANGE_MAX_CREATE_ENTRIES, CODE_CHANGE_MAX_MODIFY_ENTRIES, type CodeChangeProposal } from '@shared/codeChangeTypes'
import { PROJECT_TEXT_READ_MAX_FILES } from '@shared/projectTextReadTypes'
import type { ClaudeCliAdapterDeps, ClaudeChildProcess, ClaudeProcessLauncher } from './claudeCliAdapter'
import {
  ClaudeCodeChangeTaskBindingError,
  InvalidClaudeCodeChangeRequestError,
  InvalidClaudeDisclosureScopeError,
  proposeCodeChange,
  validateClaudeCodeChangeRequest,
  validateClaudeDisclosureScope,
  type ClaudeCodeChangeOutcome,
  type ClaudeCodeChangeRequest,
  type ClaudeDisclosureScope
} from './claudeCodeChangeService'

class FakeStdin extends EventEmitter {
  write = vi.fn()
  end = vi.fn()
}

class FakeChildProcess extends EventEmitter implements ClaudeChildProcess {
  pid = 9001
  stdin = new FakeStdin()
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill(): boolean {
    return true
  }
}

function respondToVersionCheck(): FakeChildProcess {
  const child = new FakeChildProcess()
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from('2.1.266', 'utf8'))
    child.emit('close', 0, null)
  })
  return child
}

// Matches the confirmed Claude Code 2.1.266 code-change terminal envelope (see
// claudeCliAdapter.test.ts's codeChangeSuccessEnvelope) - subtype/api_error_status/terminal_reason
// all set to their confirmed success values.
function successEnvelope(proposal: CodeChangeProposal): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    terminal_reason: 'completed',
    result: 'synthetic discarded result text',
    session_id: 'fake-session',
    structured_output: proposal
  })
}

function fakeAdapterDeps(
  options: {
    proposal?: CodeChangeProposal
    onInvoke?: (call: { args: string[]; stdinPayload: string }) => void
    processFailure?: boolean
  } = {}
): { deps: ClaudeCliAdapterDeps; invocationArgs: string[][] } {
  const invocationArgs: string[][] = []
  const executablePath = process.execPath
  const launcher: ClaudeProcessLauncher = (_executable, args) => {
    if (args.includes('--version')) return respondToVersionCheck()
    invocationArgs.push(args)
    const child = new FakeChildProcess()
    const originalWrite = child.stdin.write
    child.stdin.write = vi.fn((chunk: string) => {
      originalWrite(chunk)
      options.onInvoke?.({ args, stdinPayload: chunk })
      queueMicrotask(() => {
        if (options.processFailure) {
          child.emit('close', 1, null)
          return
        }
        child.stdout.emit('data', Buffer.from(successEnvelope(options.proposal ?? defaultProposal()), 'utf8'))
        child.emit('close', 0, null)
      })
    })
    return child
  }
  return { invocationArgs, deps: { launcher, killProcessTree: async () => {}, executablePath } }
}

function defaultSourceContent(): string {
  return 'export function add(a, b) {\n  return a + b\n}\n'
}

function defaultModifiedContent(): string {
  return 'export function add(a, b) {\n  return a + b + 0\n}\n'
}

function defaultCreateContent(): string {
  return 'export function test() {}\n'
}

function defaultProposal(overrides: Partial<CodeChangeProposal> = {}): CodeChangeProposal {
  return {
    summary: 'Updated add()',
    changes: [{ type: 'MODIFY', path: 'src/math.ts', content: defaultModifiedContent() }],
    warnings: [],
    ...overrides
  }
}

let db: Database.Database
let root: string
let projectId: number
let workRequestId: number
let taskId: number

function write(relativePath: string, content: string): void {
  const full = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function defaultRequest(overrides: Partial<ClaudeCodeChangeRequest> = {}): Record<string, unknown> {
  return {
    projectId,
    workRequestId,
    taskId,
    sourcePaths: ['src/math.ts'],
    modifyPaths: ['src/math.ts'],
    createPaths: [],
    ...overrides
  }
}

function defaultDisclosure(overrides: Partial<ClaudeDisclosureScope> = {}): Record<string, unknown> {
  return { disclosedRelativePaths: ['src/math.ts'], ...overrides }
}

// V2 FIX 1 test helpers - a valid, minimal filesystem.read-ALLOW RunPolicySnapshot/RunTrustedScope
// pair, reused as the default "everything is authorized" source-read authority for tests that are
// not specifically exercising the Run-gate integration itself.
function readPolicy(overrides: Partial<RunPolicySnapshot> = {}): RunPolicySnapshot {
  return { policy: { 'filesystem.read': 'ALLOW' }, ruleDeniedCapabilities: [], ...overrides }
}

function readScope(allowedRelativePaths: string[]): RunTrustedScope {
  return { operationId: 'project.readTextFiles', allowedRelativePaths }
}

/**
 * Convenience wrapper matching the OLD (V1) 4-argument call shape used throughout most of this
 * file - supplies a valid source-read policy/scope by default (derived from the request's own
 * sourcePaths, so overriding sourcePaths on a request automatically keeps the default trusted
 * scope in sync). Tests that specifically exercise the source-read authority integration call
 * proposeCodeChange directly instead, with explicit policy/scope arguments.
 */
function propose(
  deps: ClaudeCliAdapterDeps,
  request: Record<string, unknown> = defaultRequest(),
  disclosure: Record<string, unknown> = defaultDisclosure(),
  sourceReadPolicy: unknown = readPolicy(),
  sourceReadScope: unknown = readScope(Array.isArray(request.sourcePaths) ? (request.sourcePaths as string[]) : ['src/math.ts'])
): Promise<ClaudeCodeChangeOutcome> {
  return proposeCodeChange(db, deps, request, disclosure, sourceReadPolicy, sourceReadScope)
}

/** Fires `mutate()` exactly on the n-th time a disclosed source file's bytes are actually read
 * through the trusted source boundary (see projectTextReadService.ts's readOneFile) - lets a test
 * deterministically inject a state change between two of proposeCodeChange's internal snapshot
 * rebuilds (A=1st read, C=2nd read, I=3rd read when sourcePaths has exactly one entry, matching
 * every defaultRequest()-based test in this file) without any real timing-sensitive race. */
function mutateOnNthSourceRead(n: number, mutate: () => void): void {
  let count = 0
  __setTestHookAfterStatBefore(() => {
    count++
    if (count === n) mutate()
  })
}

beforeEach(() => {
  db = createTestDb()
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-code-change-')))
  write('src/math.ts', defaultSourceContent())
  projectId = createProject(db, { name: 'Eclipse Hub', projectType: 'App', description: 'A local project manager', folderPath: root }).id
  workRequestId = createWorkRequest(db, { projectId, intentMarkdown: 'Fix the add() helper', createdBy: 'LEON' }).id
  taskId = createTask(db, { projectId, title: 'Fix add()', createdBy: 'LEON' }).id
  replaceTaskLinks(db, { projectId, workRequestId, taskIds: [taskId] })
})

afterEach(() => {
  __setTestHookAfterStatBefore(null)
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// REQUEST / DISCLOSURE VALIDATORS
// ---------------------------------------------------------------------------

describe('validateClaudeCodeChangeRequest', () => {
  it('accepts a minimal valid request', () => {
    const result = validateClaudeCodeChangeRequest(defaultRequest())
    expect(result).toEqual({
      projectId,
      workRequestId,
      taskId,
      sourcePaths: ['src/math.ts'],
      modifyPaths: ['src/math.ts'],
      createPaths: []
    })
  })

  it.each([
    { projectRoot: 'C:\\somewhere' },
    { policy: 'allow-all' },
    { capabilities: ['filesystem.read'] },
    { approval: true },
    { provider: 'CLAUDE' },
    { model: 'claude-opus' },
    { tools: ['bash'] },
    { executable: 'C:\\evil\\claude.exe' },
    { commands: ['npm test'] },
    { projectRootDir: root },
    { allowedRelativePaths: ['src/math.ts'] },
    { trustedScope: { operationId: 'project.readTextFiles', allowedRelativePaths: ['src/math.ts'] } }
  ])('rejects an extra field %o', (extra) => {
    expect(() => validateClaudeCodeChangeRequest({ ...defaultRequest(), ...extra })).toThrow(InvalidClaudeCodeChangeRequestError)
  })

  it('rejects non-object input', () => {
    expect(() => validateClaudeCodeChangeRequest(null)).toThrow(InvalidClaudeCodeChangeRequestError)
    expect(() => validateClaudeCodeChangeRequest('x')).toThrow(InvalidClaudeCodeChangeRequestError)
    expect(() => validateClaudeCodeChangeRequest([1])).toThrow(InvalidClaudeCodeChangeRequestError)
  })

  it('rejects non-integer/zero/negative IDs', () => {
    expect(() => validateClaudeCodeChangeRequest({ ...defaultRequest(), projectId: 0 })).toThrow(InvalidClaudeCodeChangeRequestError)
    expect(() => validateClaudeCodeChangeRequest({ ...defaultRequest(), workRequestId: -1 })).toThrow(InvalidClaudeCodeChangeRequestError)
    expect(() => validateClaudeCodeChangeRequest({ ...defaultRequest(), taskId: 1.5 })).toThrow(InvalidClaudeCodeChangeRequestError)
  })

  it('rejects an unsafe path in any of the three path lists', () => {
    expect(() => validateClaudeCodeChangeRequest({ ...defaultRequest(), sourcePaths: ['../escape.ts'] })).toThrow(
      InvalidClaudeCodeChangeRequestError
    )
    expect(() => validateClaudeCodeChangeRequest({ ...defaultRequest(), modifyPaths: ['C:\\abs.ts'], sourcePaths: ['C:\\abs.ts'] })).toThrow(
      InvalidClaudeCodeChangeRequestError
    )
    expect(() => validateClaudeCodeChangeRequest({ ...defaultRequest(), createPaths: ['.env'] })).toThrow(InvalidClaudeCodeChangeRequestError)
  })

  it('rejects case-insensitive duplicates within a single path list', () => {
    expect(() =>
      validateClaudeCodeChangeRequest({ ...defaultRequest(), sourcePaths: ['src/math.ts', 'SRC/MATH.ts'] })
    ).toThrow(InvalidClaudeCodeChangeRequestError)
  })

  it('rejects a modifyPaths entry not present in sourcePaths', () => {
    expect(() =>
      validateClaudeCodeChangeRequest({ ...defaultRequest(), sourcePaths: [], modifyPaths: ['src/math.ts'] })
    ).toThrow(InvalidClaudeCodeChangeRequestError)
  })

  it('rejects a createPaths entry that case-insensitively collides with sourcePaths/modifyPaths', () => {
    expect(() =>
      validateClaudeCodeChangeRequest({ ...defaultRequest(), createPaths: ['SRC/MATH.ts'] })
    ).toThrow(InvalidClaudeCodeChangeRequestError)
  })

  it('rejects both modifyPaths and createPaths being empty', () => {
    expect(() =>
      validateClaudeCodeChangeRequest({ ...defaultRequest(), modifyPaths: [], createPaths: [] })
    ).toThrow(InvalidClaudeCodeChangeRequestError)
  })

  it('rejects more sourcePaths than PROJECT_TEXT_READ_MAX_FILES', () => {
    const many = Array.from({ length: PROJECT_TEXT_READ_MAX_FILES + 1 }, (_, i) => `src/file${i}.ts`)
    expect(() => validateClaudeCodeChangeRequest({ ...defaultRequest(), sourcePaths: many, modifyPaths: [] })).toThrow(
      InvalidClaudeCodeChangeRequestError
    )
  })

  it('rejects more modifyPaths than CODE_CHANGE_MAX_MODIFY_ENTRIES', () => {
    const many = Array.from({ length: CODE_CHANGE_MAX_MODIFY_ENTRIES + 1 }, (_, i) => `src/file${i}.ts`)
    expect(() => validateClaudeCodeChangeRequest({ ...defaultRequest(), modifyPaths: many })).toThrow(InvalidClaudeCodeChangeRequestError)
  })

  it('rejects more createPaths than CODE_CHANGE_MAX_CREATE_ENTRIES', () => {
    const many = Array.from({ length: CODE_CHANGE_MAX_CREATE_ENTRIES + 1 }, (_, i) => `src/new${i}.ts`)
    expect(() => validateClaudeCodeChangeRequest({ ...defaultRequest(), createPaths: many })).toThrow(InvalidClaudeCodeChangeRequestError)
  })

  it('accepts a valid CREATE-only request with an empty sourcePaths/modifyPaths list', () => {
    const result = validateClaudeCodeChangeRequest({
      ...defaultRequest(),
      sourcePaths: [],
      modifyPaths: [],
      createPaths: ['src/new.ts']
    })
    expect(result.createPaths).toEqual(['src/new.ts'])
  })
})

describe('validateClaudeDisclosureScope', () => {
  it('accepts a minimal valid scope', () => {
    expect(validateClaudeDisclosureScope(defaultDisclosure())).toEqual({ disclosedRelativePaths: ['src/math.ts'] })
  })

  it('rejects non-object input', () => {
    expect(() => validateClaudeDisclosureScope(null)).toThrow(InvalidClaudeDisclosureScopeError)
    expect(() => validateClaudeDisclosureScope([])).toThrow(InvalidClaudeDisclosureScopeError)
  })

  it('rejects an extra field', () => {
    expect(() => validateClaudeDisclosureScope({ disclosedRelativePaths: [], approved: true })).toThrow(
      InvalidClaudeDisclosureScopeError
    )
  })

  it('rejects an unsafe path', () => {
    expect(() => validateClaudeDisclosureScope({ disclosedRelativePaths: ['../escape.ts'] })).toThrow(InvalidClaudeDisclosureScopeError)
  })

  it('rejects case-insensitive duplicates', () => {
    expect(() => validateClaudeDisclosureScope({ disclosedRelativePaths: ['a.ts', 'A.ts'] })).toThrow(InvalidClaudeDisclosureScopeError)
  })
})

// ---------------------------------------------------------------------------
// DISCLOSURE (V2 FIX 2) - exact set equality with sourcePaths, separate
// authority from the raw request AND from source-read authority.
// ---------------------------------------------------------------------------

describe('proposeCodeChange - DISCLOSURE (exact set equality, fail closed)', () => {
  it('rejects with DISCLOSURE_NOT_ALLOWED and never invokes Claude when the disclosure scope is malformed', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest(), { approved: true })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'DISCLOSURE_NOT_ALLOWED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('rejects when the disclosure scope is missing one of the requested sourcePaths', async () => {
    write('src/other.ts', 'x\n')
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(
      deps,
      defaultRequest({ sourcePaths: ['src/math.ts', 'src/other.ts'], modifyPaths: ['src/math.ts'] }),
      { disclosedRelativePaths: ['src/math.ts'] }
    )
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'DISCLOSURE_NOT_ALLOWED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('rejects when the disclosure scope is empty but sourcePaths is not', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest(), { disclosedRelativePaths: [] })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'DISCLOSURE_NOT_ALLOWED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('rejects when the disclosure scope has an EXTRA path beyond sourcePaths (a superset must fail, not succeed)', async () => {
    write('src/other.ts', 'x\n')
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest(), { disclosedRelativePaths: ['src/math.ts', 'src/other.ts'] })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'DISCLOSURE_NOT_ALLOWED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('rejects a case-insensitive alias in the disclosure scope', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest(), { disclosedRelativePaths: ['SRC/MATH.ts'] })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'DISCLOSURE_NOT_ALLOWED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('succeeds when the disclosure scope is exactly sourcePaths', async () => {
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome.status).toBe('SUCCEEDED')
  })

  it('succeeds when the disclosure scope is the same set in a different order', async () => {
    write('src/other.ts', 'export const y = 1\n')
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(
      deps,
      defaultRequest({ sourcePaths: ['src/math.ts', 'src/other.ts'], modifyPaths: ['src/math.ts'] }),
      { disclosedRelativePaths: ['src/other.ts', 'src/math.ts'] }
    )
    expect(outcome.status).toBe('SUCCEEDED')
  })

  it('CREATE-only request: sourcePaths=[] with disclosedRelativePaths=[] is valid', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: defaultCreateContent() }], warnings: [] }
    })
    const outcome = await propose(deps, defaultRequest({ sourcePaths: [], modifyPaths: [], createPaths: ['src/new.ts'] }), {
      disclosedRelativePaths: []
    })
    expect(outcome.status).toBe('SUCCEEDED')
  })

  it('a capability-shaped object unrelated to disclosure never substitutes for disclosure authority', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest(), { allow: true, scope: 'filesystem.read' })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'DISCLOSURE_NOT_ALLOWED' })
    expect(invocationArgs.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SOURCE READ AUTHORITY (V2 FIX 1) - every non-empty source snapshot goes
// through runOperation()'s 'project.readTextFiles', never a direct read.
// Three independent conditions: filesystem.read policy, RunTrustedScope, and
// ClaudeDisclosureScope - none substitutes for another.
// ---------------------------------------------------------------------------

describe('proposeCodeChange - SOURCE READ AUTHORITY (Run gate integration, fail closed)', () => {
  it('no source-read policy at all -> SOURCE_UNAVAILABLE, Claude never invoked', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await proposeCodeChange(db, deps, defaultRequest(), defaultDisclosure(), undefined, readScope(['src/math.ts']))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'SOURCE_UNAVAILABLE' })
    expect(invocationArgs.length).toBe(0)
  })

  it('filesystem.read POLICY_UNSET (empty policy map) -> SOURCE_UNAVAILABLE, Claude never invoked', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await proposeCodeChange(
      db,
      deps,
      defaultRequest(),
      defaultDisclosure(),
      { policy: {}, ruleDeniedCapabilities: [] },
      readScope(['src/math.ts'])
    )
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'SOURCE_UNAVAILABLE' })
    expect(invocationArgs.length).toBe(0)
  })

  it('filesystem.read DENY -> SOURCE_UNAVAILABLE, Claude never invoked', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await proposeCodeChange(
      db,
      deps,
      defaultRequest(),
      defaultDisclosure(),
      readPolicy({ policy: { 'filesystem.read': 'DENY' } }),
      readScope(['src/math.ts'])
    )
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'SOURCE_UNAVAILABLE' })
    expect(invocationArgs.length).toBe(0)
  })

  it('filesystem.read REQUIRES_APPROVAL -> SOURCE_UNAVAILABLE, Claude never invoked', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await proposeCodeChange(
      db,
      deps,
      defaultRequest(),
      defaultDisclosure(),
      readPolicy({ policy: { 'filesystem.read': 'REQUIRES_APPROVAL' } }),
      readScope(['src/math.ts'])
    )
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'SOURCE_UNAVAILABLE' })
    expect(invocationArgs.length).toBe(0)
  })

  it('filesystem.read ALLOW + missing RunTrustedScope (null) -> SOURCE_UNAVAILABLE, Claude never invoked', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await proposeCodeChange(db, deps, defaultRequest(), defaultDisclosure(), readPolicy(), null)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'SOURCE_UNAVAILABLE' })
    expect(invocationArgs.length).toBe(0)
  })

  it('filesystem.read ALLOW + an out-of-scope RunTrustedScope path -> SOURCE_UNAVAILABLE, Claude never invoked', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await proposeCodeChange(db, deps, defaultRequest(), defaultDisclosure(), readPolicy(), readScope(['src/other.ts']))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'SOURCE_UNAVAILABLE' })
    expect(invocationArgs.length).toBe(0)
  })

  it('git.read ALLOW does NOT substitute for filesystem.read -> SOURCE_UNAVAILABLE', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await proposeCodeChange(
      db,
      deps,
      defaultRequest(),
      defaultDisclosure(),
      { policy: { 'git.read': 'ALLOW' }, ruleDeniedCapabilities: [] },
      readScope(['src/math.ts'])
    )
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'SOURCE_UNAVAILABLE' })
    expect(invocationArgs.length).toBe(0)
  })

  it('filesystem.read ALLOW + valid RunTrustedScope does NOT substitute for disclosure -> DISCLOSURE_NOT_ALLOWED', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await proposeCodeChange(
      db,
      deps,
      defaultRequest(),
      { disclosedRelativePaths: [] },
      readPolicy(),
      readScope(['src/math.ts'])
    )
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'DISCLOSURE_NOT_ALLOWED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('an exact disclosure match does NOT substitute for filesystem.read -> SOURCE_UNAVAILABLE', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await proposeCodeChange(
      db,
      deps,
      defaultRequest(),
      defaultDisclosure(),
      { policy: {}, ruleDeniedCapabilities: [] },
      readScope(['src/math.ts'])
    )
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'SOURCE_UNAVAILABLE' })
    expect(invocationArgs.length).toBe(0)
  })

  it('valid filesystem.read + RunTrustedScope + exact disclosure succeeds', async () => {
    const { deps } = fakeAdapterDeps()
    const outcome = await proposeCodeChange(db, deps, defaultRequest(), defaultDisclosure(), readPolicy(), readScope(['src/math.ts']))
    expect(outcome.status).toBe('SUCCEEDED')
  })

  it('CREATE-only requests (sourcePaths=[]) never start a project.readTextFiles Run - malformed source-read authority is harmless', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: defaultCreateContent() }], warnings: [] }
    })
    const outcome = await proposeCodeChange(
      db,
      deps,
      defaultRequest({ sourcePaths: [], modifyPaths: [], createPaths: ['src/new.ts'] }),
      { disclosedRelativePaths: [] },
      undefined,
      undefined
    )
    expect(outcome.status).toBe('SUCCEEDED')
    expect(invocationArgs.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// PROJECT / WORK REQUEST / TASK BINDING
// ---------------------------------------------------------------------------

describe('proposeCodeChange - project/work request/task binding', () => {
  it('rejects a missing project', async () => {
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest({ projectId: 999_999 }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'PROJECT_NOT_FOUND' })
  })

  it('rejects an archived project', async () => {
    archiveProject(db, projectId)
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'PROJECT_NOT_FOUND' })
  })

  it('rejects a missing Work Request', async () => {
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest({ workRequestId: 999_999 }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'WORK_REQUEST_MISMATCH' })
  })

  it('rejects a Work Request belonging to a different project', async () => {
    const otherProjectId = createProject(db, { name: 'Other', projectType: 'App', description: '' }).id
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest({ projectId: otherProjectId }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'WORK_REQUEST_MISMATCH' })
  })

  it('rejects a missing Task', async () => {
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest({ taskId: 999_999 }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'TASK_MISMATCH' })
  })

  it('rejects a Task belonging to a different project', async () => {
    const otherProjectId = createProject(db, { name: 'Other', projectType: 'App', description: '' }).id
    const otherTaskId = createTask(db, { projectId: otherProjectId, title: 'Other task', createdBy: 'LEON' }).id
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest({ taskId: otherTaskId }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'TASK_MISMATCH' })
  })

  it('rejects a Task that exists on the project but is not linked to the given Work Request', async () => {
    const unlinkedTaskId = createTask(db, { projectId, title: 'Unlinked task', createdBy: 'LEON' }).id
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest({ taskId: unlinkedTaskId }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'TASK_MISMATCH' })
  })

  it('rejects a sourcePaths entry that does not exist on disk with SOURCE_UNAVAILABLE', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(
      deps,
      defaultRequest({ sourcePaths: ['src/missing.ts'], modifyPaths: ['src/missing.ts'] }),
      { disclosedRelativePaths: ['src/missing.ts'] }
    )
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'SOURCE_UNAVAILABLE' })
    expect(invocationArgs.length).toBe(0)
  })

  it('resolveClaudeCodeChangeTaskBindingError carries the task/work request IDs', () => {
    const error = new ClaudeCodeChangeTaskBindingError(5, 9)
    expect(error.message).toContain('5')
    expect(error.message).toContain('9')
  })
})

// ---------------------------------------------------------------------------
// CODE CONTEXT PACK
// ---------------------------------------------------------------------------

describe('proposeCodeChange - Code Context Pack contents', () => {
  it('sends only the expected bounded fields and no project root/DB IDs/hash', async () => {
    let capturedStdin = ''
    const { deps } = fakeAdapterDeps({ onInvoke: ({ stdinPayload }) => (capturedStdin = stdinPayload) })
    const outcome = await propose(deps)
    expect(outcome.status).toBe('SUCCEEDED')

    const pack = JSON.parse(capturedStdin)
    expect(Object.keys(pack).sort()).toEqual(['allowedChanges', 'context', 'decisions', 'project', 'rules', 'sourceFiles', 'task', 'workRequest'])
    expect(Object.keys(pack.project).sort()).toEqual(['description', 'name', 'projectType'])
    expect(pack.workRequest).toEqual({ intentMarkdown: 'Fix the add() helper', planMarkdown: null, status: 'IDEA' })
    expect(pack.rules).toBeNull()
    expect(pack.context).toBeNull()
    expect(pack.decisions).toEqual([])
    expect(pack.allowedChanges).toEqual({ modifyPaths: ['src/math.ts'], createPaths: [] })
    expect(pack.sourceFiles).toEqual([
      { path: 'src/math.ts', content: defaultSourceContent(), format: { utf8Bom: false, lineEnding: 'LF', finalNewline: true } }
    ])
    expect(Object.keys(pack.sourceFiles[0]).sort()).toEqual(['content', 'format', 'path'])

    expect(capturedStdin).not.toMatch(/folderPath|projectRoot|sha256|approval|approved/i)
    expect(capturedStdin).not.toContain(root.replace(/\\/g, '\\\\'))
  })

  it('includes the current Rules/Context content when present', async () => {
    const rules = createRuleVersion(db, { projectId, contentMarkdown: '# Rules\nBe careful.', createdBy: 'LEON' })
    const context = createContextVersion(db, { projectId, contentMarkdown: '# Context\nCurrent state.', createdBy: 'LEON' })
    let capturedStdin = ''
    const { deps } = fakeAdapterDeps({ onInvoke: ({ stdinPayload }) => (capturedStdin = stdinPayload) })
    await propose(deps)
    const pack = JSON.parse(capturedStdin)
    expect(pack.rules).toEqual({ versionNumber: rules.versionNumber, contentMarkdown: '# Rules\nBe careful.' })
    expect(pack.context).toEqual({ versionNumber: context.versionNumber, contentMarkdown: '# Context\nCurrent state.' })
    expect(capturedStdin).not.toMatch(/"versionId"/)
  })

  it('includes the Task title/goal/description/priority/acceptance criteria/verification requirements', async () => {
    let capturedStdin = ''
    const { deps } = fakeAdapterDeps({ onInvoke: ({ stdinPayload }) => (capturedStdin = stdinPayload) })
    await propose(deps)
    const pack = JSON.parse(capturedStdin)
    expect(pack.task.title).toBe('Fix add()')
    expect(Object.keys(pack.task).sort()).toEqual([
      'acceptanceCriteriaMarkdown',
      'descriptionMarkdown',
      'goalMarkdown',
      'priority',
      'status',
      'title',
      'verificationRequirementsMarkdown'
    ])
  })

  it('sends a CREATE-only pack with an empty sourceFiles list when sourcePaths is empty', async () => {
    let capturedStdin = ''
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: defaultCreateContent() }], warnings: [] },
      onInvoke: ({ stdinPayload }) => (capturedStdin = stdinPayload)
    })
    const outcome = await propose(deps, defaultRequest({ sourcePaths: [], modifyPaths: [], createPaths: ['src/new.ts'] }), {
      disclosedRelativePaths: []
    })
    expect(outcome.status).toBe('SUCCEEDED')
    const pack = JSON.parse(capturedStdin)
    expect(pack.sourceFiles).toEqual([])
  })

  it('fails INPUT_LIMIT before invoking Claude when the Code Context Pack exceeds the cap', async () => {
    // createContextVersion has no server-side content length cap (unlike Rules, capped at 50,000
    // chars) - used here purely to push the serialized pack past the 128 KiB cap.
    createContextVersion(db, { projectId, contentMarkdown: 'x'.repeat(200_000), createdBy: 'LEON' })
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_LIMIT' })
    expect(invocationArgs.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TRANSPORT - integration with the shared Claude adapter/profile
// ---------------------------------------------------------------------------

describe('proposeCodeChange - transport integration', () => {
  it('passes the request modify/createPaths as the trusted scope (proposal outside scope is rejected)', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'MODIFY', path: 'src/outside-scope.ts', content: 'x\n' }], warnings: [] }
    })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects a MODIFY on a file that IS disclosed but is NOT in the MODIFY scope (disclosure != write authority)', async () => {
    write('src/readonly.ts', 'export const x = 1\n')
    const request = defaultRequest({ sourcePaths: ['src/math.ts', 'src/readonly.ts'], modifyPaths: ['src/math.ts'] })
    const disclosure = { disclosedRelativePaths: ['src/math.ts', 'src/readonly.ts'] }
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'MODIFY', path: 'src/readonly.ts', content: 'export const x = 2\n' }], warnings: [] }
    })
    const outcome = await propose(deps, request, disclosure)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('passes adapter-level transport failures through unchanged', async () => {
    const { deps } = fakeAdapterDeps({ processFailure: true })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'PROCESS_FAILED' })
  })

  it('returns the Hub-validated proposal as untrusted data on success', async () => {
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome.status).toBe('SUCCEEDED')
    if (outcome.status !== 'SUCCEEDED') return
    const expectedSourceFile = {
      path: 'src/math.ts',
      content: defaultSourceContent(),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      format: { utf8Bom: false, lineEnding: 'LF', finalNewline: true },
      identity: { dev: expect.any(String), ino: expect.any(String) }
    }
    expect(outcome.result.proposal).toEqual(defaultProposal())
    expect(outcome.result.sourceSnapshot).toEqual([expectedSourceFile])
    expect(outcome.result.createPreconditions).toEqual([])
    expect(outcome.result.provenance).toEqual({
      projectId,
      taskId,
      workRequestId,
      project: { name: 'Eclipse Hub', projectType: 'App', description: 'A local project manager' },
      projectFolderPath: root,
      projectFolderComparisonKey: expect.any(String),
      rootIdentity: { realPath: expect.any(String), dev: expect.any(String), ino: expect.any(String) },
      workRequest: { intentMarkdown: 'Fix the add() helper', planMarkdown: null, status: 'IDEA' },
      task: {
        title: 'Fix add()',
        goalMarkdown: '',
        descriptionMarkdown: '',
        priority: expect.any(String),
        status: expect.any(String),
        acceptanceCriteriaMarkdown: '',
        verificationRequirementsMarkdown: ''
      },
      rules: null,
      context: null,
      decisions: [],
      sourcePaths: ['src/math.ts'],
      modifyPaths: ['src/math.ts'],
      createPaths: [],
      disclosedRelativePaths: ['src/math.ts'],
      sourceFiles: [expectedSourceFile],
      createPreconditions: []
    })
  })

  it('provenance carries CREATE candidate observations and an empty sourceFiles list for CREATE-only requests', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: defaultCreateContent() }], warnings: [] }
    })
    const outcome = await propose(deps, defaultRequest({ sourcePaths: [], modifyPaths: [], createPaths: ['src/new.ts'] }), {
      disclosedRelativePaths: []
    })
    expect(outcome.status).toBe('SUCCEEDED')
    if (outcome.status !== 'SUCCEEDED') return
    expect(outcome.result.provenance.sourceFiles).toEqual([])
    expect(outcome.result.provenance.createPreconditions).toEqual([{ path: 'src/new.ts', verifiedAbsent: true }])
    expect(outcome.result.provenance.sourcePaths).toEqual([])
    expect(outcome.result.provenance.createPaths).toEqual(['src/new.ts'])
  })

  it('never retains a policy/trustedScope object as future authority inside provenance', async () => {
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome.status).toBe('SUCCEEDED')
    if (outcome.status !== 'SUCCEEDED') return
    const serialized = JSON.stringify(outcome.result.provenance)
    // No capability/policy vocabulary anywhere in the retained provenance - only plain path lists
    // and generation-time data, never an object shaped like RunPolicySnapshot/RunTrustedScope.
    expect(serialized).not.toMatch(/filesystem\.read|ruleDeniedCapabilities|operationId|allowedRelativePaths/i)
  })
})

// ---------------------------------------------------------------------------
// FORMAT - MODIFY must preserve base format EXACTLY (V2 FIX 4), CREATE
// follows the fixed V1 convention.
// ---------------------------------------------------------------------------

describe('proposeCodeChange - FORMAT', () => {
  it('accepts a MODIFY that preserves LF + final newline exactly', async () => {
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome.status).toBe('SUCCEEDED')
  })

  it('rejects a MODIFY that converts LF to CRLF', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: defaultProposal({ changes: [{ type: 'MODIFY', path: 'src/math.ts', content: defaultModifiedContent().replace(/\n/g, '\r\n') }] })
    })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects a MODIFY that removes the final newline', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: defaultProposal({ changes: [{ type: 'MODIFY', path: 'src/math.ts', content: defaultModifiedContent().trimEnd() }] })
    })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects a MODIFY with mixed LF/CRLF line endings', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: defaultProposal({ changes: [{ type: 'MODIFY', path: 'src/math.ts', content: 'line1\r\nline2\n' }] })
    })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects a MODIFY containing a literal BOM character (U+FEFF)', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: defaultProposal({ changes: [{ type: 'MODIFY', path: 'src/math.ts', content: String.fromCharCode(0xfeff) + defaultModifiedContent() }] })
    })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('preserves a CRLF base file: accepts CRLF-preserving MODIFY, rejects LF-converting MODIFY', async () => {
    write('src/crlf.ts', 'line1\r\nline2\r\n')
    const request = defaultRequest({ sourcePaths: ['src/crlf.ts'], modifyPaths: ['src/crlf.ts'] })
    const disclosure = { disclosedRelativePaths: ['src/crlf.ts'] }

    const { deps: goodDeps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'MODIFY', path: 'src/crlf.ts', content: 'line1\r\nline2 changed\r\n' }], warnings: [] }
    })
    expect((await propose(goodDeps, request, disclosure)).status).toBe('SUCCEEDED')

    const { deps: badDeps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'MODIFY', path: 'src/crlf.ts', content: 'line1\nline2 changed\n' }], warnings: [] }
    })
    const badOutcome = await propose(badDeps, request, disclosure)
    expect(badOutcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects introducing an internal LF when the base file has NONE line endings', async () => {
    write('src/none.ts', 'plain text no newline')
    const request = defaultRequest({ sourcePaths: ['src/none.ts'], modifyPaths: ['src/none.ts'] })
    const disclosure = { disclosedRelativePaths: ['src/none.ts'] }
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'MODIFY', path: 'src/none.ts', content: 'line1\nline2' }], warnings: [] }
    })
    const outcome = await propose(deps, request, disclosure)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects introducing an internal CRLF when the base file has NONE line endings', async () => {
    write('src/none.ts', 'plain text no newline')
    const request = defaultRequest({ sourcePaths: ['src/none.ts'], modifyPaths: ['src/none.ts'] })
    const disclosure = { disclosedRelativePaths: ['src/none.ts'] }
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'MODIFY', path: 'src/none.ts', content: 'line1\r\nline2' }], warnings: [] }
    })
    const outcome = await propose(deps, request, disclosure)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects collapsing an LF base without a final newline down to NONE', async () => {
    write('src/nolf.ts', 'line1\nline2')
    const request = defaultRequest({ sourcePaths: ['src/nolf.ts'], modifyPaths: ['src/nolf.ts'] })
    const disclosure = { disclosedRelativePaths: ['src/nolf.ts'] }
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'MODIFY', path: 'src/nolf.ts', content: 'line1 line2 no newline at all' }], warnings: [] }
    })
    const outcome = await propose(deps, request, disclosure)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('accepts an exact NONE->NONE MODIFY (no line endings on either side)', async () => {
    write('src/none2.ts', 'original text')
    const request = defaultRequest({ sourcePaths: ['src/none2.ts'], modifyPaths: ['src/none2.ts'] })
    const disclosure = { disclosedRelativePaths: ['src/none2.ts'] }
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'MODIFY', path: 'src/none2.ts', content: 'changed text' }], warnings: [] }
    })
    const outcome = await propose(deps, request, disclosure)
    expect(outcome.status).toBe('SUCCEEDED')
  })

  it('accepts a valid CREATE (UTF-8, LF, final newline, no BOM)', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: defaultCreateContent() }], warnings: [] }
    })
    const outcome = await propose(deps, defaultRequest({ createPaths: ['src/new.ts'] }))
    expect(outcome.status).toBe('SUCCEEDED')
  })

  it('rejects a CREATE containing CR', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: 'a\r\nb\r\n' }], warnings: [] }
    })
    const outcome = await propose(deps, defaultRequest({ createPaths: ['src/new.ts'] }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects a CREATE without a final newline', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: 'a\nb' }], warnings: [] }
    })
    const outcome = await propose(deps, defaultRequest({ createPaths: ['src/new.ts'] }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects a CREATE containing a literal BOM character (U+FEFF)', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: String.fromCharCode(0xfeff) + 'a\n' }], warnings: [] }
    })
    const outcome = await propose(deps, defaultRequest({ createPaths: ['src/new.ts'] }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })
})

// ---------------------------------------------------------------------------
// CREATE PRECONDITION - absence must be verified before AND after invocation
// ---------------------------------------------------------------------------

describe('proposeCodeChange - CREATE precondition', () => {
  it('rejects (before invoking Claude) when the CREATE target already exists as a file', async () => {
    write('src/new.ts', 'already here\n')
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest({ createPaths: ['src/new.ts'] }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('rejects when the CREATE target already exists as a directory', async () => {
    fs.mkdirSync(path.join(root, 'src', 'new.ts'), { recursive: true })
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest({ createPaths: ['src/new.ts'] }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('rejects when the CREATE target collides case-insensitively with an existing file', async () => {
    write('src/New.ts', 'already here (different case)\n')
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest({ createPaths: ['src/new.ts'] }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('rejects when the CREATE target parent directory does not exist (never auto-created)', async () => {
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps, defaultRequest({ createPaths: ['does/not/exist/new.ts'] }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
    expect(fs.existsSync(path.join(root, 'does'))).toBe(false)
  })

  it('rejects (after invoking Claude) when the CREATE target appears while Claude is running', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: defaultCreateContent() }], warnings: [] },
      onInvoke: () => write('src/new.ts', 'appeared during invocation\n')
    })
    const outcome = await propose(deps, defaultRequest({ createPaths: ['src/new.ts'] }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('succeeds and reports the CREATE target as verified absent when nothing changed', async () => {
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: defaultCreateContent() }], warnings: [] }
    })
    const outcome = await propose(deps, defaultRequest({ createPaths: ['src/new.ts'] }))
    expect(outcome).toEqual({
      status: 'SUCCEEDED',
      result: expect.objectContaining({ createPreconditions: [{ path: 'src/new.ts', verifiedAbsent: true }] })
    })
    expect(fs.existsSync(path.join(root, 'src', 'new.ts'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PRE-DISCLOSURE STALE PROTECTION (V2 FIX 3) - a full freshness checkpoint
// runs immediately BEFORE Claude is ever invoked. Every scenario below must
// return INPUT_CHANGED AND invoke Claude ZERO times - the state change is
// injected between the initial snapshot and the pre-disclosure rebuild (or,
// for the CREATE-target case, before the very first CREATE-precondition
// check), never anywhere near the actual invocation.
// ---------------------------------------------------------------------------

describe('proposeCodeChange - PRE-DISCLOSURE stale protection (before any Claude invocation)', () => {
  it('a disclosed source file changing content is caught before invocation', async () => {
    // Injected at the SECOND source read (the pre-disclosure rebuild's own read) so the initial
    // snapshot's read is unaffected and captures the original content.
    mutateOnNthSourceRead(2, () => write('src/math.ts', defaultSourceContent() + '// changed\n'))
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('Rules changing is caught before invocation', async () => {
    // Injected at the FIRST source read's tail (after the initial snapshot's own DB fields are
    // already captured, but before the pre-disclosure rebuild starts) so the pre-disclosure
    // rebuild's own DB read sees the new Rules version.
    mutateOnNthSourceRead(1, () => createRuleVersion(db, { projectId, contentMarkdown: 'v2', createdBy: 'LEON' }))
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('Context changing is caught before invocation', async () => {
    mutateOnNthSourceRead(1, () => createContextVersion(db, { projectId, contentMarkdown: 'v2', createdBy: 'LEON' }))
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('the Task changing is caught before invocation', async () => {
    mutateOnNthSourceRead(1, () => updateTaskDetails(db, { projectId, id: taskId, title: 'Renamed before disclosure' }))
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('the Work Request changing is caught before invocation', async () => {
    mutateOnNthSourceRead(1, () => updateWorkRequestIntent(db, { projectId, id: workRequestId, intentMarkdown: 'Different before disclosure' }))
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('the Task<->Work-Request link being removed is caught before invocation', async () => {
    mutateOnNthSourceRead(1, () => replaceTaskLinks(db, { projectId, workRequestId, taskIds: [] }))
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('project archival is caught before invocation', async () => {
    mutateOnNthSourceRead(1, () => archiveProject(db, projectId))
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('project folder reassociation is caught before invocation', async () => {
    const root2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-code-change-predisc-')))
    fs.mkdirSync(path.join(root2, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root2, 'src', 'math.ts'), defaultSourceContent())
    try {
      mutateOnNthSourceRead(1, () => updateProject(db, { id: projectId, folderPath: root2 }))
      const { deps, invocationArgs } = fakeAdapterDeps()
      const outcome = await propose(deps)
      expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
      expect(invocationArgs.length).toBe(0)
    } finally {
      fs.rmSync(root2, { recursive: true, force: true })
    }
  })

  it('a CREATE target appearing before the pre-disclosure recheck is caught before invocation', async () => {
    mutateOnNthSourceRead(1, () => write('src/new.ts', 'appeared before disclosure\n'))
    const { deps, invocationArgs } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: defaultCreateContent() }], warnings: [] }
    })
    const outcome = await propose(deps, defaultRequest({ createPaths: ['src/new.ts'] }))
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    expect(invocationArgs.length).toBe(0)
  })

  it('succeeds when nothing changes before disclosure either', async () => {
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome.status).toBe('SUCCEEDED')
  })
})

// ---------------------------------------------------------------------------
// POST-DISCLOSURE (POST-INVOCATION) STALE PROTECTION - unchanged from V1:
// a change occurring WHILE Claude is actually running (during stdin.write,
// i.e. after the pre-disclosure recheck already passed) is still caught by
// the existing post-invocation recheck.
// ---------------------------------------------------------------------------

describe('proposeCodeChange - POST-DISCLOSURE stale source protection', () => {
  it('discards the proposal when a disclosed source file changes content during the invocation', async () => {
    const { deps } = fakeAdapterDeps({ onInvoke: () => write('src/math.ts', defaultSourceContent() + '// changed\n') })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when a disclosed source file is deleted during the invocation', async () => {
    const { deps } = fakeAdapterDeps({ onInvoke: () => fs.rmSync(path.join(root, 'src', 'math.ts')) })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })
})

describe('proposeCodeChange - POST-DISCLOSURE stale DB protection', () => {
  it('discards the proposal when the Work Request intent changes during the invocation', async () => {
    const { deps } = fakeAdapterDeps({
      onInvoke: () => updateWorkRequestIntent(db, { projectId, id: workRequestId, intentMarkdown: 'Different intent now' })
    })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the Task title changes during the invocation', async () => {
    const { deps } = fakeAdapterDeps({
      onInvoke: () => updateTaskDetails(db, { projectId, id: taskId, title: 'Renamed task' })
    })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the Task is unlinked from the Work Request during the invocation', async () => {
    const { deps } = fakeAdapterDeps({ onInvoke: () => replaceTaskLinks(db, { projectId, workRequestId, taskIds: [] }) })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the Rules version changes during the invocation', async () => {
    createRuleVersion(db, { projectId, contentMarkdown: 'v1', createdBy: 'LEON' })
    const { deps } = fakeAdapterDeps({ onInvoke: () => createRuleVersion(db, { projectId, contentMarkdown: 'v2', createdBy: 'LEON' }) })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the Context version changes during the invocation', async () => {
    createContextVersion(db, { projectId, contentMarkdown: 'v1', createdBy: 'LEON' })
    const { deps } = fakeAdapterDeps({ onInvoke: () => createContextVersion(db, { projectId, contentMarkdown: 'v2', createdBy: 'LEON' }) })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the project is archived during the invocation', async () => {
    const { deps } = fakeAdapterDeps({ onInvoke: () => archiveProject(db, projectId) })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the project is deleted during the invocation', async () => {
    const { deps } = fakeAdapterDeps({ onInvoke: () => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId) })
    const outcome = await propose(deps)
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the project folder identity changes during the invocation, even to an identical-content folder', async () => {
    const root2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-code-change-2-')))
    fs.mkdirSync(path.join(root2, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root2, 'src', 'math.ts'), defaultSourceContent())
    try {
      const { deps } = fakeAdapterDeps({ onInvoke: () => updateProject(db, { id: projectId, folderPath: root2 }) })
      const outcome = await propose(deps)
      expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
    } finally {
      fs.rmSync(root2, { recursive: true, force: true })
    }
  })

  it('succeeds when nothing relevant changed during the invocation', async () => {
    const { deps } = fakeAdapterDeps({ onInvoke: () => undefined })
    const outcome = await propose(deps)
    expect(outcome.status).toBe('SUCCEEDED')
  })
})

// ---------------------------------------------------------------------------
// NO SIDE EFFECTS - M4.7B.2 mutates nothing
// ---------------------------------------------------------------------------

describe('proposeCodeChange - no side effects', () => {
  it('never writes/creates/deletes any file in the project folder, and never mutates DB/event log state', async () => {
    const filesBefore = fs.readdirSync(path.join(root, 'src'))
    const tasksBefore = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
    const eventsBefore = listEventLog(db).length
    const workRequestRowBefore = db.prepare('SELECT * FROM work_requests WHERE id = ?').get(workRequestId)
    const taskRowBefore = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
    const sourceBefore = fs.readFileSync(path.join(root, 'src', 'math.ts'), 'utf8')

    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: defaultCreateContent() }], warnings: [] }
    })
    const outcome = await propose(deps, defaultRequest({ createPaths: ['src/new.ts'] }))
    expect(outcome.status).toBe('SUCCEEDED')

    const filesAfter = fs.readdirSync(path.join(root, 'src'))
    expect(filesAfter.sort()).toEqual(filesBefore.sort())
    expect(fs.readFileSync(path.join(root, 'src', 'math.ts'), 'utf8')).toBe(sourceBefore)

    const tasksAfter = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
    expect(tasksAfter.n).toBe(tasksBefore.n)
    const eventsAfter = listEventLog(db)
    expect(eventsAfter.length).toBe(eventsBefore)
    expect(eventsAfter.every((entry) => !JSON.stringify(entry.payload).includes('CodeChangeProposal'))).toBe(true)
    expect(db.prepare('SELECT * FROM work_requests WHERE id = ?').get(workRequestId)).toEqual(workRequestRowBefore)
    expect(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)).toEqual(taskRowBefore)

    // Sanity check the assertions above are meaningful (the DB/filesystem still work at all).
    expect(() => createTask(db, { projectId, title: 'Manual task', createdBy: 'LEON' })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// PROPOSAL - InvalidClaudeCodeChangeRequestError propagates uncaught (matches
// claudePlanningService.ts's precedent for a malformed raw request).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PROVENANCE (M4.8A Part A/B) - the retained generation-time provenance
// survives the B.2 return path and reflects real generation-time state.
// ---------------------------------------------------------------------------

describe('proposeCodeChange - retained provenance (M4.8A)', () => {
  it('retains Rules/Context/decisions content when present', async () => {
    const rules = createRuleVersion(db, { projectId, contentMarkdown: '# Rules\nBe careful.', createdBy: 'LEON' })
    const context = createContextVersion(db, { projectId, contentMarkdown: '# Context\nCurrent state.', createdBy: 'LEON' })
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome.status).toBe('SUCCEEDED')
    if (outcome.status !== 'SUCCEEDED') return
    expect(outcome.result.provenance.rules).toEqual({ versionNumber: rules.versionNumber, contentMarkdown: '# Rules\nBe careful.' })
    expect(outcome.result.provenance.context).toEqual({ versionNumber: context.versionNumber, contentMarkdown: '# Context\nCurrent state.' })
  })

  it('captures root identity evidence bound to the actual project folder', async () => {
    const { deps } = fakeAdapterDeps()
    const outcome = await propose(deps)
    expect(outcome.status).toBe('SUCCEEDED')
    if (outcome.status !== 'SUCCEEDED') return
    expect(outcome.result.provenance.rootIdentity?.realPath.toLowerCase()).toBe(root.toLowerCase())
    expect(outcome.result.provenance.rootIdentity?.dev).toMatch(/^\d+$/)
    expect(outcome.result.provenance.rootIdentity?.ino).toMatch(/^\d+$/)
  })

  it('retains per-file identity evidence on each captured source file, never exposed to the Claude-facing pack', async () => {
    let capturedStdin = ''
    const { deps } = fakeAdapterDeps({ onInvoke: ({ stdinPayload }) => (capturedStdin = stdinPayload) })
    const outcome = await propose(deps)
    expect(outcome.status).toBe('SUCCEEDED')
    if (outcome.status !== 'SUCCEEDED') return
    expect(outcome.result.provenance.sourceFiles[0].identity.dev).toMatch(/^\d+$/)
    expect(outcome.result.provenance.sourceFiles[0].identity.ino).toMatch(/^\d+$/)
    expect(capturedStdin).not.toMatch(/"identity"|"dev"|"ino"/)
  })

  it('root identity evidence is null when no project folder is associated', async () => {
    const noFolderProjectId = createProject(db, { name: 'No Folder', projectType: 'App', description: '' }).id
    const noFolderWorkRequestId = createWorkRequest(db, { projectId: noFolderProjectId, intentMarkdown: 'x', createdBy: 'LEON' }).id
    const noFolderTaskId = createTask(db, { projectId: noFolderProjectId, title: 'x', createdBy: 'LEON' }).id
    replaceTaskLinks(db, { projectId: noFolderProjectId, workRequestId: noFolderWorkRequestId, taskIds: [noFolderTaskId] })
    const { deps } = fakeAdapterDeps({
      proposal: { summary: 'x', changes: [{ type: 'CREATE', path: 'src/new.ts', content: defaultCreateContent() }], warnings: [] }
    })
    const outcome = await proposeCodeChange(
      db,
      deps,
      {
        projectId: noFolderProjectId,
        workRequestId: noFolderWorkRequestId,
        taskId: noFolderTaskId,
        sourcePaths: [],
        modifyPaths: [],
        createPaths: ['src/new.ts']
      },
      { disclosedRelativePaths: [] },
      undefined,
      undefined
    )
    // No folder association means the CREATE-precondition root resolution fails, which is a
    // legitimate, unrelated INPUT_CHANGED - the point of this test is only to prove no invented
    // identity is produced, so accept either outcome and only assert on rootIdentity when present.
    if (outcome.status === 'SUCCEEDED') {
      expect(outcome.result.provenance.rootIdentity).toBeNull()
    } else {
      expect(outcome.failureCode).toBe('INPUT_CHANGED')
    }
  })

  it('mutating a returned provenance array does not affect a subsequent independent call', async () => {
    const { deps: deps1 } = fakeAdapterDeps()
    const outcome1 = await propose(deps1)
    expect(outcome1.status).toBe('SUCCEEDED')
    if (outcome1.status !== 'SUCCEEDED') return
    outcome1.result.provenance.sourcePaths.push('src/tampered.ts')
    outcome1.result.provenance.decisions.push({ questionMarkdown: 'tampered', status: 'OPEN', resolvedOptionKey: null, resolutionNote: '' })

    const { deps: deps2 } = fakeAdapterDeps()
    const outcome2 = await propose(deps2)
    expect(outcome2.status).toBe('SUCCEEDED')
    if (outcome2.status !== 'SUCCEEDED') return
    expect(outcome2.result.provenance.sourcePaths).toEqual(['src/math.ts'])
    expect(outcome2.result.provenance.decisions).toEqual([])
  })
})

describe('proposeCodeChange - malformed raw request', () => {
  it('throws InvalidClaudeCodeChangeRequestError synchronously for a malformed request, not a FAILED outcome', async () => {
    const { deps } = fakeAdapterDeps()
    await expect(propose(deps, { projectId: 'not-a-number' })).rejects.toThrow(InvalidClaudeCodeChangeRequestError)
  })
})
