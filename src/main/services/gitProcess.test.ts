import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { getDiagnostics } from './gitService'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
let root: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-git-process-')))
  fs.mkdirSync(path.join(root, '.git'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(execFile).mockReset()
  fs.rmSync(root, { recursive: true, force: true })
})
function response(error: object | null, stdout = ''): void {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: object | null, stdout: string) => void
    callback(error, stdout)
    return { stdin: { end: vi.fn() } } as unknown as ReturnType<typeof execFile>
  })
}
describe('Git process safety', () => {
  it.each([
    [{ code: 'ENOENT' }, 'GIT_UNAVAILABLE'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'GIT_OUTPUT_LIMIT'],
    [{ killed: true }, 'GIT_TIMEOUT'],
    [{ code: 128, message: 'private stderr', stack: 'private stack' }, 'GIT_FAILED']
  ])('maps process failures to controlled errors', async (error, code) => {
    response(error)
    await expect(getDiagnostics(root)).rejects.toMatchObject({ code })
    await expect(getDiagnostics(root)).rejects.not.toHaveProperty('message', 'private stderr')
  })
  it('uses a fixed executable, no shell, a timeout, bounded buffers and a minimal environment', async () => {
    vi.stubEnv('SECRET_TOKEN', 'do-not-inherit')
    vi.stubEnv('GIT_SSH_COMMAND', 'do-not-run')
    response({ code: 128 })
    await expect(getDiagnostics(root)).rejects.toBeDefined()
    const [executable, args, options] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[], {
      shell: boolean; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; cwd: string; killSignal: string
    }]
    expect(path.isAbsolute(executable)).toBe(true)
    expect(executable).toMatch(/git(?:\.exe)?$/)
    expect(args).toContain('--no-pager')
    expect(args).toContain('core.fsmonitor=false')
    expect(args).toContain('--no-includes')
    expect(options).toMatchObject({ shell: false, cwd: root, maxBuffer: 512 * 1024, killSignal: 'SIGKILL' })
    expect(options.timeout).toBeGreaterThan(0)
    expect(options.timeout).toBeLessThanOrEqual(10_000)
    expect(options.env.SECRET_TOKEN).toBeUndefined()
    expect(options.env.GIT_SSH_COMMAND).toBeUndefined()
    expect(options.env.GIT_ALLOW_PROTOCOL).toBe('')
    vi.unstubAllEnvs()
  })
  it('fails closed when realpath fails', async () => {
    vi.spyOn(fsp, 'realpath').mockRejectedValue(Object.assign(new Error('private path'), { code: 'EACCES' }))
    await expect(getDiagnostics(root)).rejects.toMatchObject({ code: 'GIT_UNSAFE_PATH' })
    expect(execFile).not.toHaveBeenCalled()
  })
  it.each(['config', 'HEAD', 'index', 'packed-refs', 'shallow', 'info/grafts', 'info/attributes', 'info/exclude'])(
    'fails closed for redirected metadata file %s before executing Git', async (name) => {
      const target = path.join(root, '.git', name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '')
      const realpath = fsp.realpath.bind(fsp)
      vi.spyOn(fsp, 'realpath').mockImplementation(async (candidate) =>
        candidate === target ? path.join(root, 'outside') : realpath(candidate))
      await expect(getDiagnostics(root)).rejects.toMatchObject({ code: 'GIT_UNSAFE_PATH' })
      expect(execFile).not.toHaveBeenCalled()
    })
  it('rejects an unexpected reported repository root', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string) => void
      const gitArgs = args[1] as string[]
      callback(null, gitArgs.includes('config') ? '' : os.tmpdir())
      return { stdin: { end: vi.fn() } } as unknown as ReturnType<typeof execFile>
    })
    await expect(getDiagnostics(root)).rejects.toMatchObject({ code: 'GIT_INVALID_ROOT' })
  })
})

describe('Git request bounds', () => {
  it('limits concurrent reads and releases slots after errors', async () => {
    response({ code: 128 })
    const first = getDiagnostics(root)
    const second = getDiagnostics(root)
    await expect(getDiagnostics(root)).rejects.toMatchObject({ code: 'GIT_BUSY' })
    await Promise.allSettled([first, second])
    await expect(getDiagnostics(root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
  })
  it('does not spawn after the shared deadline expires', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(20_000)
    await expect(getDiagnostics(root)).rejects.toMatchObject({ code: 'GIT_TIMEOUT' })
    expect(execFile).not.toHaveBeenCalled()
  })
})

describe('normalization config process boundary', () => {
  it.each(['--global', '--system'] as const)('limits %s reads to autocrlf and keeps repository processes isolated', async (scope) => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/isolated-global')
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/isolated-system')
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.sshCommand')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'do-not-run')
    vi.stubEnv('SECRET_TOKEN', 'do-not-inherit')
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: object | null, stdout: string) => void
      const command = args[1] as string[]
      if (command.includes(scope)) callback(null, 'true\0')
      else if (command.includes('--global')) callback({ code: 1 }, '')
      else callback(null, command.includes('--show-toplevel') ? root : '')
      return { stdin: { end: vi.fn() } } as unknown as ReturnType<typeof execFile>
    })
    expect(await getDiagnostics(root)).toMatchObject({ detected: true, state: 'clean' })
    const calls = vi.mocked(execFile).mock.calls as unknown as [string, string[], {
      shell: boolean; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv
    }][]
    expect(calls.some(([, args]) => args.includes(scope))).toBe(true)
    for (const [, args, options] of calls) {
      expect(options).toMatchObject({ shell: false, maxBuffer: 512 * 1024 })
      expect(options.timeout).toBeGreaterThan(0)
      expect(options.timeout).toBeLessThanOrEqual(10_000)
      expect(options.env.GIT_CONFIG_COUNT).toBeUndefined()
      expect(options.env.GIT_CONFIG_KEY_0).toBeUndefined()
      expect(options.env.GIT_CONFIG_VALUE_0).toBeUndefined()
      expect(options.env.SECRET_TOKEN).toBeUndefined()
      expect(options.env.GIT_ALLOW_PROTOCOL).toBe('')
      expect(args).toContain('core.fsmonitor=false')
      expect(args).toContain('protocol.allow=never')
      if (args.includes('--global') || args.includes('--system')) {
        const queryScope = args.includes('--global') ? '--global' : '--system'
        expect(args.slice(-6)).toEqual(['config', queryScope, '--no-includes', '--null', '--get', 'core.autocrlf'])
      } else {
        expect(options.env.GIT_CONFIG_GLOBAL).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null')
        expect(options.env.GIT_CONFIG_NOSYSTEM).toBe('1')
        expect(options.env.GIT_CONFIG_SYSTEM).toBeUndefined()
        expect(options.env.HOME).toBeUndefined()
        if (args.includes('status')) expect(args).toContain('core.autocrlf=true')
      }
    }
  })
  it.each([
    [{ code: 'ENOENT' }, 'GIT_UNAVAILABLE'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'GIT_OUTPUT_LIMIT'],
    [{ killed: true }, 'GIT_TIMEOUT'],
    [{ code: 128 }, 'GIT_FAILED']
  ])('preserves process-error handling for normalization reads', async (error, code) => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: object | null, stdout: string) => void
      callback((args[1] as string[]).includes('--global') ? error : null, '')
      return { stdin: { end: vi.fn() } } as unknown as ReturnType<typeof execFile>
    })
    await expect(getDiagnostics(root)).rejects.toMatchObject({ code })
  })
  it.each(['true\0unexpected', 'true\n-c core.fsmonitor=helper\0'])(
    'rejects an unexpected complete config response', async (value) => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1) as (error: null, stdout: string) => void
        callback(null, (args[1] as string[]).includes('--global') ? value : '')
        return { stdin: { end: vi.fn() } } as unknown as ReturnType<typeof execFile>
      })
      await expect(getDiagnostics(root)).rejects.toMatchObject({ code: 'GIT_UNSAFE_CONFIG' })
      expect(vi.mocked(execFile).mock.calls).toHaveLength(2)
    })
})
