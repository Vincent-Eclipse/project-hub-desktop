import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { AppInfo, IpcResult, Task } from '@shared/types'
import type { EclipseHubApi } from '../../preload/index'
import type { FileLogger } from '../logger'
import { createTestDb } from '../testUtils/testDb'
import { archiveProject, createProject } from '../services/projectsService'
import { listEventLog } from '../services/eventLogService'
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
const call = (channel: string, raw: unknown) => handlers.get(`tasks:${channel}`)!(null, raw)
const input = () => ({ projectId, title: 'Implement feature', createdBy: 'LEON' })
beforeEach(() => {
  db = createTestDb()
  projectId = createProject(db, { name: 'IPC Tasks', projectType: 'Test', description: '' }).id
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

describe('Tasks IPC and preload', () => {
  it('rejects malformed requests on all six channels', async () => {
    for (const raw of [null, undefined, [], 'invalid', {}]) {
      for (const channel of ['list', 'get', 'create', 'update', 'updateStatus', 'updateDependencies']) {
        expect(await call(channel, raw)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
      }
    }
  })

  it('supports create, list, get, update, updateStatus and updateDependencies end-to-end against SQLite', async () => {
    const created = (await call('create', input())) as IpcResult<Task>
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('create failed')
    const task = created.data
    expect(await call('list', { projectId })).toEqual({ ok: true, data: [task] })
    expect(await call('get', { projectId, taskId: task.id })).toEqual(created)

    const updated = (await call('update', { projectId, id: task.id, title: 'Renamed' })) as IpcResult<Task>
    expect(updated.ok).toBe(true)
    if (!updated.ok) throw new Error('update failed')
    expect(updated.data.title).toBe('Renamed')

    const statusUpdated = (await call('updateStatus', { projectId, id: task.id, status: 'READY' })) as IpcResult<Task>
    expect(statusUpdated.ok).toBe(true)
    if (!statusUpdated.ok) throw new Error('status update failed')
    expect(statusUpdated.data.status).toBe('READY')

    const other = (await call('create', { ...input(), title: 'Dependency target' })) as IpcResult<Task>
    if (!other.ok) throw new Error('create failed')
    const depsUpdated = (await call('updateDependencies', {
      projectId,
      id: task.id,
      dependsOnTaskIds: [other.data.id]
    })) as IpcResult<Task>
    expect(depsUpdated.ok).toBe(true)
    if (!depsUpdated.ok) throw new Error('deps update failed')
    expect(depsUpdated.data.dependsOnTaskIds).toEqual([other.data.id])
  })

  it('rejects invalid create fields', async () => {
    for (const fields of [{ title: '' }, { title: 'x'.repeat(201) }, { priority: 'URGENT' }, { status: 'UNKNOWN' }, { createdBy: 'INVALID' }]) {
      expect(await call('create', { ...input(), ...fields })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    }
    expect(await call('list', { projectId })).toEqual({ ok: true, data: [] })
  })

  it('rejects unsafe relevant file paths via IPC without touching disk', async () => {
    for (const relevantFiles of [['../escape.ts'], ['/etc/passwd'], ['C:\\Windows\\System32'], ['\\\\server\\share']]) {
      expect(await call('create', { ...input(), relevantFiles })).toMatchObject({
        ok: false,
        error: { code: 'InvalidRelevantFileError' }
      })
    }
  })

  // ChatGPT review fix 4 - the canonical one-path-per-line format is
  // enforced at the IPC boundary too, not only in the service unit tests.
  it('rejects non-canonical relevant file paths via IPC (leading/trailing whitespace, CR, LF)', async () => {
    for (const relevantFiles of [[' file.ts'], ['file.ts '], ['a\nb'], ['a\rb']]) {
      expect(await call('create', { ...input(), relevantFiles })).toMatchObject({
        ok: false,
        error: { code: 'InvalidRelevantFileError' }
      })
    }
  })

  it('accepts a canonical relevant file path with internal spaces via IPC', async () => {
    const created = (await call('create', { ...input(), relevantFiles: ['my folder/file.ts'] })) as {
      ok: true
      data: Task
    }
    expect(created.ok).toBe(true)
    expect(created.data.relevantFiles).toEqual(['my folder/file.ts'])
  })

  it('maps ownership mismatches and unknown ids safely on reads', async () => {
    const created = (await call('create', input())) as { ok: true; data: Task }
    const other = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    expect(await call('get', { projectId: other, taskId: created.data.id })).toMatchObject({
      ok: false,
      error: { code: 'TaskMismatchError' }
    })
    expect(await call('get', { projectId, taskId: 99999 })).toMatchObject({ ok: false, error: { code: 'TaskNotFoundError' } })
    expect(await call('list', { projectId: 99999 })).toMatchObject({ ok: false, error: { code: 'ProjectNotFoundError' } })
  })

  it('rejects malformed payloads missing projectId on all three mutation channels', async () => {
    const created = (await call('create', input())) as { ok: true; data: Task }
    expect(await call('update', { id: created.data.id, title: 'X' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
    expect(await call('updateStatus', { id: created.data.id, status: 'READY' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
    expect(await call('updateDependencies', { id: created.data.id, dependsOnTaskIds: [] })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
  })

  // ChatGPT review fix 1 - Task mutations must be project-scoped exactly like
  // reads (list/get): a caller that supplies a Task ID belonging to a
  // DIFFERENT project than the one it claims must be rejected, never
  // silently applied to the Task's actual project.
  it('rejects update/updateStatus/updateDependencies when projectId does not match the Task\u2019s actual project', async () => {
    const projectA = projectId
    const projectB = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const inB = (await handlers.get('tasks:create')!(null, { projectId: projectB, title: 'Owned by B', createdBy: 'LEON' })) as {
      ok: true
      data: Task
    }

    expect(await call('update', { projectId: projectA, id: inB.data.id, title: 'Hijacked' })).toMatchObject({
      ok: false,
      error: { code: 'TaskMismatchError' }
    })
    expect(await call('updateStatus', { projectId: projectA, id: inB.data.id, status: 'DONE' })).toMatchObject({
      ok: false,
      error: { code: 'TaskMismatchError' }
    })
    expect(await call('updateDependencies', { projectId: projectA, id: inB.data.id, dependsOnTaskIds: [] })).toMatchObject({
      ok: false,
      error: { code: 'TaskMismatchError' }
    })

    // The foreign Task must be completely unchanged, and no audit event must
    // have been written for either project.
    const unchanged = await call('get', { projectId: projectB, taskId: inB.data.id })
    expect(unchanged).toEqual(inB)
    expect(listEventLog(db, { projectId: projectA, type: 'TASK_UPDATED' })).toEqual([])
    expect(listEventLog(db, { projectId: projectA, type: 'TASK_STATUS_CHANGED' })).toEqual([])
    expect(listEventLog(db, { projectId: projectA, type: 'TASK_DEPENDENCIES_UPDATED' })).toEqual([])
    expect(listEventLog(db, { projectId: projectB, type: 'TASK_UPDATED' })).toEqual([])
    expect(listEventLog(db, { projectId: projectB, type: 'TASK_STATUS_CHANGED' })).toEqual([])
    expect(listEventLog(db, { projectId: projectB, type: 'TASK_DEPENDENCIES_UPDATED' })).toEqual([])

    // A correctly-scoped mutation on the SAME Task via its real project must still work.
    const legit = await call('update', { projectId: projectB, id: inB.data.id, title: 'Legitimate rename' })
    expect(legit).toMatchObject({ ok: true, data: { title: 'Legitimate rename' } })
  })

  it('rejects cross-project and self dependencies, and dependency cycles', async () => {
    const created = (await call('create', input())) as { ok: true; data: Task }
    const other = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const foreign = (await handlers.get('tasks:create')!(null, { projectId: other, title: 'Foreign', createdBy: 'LEON' })) as {
      ok: true
      data: Task
    }
    expect(
      await call('updateDependencies', { projectId, id: created.data.id, dependsOnTaskIds: [created.data.id] })
    ).toMatchObject({
      ok: false,
      error: { code: 'InvalidTaskDependencyError' }
    })
    expect(
      await call('updateDependencies', { projectId, id: created.data.id, dependsOnTaskIds: [foreign.data.id] })
    ).toMatchObject({
      ok: false,
      error: { code: 'InvalidTaskDependencyError' }
    })

    const second = (await call('create', { ...input(), title: 'Second' })) as { ok: true; data: Task }
    await call('updateDependencies', { projectId, id: created.data.id, dependsOnTaskIds: [second.data.id] })
    expect(
      await call('updateDependencies', { projectId, id: second.data.id, dependsOnTaskIds: [created.data.id] })
    ).toMatchObject({
      ok: false,
      error: { code: 'InvalidTaskDependencyError' }
    })
  })

  it('rejects writes on archived projects but keeps reads working', async () => {
    const created = (await call('create', input())) as { ok: true; data: Task }
    archiveProject(db, projectId)
    expect(await call('create', input())).toMatchObject({ ok: false, error: { code: 'ProjectArchivedError' } })
    expect(await call('update', { projectId, id: created.data.id, title: 'New' })).toMatchObject({
      ok: false,
      error: { code: 'ProjectArchivedError' }
    })
    expect(await call('updateStatus', { projectId, id: created.data.id, status: 'READY' })).toMatchObject({
      ok: false,
      error: { code: 'ProjectArchivedError' }
    })
    expect(await call('updateDependencies', { projectId, id: created.data.id, dependsOnTaskIds: [] })).toMatchObject({
      ok: false,
      error: { code: 'ProjectArchivedError' }
    })
    expect((await call('list', { projectId })).ok).toBe(true)
    expect((await call('get', { projectId, taskId: created.data.id })).ok).toBe(true)
  })

  it('maps unexpected DB errors to a generic response', async () => {
    db.exec('DROP TABLE tasks')
    expect(await call('list', { projectId })).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Ein interner Fehler ist aufgetreten.' }
    })
  })

  it('exposes only the six typed Tasks methods and sends projectId on all three mutation channels', async () => {
    await import('../../preload/index')
    const api = expose.mock.calls[0][1] as EclipseHubApi
    expect(Object.keys(api.tasks).sort()).toEqual(['create', 'get', 'list', 'update', 'updateDependencies', 'updateStatus'])
    expectTypeOf(api.tasks.list).returns.toEqualTypeOf<Promise<IpcResult<Task[]>>>()
    expectTypeOf(api.tasks.get).returns.toEqualTypeOf<Promise<IpcResult<Task>>>()

    await api.tasks.list(7)
    expect(invoke).toHaveBeenLastCalledWith('tasks:list', { projectId: 7 })
    await api.tasks.get(7, 3)
    expect(invoke).toHaveBeenLastCalledWith('tasks:get', { projectId: 7, taskId: 3 })
    await api.tasks.create({ projectId: 7, title: 'X', createdBy: 'LEON' })
    expect(invoke).toHaveBeenLastCalledWith('tasks:create', { projectId: 7, title: 'X', createdBy: 'LEON' })
    await api.tasks.update({ projectId: 7, id: 3, title: 'Y' })
    expect(invoke).toHaveBeenLastCalledWith('tasks:update', { projectId: 7, id: 3, title: 'Y' })
    await api.tasks.updateStatus({ projectId: 7, id: 3, status: 'READY' })
    expect(invoke).toHaveBeenLastCalledWith('tasks:updateStatus', { projectId: 7, id: 3, status: 'READY' })
    await api.tasks.updateDependencies({ projectId: 7, id: 3, dependsOnTaskIds: [4] })
    expect(invoke).toHaveBeenLastCalledWith('tasks:updateDependencies', { projectId: 7, id: 3, dependsOnTaskIds: [4] })
    expect(api).not.toHaveProperty('invoke')
    expect(api).not.toHaveProperty('ipcRenderer')
  })
})
