import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { AppInfo, IpcResult, ProjectRuleVersion } from '@shared/types'
import type { EclipseHubApi } from '../../preload/index'
import type { FileLogger } from '../logger'
import { createTestDb } from '../testUtils/testDb'
import { createProject, archiveProject } from '../services/projectsService'
import { registerIpc } from './registerIpc'
import { createCodeChangeReviewRegistry } from '../services/codeChangeReviewService'

const { handlers, invoke, expose } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>>(),
  invoke: vi.fn(), expose: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>) => handlers.set(channel, handler) },
  ipcRenderer: { invoke }, contextBridge: { exposeInMainWorld: expose }, clipboard: {}, dialog: {}, shell: {}
}))
let db: ReturnType<typeof createTestDb>
let id: number
const call = (channel: string, raw: unknown) => handlers.get(`rules:${channel}`)!(null, raw)
const input = () => ({ projectId: id, contentMarkdown: 'Exact rules', createdBy: 'LEON' })
beforeEach(() => {
  db = createTestDb()
  id = createProject(db, { name: 'IPC Rules', projectType: 'Test', description: '' }).id
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

describe('Rules IPC and preload', () => {
  it('labels malformed Rules requests correctly while preserving Context labels', async () => {
    for (const raw of [null, undefined, [], 'invalid']) {
      for (const operation of ['getVersion', 'diff']) {
        for (const domain of ['rules', 'context']) {
          const channel = `${domain}:${operation}`
          expect(await handlers.get(channel)!(null, raw)).toEqual({
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: `Ungueltige Eingabe fuer ${channel}.` }
          })
        }
      }
    }
  })

  it('supports create, list, get and diff end-to-end against SQLite', async () => {
    const created = await call('createVersion', input()) as IpcResult<ProjectRuleVersion>
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('create failed')
    const version = created.data
    expect(await call('listVersions', { id })).toEqual({ ok: true, data: [version] })
    expect(await call('getVersion', { projectId: id, versionId: version.id })).toEqual(created)
    expect(await call('diff', { projectId: id, fromVersionId: version.id, toVersionId: version.id })).toMatchObject({ ok: true, data: [{ type: 'unchanged', text: 'Exact rules' }] })
  })

  it.each([null, undefined, [], {}, { projectId: 0 }, { projectId: '1' }])('rejects malformed payloads on all four channels', async (raw) => {
    for (const channel of ['createVersion', 'listVersions', 'getVersion', 'diff']) {
      expect(await call(channel, raw)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    }
  })

  it.each([{ contentMarkdown: 1 }, { contentMarkdown: 'x'.repeat(50_001) }, { note: 'n'.repeat(501) }, { createdBy: 'INVALID' }])('rejects invalid create fields', async (fields) => {
    expect(await call('createVersion', { ...input(), ...fields })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await call('listVersions', { id })).toEqual({ ok: true, data: [] })
  })

  it('accepts the boundary length and maps wrong IDs and archived writes safely', async () => {
    const created = await call('createVersion', { ...input(), contentMarkdown: 'x'.repeat(50_000) }) as { ok: true; data: ProjectRuleVersion }
    expect(created.ok).toBe(true)
    const other = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    expect(await call('getVersion', { projectId: other, versionId: created.data.id })).toMatchObject({ ok: false, error: { code: 'RuleVersionMismatchError' } })
    expect(await call('diff', { projectId: other, fromVersionId: created.data.id, toVersionId: created.data.id })).toMatchObject({ ok: false, error: { code: 'RuleVersionMismatchError' } })
    expect(await call('getVersion', { projectId: id, versionId: 99999 })).toMatchObject({ ok: false, error: { code: 'RuleVersionNotFoundError' } })
    expect(await call('listVersions', { id: 99999 })).toMatchObject({ ok: false, error: { code: 'ProjectNotFoundError' } })
    archiveProject(db, id)
    expect(await call('createVersion', input())).toMatchObject({ ok: false, error: { code: 'ProjectArchivedError' } })
    expect((await call('listVersions', { id })).ok).toBe(true)
  })

  it('maps unexpected DB errors to a generic response', async () => {
    db.exec('DROP TABLE project_rule_versions')
    expect(await call('listVersions', { id })).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Ein interner Fehler ist aufgetreten.' } })
  })

  it('exposes only the four typed Rules methods and exact channel payloads', async () => {
    await import('../../preload/index')
    const api = expose.mock.calls[0][1] as EclipseHubApi
    expect(Object.keys(api.rules).sort()).toEqual(['createVersion', 'diff', 'getVersion', 'listVersions'])
    expectTypeOf(api.rules.listVersions).returns.toEqualTypeOf<Promise<IpcResult<ProjectRuleVersion[]>>>()
    expectTypeOf(api.rules.getVersion).returns.toEqualTypeOf<Promise<IpcResult<ProjectRuleVersion>>>()
    await api.rules.listVersions(7)
    expect(invoke).toHaveBeenLastCalledWith('rules:listVersions', { id: 7 })
    await api.rules.getVersion(7, 3)
    expect(invoke).toHaveBeenLastCalledWith('rules:getVersion', { projectId: 7, versionId: 3 })
    await api.rules.createVersion({ projectId: 7, contentMarkdown: 'Rules', createdBy: 'LEON' })
    expect(invoke).toHaveBeenLastCalledWith('rules:createVersion', { projectId: 7, contentMarkdown: 'Rules', createdBy: 'LEON' })
    await api.rules.diff(7, 3, 4)
    expect(invoke).toHaveBeenLastCalledWith('rules:diff', { projectId: 7, fromVersionId: 3, toVersionId: 4 })
    expect(api).not.toHaveProperty('invoke')
    expect(api).not.toHaveProperty('ipcRenderer')
  })
})
