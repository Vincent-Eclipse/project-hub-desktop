import type { DiffLine } from '@shared/types'
import { diffLines, splitLines } from '../utils/diff'

// Meilenstein 4.8A Teil I/K - Review-Diff-Engine. Reuse des bestehenden,
// handgeschriebenen LCS-Zeilen-Diffs (diffLines, utils/diff.ts) - KEINE
// zusaetzliche Abhaengigkeit, KEIN `git diff --no-index`, KEIN neuer
// Myers-Algorithmus, KEIN Git-Patch-Parsing. Der Review-Diff vergleicht
// IMMER den ERFASSTEN Original-Inhalt (captured base) gegen den EXAKTEN
// vorgeschlagenen Inhalt - niemals Git HEAD (siehe claudeCodeChangeService.ts's
// Provenienz: der erfasste Quellinhalt ist bereits vom Git-Arbeitsbaum-Zustand
// entkoppelt).
//
// CREATE: `beforeText` ist `null` ("absent") - der gesamte vorgeschlagene
// Inhalt erscheint als vollstaendig "added".

export const CODE_CHANGE_DIFF_MAX_LCS_CELLS = 1_000_000
export const CODE_CHANGE_DIFF_MAX_ROWS_PER_FILE = 10_000

export type CodeChangeDiffTooLargeReason = 'LCS_CELL_LIMIT' | 'ROW_LIMIT'

export class CodeChangeDiffTooLargeError extends Error {
  constructor(public readonly reason: CodeChangeDiffTooLargeReason) {
    super('Der Diff ueberschreitet ein V1-Groessenlimit.')
    this.name = 'CodeChangeDiffTooLargeError'
  }
}

/**
 * Feste, kleine Sperrliste gefaehrlicher bidi-/Nullbreite-Formatierungs-
 * Zeichen (siehe Vorgabe Teil K) - KEIN generisches Unicode-Sicherheits-
 * Framework. Deckt ab: Nullbreite-Zeichen + LRM/RLM (200B-200F), die
 * klassischen bidi-Einbettungs-/Override-Steuerzeichen (202A-202E), die
 * neueren bidi-Isolat-Steuerzeichen (2066-2069) und eine literale BOM
 * (FEFF) innerhalb von Inhalt. Bewusst ueber String.fromCharCode statt
 * literaler Unicode-Zeichen im Quelltext aufgebaut - ein tatsaechliches
 * unsichtbares/bidi-Steuerzeichen als rohes Byte in dieser Datei waere
 * selbst genau das Risiko, das diese Pruefung erkennen soll (analog
 * claudeCodeChangeService.ts's BOM-Zeichen-Pruefung).
 */
function charCodeRange(startCode: number, endCode: number): string {
  let chars = ''
  for (let code = startCode; code <= endCode; code++) chars += String.fromCharCode(code)
  return chars
}

const INVISIBLE_CHAR_SET: ReadonlySet<string> = new Set(
  (charCodeRange(0x200b, 0x200f) + charCodeRange(0x202a, 0x202e) + charCodeRange(0x2066, 0x2069) + String.fromCharCode(0xfeff)).split('')
)

function findInvisibleCharacters(text: string): string[] {
  const found: string[] = []
  for (const char of text) {
    if (INVISIBLE_CHAR_SET.has(char)) found.push(char)
  }
  return found
}

export interface CodeChangeInvisibleAnnotation {
  codePoint: string
  line: number
  side: 'before' | 'after'
}

export interface CodeChangeFileDiffResult {
  lines: DiffLine[]
  whitespaceOnlyChangedLines: number[]
  invisibleAnnotations: CodeChangeInvisibleAnnotation[]
}

function codePointLabel(char: string): string {
  const codePoint = char.codePointAt(0)
  return `U+${(codePoint ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
}

function isWhitespaceOnlyDifference(a: string, b: string): boolean {
  return a !== b && a.replace(/\s+/g, '') === b.replace(/\s+/g, '')
}

/**
 * Erkennt Zeilen, die sich NUR durch Whitespace unterscheiden - ein
 * bewusst kleiner, positions-basierter Heuristik-Abgleich: ein
 * zusammenhaengender "removed"-Lauf gefolgt von einem gleich langen
 * "added"-Lauf wird paarweise (gleicher Index innerhalb des Laufs)
 * verglichen. KEIN generisches Zeilen-Matching/Alignment-Framework.
 */
function detectWhitespaceOnlyChangedLines(lines: DiffLine[]): number[] {
  const flagged: number[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type !== 'removed') {
      i++
      continue
    }
    let removedEnd = i
    while (removedEnd < lines.length && lines[removedEnd].type === 'removed') removedEnd++
    let addedEnd = removedEnd
    while (addedEnd < lines.length && lines[addedEnd].type === 'added') addedEnd++
    const removedCount = removedEnd - i
    const addedCount = addedEnd - removedEnd
    if (removedCount === addedCount) {
      for (let k = 0; k < removedCount; k++) {
        const removedLine = lines[i + k]
        const addedLine = lines[removedEnd + k]
        if (addedLine.newLineNumber !== null && isWhitespaceOnlyDifference(removedLine.text, addedLine.text)) {
          flagged.push(addedLine.newLineNumber)
        }
      }
    }
    i = addedEnd
  }
  return flagged
}

/** Nur ADDED/REMOVED Zeilen werden gescannt ("changed review text", siehe Vorgabe Teil K) - unveraenderte Zeilen nicht. */
function detectInvisibleAnnotations(lines: DiffLine[]): CodeChangeInvisibleAnnotation[] {
  const annotations: CodeChangeInvisibleAnnotation[] = []
  for (const line of lines) {
    if (line.type === 'unchanged') continue
    const side: 'before' | 'after' = line.type === 'removed' ? 'before' : 'after'
    const lineNumber = line.type === 'removed' ? line.oldLineNumber : line.newLineNumber
    if (lineNumber === null) continue
    for (const match of findInvisibleCharacters(line.text)) {
      annotations.push({ codePoint: codePointLabel(match), line: lineNumber, side })
    }
  }
  return annotations
}

/**
 * Berechnet den Review-Diff fuer GENAU eine Datei. `beforeText` ist `null`
 * fuer CREATE (absent -> vollstaendig neuer Inhalt). Wirft
 * CodeChangeDiffTooLargeError, BEVOR die O(n*m)-LCS-Matrix ueberhaupt
 * alloziert/berechnet wird, wenn die Zellenzahl das feste V1-Limit
 * ueberschreitet - und erneut, falls das fertige Diff-Ergebnis selbst das
 * Zeilen-Limit je Datei ueberschreitet. Es gibt KEIN Abschneiden/Kuerzen und
 * danach eine "unvollstaendige" Freigabe - ein zu grosser Diff lehnt die
 * gesamte Datei (und damit die gesamte Review-Erstellung, siehe
 * codeChangeReviewService.ts) komplett ab.
 */
export function computeCodeChangeDiff(beforeText: string | null, afterText: string): CodeChangeFileDiffResult {
  const before = beforeText ?? ''
  const oldLineCount = splitLines(before).length
  const newLineCount = splitLines(afterText).length
  const cellCount = (oldLineCount + 1) * (newLineCount + 1)
  if (cellCount > CODE_CHANGE_DIFF_MAX_LCS_CELLS) {
    throw new CodeChangeDiffTooLargeError('LCS_CELL_LIMIT')
  }

  const lines = diffLines(before, afterText)
  if (lines.length > CODE_CHANGE_DIFF_MAX_ROWS_PER_FILE) {
    throw new CodeChangeDiffTooLargeError('ROW_LIMIT')
  }

  return {
    lines,
    whitespaceOnlyChangedLines: detectWhitespaceOnlyChangedLines(lines),
    invisibleAnnotations: detectInvisibleAnnotations(lines)
  }
}
