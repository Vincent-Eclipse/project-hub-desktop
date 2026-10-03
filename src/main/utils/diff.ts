import type { DiffLine } from '@shared/types'

/**
 * Einfacher zeilenbasierter Diff auf Basis der laengsten gemeinsamen
 * Teilfolge (LCS). Bewusst hand-geschrieben statt einer npm-Abhaengigkeit
 * (siehe Entscheidungs-Memo): Milestone 1 braucht nur einen lesbaren
 * Zeilen-Diff fuer Markdown-Kontextdokumente, keine Wort- oder
 * Zeichen-Diffs. Laufzeit ist O(n*m); fuer die hier erwarteten
 * Dokumentgroessen (Kilobyte-Bereich, nicht Megabyte) unproblematisch.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const n = oldLines.length
  const m = newLines.length

  // LCS-Laengen-Tabelle
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  let oldLineNumber = 1
  let newLineNumber = 1

  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({
        type: 'unchanged',
        text: oldLines[i],
        oldLineNumber: oldLineNumber++,
        newLineNumber: newLineNumber++
      })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: 'removed', text: oldLines[i], oldLineNumber: oldLineNumber++, newLineNumber: null })
      i++
    } else {
      result.push({ type: 'added', text: newLines[j], oldLineNumber: null, newLineNumber: newLineNumber++ })
      j++
    }
  }
  while (i < n) {
    result.push({ type: 'removed', text: oldLines[i], oldLineNumber: oldLineNumber++, newLineNumber: null })
    i++
  }
  while (j < m) {
    result.push({ type: 'added', text: newLines[j], oldLineNumber: null, newLineNumber: newLineNumber++ })
    j++
  }

  return result
}

// Exported (additive-only, no behavior change) so M4.8A's codeChangeDiff.ts can precompute the
// exact LCS matrix cell count (using the SAME line-splitting rule as diffLines itself) BEFORE
// allocating/computing it, instead of duplicating this splitting logic.
export function splitLines(text: string): string[] {
  if (text === '') return []
  return text.split(/\r\n|\r|\n/)
}
