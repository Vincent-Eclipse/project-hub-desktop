import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { AppInfo, IpcResult } from '@shared/types'
import type { FileLogger } from '../logger'
import { IpcChannels } from '@shared/ipcChannels'
import { registerIpc } from './registerIpc'
import { createCodeChangeReviewRegistry } from '../services/codeChangeReviewService'
import * as projects from '../services/projectsService'
import * as git from '../services/gitService'
import { GitError } from '../services/gitErrors'

const { handlers, invoke, expose } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>>(),
  invoke: vi.fn(), expose: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>) => handlers.set(channel, handler) },
  ipcRenderer: { invoke }, contextBridge: { exposeInMainWorld: expose },
  clipboard: {}, dialog: {}, shell: {}
}))
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as FileLogger
beforeEach(() => {
  vi.restoreAllMocks()
  handlers.clear()
  registerIpc({
    db: {} as Database.Database,
    logger,
    appInfo: {} as AppInfo,
    getMainWebContentsId: () => null,
    codeChangeReviews: createCodeChangeReviewRegistry()
  })
})
describe('repository IPC', () => {
  it.each([undefined, null, {}, { id: 0 }, { id: '1' }, { id: 1.2 }, { id: Infinity },
    { id: Number.MAX_SAFE_INTEGER + 1 }, { id: 1, path: 'C:/outside' }, { id: 1, command: 'reset' }])(
    'rejects invalid arguments on both channels', async (payload) => {
      const service = vi.spyOn(git, 'getDiagnostics')
      for (const channel of [IpcChannels.repositoryDiagnostics, IpcChannels.repositoryDiff]) {
        expect(await handlers.get(channel)!(null, payload)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
      }
      expect(service).not.toHaveBeenCalled()
    })
  it('resolves paths from saved project records on both channels', async () => {
    vi.spyOn(projects, 'getProjectById').mockReturnValue({ folderPath: 'C:/saved' } as ReturnType<typeof projects.getProjectById>)
    const diagnostics = vi.spyOn(git, 'getDiagnostics').mockResolvedValue({ detected: false, root: null, branch: null, state: null, files: [] })
    const diff = vi.spyOn(git, 'getDiff').mockResolvedValue({ staged: '', unstaged: '', stagedStat: '', unstagedStat: '', truncated: false })
    expect(await handlers.get(IpcChannels.repositoryDiagnostics)!(null, { id: 1 })).toMatchObject({ ok: true })
    expect(await handlers.get(IpcChannels.repositoryDiff)!(null, { id: 1 })).toMatchObject({ ok: true })
    expect(diagnostics).toHaveBeenCalledWith('C:/saved')
    expect(diff).toHaveBeenCalledWith('C:/saved')
  })
  it('translates Git errors without exposing stderr or a stack', async () => {
    vi.spyOn(projects, 'getProjectById').mockReturnValue({ folderPath: 'C:/saved' } as ReturnType<typeof projects.getProjectById>)
    vi.spyOn(git, 'getDiff').mockRejectedValue(new GitError('GIT_TIMEOUT'))
    const result = await handlers.get(IpcChannels.repositoryDiff)!(null, { id: 1 })
    expect(result).toEqual({ ok: false, error: { code: 'GIT_TIMEOUT', message: new GitError('GIT_TIMEOUT').message } })
  })
  it('exposes exactly two typed repository methods through preload', async () => {
    await import('../../preload/index')
    const api = expose.mock.calls[0][1] as import('../../preload/index').EclipseHubApi
    expect(Object.keys(api.repository).sort()).toEqual(['diagnostics', 'diff'])
    await api.repository.diagnostics(7)
    expect(invoke).toHaveBeenLastCalledWith('repository:diagnostics', { id: 7 })
    await api.repository.diff(7)
    expect(invoke).toHaveBeenLastCalledWith('repository:diff', { id: 7 })
  })
})
