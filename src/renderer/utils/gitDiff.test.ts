import { describe, expect, it } from 'vitest'
import { gitDiffLines } from './gitDiff'

describe('Git patch display', () => {
  it('preserves file headers and hunk line numbers', () => {
    const result = gitDiffLines('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -2,2 +3,2 @@\n context\n-old\n+new\n')
    if (result.format !== 'normal') throw new Error('Expected normal diff')
    expect(result.lines[2]).toMatchObject({ type: 'unchanged', text: '+++ b/f', newLineNumber: null })
    expect(result.lines[4]).toMatchObject({ oldLineNumber: 2, newLineNumber: 3, text: 'context' })
    expect(result.lines[5]).toMatchObject({ type: 'removed', oldLineNumber: 3 })
    expect(result.lines[6]).toMatchObject({ type: 'added', newLineNumber: 4 })
    expect(result.truncated).toBe(false)
  })
  it('resets numbering between files and retains binary metadata', () => {
    const result = gitDiffLines('@@ -1 +1 @@\n-old\n+new\ndiff --git a/bin b/bin\nBinary files differ\n')
    if (result.format !== 'normal') throw new Error('Expected normal diff')
    expect(result.lines.at(-1)).toMatchObject({ text: 'Binary files differ', oldLineNumber: null })
  })
  it.each(['diff --cc f', 'diff --combined f', '@@@ -1,1 -1,1 +1,5 @@@'])(
    'displays combined conflict patches as raw text: %s', (header) => {
      const patch = `${header}\nindex 1111111,2222222..0000000\n--- a/f\n+++ b/f\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n +ours\n++=======\n+ theirs\n++>>>>>>> topic\n`
      const result = gitDiffLines(patch)
      expect(result).toEqual({ format: 'combined', raw: patch.trimEnd(), truncated: false })
      expect(result).not.toHaveProperty('lines')
    })
  it('falls back for mixed patches even when the combined header is beyond the display limit', () => {
    const patch = 'diff --git a/f b/f\n@@ -1 +1 @@\n-old\n+new\n' + ' context\n'.repeat(4000) + 'diff --cc conflict\n'
    const result = gitDiffLines(patch)
    expect(result).toMatchObject({ format: 'combined', truncated: true })
    expect(result).not.toHaveProperty('lines')
    if (result.format === 'combined') expect(result.raw.split('\n')).toHaveLength(4000)
  })
  it('explicitly bounds rendered lines', () => {
    expect(gitDiffLines('line\n'.repeat(4001))).toMatchObject({ truncated: true })
    const result = gitDiffLines('line\n'.repeat(4001))
    if (result.format !== 'normal') throw new Error('Expected normal diff')
    expect(result.lines).toHaveLength(4000)
    expect(gitDiffLines('')).toEqual({ format: 'normal', lines: [], truncated: false })
  })
}
)
