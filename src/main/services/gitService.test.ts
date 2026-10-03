import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getDiagnostics, getDiff } from './gitService'

let temporary: string
let root: string
const git = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'mingw64', 'bin', 'git.exe') : '/usr/bin/git'
function command(...args: string[]): string {
  return execFileSync(git, ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@local.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@local.invalid' }
  })
}
function repository(): void {
  command('init', '--initial-branch=main')
  fs.writeFileSync(path.join(root, 'file.txt'), 'before\n')
  command('add', '--', 'file.txt')
  command('commit', '-m', 'fixture')
}
beforeEach(() => {
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-git-test-')))
  root = path.join(temporary, 'project space ü')
  fs.mkdirSync(root)
  for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    const config = path.join(temporary, name)
    fs.writeFileSync(config, '')
    vi.stubEnv(name, config)
  }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })

describe('read-only repository service', () => {
  it('returns no repository for a plain directory', async () => {
    expect(await getDiagnostics(root)).toMatchObject({ detected: false, root: null, files: [] })
    await expect(getDiff(root)).rejects.toMatchObject({ code: 'GIT_NOT_REPOSITORY' })
  })
  it('detects root, branch and clean state without changing index', async () => {
    repository()
    const index = fs.readFileSync(path.join(root, '.git/index'))
    expect(await getDiagnostics(root)).toMatchObject({ detected: true, root, branch: 'main', state: 'clean', files: [] })
    expect(fs.readFileSync(path.join(root, '.git/index'))).toEqual(index)
    expect(fs.existsSync(path.join(root, '.git/index.lock'))).toBe(false)
  })
  it('handles an unborn branch', async () => {
    command('init', '--initial-branch=main')
    expect(await getDiagnostics(root)).toMatchObject({ branch: 'main', state: 'clean' })
    expect(await getDiff(root)).toMatchObject({ staged: '', unstaged: '' })
  })
  it('reports a detached HEAD', async () => {
    repository()
    fs.writeFileSync(path.join(root, '.git/HEAD'), command('rev-parse', 'HEAD'))
    expect(await getDiagnostics(root)).toMatchObject({ branch: null })
  })
  it('reports modified, staged added, untracked and deleted files', async () => {
    repository()
    fs.writeFileSync(path.join(root, 'file.txt'), 'after\n')
    fs.writeFileSync(path.join(root, 'added.txt'), 'added\n')
    command('add', '--', 'added.txt')
    fs.writeFileSync(path.join(root, 'new ü.txt'), 'untracked\n')
    expect((await getDiagnostics(root)).files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'file.txt', kind: 'modified', worktree: 'M' }),
      expect.objectContaining({ path: 'added.txt', kind: 'added', index: 'A' }),
      expect.objectContaining({ path: 'new ü.txt', kind: 'untracked' })
    ]))
    fs.unlinkSync(path.join(root, 'file.txt'))
    expect((await getDiagnostics(root)).files).toContainEqual(expect.objectContaining({ path: 'file.txt', kind: 'deleted' }))
  })
  it('reports staged renames', async () => {
    repository()
    command('config', 'status.renames', 'copies')
    fs.renameSync(path.join(root, 'file.txt'), path.join(root, 'renamed.txt'))
    command('add', '-A')
    expect((await getDiagnostics(root)).files).toContainEqual(expect.objectContaining({
      path: 'renamed.txt', previousPath: 'file.txt', kind: 'renamed'
    }))
  })
  it('returns separate staged/unstaged patches and statistics', async () => {
    repository()
    fs.writeFileSync(path.join(root, 'file.txt'), 'staged\n')
    command('add', '--', 'file.txt')
    fs.writeFileSync(path.join(root, 'file.txt'), 'unstaged\n')
    const index = fs.readFileSync(path.join(root, '.git/index'))
    const diff = await getDiff(root)
    expect(fs.readFileSync(path.join(root, '.git/index'))).toEqual(index)
    expect(diff.staged).toContain('+staged')
    expect(diff.unstaged).toContain('+unstaged')
    expect(diff.stagedStat).toContain('file.txt')
    expect(diff.unstagedStat).toContain('file.txt')
    expect(diff.truncated).toBe(false)
  })
  it('does not discover a parent repository', async () => {
    repository()
    const child = path.join(root, 'child')
    fs.mkdirSync(child)
    expect((await getDiagnostics(child)).detected).toBe(false)
  })
  it('rejects missing, relative, traversal and file paths', async () => {
    await expect(getDiagnostics(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'GIT_PATH_MISSING' })
    await expect(getDiagnostics(null)).rejects.toMatchObject({ code: 'GIT_PATH_MISSING' })
    await expect(getDiagnostics('.')).rejects.toMatchObject({ code: 'GIT_UNSAFE_PATH' })
    await expect(getDiagnostics(root + '/..')).rejects.toMatchObject({ code: 'GIT_UNSAFE_PATH' })
    fs.writeFileSync(path.join(root, 'plain'), '')
    await expect(getDiagnostics(path.join(root, 'plain'))).rejects.toMatchObject({ code: 'GIT_PATH_NOT_DIRECTORY' })
  })
  it('rejects a project path redirected by junction/symlink', async () => {
    repository()
    const link = path.join(temporary, 'linked')
    fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(getDiagnostics(link)).rejects.toMatchObject({ code: 'GIT_UNSAFE_PATH' })
  })
  it('allows an ignored sibling junction without changing the repository boundary', async () => {
    repository()
    const sibling = path.join(temporary, 'project space ü-sibling')
    fs.mkdirSync(sibling)
    fs.symlinkSync(sibling, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    fs.writeFileSync(path.join(sibling, 'outside.txt'), 'outside content\n')
    fs.writeFileSync(path.join(root, '.git/info/exclude'), '/escape/\n')
    expect(await getDiagnostics(root)).toMatchObject({ detected: true, root, state: 'clean' })
    expect(await getDiff(root)).toMatchObject({ staged: '', unstaged: '' })
  })
  it('does not enumerate the worktree or impose a 50,000-entry prewalk limit', async () => {
    repository()
    // A prewalk of any size would hit these spies. Git itself still reads the real fixture.
    const opendir = vi.spyOn(fsp, 'opendir').mockRejectedValue(new Error('No directory prewalk allowed'))
    const readdir = vi.spyOn(fsp, 'readdir').mockRejectedValue(new Error('No directory prewalk allowed'))
    expect(await getDiagnostics(root)).toMatchObject({ detected: true, state: 'clean' })
    expect(await getDiff(root)).toMatchObject({ staged: '', unstaged: '' })
    expect(opendir).not.toHaveBeenCalled()
    expect(readdir).not.toHaveBeenCalled()
  })
  it.each(['objects', 'objects/info', 'objects/pack', 'refs', 'info'])(
    'rejects redirected metadata directory %s', async (name) => {
      repository()
      const target = path.join(root, '.git', name)
      const outside = path.join(temporary, 'metadata')
      fs.renameSync(target, outside)
      fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(getDiagnostics(root)).rejects.toMatchObject({ code: 'GIT_UNSAFE_PATH' })
      await expect(getDiff(root)).rejects.toMatchObject({ code: 'GIT_UNSAFE_PATH' })
    })
  it('rejects linked git metadata and gitdir files', async () => {
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../other/.git')
    await expect(getDiagnostics(root)).rejects.toMatchObject({ code: 'GIT_INVALID_ROOT' })
    fs.unlinkSync(path.join(root, '.git'))
    const outside = path.join(temporary, 'metadata')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(root, '.git'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(getDiagnostics(root)).rejects.toMatchObject({ code: 'GIT_INVALID_ROOT' })
  })
  it.each(['include.path', 'filter.danger.clean', 'core.worktree', 'extensions.worktreeConfig'])(
    'rejects unsafe config %s', async (key) => {
      repository()
      command('config', '--local', key, key === 'extensions.worktreeConfig' ? 'true' : 'unsafe')
      await expect(getDiff(root)).rejects.toMatchObject({ code: 'GIT_UNSAFE_CONFIG' })
    })
  it.each(['commondir', 'objects/info/alternates', 'objects/info/http-alternates'])('rejects redirected storage metadata %s', async (name) => {
    repository()
    fs.writeFileSync(path.join(root, '.git', name), '../outside')
    await expect(getDiff(root)).rejects.toMatchObject({ code: 'GIT_UNSAFE_CONFIG' })
  })
  it('ignores external diff, textconv and fsmonitor commands', async () => {
    repository()
    command('config', 'diff.external', 'definitely-not-a-real-command')
    command('config', 'diff.danger.textconv', 'definitely-not-a-real-command')
    command('config', 'core.fsmonitor', 'definitely-not-a-real-command')
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt diff=danger\n')
    fs.writeFileSync(path.join(root, 'file.txt'), 'safe diff\n')
    expect((await getDiff(root)).unstaged).toContain('+safe diff')
    expect((await getDiagnostics(root)).state).toBe('changed')
  })
  it('rejects excessive diff output without returning a partial patch', async () => {
    repository()
    fs.writeFileSync(path.join(root, 'file.txt'), 'large line\n'.repeat(60_000))
    await expect(getDiff(root)).rejects.toMatchObject({ code: 'GIT_OUTPUT_LIMIT' })
  })
})

// Unlike the original fixtures, these use isolated native configuration precedence.
function normalizedCommand(...args: string[]): string {
  return execFileSync(git, ['--no-optional-locks', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    '-c', 'commit.gpgSign=false', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, GIT_CONFIG_NOSYSTEM: '0',
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@local.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@local.invalid' }
  })
}
function normalizationRepository(local?: string, global?: string, system?: string, attributes?: string): void {
  if (global !== undefined) fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL!, `[core]\n autocrlf = ${global}\n`)
  if (system !== undefined) fs.writeFileSync(process.env.GIT_CONFIG_SYSTEM!, `[core]\n autocrlf = ${system}\n`)
  command('init', '--initial-branch=main')
  if (local !== undefined) command('config', '--local', 'core.autocrlf', local)
  fs.writeFileSync(path.join(root, 'file.txt'), 'one\r\ntwo\r\nthree\r\n')
  if (attributes) fs.writeFileSync(path.join(root, '.gitattributes'), attributes + '\n')
  normalizedCommand('add', '--all')
  normalizedCommand('commit', '-m', 'normalization fixture')
  // Ensure Git compares content instead of trusting the index's cached timestamps.
  const time = new Date(Date.now() + 2000)
  fs.utimesSync(path.join(root, 'file.txt'), time, time)
}
const patchArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=all', '--patch', '--']

describe('allowlisted Git text normalization', () => {
  it.each(['false', 'true', 'input'])('preserves explicit local core.autocrlf=%s', async (local) => {
    normalizationRepository(local)
    expect(normalizedCommand('status', '--porcelain=v1')).toBe('')
    expect(await getDiagnostics(root)).toMatchObject({ state: 'clean', files: [] })
    expect(await getDiff(root)).toMatchObject({ unstaged: '', staged: '' })
    fs.writeFileSync(path.join(root, 'file.txt'), 'one\r\nchanged\r\nthree\r\n')
    expect((await getDiff(root)).unstaged).toBe(normalizedCommand(...patchArgs))
    expect((await getDiff(root)).unstaged).toContain('+changed')
  })
  it('keeps a CRLF worktree clean when only global autocrlf=true normalizes its LF index', async () => {
    normalizationRepository(undefined, 'true')
    expect(fs.readFileSync(path.join(root, '.git/config'), 'utf8')).not.toContain('autocrlf')
    expect(normalizedCommand('show', ':file.txt')).toBe('one\ntwo\nthree\n')
    expect(normalizedCommand('status', '--porcelain=v1')).toBe('')
    expect(await getDiagnostics(root)).toMatchObject({ state: 'clean', files: [] })
    expect(await getDiff(root)).toMatchObject({ unstaged: '', staged: '', unstagedStat: '' })
    fs.writeFileSync(path.join(root, 'file.txt'), 'one\r\nchanged\r\nthree\r\n')
    const diff = await getDiff(root)
    expect(diff.unstaged).toBe(normalizedCommand(...patchArgs))
    expect(diff.unstagedStat).toContain('1 insertion(+), 1 deletion(-)')
  })
  it('uses the same allowlist for system autocrlf when global/local values are absent', async () => {
    normalizationRepository(undefined, undefined, 'true')
    expect(await getDiagnostics(root)).toMatchObject({ state: 'clean' })
    expect((await getDiff(root)).unstaged).toBe('')
  })
  it('gives an explicit global false precedence over system true', async () => {
    normalizationRepository(undefined, 'false', 'true')
    expect(normalizedCommand('show', ':file.txt')).toContain('\r\n')
    expect((await getDiff(root)).unstaged).toBe('')
  })
  it.each([['false', 'true'], ['true', 'false'], ['input', 'true']])(
    'gives local %s precedence over global %s', async (local, global) => {
      normalizationRepository(local, global)
      expect(await getDiagnostics(root)).toMatchObject({ state: 'clean' })
      expect((await getDiff(root)).unstaged).toBe('')
      fs.writeFileSync(path.join(root, 'file.txt'), 'one\ntwo\nthree\n')
      expect((await getDiff(root)).unstaged).toBe(normalizedCommand(...patchArgs))
      if (local === 'false') expect((await getDiff(root)).unstagedStat).toContain('3 insertions(+), 3 deletions(-)')
    })
  it('does not consult an invalid fallback when a local value exists', async () => {
    normalizationRepository('false')
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL!, '[core]\n autocrlf = unexpected\n')
    expect((await getDiff(root)).unstaged).toBe('')
  })
  it.each(['unexpected', 'yes', '1', 'TRUE', '', 'true extra'])(
    'rejects unallowlisted global value %j safely', async (value) => {
      normalizationRepository()
      fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL!, `[core]\n autocrlf = "${value}"\n`)
      await expect(getDiff(root)).rejects.toMatchObject({ code: 'GIT_UNSAFE_CONFIG' })
    })
  it.each(['*.txt -text', '*.txt text eol=lf'])('preserves attributes: %s', async (attributes) => {
    normalizationRepository(undefined, 'true', undefined, attributes)
    expect((await getDiff(root)).unstaged).toBe('')
    fs.writeFileSync(path.join(root, 'file.txt'), 'one\ntwo\nthree\n')
    expect((await getDiff(root)).unstaged).toBe(normalizedCommand(...patchArgs))
    if (attributes.endsWith('-text')) expect((await getDiff(root)).unstaged).not.toBe('')
  })
  it('imports no unrelated global settings or includes and leaves helpers disabled', async () => {
    normalizationRepository(undefined, 'true')
    const included = path.join(temporary, 'included.config')
    fs.writeFileSync(included, '[core]\n autocrlf = false\n')
    fs.appendFileSync(process.env.GIT_CONFIG_GLOBAL!, `
[include]
 path = ${included.replace(/\\/g, '/')}
[core]
 bare = true
 worktree = /not-the-repository
 fsmonitor = definitely-not-a-real-command
 sshCommand = definitely-not-a-real-command
 hooksPath = /not-the-hooks
[diff]
 external = definitely-not-a-real-command
[diff "danger"]
 textconv = definitely-not-a-real-command
[filter "danger"]
 clean = definitely-not-a-real-command
 required = true
[protocol]
 allow = always
[alias]
 status = definitely-not-a-real-command
`)
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt diff=danger filter=danger\n')
    fs.writeFileSync(path.join(root, 'file.txt'), 'one\r\nchanged\r\nthree\r\n')
    expect(await getDiagnostics(root)).toMatchObject({ detected: true, root, state: 'changed' })
    const diff = await getDiff(root)
    expect(diff.unstaged).toContain('+changed')
    expect(diff.unstagedStat).toContain('1 insertion(+), 1 deletion(-)')
  })
})
