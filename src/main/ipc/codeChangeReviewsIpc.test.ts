import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { AppInfo, IpcResult } from '@shared/types'
import type { CodeChangeReviewProjection, CodeChangeReviewSummary } from '@shared/codeChangeReviewTypes'
import type { FileLogger } from '../logger'
import { IpcChannels } from '@shared/ipcChannels'
import { registerIpc } from './registerIpc'
import { createCodeChangeReviewRegistry, type CodeChangeReviewRegistry } from '../services/codeChangeReviewService'
import type { CodeChangeGenerationProvenance, ValidatedCodeChangePackage } from '../services/claudeCodeChangeService'

// Meilenstein 4.8A Teil O/P - IPC-Schicht-Tests fuer die vier Review-Kanaele.
// Exercised: exakte Eingabeform (kein proposal/approved/fingerprint/root/
// policy/capabilities/writeScope/source/changes durchgelassen), die
// dedizierte Sender-Identitaets-Pruefung, und dass die Registry-Methoden mit
// genau den validierten, identifier-only Werten aufgerufen werden. Die
// Registry selbst ist hier eine FAKE (codeChangeReviewService.ts's eigene
// Tests decken die tatsaechliche Geschaefts-/Fingerprint-/Zustandslogik
// bereits vollstaendig ab) - dieser Test isoliert die IPC-Verdrahtung/
// -Validierung/-Sender-Pruefung selbst.

const { handlers, invoke, expose } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>>(),
  invoke: vi.fn(),
  expose: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>) =>
      handlers.set(channel, handler)
  },
  ipcRenderer: { invoke },
  contextBridge: { exposeInMainWorld: expose },
  clipboard: {},
  dialog: {},
  shell: {}
}))

const EXPECTED_WEBCONTENTS_ID = 1

function trustedEvent(): unknown {
  const mainFrame = {}
  return { sender: { id: EXPECTED_WEBCONTENTS_ID, isDestroyed: () => false, mainFrame }, senderFrame: mainFrame }
}
function subframeEvent(): unknown {
  const sender = { id: EXPECTED_WEBCONTENTS_ID, isDestroyed: () => false, mainFrame: {} }
  return { sender, senderFrame: {} } // a different object reference than sender.mainFrame
}
function destroyedSenderEvent(): unknown {
  const mainFrame = {}
  return { sender: { id: EXPECTED_WEBCONTENTS_ID, isDestroyed: () => true, mainFrame }, senderFrame: mainFrame }
}
function foreignWindowEvent(): unknown {
  const mainFrame = {}
  return { sender: { id: 999, isDestroyed: () => false, mainFrame }, senderFrame: mainFrame }
}
function noWindowRegisteredContext(): { getMainWebContentsId: () => number | null } {
  return { getMainWebContentsId: () => null }
}

function fakeProjection(overrides: Partial<CodeChangeReviewProjection> = {}): CodeChangeReviewProjection {
  return {
    reviewId: 'r-1',
    projectId: 1,
    taskId: 1,
    workRequestId: 1,
    state: 'PENDING',
    summary: 'Update add()',
    warnings: [],
    files: [],
    feedback: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T02:00:00.000Z',
    ...overrides
  }
}

function fakeSummary(overrides: Partial<CodeChangeReviewSummary> = {}): CodeChangeReviewSummary {
  return {
    reviewId: 'r-1',
    projectId: 1,
    taskId: 1,
    workRequestId: 1,
    state: 'PENDING',
    summary: 'Update add()',
    warnings: [],
    fileCount: 0,
    feedback: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T02:00:00.000Z',
    ...overrides
  }
}

interface FakeRegistry extends CodeChangeReviewRegistry {
  listCalls: number[]
  getCalls: Array<[number, string]>
  approveCalls: Array<[number, string]>
  requestChangesCalls: Array<[number, string, unknown]>
  resolveAuthoritativeCalls: Array<[number, string]>
}

function fakeRegistry(): FakeRegistry {
  const listCalls: number[] = []
  const getCalls: Array<[number, string]> = []
  const approveCalls: Array<[number, string]> = []
  const requestChangesCalls: Array<[number, string, unknown]> = []
  const resolveAuthoritativeCalls: Array<[number, string]> = []
  return {
    createReview: () => fakeProjection(),
    listReviewsForProject: (projectId) => {
      listCalls.push(projectId)
      return [fakeSummary()]
    },
    getReview: (projectId, reviewId) => {
      getCalls.push([projectId, reviewId])
      return fakeProjection({ reviewId })
    },
    approveReview: (projectId, reviewId) => {
      approveCalls.push([projectId, reviewId])
      return fakeProjection({ reviewId, state: 'APPROVED' })
    },
    requestChanges: (projectId, reviewId, feedback) => {
      requestChangesCalls.push([projectId, reviewId, feedback])
      return fakeProjection({ reviewId, state: 'CHANGES_REQUESTED', feedback: feedback as string })
    },
    // M4.8A V2 - Main-only, never invoked from any IPC handler. Recording calls here lets the
    // "no IPC path reaches resolveAuthoritative" test below prove that directly.
    resolveAuthoritative: (projectId, reviewId) => {
      resolveAuthoritativeCalls.push([projectId, reviewId])
      throw new Error('resolveAuthoritative must never be reachable from IPC')
    },
    listCalls,
    getCalls,
    approveCalls,
    requestChangesCalls,
    resolveAuthoritativeCalls
  }
}

let registry: FakeRegistry
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as FileLogger

function setup(getMainWebContentsId: () => number | null = () => EXPECTED_WEBCONTENTS_ID): void {
  registry = fakeRegistry()
  handlers.clear()
  registerIpc({ db: {} as Database.Database, logger, appInfo: {} as AppInfo, codeChangeReviews: registry, getMainWebContentsId })
}

beforeEach(() => {
  vi.restoreAllMocks()
  setup()
})

describe('codeChangeReviews IPC - exact-shape input validation', () => {
  it.each([
    { proposal: { summary: 'x', changes: [], warnings: [] } },
    { approved: true },
    { fingerprint: 'deadbeef' },
    { root: 'C:\\evil' },
    { policy: { 'filesystem.write': 'ALLOW' } },
    { capabilities: ['filesystem.write'] },
    { writeScope: ['src/a.ts'] },
    { source: 'x' },
    { changes: [{ type: 'MODIFY', path: 'src/a.ts', content: 'x' }] }
  ])('list rejects an unknown field %o', async (extra) => {
    const result = await handlers.get(IpcChannels.codeChangeReviewsList)!(trustedEvent(), { projectId: 1, ...extra })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(registry.listCalls).toEqual([])
  })

  it.each([
    { approved: true },
    { fingerprint: 'deadbeef' },
    { proposal: {} },
    { root: 'C:\\evil' },
    { policy: {} },
    { capabilities: [] },
    { writeScope: [] },
    { source: 'x' },
    { changes: [] }
  ])('approve rejects an unknown field %o', async (extra) => {
    const result = await handlers.get(IpcChannels.codeChangeReviewsApprove)!(trustedEvent(), {
      projectId: 1,
      reviewId: 'r-1',
      ...extra
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(registry.approveCalls).toEqual([])
  })

  it('requestChanges rejects a fingerprint field alongside otherwise-valid input', async () => {
    const result = await handlers.get(IpcChannels.codeChangeReviewsRequestChanges)!(trustedEvent(), {
      projectId: 1,
      reviewId: 'r-1',
      feedback: 'please fix it',
      fingerprint: 'deadbeef'
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(registry.requestChangesCalls).toEqual([])
  })

  it('rejects a non-string reviewId and a non-positive-integer projectId', async () => {
    expect(await handlers.get(IpcChannels.codeChangeReviewsGet)!(trustedEvent(), { projectId: 1, reviewId: 123 })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
    expect(
      await handlers.get(IpcChannels.codeChangeReviewsGet)!(trustedEvent(), { projectId: 'one', reviewId: 'r-1' })
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })

  it('there is no create/apply channel at all', () => {
    expect((IpcChannels as Record<string, string>).codeChangeReviewsCreate).toBeUndefined()
    expect((IpcChannels as Record<string, string>).codeChangeReviewsApply).toBeUndefined()
  })

  it('M4.8A V2: no registered IPC handler ever calls resolveAuthoritative() (Main-only authoritative resolver)', async () => {
    await handlers.get(IpcChannels.codeChangeReviewsList)!(trustedEvent(), { projectId: 1 })
    await handlers.get(IpcChannels.codeChangeReviewsGet)!(trustedEvent(), { projectId: 1, reviewId: 'r-1' })
    await handlers.get(IpcChannels.codeChangeReviewsApprove)!(trustedEvent(), { projectId: 1, reviewId: 'r-1' })
    await handlers.get(IpcChannels.codeChangeReviewsRequestChanges)!(trustedEvent(), { projectId: 1, reviewId: 'r-1', feedback: 'x' })
    expect(registry.resolveAuthoritativeCalls).toEqual([])
  })
})

describe('codeChangeReviews IPC - sender validation (Part P)', () => {
  it('a normal registered top-level renderer succeeds', async () => {
    const result = await handlers.get(IpcChannels.codeChangeReviewsList)!(trustedEvent(), { projectId: 1 })
    expect(result).toMatchObject({ ok: true })
    expect(registry.listCalls).toEqual([1])
  })

  it('rejects when no window is registered yet', async () => {
    setup(noWindowRegisteredContext().getMainWebContentsId)
    const result = await handlers.get(IpcChannels.codeChangeReviewsList)!(trustedEvent(), { projectId: 1 })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(registry.listCalls).toEqual([])
  })

  it('rejects a sender from an unregistered/foreign window', async () => {
    const result = await handlers.get(IpcChannels.codeChangeReviewsGet)!(foreignWindowEvent(), { projectId: 1, reviewId: 'r-1' })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(registry.getCalls).toEqual([])
  })

  it('rejects a destroyed sender', async () => {
    const result = await handlers.get(IpcChannels.codeChangeReviewsApprove)!(destroyedSenderEvent(), { projectId: 1, reviewId: 'r-1' })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(registry.approveCalls).toEqual([])
  })

  it('rejects a call from a subframe/iframe of the registered window', async () => {
    const result = await handlers.get(IpcChannels.codeChangeReviewsRequestChanges)!(subframeEvent(), {
      projectId: 1,
      reviewId: 'r-1',
      feedback: 'fix it'
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(registry.requestChangesCalls).toEqual([])
  })

  it('applies the same sender validation to read-only list/get, since source review text is sensitive', async () => {
    const listResult = await handlers.get(IpcChannels.codeChangeReviewsList)!(foreignWindowEvent(), { projectId: 1 })
    const getResult = await handlers.get(IpcChannels.codeChangeReviewsGet)!(foreignWindowEvent(), { projectId: 1, reviewId: 'r-1' })
    expect(listResult).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(getResult).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })
})

describe('codeChangeReviews IPC - happy path wiring', () => {
  it('list passes only projectId through to the registry and returns lightweight summaries', async () => {
    const result = await handlers.get(IpcChannels.codeChangeReviewsList)!(trustedEvent(), { projectId: 7 })
    expect(result).toMatchObject({ ok: true, data: [fakeSummary()] })
    expect(registry.listCalls).toEqual([7])
  })

  it('get passes projectId+reviewId through to the registry', async () => {
    const result = await handlers.get(IpcChannels.codeChangeReviewsGet)!(trustedEvent(), { projectId: 7, reviewId: 'r-2' })
    expect(result).toMatchObject({ ok: true, data: fakeProjection({ reviewId: 'r-2' }) })
    expect(registry.getCalls).toEqual([[7, 'r-2']])
  })

  it('approve passes projectId+reviewId through and returns the APPROVED projection', async () => {
    const result = await handlers.get(IpcChannels.codeChangeReviewsApprove)!(trustedEvent(), { projectId: 7, reviewId: 'r-3' })
    expect(result).toMatchObject({ ok: true, data: { state: 'APPROVED' } })
    expect(registry.approveCalls).toEqual([[7, 'r-3']])
  })

  it('requestChanges passes projectId+reviewId+feedback through and returns the CHANGES_REQUESTED projection', async () => {
    const result = await handlers.get(IpcChannels.codeChangeReviewsRequestChanges)!(trustedEvent(), {
      projectId: 7,
      reviewId: 'r-4',
      feedback: 'please add a test'
    })
    expect(result).toMatchObject({ ok: true, data: { state: 'CHANGES_REQUESTED', feedback: 'please add a test' } })
    expect(registry.requestChangesCalls).toEqual([[7, 'r-4', 'please add a test']])
  })
})

// ---------------------------------------------------------------------------
// End-to-end through the REAL registry (not the fake above) - proves the
// PROJECT_MISMATCH error code genuinely propagates through
// registerIpc -> codeChangeReviewService -> ipcError.ts's dedicated
// CodeChangeReviewError branch, not just through a hand-rolled fake.
// ---------------------------------------------------------------------------

function realProvenance(overrides: Partial<CodeChangeGenerationProvenance> = {}): CodeChangeGenerationProvenance {
  return {
    projectId: 1,
    taskId: 1,
    workRequestId: 1,
    project: { name: 'Demo', projectType: 'App', description: '' },
    projectFolderPath: 'C:\\demo',
    projectFolderComparisonKey: 'c:\\demo',
    rootIdentity: null,
    workRequest: { intentMarkdown: 'x', planMarkdown: null, status: 'IDEA' },
    task: {
      title: 'x',
      goalMarkdown: '',
      descriptionMarkdown: '',
      priority: 'MEDIUM',
      status: 'TODO',
      acceptanceCriteriaMarkdown: '',
      verificationRequirementsMarkdown: ''
    },
    rules: null,
    context: null,
    decisions: [],
    sourcePaths: [],
    modifyPaths: [],
    createPaths: ['src/new.ts'],
    disclosedRelativePaths: [],
    sourceFiles: [],
    createPreconditions: [{ path: 'src/new.ts', verifiedAbsent: true }],
    ...overrides
  }
}

function realPackage(): ValidatedCodeChangePackage {
  const provenance = realProvenance()
  return {
    proposal: { summary: 'Add file', changes: [{ type: 'CREATE', path: 'src/new.ts', content: 'x\n' }], warnings: [] },
    sourceSnapshot: [],
    createPreconditions: provenance.createPreconditions,
    provenance
  }
}

describe('codeChangeReviews IPC - end-to-end project binding through the real registry', () => {
  it('a review created for project 1 cannot be retrieved or decided under project 2', async () => {
    const realRegistry = createCodeChangeReviewRegistry()
    const created = realRegistry.createReview(realPackage())
    handlers.clear()
    registerIpc({
      db: {} as Database.Database,
      logger,
      appInfo: {} as AppInfo,
      codeChangeReviews: realRegistry,
      getMainWebContentsId: () => EXPECTED_WEBCONTENTS_ID
    })

    const getResult = await handlers.get(IpcChannels.codeChangeReviewsGet)!(trustedEvent(), {
      projectId: 2,
      reviewId: created.reviewId
    })
    const approveResult = await handlers.get(IpcChannels.codeChangeReviewsApprove)!(trustedEvent(), {
      projectId: 2,
      reviewId: created.reviewId
    })
    expect(getResult).toEqual({ ok: false, error: { code: 'PROJECT_MISMATCH', message: expect.any(String) } })
    expect(approveResult).toEqual({ ok: false, error: { code: 'PROJECT_MISMATCH', message: expect.any(String) } })

    // The SAME review under its OWN project still resolves normally.
    const ownProjectResult = await handlers.get(IpcChannels.codeChangeReviewsGet)!(trustedEvent(), {
      projectId: 1,
      reviewId: created.reviewId
    })
    expect(ownProjectResult).toMatchObject({ ok: true, data: { reviewId: created.reviewId, projectId: 1 } })
  })
})

describe('preload exposes exactly the four review methods, never create/apply', () => {
  it('exposes list/get/approve/requestChanges only', async () => {
    await import('../../preload/index')
    const api = expose.mock.calls[expose.mock.calls.length - 1][1] as import('../../preload/index').EclipseHubApi
    expect(Object.keys(api.codeChangeReviews).sort()).toEqual(['approve', 'get', 'list', 'requestChanges'])
    await api.codeChangeReviews.list(3)
    expect(invoke).toHaveBeenLastCalledWith('codeChangeReviews:list', { projectId: 3 })
    await api.codeChangeReviews.get(3, 'r-9')
    expect(invoke).toHaveBeenLastCalledWith('codeChangeReviews:get', { projectId: 3, reviewId: 'r-9' })
    await api.codeChangeReviews.approve(3, 'r-9')
    expect(invoke).toHaveBeenLastCalledWith('codeChangeReviews:approve', { projectId: 3, reviewId: 'r-9' })
    await api.codeChangeReviews.requestChanges(3, 'r-9', 'fix it')
    expect(invoke).toHaveBeenLastCalledWith('codeChangeReviews:requestChanges', { projectId: 3, reviewId: 'r-9', feedback: 'fix it' })
  })
})
