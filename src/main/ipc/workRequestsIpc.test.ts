import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { AppInfo, IpcResult, WorkRequestDetail } from '@shared/types'
import type { EclipseHubApi } from '../../preload/index'
import type { FileLogger } from '../logger'
import { createTestDb } from '../testUtils/testDb'
import { archiveProject, createProject } from '../services/projectsService'
import { applyPlanningResult, setWorkRequestStatus } from '../services/workRequestService'
import { registerIpc } from './registerIpc'
import { createCodeChangeReviewRegistry } from '../services/codeChangeReviewService'

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
let db: ReturnType<typeof createTestDb>
let projectId: number
const call = (channel: string, raw: unknown) => handlers.get(`workRequests:${channel}`)!(null, raw)
const input = () => ({ projectId, intentMarkdown: 'Ich moechte X bauen.' })
beforeEach(() => {
  db = createTestDb()
  projectId = createProject(db, { name: 'IPC Work', projectType: 'Test', description: '' }).id
  handlers.clear()
  registerIpc({
    db,
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as FileLogger,
    appInfo: {} as AppInfo,
    getMainWebContentsId: () => null,
    codeChangeReviews: createCodeChangeReviewRegistry()
  })
})
afterEach(() => db.close())

describe('Work Requests IPC and preload', () => {
  it('registers only the five renderer-approved channels - no applyPlanningResult/replaceTaskLinks/setWorkRequestStatus', () => {
    const registered = [...handlers.keys()].filter((key) => key.startsWith('workRequests:'))
    expect(registered.sort()).toEqual([
      'workRequests:create',
      'workRequests:get',
      'workRequests:list',
      'workRequests:resolveDecision',
      'workRequests:updateIntent'
    ])
  })

  it('rejects malformed requests on all five channels', async () => {
    for (const raw of [null, undefined, [], 'invalid', {}]) {
      for (const channel of ['list', 'get', 'create', 'updateIntent', 'resolveDecision']) {
        expect(await call(channel, raw)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
      }
    }
  })

  it('supports create, list, get and updateIntent end-to-end against SQLite', async () => {
    const created = (await call('create', input())) as IpcResult<WorkRequestDetail>
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('create failed')
    const wr = created.data
    expect(wr.createdBy).toBe('LEON')
    expect(await call('list', { projectId })).toMatchObject({ ok: true, data: [{ id: wr.id }] })
    expect(await call('get', { projectId, id: wr.id })).toEqual(created)

    const updated = (await call('updateIntent', { projectId, id: wr.id, intentMarkdown: 'Neue Fassung' })) as IpcResult<WorkRequestDetail>
    expect(updated.ok).toBe(true)
    if (!updated.ok) throw new Error('update failed')
    expect(updated.data.intentMarkdown).toBe('Neue Fassung')
  })

  // ChatGPT re-review Fix 3 - the list contract must be genuinely
  // lightweight over IPC, not just at the TypeScript type level.
  it('list results never expose intentMarkdown, planMarkdown, decisions or taskIds', async () => {
    const created = (await call('create', input())) as { ok: true; data: WorkRequestDetail }
    const listed = (await call('list', { projectId })) as IpcResult<Array<Record<string, unknown>>>
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error('list failed')
    expect(listed.data).toHaveLength(1)
    const [entry] = listed.data
    expect(entry.id).toBe(created.data.id)
    expect(entry).not.toHaveProperty('intentMarkdown')
    expect(entry).not.toHaveProperty('planMarkdown')
    expect(entry).not.toHaveProperty('createdBy')
    expect(entry).not.toHaveProperty('decisions')
    expect(entry).not.toHaveProperty('taskIds')
    expect(Object.keys(entry).sort()).toEqual(['createdAt', 'id', 'projectId', 'status', 'title', 'updatedAt'])
  })

  it('never accepts createdBy from the renderer - it is always forced to LEON server-side', async () => {
    const created = (await call('create', { ...input(), createdBy: 'CHATGPT' })) as { ok: true; data: WorkRequestDetail }
    expect(created.ok).toBe(true)
    expect(created.data.createdBy).toBe('LEON')
  })

  it('rejects invalid create fields', async () => {
    for (const fields of [{ intentMarkdown: '' }, { intentMarkdown: '   ' }, { intentMarkdown: 'x'.repeat(50_001) }]) {
      expect(await call('create', { ...input(), ...fields })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    }
    expect(await call('list', { projectId })).toEqual({ ok: true, data: [] })
  })

  it('maps ownership mismatches and unknown ids safely on reads', async () => {
    const created = (await call('create', input())) as { ok: true; data: WorkRequestDetail }
    const other = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    expect(await call('get', { projectId: other, id: created.data.id })).toMatchObject({
      ok: false,
      error: { code: 'WorkRequestMismatchError' }
    })
    expect(await call('get', { projectId, id: 99999 })).toMatchObject({ ok: false, error: { code: 'WorkRequestNotFoundError' } })
    expect(await call('list', { projectId: 99999 })).toMatchObject({ ok: false, error: { code: 'ProjectNotFoundError' } })
  })

  it('rejects cross-project updateIntent - a Work Request from another project cannot be hijacked', async () => {
    const projectA = projectId
    const projectB = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const inB = (await handlers.get('workRequests:create')!(null, { projectId: projectB, intentMarkdown: 'B intent' })) as {
      ok: true
      data: WorkRequestDetail
    }
    expect(await call('updateIntent', { projectId: projectA, id: inB.data.id, intentMarkdown: 'Hijacked' })).toMatchObject({
      ok: false,
      error: { code: 'WorkRequestMismatchError' }
    })
    const unchanged = await call('get', { projectId: projectB, id: inB.data.id })
    expect(unchanged).toEqual(inB)
  })

  it('rejects updateIntent once planning has been applied', async () => {
    const created = (await call('create', input())) as { ok: true; data: WorkRequestDetail }
    applyPlanningResult(db, { projectId, id: created.data.id, planningResult: { planMarkdown: 'Plan', decisionRequests: [] } })
    expect(await call('updateIntent', { projectId, id: created.data.id, intentMarkdown: 'Neu' })).toMatchObject({
      ok: false,
      error: { code: 'WorkRequestNotEditableError' }
    })
  })

  // ChatGPT-Re-Review Fix 1 (v4), scenario C: the same server-side invariant
  // must hold through the renderer-facing IPC channel, not just the direct
  // service call - status alone (even forced back to IDEA via the
  // Main/internal setWorkRequestStatus) must not re-open editing once a plan
  // and/or decisions exist.
  it('C) rejects updateIntent over IPC after a plan with no decisions, even once status is forced back to IDEA', async () => {
    const created = (await call('create', input())) as { ok: true; data: WorkRequestDetail }
    applyPlanningResult(db, { projectId, id: created.data.id, planningResult: { planMarkdown: 'Plan', decisionRequests: [] } })
    setWorkRequestStatus(db, { projectId, id: created.data.id, status: 'IDEA' })
    expect(await call('updateIntent', { projectId, id: created.data.id, intentMarkdown: 'Neu' })).toMatchObject({
      ok: false,
      error: { code: 'WorkRequestNotEditableError' }
    })
    const unchanged = await call('get', { projectId, id: created.data.id })
    expect((unchanged as { ok: true; data: WorkRequestDetail }).data.intentMarkdown).toBe(input().intentMarkdown)
  })

  it('C) rejects updateIntent over IPC after a plan with decisions, even once status is forced back to IDEA', async () => {
    const created = (await call('create', input())) as { ok: true; data: WorkRequestDetail }
    applyPlanningResult(db, {
      projectId,
      id: created.data.id,
      planningResult: {
        planMarkdown: 'Plan',
        decisionRequests: [{ questionMarkdown: 'Q?', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }]
      }
    })
    setWorkRequestStatus(db, { projectId, id: created.data.id, status: 'IDEA' })
    expect(await call('updateIntent', { projectId, id: created.data.id, intentMarkdown: 'Neu' })).toMatchObject({
      ok: false,
      error: { code: 'WorkRequestNotEditableError' }
    })
  })

  it('resolves a decision end-to-end and rejects an unknown option key', async () => {
    const created = (await call('create', input())) as { ok: true; data: WorkRequestDetail }
    const planned = applyPlanningResult(db, {
      projectId,
      id: created.data.id,
      planningResult: {
        planMarkdown: 'Plan',
        decisionRequests: [{ questionMarkdown: 'Q?', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }]
      }
    })
    const decisionId = planned.decisions[0].id

    expect(
      await call('resolveDecision', { projectId, workRequestId: created.data.id, decisionId, optionKey: 'does-not-exist' })
    ).toMatchObject({ ok: false, error: { code: 'InvalidDecisionError' } })

    const resolved = (await call('resolveDecision', {
      projectId,
      workRequestId: created.data.id,
      decisionId,
      optionKey: 'a'
    })) as IpcResult<WorkRequestDetail>
    expect(resolved).toMatchObject({ ok: true, data: { status: 'READY', decisions: [{ status: 'RESOLVED', resolvedOptionKey: 'a' }] } })
  })

  it('rejects cross-project decision resolution', async () => {
    const projectA = projectId
    const projectB = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const inB = (await handlers.get('workRequests:create')!(null, { projectId: projectB, intentMarkdown: 'B intent' })) as {
      ok: true
      data: WorkRequestDetail
    }
    const planned = applyPlanningResult(db, {
      projectId: projectB,
      id: inB.data.id,
      planningResult: {
        planMarkdown: 'Plan',
        decisionRequests: [{ questionMarkdown: 'Q?', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }]
      }
    })
    expect(
      await call('resolveDecision', {
        projectId: projectA,
        workRequestId: inB.data.id,
        decisionId: planned.decisions[0].id,
        optionKey: 'a'
      })
    ).toMatchObject({ ok: false, error: { code: 'WorkRequestMismatchError' } })
  })

  it('rejects writes on archived projects but keeps reads working', async () => {
    const created = (await call('create', input())) as { ok: true; data: WorkRequestDetail }
    archiveProject(db, projectId)
    expect(await call('create', input())).toMatchObject({ ok: false, error: { code: 'ProjectArchivedError' } })
    expect(await call('updateIntent', { projectId, id: created.data.id, intentMarkdown: 'Neu' })).toMatchObject({
      ok: false,
      error: { code: 'ProjectArchivedError' }
    })
    expect((await call('list', { projectId })).ok).toBe(true)
    expect((await call('get', { projectId, id: created.data.id })).ok).toBe(true)
  })

  it('maps unexpected DB errors to a generic response', async () => {
    db.exec('DROP TABLE work_requests')
    expect(await call('list', { projectId })).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Ein interner Fehler ist aufgetreten.' }
    })
  })

  it('exposes only the five typed workRequests methods, no raw ipcRenderer/generic invoke', async () => {
    await import('../../preload/index')
    const api = expose.mock.calls[0][1] as EclipseHubApi
    expect(Object.keys(api.workRequests).sort()).toEqual(['create', 'get', 'list', 'resolveDecision', 'updateIntent'])
    expectTypeOf(api.workRequests.list).returns.toEqualTypeOf<
      Promise<IpcResult<import('@shared/types').WorkRequestSummary[]>>
    >()
    expectTypeOf(api.workRequests.get).returns.toEqualTypeOf<Promise<IpcResult<WorkRequestDetail>>>()

    await api.workRequests.list(7)
    expect(invoke).toHaveBeenLastCalledWith('workRequests:list', { projectId: 7 })
    await api.workRequests.get(7, 3)
    expect(invoke).toHaveBeenLastCalledWith('workRequests:get', { projectId: 7, id: 3 })
    await api.workRequests.create({ projectId: 7, intentMarkdown: 'X' })
    expect(invoke).toHaveBeenLastCalledWith('workRequests:create', { projectId: 7, intentMarkdown: 'X' })
    await api.workRequests.updateIntent({ projectId: 7, id: 3, intentMarkdown: 'Y' })
    expect(invoke).toHaveBeenLastCalledWith('workRequests:updateIntent', { projectId: 7, id: 3, intentMarkdown: 'Y' })
    await api.workRequests.resolveDecision({ projectId: 7, workRequestId: 3, decisionId: 1, optionKey: 'a' })
    expect(invoke).toHaveBeenLastCalledWith('workRequests:resolveDecision', {
      projectId: 7,
      workRequestId: 3,
      decisionId: 1,
      optionKey: 'a'
    })
    expect(api).not.toHaveProperty('invoke')
    expect(api).not.toHaveProperty('ipcRenderer')
    // No method on the exposed surface can trigger applyPlanningResult/replaceTaskLinks/setWorkRequestStatus.
    expect(api.workRequests).not.toHaveProperty('applyPlanningResult')
    expect(api.workRequests).not.toHaveProperty('replaceTaskLinks')
    expect(api.workRequests).not.toHaveProperty('setStatus')
    expect(api.workRequests).not.toHaveProperty('setWorkRequestStatus')
  })
})
