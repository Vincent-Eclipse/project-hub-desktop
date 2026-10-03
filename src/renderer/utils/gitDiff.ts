import type { DiffLine } from '@shared/types'

type PatchDisplay =
  | { format: 'normal'; lines: DiffLine[]; truncated: boolean }
  | { format: 'combined'; raw: string; truncated: boolean }

export function gitDiffLines(patch: string): PatchDisplay {
  const rows = patch.split('\n')
  if (rows.at(-1) === '') rows.pop()
  // Inspect the entire bounded patch, including headers beyond the display limit.
  if (rows.some((row) => /^(?:diff --(?:cc|combined) |@@@)/.test(row))) {
    return { format: 'combined', raw: rows.slice(0, 4000).join('\n'), truncated: rows.length > 4000 }
  }
  let oldLine = 0
  let newLine = 0
  const lines = rows.slice(0, 4000).map((row): DiffLine => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
    } else if (row.startsWith('diff --git ')) {
      oldLine = 0
      newLine = 0
    } else if (oldLine || newLine) {
      if (row.startsWith('+')) return { type: 'added', text: row.slice(1), oldLineNumber: null, newLineNumber: newLine++ }
      if (row.startsWith('-')) return { type: 'removed', text: row.slice(1), oldLineNumber: oldLine++, newLineNumber: null }
      if (row.startsWith(' ')) return { type: 'unchanged', text: row.slice(1), oldLineNumber: oldLine++, newLineNumber: newLine++ }
    }
    return { type: 'unchanged', text: row, oldLineNumber: null, newLineNumber: null }
  })
  return { format: 'normal', lines, truncated: rows.length > lines.length }
}
