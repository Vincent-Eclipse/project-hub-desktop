import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { RepositoryDiagnostics, RepositoryDiff, RepositoryFile } from '@shared/types'
import { GitError } from './gitErrors'

const MAX_OUTPUT = 512 * 1024
const TIMEOUT_MS = 10_000
let activeReads = 0

function beginRead(): number {
  if (activeReads >= 2) throw new GitError('GIT_BUSY')
  activeReads++
  return Date.now() + TIMEOUT_MS
}
const NULL_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null'
const GIT = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'mingw64', 'bin', 'git.exe')
  : '/usr/bin/git'

type AutoCrlf = 'true' | 'false' | 'input'
type ConfigScope = '--global' | '--system'

function environment(configScope?: ConfigScope): NodeJS.ProcessEnv {
  return {
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_NOSYSTEM: configScope === '--system' ? '0' : '1',
    GIT_CONFIG_GLOBAL: configScope === '--global' ? process.env.GIT_CONFIG_GLOBAL : NULL_FILE,
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: '', LC_ALL: 'C',
    // These sources are visible only to the fixed, includes-disabled autocrlf query.
    ...(configScope === '--global' ? {
      HOME: process.env.HOME || os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME
    } : configScope === '--system' ? {
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM
    } : {})
  }
}

// Private and called only with literal read operations; never exposed through IPC.
async function readGit(root: string, args: string[], deadline: number,
  options: { autocrlf?: AutoCrlf; configScope?: ConfigScope } = {}): Promise<string> {
  if (await canonicalFolder(root) !== root) throw new GitError('GIT_UNSAFE_PATH')
  try {
    const metadata = path.join(root, '.git')
    if (await fs.realpath(metadata) !== metadata) throw new GitError('GIT_UNSAFE_PATH')
  } catch {
    throw new GitError('GIT_UNSAFE_PATH')
  }
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.reject(new GitError('GIT_TIMEOUT'))
  return new Promise((resolve, reject) => {
    const child = execFile(GIT, [
      '--no-pager', '--no-optional-locks', '--git-dir', path.join(root, '.git'), '--work-tree', root,
      '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NULL_FILE}`,
      '-c', `core.attributesFile=${NULL_FILE}`, '-c', `core.excludesFile=${NULL_FILE}`,
      '-c', 'core.untrackedCache=false', '-c', 'maintenance.auto=false',
      '-c', 'gc.auto=0', '-c', 'protocol.allow=never',
      '-c', `diff.orderFile=${NULL_FILE}`, '-c', 'diff.relative=false',
      '-c', 'diff.autoRefreshIndex=false', '-c', 'status.renames=true', '-c', 'status.renameLimit=1000',
      ...(options.autocrlf ? ['-c', `core.autocrlf=${options.autocrlf}`] : []),
      ...(options.configScope
        ? ['config', options.configScope, '--no-includes', '--null', '--get', 'core.autocrlf'] : args)
    ], {
      cwd: root, shell: false, windowsHide: true, env: environment(options.configScope),
      encoding: 'utf8', timeout: remaining, maxBuffer: MAX_OUTPUT, killSignal: 'SIGKILL'
    }, (error, stdout) => {
      if (!error) return resolve(stdout)
      // Exit 1 means the requested config key is absent, not a process failure.
      if (options.configScope && !error.killed && (error as { code?: unknown }).code === 1) return resolve('')
      const code = (error as NodeJS.ErrnoException).code
      reject(new GitError(code === 'ENOENT' ? 'GIT_UNAVAILABLE'
        : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'GIT_OUTPUT_LIMIT'
          : error.killed ? 'GIT_TIMEOUT' : 'GIT_FAILED'))
    })
    child.stdin?.end()
  })
}

async function canonicalFolder(raw: string | null): Promise<string> {
  if (!raw) throw new GitError('GIT_PATH_MISSING')
  if (!path.isAbsolute(raw) || /[\x00-\x1f]/.test(raw) || raw.split(/[\\/]/).includes('..') ||
      (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(raw) || /[:]/.test(raw.slice(2))))) {
    throw new GitError('GIT_UNSAFE_PATH')
  }
  try {
    if (!(await fs.stat(raw)).isDirectory()) throw new GitError('GIT_PATH_NOT_DIRECTORY')
    const canonical = await fs.realpath(raw)
    // Saved project folders are already canonical. A later junction replacement must fail closed.
    if (path.relative(path.resolve(raw), canonical) !== '') throw new GitError('GIT_UNSAFE_PATH')
    return canonical
  } catch (error) {
    if (error instanceof GitError) throw error
    throw new GitError((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'GIT_PATH_MISSING' : 'GIT_UNSAFE_PATH')
  }
}

// Only Git's trusted metadata boundary is checked; Git owns worktree traversal.
async function checkMetadata(root: string): Promise<void> {
  for (const name of ['.git', '.git/config', '.git/HEAD', '.git/index', '.git/packed-refs',
    '.git/shallow', '.git/refs', '.git/objects', '.git/objects/info', '.git/objects/pack',
    '.git/info', '.git/info/grafts', '.git/info/attributes', '.git/info/exclude']) {
    const target = path.join(root, name)
    let entry
    try {
      entry = await fs.lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && name !== '.git') continue
      throw error
    }
    if (entry.isSymbolicLink() || await fs.realpath(target) !== target) {
      throw new GitError('GIT_UNSAFE_PATH')
    }
  }
}

async function fallbackAutoCrlf(root: string, deadline: number): Promise<AutoCrlf | undefined> {
  for (const configScope of ['--global', '--system'] as const) {
    const value = await readGit(root, [], deadline, { configScope })
    if (value === '') continue
    // Validate the complete NUL-terminated result; never forward arbitrary config text.
    if (value === 'true\0') return 'true'
    if (value === 'false\0') return 'false'
    if (value === 'input\0') return 'input'
    throw new GitError('GIT_UNSAFE_CONFIG')
  }
  return undefined
}

async function prepare(raw: string | null, deadline: number): Promise<{ root: string; autocrlf?: AutoCrlf } | null> {
  const root = await canonicalFolder(raw)
  try {
    const metadata = await fs.lstat(path.join(root, '.git'))
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new GitError('GIT_INVALID_ROOT')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof GitError) throw error
    throw new GitError('GIT_UNSAFE_PATH')
  }
  try {
    await checkMetadata(root)
    for (const name of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']) {
      try {
        await fs.lstat(path.join(root, '.git', name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      throw new GitError('GIT_UNSAFE_CONFIG')
    }
  } catch (error) {
    if (error instanceof GitError) throw error
    throw new GitError('GIT_UNSAFE_PATH')
  }
  // Do not load includes. Reject configs that redirect storage or execute conversion helpers.
  const config = await readGit(root, ['config', '--local', '--no-includes', '--null', '--list'], deadline)
  let localAutoCrlf = false
  for (const record of config.split('\0')) {
    const key = record.split('\n', 1)[0].toLowerCase()
    if (key === 'core.autocrlf') localAutoCrlf = true
    if (/^(include\.|includeif\.|filter\.|extensions\.)/.test(key) ||
        ['core.worktree', 'core.bare', 'core.sshcommand'].includes(key) &&
        !(key === 'core.bare' && record.endsWith('\nfalse'))) {
      throw new GitError('GIT_UNSAFE_CONFIG')
    }
  }
  const autocrlf = localAutoCrlf ? undefined : await fallbackAutoCrlf(root, deadline)
  const detected = (await readGit(root, ['rev-parse', '--show-toplevel'], deadline)).trimEnd()
  if (await canonicalFolder(detected) !== root) throw new GitError('GIT_INVALID_ROOT')
  return { root, autocrlf }
}

function parseStatus(output: string): RepositoryFile[] {
  const records = output.split('\0')
  const files: RepositoryFile[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    const index = record[0]
    const worktree = record[1]
    const renamed = index === 'R' || worktree === 'R'
    files.push({
      path: record.slice(3), index, worktree,
      kind: record.startsWith('??') ? 'untracked'
        : index === 'U' || worktree === 'U' || ['AA', 'DD'].includes(record.slice(0, 2)) ? 'conflicted'
          : renamed ? 'renamed' : record.slice(0, 2).includes('D') ? 'deleted'
            : record.slice(0, 2).includes('A') ? 'added' : 'modified',
      previousPath: renamed ? records[++i] : null
    })
  }
  return files
}

export async function getDiagnostics(projectPath: string | null): Promise<RepositoryDiagnostics> {
  const deadline = beginRead()
  try {
    const prepared = await prepare(projectPath, deadline)
    if (!prepared) return { detected: false, root: null, branch: null, state: null, files: [] }
    const { root, autocrlf } = prepared
    const branch = (await readGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'], deadline, { autocrlf }).catch(async (error) => {
      if (!(error instanceof GitError) || error.code !== 'GIT_FAILED') throw error
      return readGit(root, ['symbolic-ref', '--short', 'HEAD'], deadline, { autocrlf })
    })).trimEnd()
    const files = parseStatus(await readGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], deadline, { autocrlf }))
    return { detected: true, root, branch: branch === 'HEAD' ? null : branch,
      state: files.length ? 'changed' : 'clean', files }
  } finally {
    activeReads--
  }
}

export async function getDiff(projectPath: string | null): Promise<RepositoryDiff> {
  const deadline = beginRead()
  try {
    const prepared = await prepare(projectPath, deadline)
    if (!prepared) throw new GitError('GIT_NOT_REPOSITORY')
    const { root, autocrlf } = prepared
    const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=all']
    const unstaged = await readGit(root, ['diff', ...options, '--patch', '--'], deadline, { autocrlf })
    const staged = await readGit(root, ['diff', '--cached', ...options, '--patch', '--'], deadline, { autocrlf })
    const unstagedStat = await readGit(root, ['diff', ...options, '--stat', '--'], deadline, { autocrlf })
    const stagedStat = await readGit(root, ['diff', '--cached', ...options, '--stat', '--'], deadline, { autocrlf })
    return { unstaged, staged, unstagedStat, stagedStat, truncated: false }
  } finally {
    activeReads--
  }
}
