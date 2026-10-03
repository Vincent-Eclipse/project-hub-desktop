import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResult, WorkRequestDecision, WorkRequestDetail, WorkRequestSummary } from '@shared/types'
import {
  canEditWorkRequestIntent,
  createWorkRequestStore,
  decisionsEmptyStateMessage,
  sortWorkRequestSummaries
} from './workRequestStore'

const list = vi.fn()
const get = vi.fn()
const create = vi.fn()
const updateIntent = vi.fn()
const resolveDecision = vi.fn()
const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })

// ChatGPT-Re-Review Fix 3: the store's `workRequests` list now holds the
// lightweight WorkRequestSummary - this fixture mirrors exactly that shape
// (no intentMarkdown/planMarkdown/createdBy). `detail()` builds the separate,
// full WorkRequestDetail returned by get/create/updateIntent/resolveDecision.
function summary(overrides: Partial<WorkRequestSummary> = {}): WorkRequestSummary {
  return {
    id: 1,
    projectId: 1,
    title: 'Titel',
    status: 'IDEA',
    createdAt: '2026-09-08',
    updatedAt: '2026-09-08',
    ...overrides
  }
}

function detail(overrides: Partial<WorkRequestDetail> = {}): WorkRequestDetail {
  return {
    id: 1,
    projectId: 1,
    title: 'Titel',
    intentMarkdown: 'Intent',
    planMarkdown: null,
    status: 'IDEA',
    createdBy: 'LEON',
    createdAt: '2026-09-08',
    updatedAt: '2026-09-08',
    decisions: [],
    taskIds: [],
    ...overrides
  }
}

function decision(overrides: Partial<WorkRequestDecision> = {}): WorkRequestDecision {
  return {
    id: 1,
    workRequestId: 1,
    questionMarkdown: 'Q?',
    options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
    recommendedOptionKey: null,
    recommendationMarkdown: '',
    status: 'OPEN',
    resolvedOptionKey: null,
    resolutionNote: '',
    createdAt: '2026-09-08',
    resolvedAt: null,
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
  vi.stubGlobal('window', { eclipseHub: { workRequests: { list, get, create, updateIntent, resolveDecision } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('project-scoped Work Request state', () => {
  it('discards late A list responses during A -> B -> A switching', async () => {
    const pending = deferred<IpcResult<WorkRequestSummary[]>>()
    list
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(ok([summary({ id: 2, projectId: 2 })]))
      .mockResolvedValueOnce(ok([summary({ id: 3, projectId: 1 })]))
    const firstA = createWorkRequestStore(1, false)
    const oldLoad = firstA.getState().loadList()
    firstA.getState().dispose()
    const b = createWorkRequestStore(2, false)
    await b.getState().loadList()
    b.getState().dispose()
    const nextA = createWorkRequestStore(1, false)
    await nextA.getState().loadList()
    pending.resolve(ok([summary({ id: 1 })]))
    await oldLoad
    expect(firstA.getState().workRequests).toEqual([])
    expect(b.getState().workRequests).toEqual([summary({ id: 2, projectId: 2 })])
    expect(nextA.getState().workRequests).toEqual([summary({ id: 3, projectId: 1 })])
  })

  it('discards a stale select() response when a newer selection has already landed', async () => {
    const pendingFirst = deferred<IpcResult<WorkRequestDetail>>()
    get.mockReturnValueOnce(pendingFirst.promise).mockResolvedValueOnce(ok(detail({ id: 2, title: 'Second' })))
    const store = createWorkRequestStore(1, false)
    const staleSelect = store.getState().select(1)
    await store.getState().select(2)
    pendingFirst.resolve(ok(detail({ id: 1, title: 'First' })))
    await staleSelect
    expect(store.getState().selected).toEqual(detail({ id: 2, title: 'Second' }))
    expect(store.getState().selectedId).toBe(2)
  })

  it('clears selection immediately when selecting null, without waiting for any pending response', async () => {
    get.mockResolvedValue(ok(detail()))
    const store = createWorkRequestStore(1, false)
    await store.getState().select(1)
    expect(store.getState().selected).not.toBeNull()
    await store.getState().select(null)
    expect(store.getState().selected).toBeNull()
    expect(store.getState().selectedId).toBeNull()
    expect(store.getState().loadingSelected).toBe(false)
  })

  it('blocks all writes on a read-only (archived) project', async () => {
    list.mockResolvedValue(ok([summary()]))
    get.mockResolvedValue(ok(detail()))
    const store = createWorkRequestStore(1, true)
    await store.getState().loadList()
    await store.getState().select(1)
    expect(await store.getState().create('Neue Idee')).toBeNull()
    expect(await store.getState().updateIntent('Neu')).toBeNull()
    expect(await store.getState().resolveDecision(1, 'a')).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(updateIntent).not.toHaveBeenCalled()
    expect(resolveDecision).not.toHaveBeenCalled()
  })

  it('creates a Work Request, prepends it to the list and selects it', async () => {
    list.mockResolvedValue(ok([]))
    create.mockResolvedValue(ok(detail({ id: 9, title: 'Neu' })))
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()
    const created = await store.getState().create('Neue Idee')
    expect(created?.title).toBe('Neu')
    expect(store.getState().workRequests).toEqual([summary({ id: 9, title: 'Neu' })])
    expect(store.getState().selectedId).toBe(9)
    expect(store.getState().selected).toEqual(detail({ id: 9, title: 'Neu' }))
    expect(create).toHaveBeenCalledWith({ projectId: 1, intentMarkdown: 'Neue Idee' })
  })

  it('replaces both selected and the matching list entry after updateIntent', async () => {
    list.mockResolvedValue(ok([summary({ id: 1 }), summary({ id: 2, title: 'Other' })]))
    get.mockResolvedValue(ok(detail({ id: 1 })))
    updateIntent.mockResolvedValue(ok(detail({ id: 1, title: 'Renamed', intentMarkdown: 'Neu' })))
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()
    await store.getState().select(1)

    await store.getState().updateIntent('Neu')
    expect(store.getState().selected?.title).toBe('Renamed')
    expect(store.getState().workRequests.find((wr) => wr.id === 1)?.title).toBe('Renamed')
    expect(store.getState().workRequests.find((wr) => wr.id === 2)?.title).toBe('Other')
  })

  it('replaces both selected and the matching list entry after resolveDecision', async () => {
    list.mockResolvedValue(ok([summary({ id: 1, status: 'NEEDS_DECISION' })]))
    get.mockResolvedValue(ok(detail({ id: 1, status: 'NEEDS_DECISION' })))
    resolveDecision.mockResolvedValue(ok(detail({ id: 1, status: 'READY' })))
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()
    await store.getState().select(1)

    const result = await store.getState().resolveDecision(5, 'opt-a')
    expect(result?.status).toBe('READY')
    expect(store.getState().selected?.status).toBe('READY')
    expect(store.getState().workRequests[0].status).toBe('READY')
    expect(resolveDecision).toHaveBeenCalledWith({ projectId: 1, workRequestId: 1, decisionId: 5, optionKey: 'opt-a' })
  })

  it('does nothing when updateIntent/resolveDecision are called with no selection', async () => {
    list.mockResolvedValue(ok([]))
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()
    expect(await store.getState().updateIntent('X')).toBeNull()
    expect(await store.getState().resolveDecision(1, 'a')).toBeNull()
    expect(updateIntent).not.toHaveBeenCalled()
    expect(resolveDecision).not.toHaveBeenCalled()
  })

  it('prevents duplicate pending saves and ignores completion after dispose', async () => {
    list.mockResolvedValue(ok([]))
    const pending = deferred<IpcResult<WorkRequestDetail>>()
    create.mockReturnValue(pending.promise)
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()
    const saving = store.getState().create('Draft')
    expect(await store.getState().create('Draft')).toBeNull()
    store.getState().dispose()
    pending.resolve(ok(detail()))
    expect(await saving).toBeNull()
    expect(store.getState().workRequests).toEqual([])
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('reports a failed mutation without dropping existing state', async () => {
    list.mockResolvedValue(ok([summary()]))
    get.mockResolvedValue(ok(detail()))
    updateIntent.mockResolvedValue({ ok: false, error: { code: 'ProjectArchivedError', message: 'Archived' } })
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()
    await store.getState().select(1)
    expect(await store.getState().updateIntent('X')).toBeNull()
    expect(store.getState().selected).toEqual(detail())
    expect(store.getState().error).toBe('Archived')
    expect(store.getState().saving).toBe(false)
  })

  // Same guard discipline established for taskStore.ts (M4.2 ChatGPT review
  // Fix 2): a mutation must invalidate any pending list/select load and keep
  // `loadingSelected` consistent, and loadList()/select() must not start a
  // new fetch while a mutation is saving - otherwise a stale response could
  // silently overwrite a newer mutation result.
  //
  // ChatGPT-Re-Review Fix 4 (v4) superseded this exact race at the source:
  // create() while `loadingSelected` is true is now refused outright (see
  // the dedicated Fix 4 test below), so the scenario this test originally
  // exercised (create() succeeding WHILE a select() is still pending, then a
  // stale select response arriving afterward) can no longer occur. Kept as a
  // regression guard that the refusal is real and the pending select still
  // resolves coherently once create() has backed off.
  it('does not let a stale select() response overwrite anything - create() refuses outright while select() is pending (Fix-2-style, case A / superseded by Fix 4)', async () => {
    list.mockResolvedValue(ok([]))
    const pendingSelect = deferred<IpcResult<WorkRequestDetail>>()
    get.mockReturnValueOnce(pendingSelect.promise)
    create.mockResolvedValue(ok(detail({ id: 9, title: 'Created' })))
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()

    const staleSelect = store.getState().select(1)
    expect(store.getState().loadingSelected).toBe(true)

    expect(await store.getState().create('Neue Idee')).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(store.getState().loadingSelected).toBe(true)

    pendingSelect.resolve(ok(detail({ id: 1, title: 'Resolved' })))
    await staleSelect
    expect(store.getState().selected).toEqual(detail({ id: 1, title: 'Resolved' }))
    expect(store.getState().loadingSelected).toBe(false)
  })

  it('does not start a new select() while a mutation is saving, and the final state reflects the mutation (Fix-2-style, case B)', async () => {
    list.mockResolvedValue(ok([]))
    get.mockResolvedValue(ok(detail({ id: 1 })))
    const pendingUpdate = deferred<IpcResult<WorkRequestDetail>>()
    updateIntent.mockReturnValue(pendingUpdate.promise)
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()
    await store.getState().select(1)
    expect(get).toHaveBeenCalledTimes(1)

    const mutating = store.getState().updateIntent('Neu')
    expect(store.getState().saving).toBe(true)

    await store.getState().select(1)
    expect(get).toHaveBeenCalledTimes(1)

    pendingUpdate.resolve(ok(detail({ id: 1, title: 'Renamed' })))
    await mutating
    expect(store.getState().selected?.title).toBe('Renamed')
  })

  // ChatGPT re-review Fix 1 - a mutation must not begin while the list is
  // still loading (most importantly the very first loadList() right after
  // mount): otherwise a successful create() could permanently strand
  // `loadingList: true` and silently lose whichever already-existing Work
  // Requests that first load would have delivered.
  it('refuses create() while the initial list load is pending, then succeeds afterward with existing entries intact (Fix 1, case A)', async () => {
    const pendingList = deferred<IpcResult<WorkRequestSummary[]>>()
    list.mockReturnValueOnce(pendingList.promise)
    // ChatGPT-Re-Review Fix 3 (v4): the store now re-sorts by updatedAt
    // descending (with an id tie-breaker) after every mutation, mirroring
    // the service's ORDER BY - so the created entry needs a distinct, later
    // updatedAt to deterministically land first, exactly like a real create()
    // would (a fresh created_at/updated_at newer than any existing entry).
    create.mockResolvedValue(ok(detail({ id: 9, title: 'Created', updatedAt: '2026-09-09' })))
    const store = createWorkRequestStore(1, false)

    const loading = store.getState().loadList()
    expect(store.getState().loadingList).toBe(true)

    // Attempting to create while the list is still loading must be a
    // complete no-op - no IPC call, no state change beyond what loadList()
    // itself will eventually apply.
    expect(await store.getState().create('Zu frueh')).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(store.getState().loadingList).toBe(true)

    pendingList.resolve(ok([summary({ id: 1, title: 'Existing', updatedAt: '2026-09-08' })]))
    await loading
    expect(store.getState().loadingList).toBe(false)
    expect(store.getState().workRequests).toEqual([summary({ id: 1, title: 'Existing', updatedAt: '2026-09-08' })])

    const created = await store.getState().create('Jetzt')
    expect(created?.title).toBe('Created')
    expect(store.getState().workRequests).toEqual([
      summary({ id: 9, title: 'Created', updatedAt: '2026-09-09' }),
      summary({ id: 1, title: 'Existing', updatedAt: '2026-09-08' })
    ])
  })

  it('also refuses updateIntent()/resolveDecision() while the list is loading, for a consistent store invariant', async () => {
    const pendingList = deferred<IpcResult<WorkRequestSummary[]>>()
    list.mockReturnValueOnce(pendingList.promise)
    const store = createWorkRequestStore(1, false)
    void store.getState().loadList()
    expect(store.getState().loadingList).toBe(true)

    expect(await store.getState().updateIntent('X')).toBeNull()
    expect(await store.getState().resolveDecision(1, 'a')).toBeNull()
    expect(updateIntent).not.toHaveBeenCalled()
    expect(resolveDecision).not.toHaveBeenCalled()

    pendingList.resolve(ok([]))
  })

  // ChatGPT-Re-Review Fix 4 (v4): create() must ALSO refuse to start while an
  // existing selection is still loading - otherwise a failed create() could
  // strand the store with `selectedId` pointing at a request whose
  // `selected`/`loadingSelected` were already discarded by beginMutation().
  it('refuses create() while an existing selection is still loading, remains coherent once it resolves (Fix 4, v4)', async () => {
    list.mockResolvedValue(ok([summary({ id: 1 })]))
    const pendingSelect = deferred<IpcResult<WorkRequestDetail>>()
    get.mockReturnValueOnce(pendingSelect.promise)
    create.mockResolvedValue(ok(detail({ id: 9, title: 'Created' })))
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()

    const selecting = store.getState().select(1)
    expect(store.getState().loadingSelected).toBe(true)

    expect(await store.getState().create('Zu frueh')).toBeNull()
    expect(create).not.toHaveBeenCalled()
    // Selection remains pending/coherent - nothing was invalidated by the
    // refused create() attempt.
    expect(store.getState().selectedId).toBe(1)
    expect(store.getState().loadingSelected).toBe(true)

    pendingSelect.resolve(ok(detail({ id: 1, title: 'Resolved' })))
    await selecting
    expect(store.getState().selectedId).toBe(1)
    expect(store.getState().selected).toEqual(detail({ id: 1, title: 'Resolved' }))
    expect(store.getState().loadingSelected).toBe(false)

    const created = await store.getState().create('Jetzt')
    expect(created?.title).toBe('Created')
    expect(create).toHaveBeenCalledTimes(1)
  })
})

// ChatGPT-Re-Review Fix 1 (v4): status alone is not the editability rule -
// setWorkRequestStatus() (Main/internal) can force a planned request back to
// IDEA. canEditWorkRequestIntent() mirrors workRequestService's server-side
// assertIntentEditable() exactly, so the UI never offers an edit control the
// server would reject anyway.
describe('canEditWorkRequestIntent (Fix 1, v4)', () => {
  it('allows editing a fresh IDEA request with no planning history', () => {
    expect(canEditWorkRequestIntent(detail(), false)).toBe(true)
  })

  it('rejects once a plan exists, even if status was forced back to IDEA', () => {
    expect(canEditWorkRequestIntent(detail({ status: 'IDEA', planMarkdown: 'Plan' }), false)).toBe(false)
  })

  it('rejects once decisions exist, even if status was forced back to IDEA', () => {
    expect(canEditWorkRequestIntent(detail({ status: 'IDEA', decisions: [decision()] }), false)).toBe(false)
  })

  it('rejects for read-only (archived) projects regardless of planning history', () => {
    expect(canEditWorkRequestIntent(detail(), true)).toBe(false)
  })

  it('rejects once status has moved past IDEA', () => {
    expect(canEditWorkRequestIntent(detail({ status: 'PLANNING' }), false)).toBe(false)
  })
})

// ChatGPT-Re-Review Fix 5 (v4): whether decisions will be needed is unknown
// before the first plan exists - "Keine Entscheidungen erforderlich." is only
// true once a plan exists with zero decisions.
describe('decisionsEmptyStateMessage (Fix 5, v4)', () => {
  it('shows the honest "not yet planned" message for a fresh unplanned IDEA request', () => {
    expect(decisionsEmptyStateMessage(detail())).toBe('Noch keine Entscheidungen vorhanden.')
  })

  it('shows "not required" once a plan exists with zero decisions', () => {
    expect(decisionsEmptyStateMessage(detail({ planMarkdown: 'Plan', status: 'READY' }))).toBe(
      'Keine Entscheidungen erforderlich.'
    )
  })

  it('returns null once decisions exist (populated rendering takes over)', () => {
    expect(decisionsEmptyStateMessage(detail({ decisions: [decision()] }))).toBeNull()
  })
})

// ChatGPT-Re-Review Fix 3 (v4): mirrors listWorkRequestsForProject()'s SQL
// ordering ("(status IN ('DONE','CANCELLED')) ASC, updated_at DESC") plus a
// deterministic id tie-breaker, since SQLite does not otherwise guarantee one
// for equal timestamps.
describe('sortWorkRequestSummaries (Fix 3, v4)', () => {
  it('keeps DONE/CANCELLED below active requests regardless of timestamp', () => {
    const active = summary({ id: 1, status: 'IDEA', updatedAt: '2020-01-01' })
    const done = summary({ id: 2, status: 'DONE', updatedAt: '2030-01-01' })
    const cancelled = summary({ id: 3, status: 'CANCELLED', updatedAt: '2031-01-01' })
    expect(sortWorkRequestSummaries([done, cancelled, active])).toEqual([active, cancelled, done])
  })

  it('orders active requests by updatedAt descending', () => {
    const older = summary({ id: 1, updatedAt: '2020-01-01' })
    const newer = summary({ id: 2, updatedAt: '2025-01-01' })
    expect(sortWorkRequestSummaries([older, newer])).toEqual([newer, older])
  })

  it('breaks equal-timestamp ties deterministically by id', () => {
    const a = summary({ id: 5, updatedAt: 'same' })
    const b = summary({ id: 2, updatedAt: 'same' })
    expect(sortWorkRequestSummaries([a, b])).toEqual([b, a])
    expect(sortWorkRequestSummaries([b, a])).toEqual([b, a])
  })

  it('does not mutate the input array', () => {
    const input = [summary({ id: 1, updatedAt: '2020-01-01' }), summary({ id: 2, updatedAt: '2025-01-01' })]
    const copy = [...input]
    sortWorkRequestSummaries(input)
    expect(input).toEqual(copy)
  })
})

describe('local list ordering after mutations matches a fresh reload (Fix 3, v4)', () => {
  it('moves an older active request above a newer one immediately once its timestamp is bumped', async () => {
    list.mockResolvedValue(
      ok([summary({ id: 2, updatedAt: '2025-01-01' }), summary({ id: 1, updatedAt: '2020-01-01' })])
    )
    get.mockResolvedValue(ok(detail({ id: 1, updatedAt: '2020-01-01' })))
    updateIntent.mockResolvedValue(ok(detail({ id: 1, updatedAt: '2030-01-01' })))
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()
    await store.getState().select(1)
    expect(store.getState().workRequests.map((w) => w.id)).toEqual([2, 1])

    await store.getState().updateIntent('Neu')
    expect(store.getState().workRequests.map((w) => w.id)).toEqual([1, 2])
  })

  it('reorders immediately after a decision resolution bumps the parent timestamp', async () => {
    list.mockResolvedValue(
      ok([summary({ id: 2, updatedAt: '2025-01-01' }), summary({ id: 1, updatedAt: '2020-01-01' })])
    )
    get.mockResolvedValue(ok(detail({ id: 1, updatedAt: '2020-01-01', status: 'NEEDS_DECISION' })))
    resolveDecision.mockResolvedValue(ok(detail({ id: 1, updatedAt: '2030-01-01', status: 'NEEDS_DECISION' })))
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()
    await store.getState().select(1)

    await store.getState().resolveDecision(5, 'opt-a')
    expect(store.getState().workRequests.map((w) => w.id)).toEqual([1, 2])
  })

  it('inserts a freshly created request in the same position a reload would place it', async () => {
    list.mockResolvedValue(ok([summary({ id: 1, updatedAt: '2020-01-01' })]))
    create.mockResolvedValue(ok(detail({ id: 9, updatedAt: '2030-01-01' })))
    const store = createWorkRequestStore(1, false)
    await store.getState().loadList()
    await store.getState().create('Neu')
    expect(store.getState().workRequests.map((w) => w.id)).toEqual([9, 1])
  })
})
