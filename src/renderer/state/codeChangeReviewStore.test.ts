import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResult } from '@shared/types'
import type { CodeChangeReviewProjection } from '@shared/codeChangeReviewTypes'
import { canApproveReview, canRequestChanges, createCodeChangeReviewStore } from './codeChangeReviewStore'

const list = vi.fn()
const get = vi.fn()
const approve = vi.fn()
const requestChanges = vi.fn()
const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })

function review(overrides: Partial<CodeChangeReviewProjection> = {}): CodeChangeReviewProjection {
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
    createdAt: '2026-09-08T00:00:00.000Z',
    expiresAt: '2026-09-08T02:00:00.000Z',
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
  vi.stubGlobal('window', { eclipseHub: { codeChangeReviews: { list, get, approve, requestChanges } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('canApproveReview / canRequestChanges', () => {
  it('offers Approve only for a PENDING review on a non-read-only project', () => {
    expect(canApproveReview(review({ state: 'PENDING' }), false)).toBe(true)
    expect(canApproveReview(review({ state: 'APPROVED' }), false)).toBe(false)
    expect(canApproveReview(review({ state: 'CHANGES_REQUESTED' }), false)).toBe(false)
    expect(canApproveReview(review({ state: 'PENDING' }), true)).toBe(false)
    expect(canApproveReview(null, false)).toBe(false)
  })

  it('offers Request Changes for PENDING or APPROVED, never CHANGES_REQUESTED, never read-only', () => {
    expect(canRequestChanges(review({ state: 'PENDING' }), false)).toBe(true)
    expect(canRequestChanges(review({ state: 'APPROVED' }), false)).toBe(true)
    expect(canRequestChanges(review({ state: 'CHANGES_REQUESTED' }), false)).toBe(false)
    expect(canRequestChanges(review({ state: 'PENDING' }), true)).toBe(false)
    expect(canRequestChanges(null, false)).toBe(false)
  })
})

describe('project-scoped code change review state', () => {
  it('loads the review list for the store\'s own project only', async () => {
    list.mockResolvedValue(ok([review()]))
    const store = createCodeChangeReviewStore(1, false)
    await store.getState().loadList()
    expect(list).toHaveBeenCalledWith(1)
    expect(store.getState().reviews).toEqual([review()])
    expect(store.getState().loadingList).toBe(false)
  })

  it('discards a stale list response after a project switch (A -> B -> A guard)', async () => {
    const pending = deferred<IpcResult<CodeChangeReviewProjection[]>>()
    list.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ok([review({ reviewId: 'r-b' })]))
    const storeA = createCodeChangeReviewStore(1, false)
    const staleLoad = storeA.getState().loadList()
    storeA.getState().dispose()
    const storeB = createCodeChangeReviewStore(2, false)
    await storeB.getState().loadList()
    pending.resolve(ok([review({ reviewId: 'r-a' })]))
    await staleLoad
    expect(storeA.getState().reviews).toEqual([])
    expect(storeB.getState().reviews).toEqual([review({ reviewId: 'r-b' })])
  })

  it('discards a stale select() response when a newer selection has already landed', async () => {
    const pendingFirst = deferred<IpcResult<CodeChangeReviewProjection>>()
    get.mockReturnValueOnce(pendingFirst.promise).mockResolvedValueOnce(ok(review({ reviewId: 'r-2', summary: 'Second' })))
    const store = createCodeChangeReviewStore(1, false)
    const staleSelect = store.getState().select('r-1')
    await store.getState().select('r-2')
    pendingFirst.resolve(ok(review({ reviewId: 'r-1', summary: 'First' })))
    await staleSelect
    expect(store.getState().selected).toEqual(review({ reviewId: 'r-2', summary: 'Second' }))
    expect(store.getState().selectedId).toBe('r-2')
  })

  it('clears selection immediately when selecting null, without waiting for any pending response', async () => {
    get.mockResolvedValue(ok(review()))
    const store = createCodeChangeReviewStore(1, false)
    await store.getState().select('r-1')
    expect(store.getState().selected).not.toBeNull()
    await store.getState().select(null)
    expect(store.getState().selected).toBeNull()
    expect(store.getState().selectedId).toBeNull()
    expect(store.getState().loadingSelected).toBe(false)
  })

  it('blocks Approve/Request Changes on a read-only (archived) project', async () => {
    list.mockResolvedValue(ok([review()]))
    get.mockResolvedValue(ok(review()))
    const store = createCodeChangeReviewStore(1, true)
    await store.getState().loadList()
    await store.getState().select('r-1')
    expect(await store.getState().approve()).toBeNull()
    expect(await store.getState().requestChanges('fix it')).toBeNull()
    expect(approve).not.toHaveBeenCalled()
    expect(requestChanges).not.toHaveBeenCalled()
  })

  it('approves the selected review and updates both selected and the list entry', async () => {
    list.mockResolvedValue(ok([review()]))
    get.mockResolvedValue(ok(review()))
    approve.mockResolvedValue(ok(review({ state: 'APPROVED' })))
    const store = createCodeChangeReviewStore(1, false)
    await store.getState().loadList()
    await store.getState().select('r-1')
    const result = await store.getState().approve()
    expect(result?.state).toBe('APPROVED')
    expect(approve).toHaveBeenCalledWith(1, 'r-1')
    expect(store.getState().selected?.state).toBe('APPROVED')
    expect(store.getState().reviews[0].state).toBe('APPROVED')
  })

  it('requests changes with the given feedback and updates state', async () => {
    list.mockResolvedValue(ok([review()]))
    get.mockResolvedValue(ok(review()))
    requestChanges.mockResolvedValue(ok(review({ state: 'CHANGES_REQUESTED', feedback: 'please add a test' })))
    const store = createCodeChangeReviewStore(1, false)
    await store.getState().loadList()
    await store.getState().select('r-1')
    const result = await store.getState().requestChanges('please add a test')
    expect(result?.state).toBe('CHANGES_REQUESTED')
    expect(requestChanges).toHaveBeenCalledWith(1, 'r-1', 'please add a test')
    expect(store.getState().selected?.feedback).toBe('please add a test')
  })

  it('returns null and does nothing when no review is selected', async () => {
    list.mockResolvedValue(ok([]))
    const store = createCodeChangeReviewStore(1, false)
    await store.getState().loadList()
    expect(await store.getState().approve()).toBeNull()
    expect(await store.getState().requestChanges('x')).toBeNull()
    expect(approve).not.toHaveBeenCalled()
    expect(requestChanges).not.toHaveBeenCalled()
  })

  it('surfaces an error message when a decision call fails, without crashing', async () => {
    list.mockResolvedValue(ok([review()]))
    get.mockResolvedValue(ok(review()))
    approve.mockResolvedValue({ ok: false, error: { code: 'REVIEW_ALREADY_DECIDED', message: 'Ueber diese Review wurde bereits entschieden.' } })
    const store = createCodeChangeReviewStore(1, false)
    await store.getState().loadList()
    await store.getState().select('r-1')
    const result = await store.getState().approve()
    expect(result).toBeNull()
    expect(store.getState().error).toContain('bereits entschieden')
    expect(store.getState().deciding).toBe(false)
  })

  it('dispose() invalidates all in-flight guards so no later response can land', async () => {
    const pending = deferred<IpcResult<CodeChangeReviewProjection[]>>()
    list.mockReturnValueOnce(pending.promise)
    const store = createCodeChangeReviewStore(1, false)
    const inFlight = store.getState().loadList()
    store.getState().dispose()
    pending.resolve(ok([review()]))
    await inFlight
    expect(store.getState().reviews).toEqual([])
  })
})
