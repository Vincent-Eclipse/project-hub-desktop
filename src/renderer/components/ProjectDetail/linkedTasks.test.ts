import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@shared/types'
import { createLinkedTaskLoader, fetchLinkedTasksById, linkedTaskFetchSignature } from './linkedTasks'

function task(id: number): Task {
  return { id, title: `T${id}` } as Task
}

describe('fetchLinkedTasksById (ChatGPT-Re-Review Fix 2)', () => {
  it('A) fetches only the linked Task ID via getTask - never touches an unrelated backlog', async () => {
    const list = vi.fn()
    const get = vi.fn(async (_projectId: number, taskId: number) => task(taskId))
    const result = await fetchLinkedTasksById(1, [42], get)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith(1, 42)
    expect(list).not.toHaveBeenCalled()
    expect(result).toEqual({ 42: task(42) })
  })

  it('B) fetches exactly the linked set for multiple IDs, one entry per ID', async () => {
    const get = vi.fn(async (_projectId: number, taskId: number) => task(taskId))
    const result = await fetchLinkedTasksById(1, [5, 9], get)
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledWith(1, 5)
    expect(get).toHaveBeenCalledWith(1, 9)
    expect(result).toEqual({ 5: task(5), 9: task(9) })
  })

  it('omits a specific linked Task that fails to load, without crashing or losing the others', async () => {
    const get = vi.fn(async (_projectId: number, taskId: number) => {
      if (taskId === 2) throw new Error('deleted')
      return task(taskId)
    })
    const result = await fetchLinkedTasksById(1, [1, 2, 3], get)
    expect(result).toEqual({ 1: task(1), 3: task(3) })
  })

  it('resolves an empty map for no linked IDs without calling getTask', async () => {
    const get = vi.fn(async (_projectId: number, taskId: number) => task(taskId))
    expect(await fetchLinkedTasksById(1, [], get)).toEqual({})
    expect(get).not.toHaveBeenCalled()
  })
})

describe('linkedTaskFetchSignature', () => {
  it('C) is identical for the same projectId + ordered taskIds, even across different objects', () => {
    expect(linkedTaskFetchSignature(7, [1, 2])).toBe(linkedTaskFetchSignature(7, [...[1, 2]]))
  })

  it('D) changes when the ordered taskIds or the projectId change', () => {
    expect(linkedTaskFetchSignature(7, [1, 2])).not.toBe(linkedTaskFetchSignature(7, [2, 1]))
    expect(linkedTaskFetchSignature(7, [1, 2])).not.toBe(linkedTaskFetchSignature(7, [1, 2, 3]))
    expect(linkedTaskFetchSignature(7, [1, 2])).not.toBe(linkedTaskFetchSignature(8, [1, 2]))
  })
})

describe('createLinkedTaskLoader (stale-result protection)', () => {
  it('E) discards a slower, older load once a newer load for a different selection has already resolved', async () => {
    let resolveFirst: (t: Task) => void = () => {}
    const get = vi.fn((_projectId: number, taskId: number) => {
      if (taskId === 1) return new Promise<Task>((resolve) => { resolveFirst = resolve })
      return Promise.resolve(task(taskId))
    })
    const loader = createLinkedTaskLoader(get)
    const results: Array<Record<number, Task>> = []

    const firstLoad = loader.load(1, [1], (byId) => results.push(byId))
    await loader.load(1, [2], (byId) => results.push(byId))
    resolveFirst(task(1))
    await firstLoad

    expect(results).toEqual([{ 2: task(2) }])
  })

  it('delivers the result normally when no newer load supersedes it', async () => {
    const get = vi.fn(async (_projectId: number, taskId: number) => task(taskId))
    const loader = createLinkedTaskLoader(get)
    const results: Array<Record<number, Task>> = []
    await loader.load(1, [3], (byId) => results.push(byId))
    expect(results).toEqual([{ 3: task(3) }])
  })

  it('discards a load that resolves after dispose()', async () => {
    let resolveIt: (t: Task) => void = () => {}
    const get = vi.fn(() => new Promise<Task>((resolve) => { resolveIt = resolve }))
    const loader = createLinkedTaskLoader(get)
    const results: Array<Record<number, Task>> = []
    const pending = loader.load(1, [1], (byId) => results.push(byId))
    loader.dispose()
    resolveIt(task(1))
    await pending
    expect(results).toEqual([])
  })
})
