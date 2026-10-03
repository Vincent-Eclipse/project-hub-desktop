import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getOperationDefinition, InvalidOperationInputError } from './runOperations'

const git = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'mingw64', 'bin', 'git.exe')
  : '/usr/bin/git'

let temporary: string
let root: string

function command(...args: string[]): string {
  return execFileSync(git, ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@local.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@local.invalid'
    }
  })
}

beforeEach(() => {
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-run-ops-test-')))
  root = path.join(temporary, 'project')
  fs.mkdirSync(root)
  for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    const config = path.join(temporary, name)
    fs.writeFileSync(config, '')
    vi.stubEnv(name, config)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('getOperationDefinition', () => {
  it('resolves the one trusted fixed operation ID with its required capability', () => {
    const definition = getOperationDefinition('repository.getDiagnostics')
    expect(definition?.id).toBe('repository.getDiagnostics')
    expect(definition?.requiredCapabilities).toEqual(['git.read'])
  })

  it('returns undefined for any unknown operation id, including prototype-chain names', () => {
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'repository.getDiff', '']) {
      expect(getOperationDefinition(id)).toBeUndefined()
    }
    expect(getOperationDefinition(42)).toBeUndefined()
    expect(getOperationDefinition(null)).toBeUndefined()
    expect(getOperationDefinition(undefined)).toBeUndefined()
  })
})

describe('repository.getDiagnostics operation - input validation', () => {
  it('accepts only an exact empty object', () => {
    const definition = getOperationDefinition('repository.getDiagnostics')!
    expect(() => definition.validateInput({})).not.toThrow()
    expect(() => definition.validateInput({ extra: 1 })).toThrow(InvalidOperationInputError)
    expect(() => definition.validateInput([])).toThrow(InvalidOperationInputError)
    expect(() => definition.validateInput(null)).toThrow(InvalidOperationInputError)
    expect(() => definition.validateInput('x')).toThrow(InvalidOperationInputError)
  })

  // `typeof x === 'object' && !Array.isArray(x)` alone still accepts
  // Date/Map/class instances with zero own enumerable keys - "exact empty
  // object" must mean a genuine plain object.
  it('rejects a Date, a Map and a class instance even though each has zero own enumerable keys', () => {
    const definition = getOperationDefinition('repository.getDiagnostics')!
    expect(() => definition.validateInput(new Date())).toThrow(InvalidOperationInputError)
    expect(() => definition.validateInput(new Map())).toThrow(InvalidOperationInputError)
    class Empty {}
    expect(() => definition.validateInput(new Empty())).toThrow(InvalidOperationInputError)
  })

  it('accepts a genuine null-prototype object with zero keys', () => {
    const definition = getOperationDefinition('repository.getDiagnostics')!
    expect(() => definition.validateInput(Object.create(null))).not.toThrow()
  })
})

describe('repository.getDiagnostics operation - execute', () => {
  it('returns a safe reduced summary for a clean repository, leaking no raw repository data', async () => {
    command('init', '--initial-branch=main')
    fs.writeFileSync(path.join(root, 'file.txt'), 'content\n')
    command('add', '--', 'file.txt')
    command('commit', '-m', 'fixture')

    const definition = getOperationDefinition('repository.getDiagnostics')!
    const result = await definition.execute(root, {})

    expect(result).toEqual({ repositoryDetected: true, clean: true, counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 } })
    expect(Object.keys(result as object).sort()).toEqual(['clean', 'counts', 'repositoryDetected'])
    expect(JSON.stringify(result)).not.toMatch(/main|file\.txt|fixture/)
  })

  it('counts staged, unstaged, untracked and conflicted files without naming any of them', async () => {
    command('init', '--initial-branch=main')
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'before\n')
    command('add', '--', 'tracked.txt')
    command('commit', '-m', 'fixture')
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'after\n')
    fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n')
    command('add', '--', 'staged.txt')
    fs.writeFileSync(path.join(root, 'new.txt'), 'untracked\n')

    const definition = getOperationDefinition('repository.getDiagnostics')!
    const result = await definition.execute(root, {})

    expect(result).toEqual({
      repositoryDetected: true,
      clean: false,
      counts: { staged: 1, unstaged: 1, untracked: 1, conflicts: 0 }
    })
  })

  it('treats a missing repository as a successful observation, not a failure', async () => {
    const definition = getOperationDefinition('repository.getDiagnostics')!
    await expect(definition.execute(root, {})).resolves.toEqual({ repositoryDetected: false, clean: null, counts: null })
  })
})

// Isoliert in einem eigenen describe-Block: mockt ./gitService per Modul und
// muss daher GitError ueber DASSELBE frisch geladene Modul konstruieren wie
// runOperations.ts es intern importiert - sonst schlaegt `instanceof` trotz
// gleichlautendem Code fehl (zwei verschiedene Modulinstanzen).
describe('repository.getDiagnostics operation - safe error mapping', () => {
  afterEach(() => {
    vi.doUnmock('./gitService')
    vi.resetModules()
  })

  it('maps existing safe GitError codes without leaking subprocess details, and defaults unmapped codes to OPERATION_FAILED', async () => {
    // Force a clean module registry BEFORE mocking - the top-level static
    // import of runOperations.ts earlier in this file already cached the
    // REAL gitService binding; without this, a fresh dynamic import() would
    // still resolve to that same cached (unmocked) module graph.
    vi.resetModules()
    vi.doMock('./gitService', () => ({ getDiagnostics: vi.fn() }))
    const { getDiagnostics } = await import('./gitService')
    const { GitError } = await import('./gitErrors')
    const { getOperationDefinition: freshGetOperationDefinition, OperationExecutionError } = await import('./runOperations')
    const definition = freshGetOperationDefinition('repository.getDiagnostics')!

    const cases: Array<[InstanceType<typeof GitError>['code'], string]> = [
      ['GIT_BUSY', 'BUSY'],
      ['GIT_TIMEOUT', 'TIMEOUT'],
      ['GIT_OUTPUT_LIMIT', 'OUTPUT_LIMIT'],
      ['GIT_UNSAFE_PATH', 'OPERATION_FAILED'],
      ['GIT_UNAVAILABLE', 'OPERATION_FAILED']
    ]
    for (const [gitCode, expectedFailureCode] of cases) {
      vi.mocked(getDiagnostics).mockRejectedValueOnce(new GitError(gitCode))
      await expect(definition.execute(root, {})).rejects.toMatchObject({ failureCode: expectedFailureCode })
    }

    vi.mocked(getDiagnostics).mockRejectedValueOnce(new Error('unexpected raw failure with secret stack info'))
    const rejection = await definition.execute(root, {}).catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(OperationExecutionError)
    expect((rejection as InstanceType<typeof OperationExecutionError>).failureCode).toBe('OPERATION_FAILED')
    expect((rejection as Error).message).not.toContain('secret')
  })
})

describe('project.readTextFiles operation - input validation (duplicate/case-alias rejection)', () => {
  it('accepts a list of normal, distinct paths', () => {
    const definition = getOperationDefinition('project.readTextFiles')!
    expect(definition.validateInput({ relativePaths: ['src/a.ts', 'src/b.ts'] })).toEqual({
      relativePaths: ['src/a.ts', 'src/b.ts']
    })
  })

  it('rejects an exact duplicate path in the request list', () => {
    const definition = getOperationDefinition('project.readTextFiles')!
    expect(() => definition.validateInput({ relativePaths: ['src/a.ts', 'src/a.ts'] })).toThrow(InvalidOperationInputError)
  })

  it('rejects a case-only alias in the request list (Windows same-file ambiguity)', () => {
    const definition = getOperationDefinition('project.readTextFiles')!
    expect(() => definition.validateInput({ relativePaths: ['src/a.ts', 'SRC/A.ts'] })).toThrow(InvalidOperationInputError)
  })
})
