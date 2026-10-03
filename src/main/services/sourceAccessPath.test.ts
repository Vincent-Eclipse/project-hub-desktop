import { describe, expect, it } from 'vitest'
import { assertNoCaseInsensitiveDuplicatePaths, InvalidSourceAccessPathError, validateSourceAccessPath } from './sourceAccessPath'

describe('validateSourceAccessPath - accepts', () => {
  it('accepts a valid nested source path', () => {
    expect(validateSourceAccessPath('src/main/example.ts')).toBe('src/main/example.ts')
  })

  it('accepts a top-level file', () => {
    expect(validateSourceAccessPath('package.json')).toBe('package.json')
  })

  it('accepts ordinary development files (not categorically secret)', () => {
    expect(validateSourceAccessPath('package.json')).toBe('package.json')
    expect(validateSourceAccessPath('tsconfig.node.json')).toBe('tsconfig.node.json')
    expect(validateSourceAccessPath('src/main/db/migrations/006_work_requests.ts')).toBe('src/main/db/migrations/006_work_requests.ts')
    expect(validateSourceAccessPath('scripts/build.js')).toBe('scripts/build.js')
    expect(validateSourceAccessPath('src/main/services/foo.test.ts')).toBe('src/main/services/foo.test.ts')
    expect(validateSourceAccessPath('README.md')).toBe('README.md')
  })
})

describe('validateSourceAccessPath - syntax rejections', () => {
  it('rejects non-string input', () => {
    expect(() => validateSourceAccessPath(42)).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath(null)).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath(undefined)).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects an empty path', () => {
    expect(() => validateSourceAccessPath('')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects an absolute path', () => {
    expect(() => validateSourceAccessPath('/etc/passwd')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('/src/main.ts')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects a Windows drive path', () => {
    expect(() => validateSourceAccessPath('C:/Windows/system32')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects a drive-relative form', () => {
    expect(() => validateSourceAccessPath('C:foo/bar')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects a UNC path', () => {
    expect(() => validateSourceAccessPath('//server/share/file.ts')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects device/extended Windows paths', () => {
    expect(() => validateSourceAccessPath('\\\\?\\C:\\Windows')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('\\\\.\\PhysicalDrive0')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects any backslash input', () => {
    expect(() => validateSourceAccessPath('src\\main\\example.ts')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects "../" traversal', () => {
    expect(() => validateSourceAccessPath('../secret.txt')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/../../../secret.txt')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/..')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects "./" segments', () => {
    expect(() => validateSourceAccessPath('./src/main.ts')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/./main.ts')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects repeated separators', () => {
    expect(() => validateSourceAccessPath('src//main.ts')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/main.ts/')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects NUL and ASCII control characters', () => {
    expect(() => validateSourceAccessPath('src/main\u0000.ts')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/main\u0007.ts')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects colon/ADS syntax', () => {
    expect(() => validateSourceAccessPath('src/file.txt:secret')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects wildcard characters', () => {
    expect(() => validateSourceAccessPath('src/*.ts')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/file?.ts')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects other invalid Windows filename characters', () => {
    expect(() => validateSourceAccessPath('src/<file>.ts')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/file|pipe.ts')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/"quoted".ts')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects a trailing dot or space in a segment', () => {
    expect(() => validateSourceAccessPath('src/file.ts.')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/file.ts ')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src /file.ts')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects Windows reserved device names', () => {
    expect(() => validateSourceAccessPath('CON')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('con.txt')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/NUL')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/COM1.ts')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('src/lpt9')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects an overly long path', () => {
    expect(() => validateSourceAccessPath('a/'.repeat(600) + 'file.ts')).toThrow(InvalidSourceAccessPathError)
  })

  it('does not clean/normalize an unsafe path - it rejects outright rather than resolving traversal', () => {
    // A path containing ".." that a naive resolver might silently collapse to a safe path must
    // still reject outright - never silently repaired/normalized away.
    expect(() => validateSourceAccessPath('src/foo/../main.ts')).toThrow(InvalidSourceAccessPathError)
  })
})

describe('validateSourceAccessPath - secret/control path exclusions', () => {
  it('rejects paths inside .git', () => {
    expect(() => validateSourceAccessPath('.git/config')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('.git/HEAD')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('sub/.git/config')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects paths inside .claude', () => {
    expect(() => validateSourceAccessPath('.claude/settings.json')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects .env and .env.* files', () => {
    expect(() => validateSourceAccessPath('.env')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('.env.local')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('server/.env.production')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects .env/.env.* as ANY path segment, not only the final filename', () => {
    expect(() => validateSourceAccessPath('.env/a.ts')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('.env/secrets.ts')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('.env.local/a.ts')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('config/.env.production/token.ts')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('CONFIG/.ENV.TEST/foo.ts')).toThrow(InvalidSourceAccessPathError)
  })

  it('keeps ordinary dot-directories allowed - only .env/.env.* is a categorical segment exclusion', () => {
    expect(() => validateSourceAccessPath('.storybook/main.ts')).not.toThrow()
    expect(() => validateSourceAccessPath('.vscode/settings.json')).not.toThrow()
  })

  it('rejects private key / certificate secret-key files', () => {
    expect(() => validateSourceAccessPath('keys/server.pem')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('keys/server.key')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('id_rsa')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects known credential-store files', () => {
    expect(() => validateSourceAccessPath('.npmrc')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('.netrc')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('.git-credentials')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects dependency/generated trees by default', () => {
    expect(() => validateSourceAccessPath('node_modules/foo/index.js')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('dist/index.js')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('build/output.js')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('out/main/index.js')).toThrow(InvalidSourceAccessPathError)
    expect(() => validateSourceAccessPath('coverage/index.html')).toThrow(InvalidSourceAccessPathError)
  })

  it('keeps ordinary explicit development files eligible even though they are not identical to excluded names', () => {
    expect(() => validateSourceAccessPath('package.json')).not.toThrow()
    expect(() => validateSourceAccessPath('src/main/db/migrations/001_init.ts')).not.toThrow()
    expect(() => validateSourceAccessPath('docs/README.md')).not.toThrow()
  })
})

describe('assertNoCaseInsensitiveDuplicatePaths', () => {
  it('accepts a list with no duplicates', () => {
    expect(() => assertNoCaseInsensitiveDuplicatePaths(['src/a.ts', 'src/b.ts'], 'list')).not.toThrow()
  })

  it('rejects an exact duplicate', () => {
    expect(() => assertNoCaseInsensitiveDuplicatePaths(['src/a.ts', 'src/a.ts'], 'list')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects a case-insensitive alias on Windows-style comparison', () => {
    expect(() => assertNoCaseInsensitiveDuplicatePaths(['src/A.ts', 'src/a.ts'], 'list')).toThrow(InvalidSourceAccessPathError)
  })

  it('rejects an empty list gracefully (no throw for zero entries)', () => {
    expect(() => assertNoCaseInsensitiveDuplicatePaths([], 'list')).not.toThrow()
  })
})
