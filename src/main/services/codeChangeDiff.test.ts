import { describe, expect, it } from 'vitest'
import {
  CODE_CHANGE_DIFF_MAX_LCS_CELLS,
  CODE_CHANGE_DIFF_MAX_ROWS_PER_FILE,
  CodeChangeDiffTooLargeError,
  computeCodeChangeDiff
} from './codeChangeDiff'

describe('computeCodeChangeDiff - MODIFY (captured base vs proposed)', () => {
  it('computes a line diff between two versions, never against Git HEAD', () => {
    const result = computeCodeChangeDiff('line1\nline2\n', 'line1\nline2 changed\n')
    expect(result.lines.map((line) => [line.type, line.text])).toEqual([
      ['unchanged', 'line1'],
      ['removed', 'line2'],
      ['added', 'line2 changed'],
      ['unchanged', '']
    ])
  })

  it('returns an empty diff for identical content', () => {
    const result = computeCodeChangeDiff('same\n', 'same\n')
    expect(result.lines.every((line) => line.type === 'unchanged')).toBe(true)
  })
})

describe('computeCodeChangeDiff - CREATE (absent -> proposed)', () => {
  it('treats a null before-text as fully absent, so every line is added', () => {
    const result = computeCodeChangeDiff(null, 'export function test() {}\n')
    expect(result.lines.every((line) => line.type === 'added')).toBe(true)
    expect(result.lines.map((line) => line.text)).toEqual(['export function test() {}', ''])
  })
})

describe('computeCodeChangeDiff - whitespace-only annotation', () => {
  it('flags a changed line that differs only by whitespace', () => {
    const result = computeCodeChangeDiff('const x = 1;\n', 'const   x =    1;\n')
    expect(result.whitespaceOnlyChangedLines).toEqual([1])
  })

  it('does not flag a line whose content actually changed', () => {
    const result = computeCodeChangeDiff('const x = 1;\n', 'const x = 2;\n')
    expect(result.whitespaceOnlyChangedLines).toEqual([])
  })

  it('does not flag unequal-length removed/added runs', () => {
    const result = computeCodeChangeDiff('a\nb\n', 'a\nb\nc\n')
    expect(result.whitespaceOnlyChangedLines).toEqual([])
  })
})

describe('computeCodeChangeDiff - invisible/bidi annotation', () => {
  it('flags a zero-width character introduced in an added line', () => {
    const zeroWidthSpace = String.fromCharCode(0x200b)
    const result = computeCodeChangeDiff('safe\n', `safe${zeroWidthSpace}\n`)
    expect(result.invisibleAnnotations).toEqual([{ codePoint: 'U+200B', line: expect.any(Number), side: 'after' }])
  })

  it('flags a bidi override character on the removed (before) side', () => {
    const rtlOverride = String.fromCharCode(0x202e)
    const result = computeCodeChangeDiff(`x${rtlOverride}y\n`, 'plain\n')
    const annotation = result.invisibleAnnotations.find((entry) => entry.side === 'before')
    expect(annotation).toEqual({ codePoint: 'U+202E', line: expect.any(Number), side: 'before' })
  })

  it('never flags an unchanged line, even if it contains an invisible character', () => {
    const zeroWidthJoiner = String.fromCharCode(0x200d)
    const shared = `shared${zeroWidthJoiner}line\n`
    const result = computeCodeChangeDiff(shared + 'a\n', shared + 'b\n')
    expect(result.invisibleAnnotations.every((entry) => entry.line !== 1)).toBe(true)
  })

  it('does not reject valid, ordinary non-ASCII Unicode text', () => {
    const result = computeCodeChangeDiff('héllo wörld 你好\n', 'héllo wörld 你好 changed\n')
    expect(result.invisibleAnnotations).toEqual([])
  })

  it('flags a literal BOM character appearing inside content', () => {
    const bom = String.fromCharCode(0xfeff)
    const result = computeCodeChangeDiff('a\n', `${bom}a\n`)
    expect(result.invisibleAnnotations).toEqual([{ codePoint: 'U+FEFF', line: expect.any(Number), side: 'after' }])
  })
})

describe('computeCodeChangeDiff - size limits (V1 bounds)', () => {
  it('rejects before allocating the LCS matrix when the cell count exceeds the fixed limit', () => {
    // (n+1)*(m+1) must exceed CODE_CHANGE_DIFF_MAX_LCS_CELLS - use two large, DIFFERENT line
    // counts so the cell-count check is exercised without needing enormous strings.
    const bigLineCount = Math.ceil(Math.sqrt(CODE_CHANGE_DIFF_MAX_LCS_CELLS)) + 10
    const before = Array.from({ length: bigLineCount }, (_, i) => `line-${i}`).join('\n')
    const after = Array.from({ length: bigLineCount }, (_, i) => `line-${i}-changed`).join('\n')
    let caught: unknown
    try {
      computeCodeChangeDiff(before, after)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeDiffTooLargeError)
    expect((caught as CodeChangeDiffTooLargeError).reason).toBe('LCS_CELL_LIMIT')
  })

  it('rejects when the finished diff itself exceeds the per-file row limit, without truncating', () => {
    // Deliberately asymmetric: one single "before" line against many unique "after" lines keeps
    // the LCS cell count tiny ((1+1)*(m+1)) while the resulting diff still has one row per "after"
    // line (all added, since none match the single before line) - isolates the ROW_LIMIT check
    // from the LCS_CELL_LIMIT check, which a symmetric n=m case cannot do (there, row count and
    // cell count grow together, so the cell limit always trips first).
    const lineCount = CODE_CHANGE_DIFF_MAX_ROWS_PER_FILE + 1
    const before = 'unrelated single line'
    const after = Array.from({ length: lineCount }, (_, i) => `unique-after-line-${i}`).join('\n')
    let caught: unknown
    try {
      computeCodeChangeDiff(before, after)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeDiffTooLargeError)
    expect((caught as CodeChangeDiffTooLargeError).reason).toBe('ROW_LIMIT')
  })

  it('accepts a diff comfortably within the row limit', () => {
    const lineCount = 9_000
    const before = 'unrelated single line'
    const after = Array.from({ length: lineCount }, (_, i) => `unique-after-line-${i}`).join('\n')
    const result = computeCodeChangeDiff(before, after)
    expect(result.lines.length).toBeLessThanOrEqual(CODE_CHANGE_DIFF_MAX_ROWS_PER_FILE)
  })
})
