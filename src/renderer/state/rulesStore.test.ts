import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResult, ProjectRuleVersion } from '@shared/types'
import { DEFAULT_CONTEXT_MARKDOWN, DEFAULT_RULES_MARKDOWN } from '@shared/documentTemplates'
import { createRulesStore } from './rulesStore'

const listVersions = vi.fn()
const createVersion = vi.fn()
const diff = vi.fn()
const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })
function version(projectId = 1, id = 1): ProjectRuleVersion {
  return { id, projectId, versionNumber: id, contentMarkdown: `Version ${id}`, note: null, createdBy: 'LEON', createdAt: '2026-09-06' }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { eclipseHub: { rules: { listVersions, createVersion, diff } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('project-scoped Rules state', () => {
  it('discards late A responses during A → B → A switching', async () => {
    const pending = deferred<IpcResult<ProjectRuleVersion[]>>()
    listVersions.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ok([version(2)])).mockResolvedValueOnce(ok([version(1, 2)]))
    const firstA = createRulesStore(1, false)
    const oldLoad = firstA.getState().load()
    firstA.getState().dispose()
    const b = createRulesStore(2, false)
    expect(b.getState().versions).toEqual([])
    await b.getState().load()
    b.getState().dispose()
    const nextA = createRulesStore(1, false)
    await nextA.getState().load()
    pending.resolve(ok([version(1)]))
    await oldLoad
    expect(firstA.getState().versions).toEqual([])
    expect(b.getState().versions).toEqual([version(2)])
    expect(nextA.getState().versions).toEqual([version(1, 2)])
  })

  it('keeps the latest reload and ignores stale failures', async () => {
    const pending = deferred<IpcResult<ProjectRuleVersion[]>>()
    listVersions.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ok([version(1, 2)]))
    const store = createRulesStore(1, false)
    const oldLoad = store.getState().load()
    await store.getState().load()
    pending.resolve({ ok: false, error: { code: 'OLD', message: 'Stale error' } })
    await oldLoad
    expect(store.getState().versions).toEqual([version(1, 2)])
    expect(store.getState().error).toBeNull()
  })

  it('allows archived history/diff reads and blocks saves', async () => {
    listVersions.mockResolvedValue(ok([version()]))
    diff.mockResolvedValue(ok([]))
    const store = createRulesStore(1, true)
    await store.getState().load()
    await store.getState().showDiff(1, 1)
    expect(diff).toHaveBeenCalledWith(1, 1, 1)
    expect(await store.getState().save({ contentMarkdown: 'New', createdBy: 'LEON' })).toBe(false)
    expect(createVersion).not.toHaveBeenCalled()
  })

  it('saves an editable first-version template without modifying the template or existing history', async () => {
    listVersions.mockResolvedValue(ok([]))
    createVersion.mockResolvedValue(ok(version()))
    const store = createRulesStore(1, false)
    await store.getState().load()
    const draft = `${DEFAULT_RULES_MARKDOWN}\nRun local verification.`
    expect(await store.getState().save({ contentMarkdown: draft, note: 'Initial', createdBy: 'LEON' })).toBe(true)
    expect(createVersion).toHaveBeenCalledWith({ projectId: 1, contentMarkdown: draft, note: 'Initial', createdBy: 'LEON' })
    expect(store.getState().versions).toEqual([version()])
    expect(DEFAULT_RULES_MARKDOWN.split('\n').filter((line) => line.startsWith('# '))).toEqual([
      '# Architecture', '# Coding Standards', '# Security', '# Forbidden Changes', '# Constraints', '# Verification Requirements'
    ])
    expect(DEFAULT_CONTEXT_MARKDOWN).toContain('# Current State')
    expect(DEFAULT_CONTEXT_MARKDOWN).toContain('# Progress Updates')
  })

  it('prevents duplicate pending saves and ignores completion after unmount', async () => {
    listVersions.mockResolvedValue(ok([]))
    const pending = deferred<IpcResult<ProjectRuleVersion>>()
    createVersion.mockReturnValue(pending.promise)
    const store = createRulesStore(1, false)
    await store.getState().load()
    const input = { contentMarkdown: 'Draft', createdBy: 'LEON' as const }
    const saving = store.getState().save(input)
    expect(await store.getState().save(input)).toBe(false)
    store.getState().dispose()
    pending.resolve(ok(version()))
    expect(await saving).toBe(false)
    expect(store.getState().versions).toEqual([])
    expect(createVersion).toHaveBeenCalledTimes(1)
  })

  it('invalidates pending diffs when selection changes', async () => {
    const pending = deferred<IpcResult<never[]>>()
    diff.mockReturnValue(pending.promise)
    const store = createRulesStore(1, false)
    const showing = store.getState().showDiff(1, 2)
    store.getState().clearDiff()
    pending.resolve(ok([]))
    await showing
    expect(store.getState().diffLines).toBeNull()
  })

  it('reports failed saves without dropping history', async () => {
    listVersions.mockResolvedValue(ok([version()]))
    createVersion.mockResolvedValue({ ok: false, error: { code: 'ProjectArchivedError', message: 'Archived' } })
    const store = createRulesStore(1, false)
    await store.getState().load()
    expect(await store.getState().save({ contentMarkdown: 'Draft', createdBy: 'LEON' })).toBe(false)
    expect(store.getState().versions).toEqual([version()])
    expect(store.getState().error).toBe('Archived')
    expect(store.getState().saving).toBe(false)
  })
})
