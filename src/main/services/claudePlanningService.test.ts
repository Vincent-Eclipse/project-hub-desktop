import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { ControllerPlan } from '@shared/types'
import { createTestDb } from '../testUtils/testDb'
import { archiveProject, createProject, ProjectArchivedError, ProjectNotFoundError, updateProject } from './projectsService'
import { createContextVersion } from './contextService'
import { createRuleVersion } from './rulesService'
import { createTask } from './taskService'
import { listEventLog } from './eventLogService'
import {
  applyPlanningResult,
  createWorkRequest,
  resolveDecision,
  updateWorkRequestIntent,
  WorkRequestMismatchError,
  WorkRequestNotFoundError
} from './workRequestService'
import type { ClaudeCliAdapterDeps, ClaudeChildProcess, ClaudeProcessLauncher } from './claudeCliAdapter'
import { CONTEXT_PACK_MAX_BYTES, InvalidClaudePlanningRequestError, planWithClaude, validateClaudePlanningRequest } from './claudePlanningService'

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

function validPlan(): ControllerPlan {
  return { planningResult: { planMarkdown: 'Plan', decisionRequests: [] }, taskDrafts: [] }
}

// Matches the ACTUAL Claude Code 2.1.266 envelope shape observed by the first real smoke test -
// the ControllerPlan proposal is the `structured_output` object, never JSON text inside `result`.
function successEnvelope(plan: ControllerPlan = validPlan()): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'synthetic discarded result text',
    session_id: 'fake-session',
    structured_output: plan
  })
}

function respondToVersionCheck(): FakeChildProcess {
  const child = new FakeChildProcess()
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from('2.1.266', 'utf8'))
    child.emit('close', 0, null)
  })
  return child
}

/**
 * Builds fake adapter deps. `onInvoke` runs synchronously (via queueMicrotask) once the
 * real (non `--version`) invocation call is made, and it receives the launcher-call's argv
 * and options plus the stdin payload that was written - used both to inspect what was sent
 * to Claude, and to simulate relevant DB state changing WHILE Claude is "running" (for the
 * stale-input tests).
 */
function fakeAdapterDeps(options: {
  plan?: ControllerPlan
  onInvoke?: (call: { args: string[]; stdinPayload: string }) => void
} = {}): { deps: ClaudeCliAdapterDeps; invocationArgs: string[][] } {
  const invocationArgs: string[][] = []
  const executablePath = process.execPath // any existing file works - preflight is short-circuited by the fake launcher itself
  const launcher: ClaudeProcessLauncher = (_executable, args) => {
    if (args.includes('--version')) return respondToVersionCheck()
    invocationArgs.push(args)
    const child = new FakeChildProcess()
    const originalWrite = child.stdin.write
    child.stdin.write = vi.fn((chunk: string) => {
      originalWrite(chunk)
      options.onInvoke?.({ args, stdinPayload: chunk })
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(successEnvelope(options.plan), 'utf8'))
        child.emit('close', 0, null)
      })
    })
    return child
  }
  return {
    invocationArgs,
    deps: { launcher, killProcessTree: async () => {}, executablePath }
  }
}

let db: Database.Database
let projectId: number
let workRequestId: number

beforeEach(() => {
  db = createTestDb()
  projectId = createProject(db, { name: 'Eclipse Hub', projectType: 'App', description: 'A local project manager' }).id
  workRequestId = createWorkRequest(db, { projectId, intentMarkdown: 'Add a dark mode toggle', createdBy: 'LEON' }).id
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

describe('validateClaudePlanningRequest - raw request shape', () => {
  it('accepts a minimal valid request', () => {
    expect(validateClaudePlanningRequest({ projectId: 1, workRequestId: 2 })).toEqual({ projectId: 1, workRequestId: 2 })
  })

  it.each([
    { projectRoot: 'C:\\Eclipse Projekte\\Project Hub M3 Work' },
    { folder: 'C:\\somewhere' },
    { prompt: 'do something' },
    { systemPrompt: 'you are...' },
    { model: 'claude-opus' },
    { provider: 'CLAUDE' },
    { executable: 'C:\\evil\\claude.exe' },
    { tools: ['bash'] },
    { permissions: { bypass: true } },
    { policy: 'allow-all' },
    { arguments: ['--dangerously-skip-permissions'] },
    { flags: ['--bare'] },
    { sessionId: 'abc' },
    { resumeId: 'abc' },
    { agent: 'controller' },
    { approval: true }
  ])('rejects an extra field %o', (extra) => {
    expect(() => validateClaudePlanningRequest({ projectId: 1, workRequestId: 1, ...extra })).toThrow(
      InvalidClaudePlanningRequestError
    )
  })

  it('rejects non-integer, zero, negative and non-numeric IDs', () => {
    expect(() => validateClaudePlanningRequest({ projectId: 0, workRequestId: 1 })).toThrow(InvalidClaudePlanningRequestError)
    expect(() => validateClaudePlanningRequest({ projectId: -1, workRequestId: 1 })).toThrow(InvalidClaudePlanningRequestError)
    expect(() => validateClaudePlanningRequest({ projectId: 1.5, workRequestId: 1 })).toThrow(InvalidClaudePlanningRequestError)
    expect(() => validateClaudePlanningRequest({ projectId: '1', workRequestId: 1 })).toThrow(InvalidClaudePlanningRequestError)
  })

  it('rejects non-object input', () => {
    expect(() => validateClaudePlanningRequest(null)).toThrow(InvalidClaudePlanningRequestError)
    expect(() => validateClaudePlanningRequest('1')).toThrow(InvalidClaudePlanningRequestError)
    expect(() => validateClaudePlanningRequest([1, 2])).toThrow(InvalidClaudePlanningRequestError)
  })
})

describe('planWithClaude - project/work request resolution', () => {
  it('rejects a missing project', async () => {
    const { deps } = fakeAdapterDeps()
    await expect(planWithClaude(db, deps, { projectId: 999_999, workRequestId })).rejects.toThrow(ProjectNotFoundError)
  })

  it('rejects an archived project', async () => {
    archiveProject(db, projectId)
    const { deps } = fakeAdapterDeps()
    await expect(planWithClaude(db, deps, { projectId, workRequestId })).rejects.toThrow(ProjectArchivedError)
  })

  it('rejects a Work Request that does not exist', async () => {
    const { deps } = fakeAdapterDeps()
    await expect(planWithClaude(db, deps, { projectId, workRequestId: 999_999 })).rejects.toThrow(WorkRequestNotFoundError)
  })

  it('rejects a foreign Work Request (belonging to a different project)', async () => {
    const otherProjectId = createProject(db, { name: 'Other', projectType: 'App', description: '' }).id
    const { deps } = fakeAdapterDeps()
    await expect(planWithClaude(db, deps, { projectId: otherProjectId, workRequestId })).rejects.toThrow(WorkRequestMismatchError)
  })
})

describe('planWithClaude - Context Pack contents', () => {
  it('sends no project folder/repository data and only the expected bounded fields', async () => {
    let capturedStdin = ''
    const { deps } = fakeAdapterDeps({ onInvoke: ({ stdinPayload }) => (capturedStdin = stdinPayload) })
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome.status).toBe('SUCCEEDED')

    const pack = JSON.parse(capturedStdin)
    expect(Object.keys(pack).sort()).toEqual(['context', 'decisions', 'project', 'rules', 'workRequest'])
    expect(Object.keys(pack.project).sort()).toEqual(['description', 'name', 'projectType'])
    expect(pack.workRequest).toEqual({ intentMarkdown: 'Add a dark mode toggle' })
    expect(pack.rules).toBeNull()
    expect(pack.context).toBeNull()
    expect(pack.decisions).toEqual([])

    expect(capturedStdin).not.toMatch(/folderPath|projectRoot|C:\\\\|\.git/i)
  })

  it('includes the current Rules completely and captures the Rules version metadata', async () => {
    const rules = createRuleVersion(db, { projectId, contentMarkdown: '# Rules\nBe careful.', createdBy: 'LEON' })
    let capturedStdin = ''
    const { deps } = fakeAdapterDeps({ onInvoke: ({ stdinPayload }) => (capturedStdin = stdinPayload) })
    await planWithClaude(db, deps, { projectId, workRequestId })
    const pack = JSON.parse(capturedStdin)
    expect(pack.rules).toEqual({ versionId: rules.id, versionNumber: rules.versionNumber, contentMarkdown: '# Rules\nBe careful.' })
  })

  it('captures the current Context version completely', async () => {
    const context = createContextVersion(db, { projectId, contentMarkdown: '# Context\nCurrent state.', createdBy: 'LEON' })
    let capturedStdin = ''
    const { deps } = fakeAdapterDeps({ onInvoke: ({ stdinPayload }) => (capturedStdin = stdinPayload) })
    await planWithClaude(db, deps, { projectId, workRequestId })
    const pack = JSON.parse(capturedStdin)
    expect(pack.context).toEqual({
      versionId: context.id,
      versionNumber: context.versionNumber,
      contentMarkdown: '# Context\nCurrent state.'
    })
  })

  it('never includes chat history, source code or Git diff data', async () => {
    let capturedStdin = ''
    const { deps } = fakeAdapterDeps({ onInvoke: ({ stdinPayload }) => (capturedStdin = stdinPayload) })
    await planWithClaude(db, deps, { projectId, workRequestId })
    expect(capturedStdin).not.toMatch(/diff --git|@@ -|chatMessage|rawResponse/i)
  })

  it('fails INPUT_LIMIT before invoking Claude when the Context Pack exceeds the cap', async () => {
    createRuleVersion(db, { projectId, contentMarkdown: 'x'.repeat(49_000), createdBy: 'LEON' })
    createContextVersion(db, { projectId, contentMarkdown: 'x'.repeat(49_000), createdBy: 'LEON' })
    const { deps, invocationArgs } = fakeAdapterDeps()
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_LIMIT' })
    expect(invocationArgs.length).toBe(0)
  })

  it('CONTEXT_PACK_MAX_BYTES matches the documented 64 KiB stdin cap', () => {
    expect(CONTEXT_PACK_MAX_BYTES).toBe(64 * 1024)
  })
})

describe('planWithClaude - success path and trust boundary', () => {
  it('returns the Hub-validated proposal as untrusted planning data on success', async () => {
    const { deps } = fakeAdapterDeps()
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome).toEqual({ status: 'SUCCEEDED', proposal: validPlan() })
  })

  it('passes adapter-level failures through unchanged', async () => {
    const launcher: ClaudeProcessLauncher = (_executable, args) => {
      if (args.includes('--version')) return respondToVersionCheck()
      const child = new FakeChildProcess()
      queueMicrotask(() => child.emit('close', 1, null))
      return child
    }
    const deps: ClaudeCliAdapterDeps = { launcher, killProcessTree: async () => {}, executablePath: process.execPath }
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'PROCESS_FAILED' })
  })
})

describe('planWithClaude - stale input protection', () => {
  it('discards the proposal when the Work Request intent changes during the invocation', async () => {
    const { deps } = fakeAdapterDeps({
      onInvoke: () => updateWorkRequestIntent(db, { projectId, id: workRequestId, intentMarkdown: 'Different intent now' })
    })
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the Rules version changes during the invocation', async () => {
    createRuleVersion(db, { projectId, contentMarkdown: 'v1', createdBy: 'LEON' })
    const { deps } = fakeAdapterDeps({
      onInvoke: () => createRuleVersion(db, { projectId, contentMarkdown: 'v2', createdBy: 'LEON' })
    })
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the Context version changes during the invocation', async () => {
    createContextVersion(db, { projectId, contentMarkdown: 'v1', createdBy: 'LEON' })
    const { deps } = fakeAdapterDeps({
      onInvoke: () => createContextVersion(db, { projectId, contentMarkdown: 'v2', createdBy: 'LEON' })
    })
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the project is archived during the invocation', async () => {
    const { deps } = fakeAdapterDeps({ onInvoke: () => archiveProject(db, projectId) })
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the project is deleted during the invocation', async () => {
    const { deps } = fakeAdapterDeps({ onInvoke: () => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId) })
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when the project name/type/description changes during the invocation (exact Context Pack comparison)', async () => {
    const { deps } = fakeAdapterDeps({
      onInvoke: () => updateProject(db, { id: projectId, description: 'A different description entirely' })
    })
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('discards the proposal when a Work Request decision is resolved during the invocation (exact Context Pack comparison)', async () => {
    const planned = applyPlanningResult(db, {
      projectId,
      id: workRequestId,
      planningResult: {
        planMarkdown: 'Plan',
        decisionRequests: [
          {
            questionMarkdown: 'Which approach?',
            options: [
              { key: 'a', label: 'Approach A' },
              { key: 'b', label: 'Approach B' }
            ]
          }
        ]
      }
    })
    const decisionId = planned.decisions[0].id
    const { deps } = fakeAdapterDeps({
      onInvoke: () => resolveDecision(db, { projectId, workRequestId, decisionId, optionKey: 'a' })
    })
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_CHANGED' })
  })

  it('succeeds when nothing relevant changed during the invocation', async () => {
    const { deps } = fakeAdapterDeps({ onInvoke: () => undefined })
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome.status).toBe('SUCCEEDED')
  })
})

describe('planWithClaude - no side effects', () => {
  it('never creates a Task, mutates the Work Request, writes an event log entry, or persists the Claude result', async () => {
    const tasksBefore = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
    const eventsBefore = listEventLog(db).length
    const workRequestRowBefore = db.prepare('SELECT * FROM work_requests WHERE id = ?').get(workRequestId)

    const { deps } = fakeAdapterDeps()
    const outcome = await planWithClaude(db, deps, { projectId, workRequestId })
    expect(outcome.status).toBe('SUCCEEDED')

    const tasksAfter = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
    expect(tasksAfter.n).toBe(tasksBefore.n)
    const eventsAfter = listEventLog(db)
    expect(eventsAfter.length).toBe(eventsBefore)
    expect(eventsAfter.every((entry) => !JSON.stringify(entry.payload).includes('planMarkdown'))).toBe(true)
    const workRequestRowAfter = db.prepare('SELECT * FROM work_requests WHERE id = ?').get(workRequestId)
    expect(workRequestRowAfter).toEqual(workRequestRowBefore)

    // Sanity check that the mutating functions this test asserts were never called still work at
    // all in this test DB (i.e. the assertion above is meaningful, not vacuous).
    expect(() => createTask(db, { projectId, title: 'Manual task', createdBy: 'LEON' })).not.toThrow()
    expect(() => applyPlanningResult(db, { projectId, id: workRequestId, planningResult: validPlan().planningResult })).not.toThrow()
  })
})
