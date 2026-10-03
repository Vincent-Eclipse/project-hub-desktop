import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { InvalidRelevantFileError, validateRelevantFilePath, validateRelevantFilesList } from './taskRelevantFiles'

describe('validateRelevantFilePath', () => {
  it('accepts normal project-relative paths and normalizes backslashes to slashes', () => {
    expect(validateRelevantFilePath('src/main/services/example.ts')).toBe('src/main/services/example.ts')
    expect(validateRelevantFilePath('src\\main\\services\\example.ts')).toBe('src/main/services/example.ts')
    expect(validateRelevantFilePath('README.md')).toBe('README.md')
  })

  it.each([
    ['not a string', 42],
    ['empty path', ''],
    ['NUL character', 'foo\u0000bar.ts'],
    ['Windows absolute path', 'C:\\Users\\leon\\file.ts'],
    ['Windows absolute path with forward slashes', 'C:/Users/leon/file.ts'],
    ['drive-qualified relative path', 'C:file.ts'],
    ['UNC path (backslash)', '\\\\server\\share\\file.ts'],
    ['UNC path (forward slash)', '//server/share/file.ts'],
    ['POSIX absolute path', '/etc/passwd'],
    ['POSIX absolute path (leading backslash)', '\\etc\\passwd'],
    ['traversal at start', '../secrets.env'],
    ['traversal in the middle', 'src/../../secrets.env'],
    ['traversal with backslashes', 'src\\..\\..\\secrets.env'],
    ['trailing slash (empty segment)', 'src/'],
    ['too long', 'a'.repeat(1025)],
    // ChatGPT-Review Fix 4: nicht-kanonische Formen, die durch die
    // "eine Zeile je Eintrag"-Oberflaeche (join('\n') / split('\n').trim())
    // nicht round-trip-sicher waeren, werden abgelehnt statt still getrimmt.
    ['leading space', ' file.ts'],
    ['trailing space', 'file.ts '],
    ['leading tab', '\tfile.ts'],
    ['trailing tab', 'file.ts\t'],
    ['embedded LF', 'a\nb'],
    ['embedded CR', 'a\rb'],
    ['embedded CRLF', 'a\r\nb']
  ])('rejects %s', (_label, raw) => {
    expect(() => validateRelevantFilePath(raw)).toThrow(InvalidRelevantFileError)
  })

  it('accepts the exact boundary length', () => {
    const path = 'a'.repeat(1024)
    expect(path.length).toBe(1024)
    expect(validateRelevantFilePath(path)).toBe(path)
  })

  it('allows spaces INSIDE a path component (only leading/trailing whitespace of the whole entry is rejected)', () => {
    expect(validateRelevantFilePath('my folder/file.ts')).toBe('my folder/file.ts')
    expect(validateRelevantFilePath('src/my file.ts')).toBe('src/my file.ts')
    expect(validateRelevantFilePath('a b c.ts')).toBe('a b c.ts')
  })

  it('round-trips normal paths unchanged (no silent trimming or rewriting beyond separator normalization)', () => {
    for (const path of ['README.md', 'src/main/example.ts', 'my folder/file.ts', 'a.b.c.ts']) {
      expect(validateRelevantFilePath(path)).toBe(path)
    }
  })

  it('still normalizes backslashes to forward slashes for otherwise-canonical input', () => {
    expect(validateRelevantFilePath('src\\main\\index.ts')).toBe('src/main/index.ts')
  })

  it('performs zero filesystem access while validating', () => {
    const statSpy = vi.spyOn(fs, 'statSync')
    const existsSpy = vi.spyOn(fs, 'existsSync')
    const readSpy = vi.spyOn(fs, 'readFileSync')
    try {
      expect(validateRelevantFilePath('src/definitely/does/not/exist.ts')).toBe('src/definitely/does/not/exist.ts')
      expect(() => validateRelevantFilePath('/etc/passwd')).toThrow(InvalidRelevantFileError)
      expect(() => validateRelevantFilePath(' file.ts')).toThrow(InvalidRelevantFileError)
      expect(() => validateRelevantFilePath('a\nb')).toThrow(InvalidRelevantFileError)
      expect(statSpy).not.toHaveBeenCalled()
      expect(existsSpy).not.toHaveBeenCalled()
      expect(readSpy).not.toHaveBeenCalled()
    } finally {
      statSpy.mockRestore()
      existsSpy.mockRestore()
      readSpy.mockRestore()
    }
  })
})

describe('validateRelevantFilesList', () => {
  it('validates every entry and preserves order', () => {
    expect(validateRelevantFilesList(['b.ts', 'a.ts'])).toEqual(['b.ts', 'a.ts'])
    expect(validateRelevantFilesList([])).toEqual([])
  })

  it('rejects a non-array value', () => {
    expect(() => validateRelevantFilesList('not-an-array')).toThrow(InvalidRelevantFileError)
  })

  it('rejects more than 100 entries', () => {
    expect(() => validateRelevantFilesList(Array.from({ length: 101 }, (_, i) => `file-${i}.ts`))).toThrow(
      InvalidRelevantFileError
    )
    expect(validateRelevantFilesList(Array.from({ length: 100 }, (_, i) => `file-${i}.ts`))).toHaveLength(100)
  })

  it('rejects the whole list if any single entry is invalid', () => {
    expect(() => validateRelevantFilesList(['valid.ts', '../escape.ts'])).toThrow(InvalidRelevantFileError)
  })

  it('does not deduplicate - a duplicate entry is preserved verbatim, in place', () => {
    expect(validateRelevantFilesList(['a.ts', 'a.ts'])).toEqual(['a.ts', 'a.ts'])
    expect(validateRelevantFilesList(['a.ts', 'b.ts', 'a.ts'])).toEqual(['a.ts', 'b.ts', 'a.ts'])
  })
})
