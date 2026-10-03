import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResult, Task } from '@shared/types'
import { createTaskStore } from './taskStore'

const list = vi.fn()
const create = vi.fn()
const update = vi.fn()
const updateStatus = vi.fn()
const updateDependencies = vi.fn()
const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 1,
    title: 'Task',
    goalMarkdown: '',
    descriptionMarkdown: '',
    priority: 'MEDIUM',
    status: 'BACKLOG',
    acceptanceCriteriaMarkdown: '',
    verificationRequirementsMarkdown: '',
    relevantFiles: [],
    blockedReason: '',
    dependsOnTaskIds: [],
    createdBy: 'LEON',
    createdAt: '2026-09-06',
    updatedAt: '2026-09-06',
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { eclipseHub: { tasks: { list, create, update, updateStatus, updateDependencies } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('project-scoped Task state', () => {
  it('discards late A responses during A -> B -> A switching', async () => {
    const pending = deferred<IpcResult<Task[]>>()
    list
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(ok([task({ id: 2, projectId: 2 })]))
      .mockResolvedValueOnce(ok([task({ id: 3, projectId: 1 })]))
    const firstA = createTaskStore(1, false)
    const oldLoad = firstA.getState().load()
    firstA.getState().dispose()
    const b = createTaskStore(2, false)
    expect(b.getState().tasks).toEqual([])
    await b.getState().load()
    b.getState().dispose()
    const nextA = createTaskStore(1, false)
    await nextA.getState().load()
    pending.resolve(ok([task({ id: 1 })]))
    await oldLoad
    expect(firstA.getState().tasks).toEqual([])
    expect(b.getState().tasks).toEqual([task({ id: 2, projectId: 2 })])
    expect(nextA.getState().tasks).toEqual([task({ id: 3, projectId: 1 })])
  })

  it('keeps the latest reload and ignores a stale failure', async () => {
    const pending = deferred<IpcResult<Task[]>>()
    list.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ok([task({ id: 5 })]))
    const store = createTaskStore(1, false)
    const oldLoad = store.getState().load()
    await store.getState().load()
    pending.resolve({ ok: false, error: { code: 'OLD', message: 'Stale error' } })
    await oldLoad
    expect(store.getState().tasks).toEqual([task({ id: 5 })])
    expect(store.getState().error).toBeNull()
  })

  it('blocks all writes on a read-only (archived) project', async () => {
    list.mockResolvedValue(ok([task()]))
    const store = createTaskStore(1, true)
    await store.getState().load()
    expect(await store.getState().create({ title: 'New', createdBy: 'LEON' })).toBeNull()
    expect(await store.getState().updateDetails({ id: 1, title: 'X' })).toBeNull()
    expect(await store.getState().updateStatus(1, 'READY')).toBeNull()
    expect(await store.getState().updateDependencies(1, [])).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(updateStatus).not.toHaveBeenCalled()
    expect(updateDependencies).not.toHaveBeenCalled()
  })

  it('appends a newly created Task to the list', async () => {
    list.mockResolvedValue(ok([]))
    create.mockResolvedValue(ok(task({ id: 9, title: 'Created' })))
    const store = createTaskStore(1, false)
    await store.getState().load()
    const created = await store.getState().create({ title: 'Created', createdBy: 'LEON' })
    expect(created?.title).toBe('Created')
    expect(store.getState().tasks).toEqual([task({ id: 9, title: 'Created' })])
    expect(create).toHaveBeenCalledWith({ title: 'Created', createdBy: 'LEON', projectId: 1 })
  })

  it('replaces the matching Task after updateDetails, updateStatus and updateDependencies', async () => {
    list.mockResolvedValue(ok([task({ id: 1 }), task({ id: 2, title: 'Other' })]))
    update.mockResolvedValue(ok(task({ id: 1, title: 'Renamed' })))
    updateStatus.mockResolvedValue(ok(task({ id: 1, title: 'Renamed', status: 'READY' })))
    updateDependencies.mockResolvedValue(ok(task({ id: 1, title: 'Renamed', status: 'READY', dependsOnTaskIds: [2] })))
    const store = createTaskStore(1, false)
    await store.getState().load()

    await store.getState().updateDetails({ id: 1, title: 'Renamed' })
    expect(store.getState().tasks.find((t) => t.id === 1)?.title).toBe('Renamed')
    expect(store.getState().tasks.find((t) => t.id === 2)?.title).toBe('Other')

    await store.getState().updateStatus(1, 'READY')
    expect(store.getState().tasks.find((t) => t.id === 1)?.status).toBe('READY')

    await store.getState().updateDependencies(1, [2])
    expect(store.getState().tasks.find((t) => t.id === 1)?.dependsOnTaskIds).toEqual([2])
  })

  it('prevents duplicate pending saves and ignores completion after dispose', async () => {
    list.mockResolvedValue(ok([]))
    const pending = deferred<IpcResult<Task>>()
    create.mockReturnValue(pending.promise)
    const store = createTaskStore(1, false)
    await store.getState().load()
    const input = { title: 'Draft', createdBy: 'LEON' as const }
    const saving = store.getState().create(input)
    expect(await store.getState().create(input)).toBeNull()
    store.getState().dispose()
    pending.resolve(ok(task()))
    expect(await saving).toBeNull()
    expect(store.getState().tasks).toEqual([])
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('reports a failed mutation without dropping existing Tasks', async () => {
    list.mockResolvedValue(ok([task()]))
    update.mockResolvedValue({ ok: false, error: { code: 'ProjectArchivedError', message: 'Archived' } })
    const store = createTaskStore(1, false)
    await store.getState().load()
    expect(await store.getState().updateDetails({ id: 1, title: 'X' })).toBeNull()
    expect(store.getState().tasks).toEqual([task()])
    expect(store.getState().error).toBe('Archived')
    expect(store.getState().saving).toBe(false)
  })

  // ChatGPT review fix 2 - a pending load and a newer mutation both write to
  // `tasks`. Without invalidating the pending load when a mutation begins, an
  // older load that resolves AFTER a newer mutation has already landed could
  // silently overwrite the fresher mutation result with stale data.
  it('does not let an older pending load overwrite a newer create result (Fix 2, case A)', async () => {
    const pendingList = deferred<IpcResult<Task[]>>()
    list.mockReturnValueOnce(pendingList.promise)
    create.mockResolvedValue(ok(task({ id: 9, title: 'Created' })))
    const store = createTaskStore(1, false)

    const oldLoad = store.getState().load()
    expect(store.getState().loading).toBe(true)

    const created = await store.getState().create({ title: 'Created', createdBy: 'LEON' })
    expect(created?.title).toBe('Created')
    expect(store.getState().tasks).toEqual([task({ id: 9, title: 'Created' })])
    // Starting the mutation must leave `loading` consistent (not stuck true)
    // even though the load it invalidated never got to resolve normally.
    expect(store.getState().loading).toBe(false)

    // The stale load now resolves with older (empty) data - it must be
    // discarded, not overwrite the newer mutation result.
    pendingList.resolve(ok([]))
    await oldLoad
    expect(store.getState().tasks).toEqual([task({ id: 9, title: 'Created' })])
  })

  it('does not let a stale reload overwrite a newer updateDetails result (Fix 2, case A)', async () => {
    list.mockResolvedValueOnce(ok([task({ id: 1, title: 'Original' })]))
    const store = createTaskStore(1, false)
    await store.getState().load()
    expect(store.getState().tasks).toEqual([task({ id: 1, title: 'Original' })])

    // A second (now stale) reload starts but does not resolve yet.
    const pendingReload = deferred<IpcResult<Task[]>>()
    list.mockReturnValueOnce(pendingReload.promise)
    update.mockResolvedValue(ok(task({ id: 1, title: 'Renamed' })))
    const staleReload = store.getState().load()

    const updated = await store.getState().updateDetails({ id: 1, title: 'Renamed' })
    expect(updated?.title).toBe('Renamed')
    expect(store.getState().tasks).toEqual([task({ id: 1, title: 'Renamed' })])

    // The stale reload now resolves with the OLD title - it must not clobber
    // the already-applied, newer mutation result.
    pendingReload.resolve(ok([task({ id: 1, title: 'Original' })]))
    await staleReload
    expect(store.getState().tasks).toEqual([task({ id: 1, title: 'Renamed' })])
  })

  it('does not start a new load while a mutation is saving, and the final state reflects the mutation (Fix 2, case B)', async () => {
    list.mockResolvedValue(ok([task({ id: 1 })]))
    const pendingUpdate = deferred<IpcResult<Task>>()
    update.mockReturnValue(pendingUpdate.promise)
    const store = createTaskStore(1, false)
    await store.getState().load()
    expect(list).toHaveBeenCalledTimes(1)

    const mutating = store.getState().updateDetails({ id: 1, title: 'Renamed' })
    expect(store.getState().saving).toBe(true)

    // A load attempted while saving must be a no-op - it must not fetch, and
    // must not race the in-flight mutation.
    await store.getState().load()
    expect(list).toHaveBeenCalledTimes(1)

    pendingUpdate.resolve(ok(task({ id: 1, title: 'Renamed' })))
    await mutating
    expect(store.getState().tasks).toEqual([task({ id: 1, title: 'Renamed' })])
  })

  it('keeps A -> B -> A switching and dispose behavior correct alongside the Fix 2 guard changes', async () => {
    const pending = deferred<IpcResult<Task[]>>()
    list
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(ok([task({ id: 2, projectId: 2 })]))
      .mockResolvedValueOnce(ok([task({ id: 3, projectId: 1 })]))
    const firstA = createTaskStore(1, false)
    const oldLoad = firstA.getState().load()
    firstA.getState().dispose()
    const b = createTaskStore(2, false)
    await b.getState().load()
    b.getState().dispose()
    const nextA = createTaskStore(1, false)
    await nextA.getState().load()
    pending.resolve(ok([task({ id: 1 })]))
    await oldLoad
    expect(firstA.getState().tasks).toEqual([])
    expect(b.getState().tasks).toEqual([task({ id: 2, projectId: 2 })])
    expect(nextA.getState().tasks).toEqual([task({ id: 3, projectId: 1 })])
  })
})
