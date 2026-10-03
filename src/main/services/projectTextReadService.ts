import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  PROJECT_TEXT_READ_MAX_AGGREGATE_BYTES,
  PROJECT_TEXT_READ_MAX_FILES,
  PROJECT_TEXT_READ_MAX_INDIVIDUAL_BYTES,
  type LineEnding,
  type ProjectTextFileIdentityEvidence,
  type ProjectTextFileResult
} from '@shared/projectTextReadTypes'
import { assertNoCaseInsensitiveDuplicatePaths, validateSourceAccessPath } from './sourceAccessPath'

// Test-only hook state - see __setTestHookAfterStatBefore at the bottom of this file.
let testHookAfterStatBefore: (() => Promise<void> | void) | null = null

// Meilenstein 4.7B.1 - vertrauenswuerdiger Quell-Textleser. Liest
// AUSSCHLIESSLICH bereits von Main geprueft freigegebene, projekt-relative
// Textdateien - niemals einen Ordner, niemals rekursiv, niemals per
// Glob/Muster. `relativePaths` sind zu diesem Zeitpunkt bereits gegen einen
// vertrauenswuerdigen Main-eigenen Lesebereich abgeglichen worden (siehe
// runService.ts's RunTrustedScope) - diese Datei validiert die Syntax
// dennoch selbst nochmal (Verteidigung-in-der-Tiefe), verlaesst sich aber
// NICHT auf `allowedRelativePaths` als eigenes Argument.
//
// WICHTIG (Windows-Containment-Ehrlichkeit, siehe Vorgabe Teil Q):
// Node lstat/realpath/open-Pruefungen sind KEINE atomare Windows-Dateisystem-
// Sandbox. Ein bösartiger Prozess mit denselben Benutzerrechten koennte
// zwischen zwei Pruefungen einen Pfad austauschen (TOCTOU-Race). Dieser Leser
// ist eine interne V1-Quellgrenze fuer kontrollierte Projektbaeume und Tests
// - er behauptet NICHT, gegen einen bösartigen, gleichzeitig manipulierenden
// Dateisystem-Akteur race-sicher zu sein. Es gibt KEINEN produktiven
// Aufrufer und KEINE Provider-Offenlegung in M4.7B.1. Es werden bewusst
// KEINE Windows Job Objects/Kernel-Treiber/Container/VM/Sandbox-Frameworks
// gebaut.

export const PROJECT_TEXT_READ_ERROR_CODES = [
  'INVALID_REQUEST',
  'LIMIT_EXCEEDED',
  'ROOT_INVALID',
  'NOT_FOUND',
  'NOT_A_FILE',
  'UNSAFE_PATH',
  'ENCODING_INVALID',
  'CONTENT_REJECTED',
  'CHANGED_DURING_READ',
  'READ_FAILED'
] as const
export type ProjectTextReadErrorCode = (typeof PROJECT_TEXT_READ_ERROR_CODES)[number]

// Feste, nicht-sensible Fehlermeldungen je Code - NIEMALS rohe Dateisystem-
// Fehlertexte, absolute Pfade oder Dateiinhalt (siehe Vorgabe Teil E/M).
const ERROR_MESSAGES: Record<ProjectTextReadErrorCode, string> = {
  INVALID_REQUEST: 'Die Leseanfrage ist ungueltig.',
  LIMIT_EXCEEDED: 'Ein Groessenlimit wurde ueberschritten.',
  ROOT_INVALID: 'Der Projektordner ist nicht als vertrauenswuerdige Quellwurzel nutzbar.',
  NOT_FOUND: 'Eine angeforderte Datei wurde nicht gefunden.',
  NOT_A_FILE: 'Ein angeforderter Pfad ist keine gewoehnliche Datei.',
  UNSAFE_PATH: 'Ein angeforderter Pfad konnte nicht sicher innerhalb der Projektwurzel bestaetigt werden.',
  ENCODING_INVALID: 'Eine Datei ist nicht in unterstuetzter UTF-8-Kodierung.',
  CONTENT_REJECTED: 'Der Dateiinhalt kann aus Sicherheitsgruenden nicht zurueckgegeben werden.',
  CHANGED_DURING_READ: 'Der Quellzustand hat sich waehrend des Lesens veraendert.',
  READ_FAILED: 'Die Datei konnte nicht gelesen werden.'
}

export class ProjectTextReadError extends Error {
  constructor(public readonly code: ProjectTextReadErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'ProjectTextReadError'
  }
}

// ---------------------------------------------------------------------------
// ROOT (Vorgabe Teil F "ROOT")
// ---------------------------------------------------------------------------

// Exported (additive-only, no behavior change) so M4.7B.2's CREATE-precondition
// check (claudeCodeChangeService.ts) can resolve the same trusted, realpath'd
// project root instead of duplicating root-safety logic.
export async function resolveRoot(projectFolderPath: string | null): Promise<string> {
  if (typeof projectFolderPath !== 'string' || projectFolderPath.length === 0 || !path.isAbsolute(projectFolderPath)) {
    throw new ProjectTextReadError('ROOT_INVALID')
  }
  let rootLstat
  try {
    rootLstat = await fsp.lstat(projectFolderPath)
  } catch {
    throw new ProjectTextReadError('ROOT_INVALID')
  }
  // lstat() folgt NIE dem letzten Pfadbestandteil - eine gewoehnliche
  // Verzeichnis-Pruefung hier lehnt bereits implizit einen symlink-/
  // junction-artigen Wurzel-Ordner ab (isDirectory() ist fuer einen Symlink
  // immer false, unabhaengig vom Ziel).
  if (!rootLstat.isDirectory()) {
    throw new ProjectTextReadError('ROOT_INVALID')
  }
  try {
    return await fsp.realpath(projectFolderPath)
  } catch {
    // Bewusst KEIN Fallback auf den unaufgeloesten Pfad (anders als
    // pathNormalization.ts's resolveExistingFolder) - fuer diese
    // Quellzugriffs-Grenze muss realpath echt erfolgreich sein.
    throw new ProjectTextReadError('ROOT_INVALID')
  }
}

// ---------------------------------------------------------------------------
// PARENT/TARGET CHECKS (Vorgabe Teil F)
// ---------------------------------------------------------------------------

async function resolveAndOpenFile(root: string, relativePath: string): Promise<fsp.FileHandle> {
  const segments = relativePath.split('/')
  let currentDir = root
  // Jedes Verzeichnis-Segment (alles ausser dem letzten) einzeln pruefen -
  // ohne unerwarteter symbolischer Umleitung zu folgen.
  for (let i = 0; i < segments.length - 1; i++) {
    const candidate = path.join(currentDir, segments[i])
    let lst
    try {
      lst = await fsp.lstat(candidate)
    } catch {
      throw new ProjectTextReadError('NOT_FOUND')
    }
    if (lst.isSymbolicLink()) throw new ProjectTextReadError('UNSAFE_PATH')
    if (!lst.isDirectory()) throw new ProjectTextReadError('UNSAFE_PATH')
    currentDir = candidate
  }

  const targetPath = path.join(currentDir, segments[segments.length - 1])
  let targetLstat
  try {
    targetLstat = await fsp.lstat(targetPath)
  } catch {
    throw new ProjectTextReadError('NOT_FOUND')
  }
  // Deckt sowohl einen echten symbolischen Verweis als auch einen
  // haengenden (dangling) Link ab - lstat() gelingt fuer einen haengenden
  // Link (isSymbolicLink() bleibt true), es wird also nie versucht, ihm zu
  // folgen, bevor er hier abgelehnt wird.
  if (targetLstat.isSymbolicLink()) throw new ProjectTextReadError('UNSAFE_PATH')
  if (targetLstat.isDirectory()) throw new ProjectTextReadError('NOT_A_FILE')
  if (!targetLstat.isFile()) {
    // Deckt jede sonstige, nicht-gewoehnliche Eintragsart ab (Geraetedatei,
    // FIFO, o.ae. nicht unterstuetzte Reparse-/Umleitungsform) - konservativ
    // wird NUR eine bestaetigte gewoehnliche Datei akzeptiert.
    throw new ProjectTextReadError('NOT_A_FILE')
  }

  // Finale realpath-Eindaemmungspruefung - das aufgeloeste Ziel muss
  // tatsaechlich unterhalb der bereits aufgeloesten echten Wurzel liegen.
  // `path.relative` statt einer reinen String-Praefix-Pruefung, damit z. B.
  // "root-backup" nicht faelschlich als "innerhalb von root" durchgeht.
  let realTarget: string
  try {
    realTarget = await fsp.realpath(targetPath)
  } catch {
    throw new ProjectTextReadError('NOT_FOUND')
  }
  const relative = path.relative(root, realTarget)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ProjectTextReadError('UNSAFE_PATH')
  }

  try {
    return await fsp.open(targetPath, 'r')
  } catch {
    throw new ProjectTextReadError('READ_FAILED')
  }
}

// ---------------------------------------------------------------------------
// READ THROUGH FILE HANDLE (Vorgabe Teil F "READ THROUGH FILE HANDLE" + "HARD LINKS")
// ---------------------------------------------------------------------------

async function readBoundedFile(handle: fsp.FileHandle, maxBytes: number): Promise<Buffer> {
  // Fester Puffer von genau maxBytes+1 Bytes - die Groesse wird NIEMALS aus
  // einem vorherigen stat() abgeleitet (das koennte veraltet/manipuliert
  // sein). Wird der Puffer vollstaendig gefuellt, ist die Datei nachweislich
  // groesser als maxBytes -> das Limit wird WAEHREND des Lesens durchgesetzt,
  // nie erst nach einem unbegrenzten Lesevorgang.
  const buffer = Buffer.alloc(maxBytes + 1)
  let totalRead = 0
  while (totalRead < buffer.length) {
    const { bytesRead } = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead)
    if (bytesRead === 0) break
    totalRead += bytesRead
  }
  if (totalRead > maxBytes) throw new ProjectTextReadError('LIMIT_EXCEEDED')
  return buffer.subarray(0, totalRead)
}

// Main-private Zwischenergebnis - `rawByteLength` ist NICHT Teil der
// oeffentlichen/geteilten ProjectTextFileResult-Form (siehe
// shared/projectTextReadTypes.ts, unveraendert), sondern existiert nur, damit
// der Aggregat-Cap unten gegen die tatsaechlich gelesenen ROHEN Bytes
// gezaehlt wird - nicht gegen die dekodierte `content`-Laenge, die durch das
// Entfernen der UTF-8-BOM-Bytes bereits kuerzer sein kann als die Quelle.
interface ReadOneFileResult {
  result: ProjectTextFileResult
  rawByteLength: number
}

async function readOneFile(root: string, relativePath: string, maxBytes: number): Promise<ReadOneFileResult> {
  const handle = await resolveAndOpenFile(root, relativePath)
  try {
    const statBefore = await handle.stat()
    if (!statBefore.isFile()) throw new ProjectTextReadError('NOT_A_FILE')
    // V1: Dateien mit mehr als einer Hardlink-Referenz werden abgelehnt -
    // ein Hardlink kann Bytes ausserhalb der beabsichtigten logischen
    // Quellidentitaet aliasieren (siehe Vorgabe Teil F "HARD LINKS").
    // Bewusst konservativ fuer dieses schmale V1.
    if (statBefore.nlink > 1) throw new ProjectTextReadError('UNSAFE_PATH')

    // Meilenstein 4.8A Teil B - kleine, ehrliche Identitaets-EVIDENZ (keine
    // atomare/kryptografische Garantie) aus DEMSELBEN bereits geoeffneten
    // Handle, NICHT aus einem spaeteren unabhaengigen Stat-Aufruf. Ein
    // fehlschlagender bigint-Stat-Aufruf (z. B. Plattform-Einschraenkung)
    // wird ehrlich als "nicht verfuegbar" (null/null) abgebildet, nie als
    // erfundene Identitaet.
    const identity: ProjectTextFileIdentityEvidence = await handle
      .stat({ bigint: true })
      .then((bigintStat) => ({ dev: bigintStat.dev.toString(), ino: bigintStat.ino.toString() }))
      .catch(() => ({ dev: null, ino: null }))

    // Test-only, narrow observability hook (see __setTestHookAfterStatBefore
    // below) - lets tests deterministically simulate "the source changed
    // while being read" without relying on a real, timing-sensitive
    // filesystem race. Always null in production.
    if (testHookAfterStatBefore) await testHookAfterStatBefore()

    const raw = await readBoundedFile(handle, maxBytes)

    const statAfter = await handle.stat()
    if (
      statAfter.size !== statBefore.size ||
      statAfter.mtimeMs !== statBefore.mtimeMs ||
      statAfter.ino !== statBefore.ino ||
      statAfter.dev !== statBefore.dev
    ) {
      throw new ProjectTextReadError('CHANGED_DURING_READ')
    }

    const sha256 = createHash('sha256').update(raw).digest('hex')
    const { text, utf8Bom } = decodeStrictUtf8(raw)
    assertNoObviousSecrets(text)
    const lineEnding = detectLineEnding(text)
    const finalNewline = text.length > 0 && text.endsWith('\n')

    return {
      result: { path: relativePath, content: text, sha256, format: { utf8Bom, lineEnding, finalNewline }, identity },
      rawByteLength: raw.length
    }
  } finally {
    await handle.close().catch(() => {
      // best-effort close only
    })
  }
}

// ---------------------------------------------------------------------------
// TEXT DECODING (Vorgabe Teil G)
// ---------------------------------------------------------------------------

const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function decodeStrictUtf8(raw: Buffer): { text: string; utf8Bom: boolean } {
  if (raw.length >= 2 && ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff))) {
    throw new ProjectTextReadError('ENCODING_INVALID')
  }
  let utf8Bom = false
  let bytes: Buffer = raw
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    utf8Bom = true
    bytes = raw.subarray(3)
  }
  let text: string
  try {
    text = STRICT_UTF8_DECODER.decode(bytes)
  } catch {
    throw new ProjectTextReadError('ENCODING_INVALID')
  }
  // \x00-\x08, \x0b, \x0c, \x0e-\x1f: NUL und binaerartige Steuerzeichen -
  // \t (\x09), \n (\x0a) und \r (\x0d) bleiben als gewoehnlicher
  // Quelltext-Whitespace erlaubt.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    throw new ProjectTextReadError('CONTENT_REJECTED')
  }
  return { text, utf8Bom }
}

// ---------------------------------------------------------------------------
// LINE ENDINGS (Vorgabe Teil G)
// ---------------------------------------------------------------------------

function detectLineEnding(text: string): LineEnding {
  const withoutCrlf = text.split('\r\n').join('')
  const hasCrlf = withoutCrlf.length !== text.length
  const hasLoneLf = withoutCrlf.includes('\n')
  const hasLoneCr = withoutCrlf.includes('\r')
  if (hasLoneCr) {
    // Einzelnes CR (alter Mac-Stil) ist kein unterstuetzter Zeilenumbruch-Stil.
    throw new ProjectTextReadError('CONTENT_REJECTED')
  }
  if (hasCrlf && hasLoneLf) {
    // Gemischte LF/CRLF-Zeilenumbrueche werden in V1 abgelehnt.
    throw new ProjectTextReadError('CONTENT_REJECTED')
  }
  if (hasCrlf) return 'CRLF'
  if (hasLoneLf) return 'LF'
  // Eine leere Datei ODER Text ganz ohne Zeilenumbruch erhaelt NONE.
  return 'NONE'
}

// ---------------------------------------------------------------------------
// CONTENT SECRET HEURISTICS (Vorgabe Teil H) - bewusst KLEIN, kein
// umfangreicher Scanner. Ein Bestehen dieser Pruefung beweist NICHT, dass
// Inhalt fuer eine Offenlegung sicher ist - nur Verteidigung-in-der-Tiefe
// gegen offensichtliche Faelle.
// ---------------------------------------------------------------------------

const OBVIOUS_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  // Case-insensitive - "openai_api_key=", "Anthropic_Api_Key=" etc. are just as much an obvious
  // secret assignment as the canonical uppercase spelling (see M4.7B.1 v2 review Fix 4).
  /\bANTHROPIC_API_KEY\s*=/i,
  /\bOPENAI_API_KEY\s*=/i,
  /\bAWS_SECRET_ACCESS_KEY\s*=/i,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/
]

function assertNoObviousSecrets(text: string): void {
  for (const pattern of OBVIOUS_SECRET_PATTERNS) {
    if (pattern.test(text)) {
      // Feste, nicht-sensible Fehlermeldung - der uebereinstimmende Text
      // erscheint NIEMALS im Fehler.
      throw new ProjectTextReadError('CONTENT_REJECTED')
    }
  }
}

// ---------------------------------------------------------------------------
// ORCHESTRIERUNG (Vorgabe Teil F)
// ---------------------------------------------------------------------------

/**
 * Liest genau die angeforderten, bereits vom Aufrufer autorisierten
 * projekt-relativen Textdateien. `relativePaths` MUSS bereits gegen einen
 * vertrauenswuerdigen Main-eigenen Lesebereich abgeglichen worden sein
 * (siehe runService.ts) - diese Funktion validiert nur noch Syntax/Limits
 * als Verteidigung-in-der-Tiefe, sie kennt selbst keinen "erlaubten Bereich".
 *
 * Alles-oder-nichts: schlaegt ein einzelner Datei-Lesevorgang fehl, wird die
 * GESAMTE Anfrage abgelehnt - es gibt kein Teilergebnis.
 */
export async function readProjectTextFiles(
  projectFolderPath: string | null,
  relativePaths: readonly string[]
): Promise<ProjectTextFileResult[]> {
  if (relativePaths.length === 0) throw new ProjectTextReadError('INVALID_REQUEST')
  if (relativePaths.length > PROJECT_TEXT_READ_MAX_FILES) throw new ProjectTextReadError('LIMIT_EXCEEDED')

  const validated = relativePaths.map((raw) => {
    try {
      return validateSourceAccessPath(raw)
    } catch {
      throw new ProjectTextReadError('INVALID_REQUEST')
    }
  })
  // Defense-in-depth: the caller (runOperations.ts) already rejects
  // duplicate/case-alias paths at the operation-input boundary, but a direct
  // internal call to this function must not silently process them either.
  try {
    assertNoCaseInsensitiveDuplicatePaths(validated, 'relativePaths')
  } catch {
    throw new ProjectTextReadError('INVALID_REQUEST')
  }

  const root = await resolveRoot(projectFolderPath)

  const results: ProjectTextFileResult[] = []
  let aggregateBytes = 0
  for (const relativePath of validated) {
    const { result, rawByteLength } = await readOneFile(root, relativePath, PROJECT_TEXT_READ_MAX_INDIVIDUAL_BYTES)
    // Counts the EXACT raw bytes actually read (including any stripped UTF-8
    // BOM), never the decoded `content` length - the BOM bytes were removed
    // from `content`, so counting decoded length could let raw source bytes
    // exceed the aggregate cap while appearing within it (see M4.7B.1 v2
    // review Fix 3).
    aggregateBytes += rawByteLength
    if (aggregateBytes > PROJECT_TEXT_READ_MAX_AGGREGATE_BYTES) {
      throw new ProjectTextReadError('LIMIT_EXCEEDED')
    }
    results.push(result)
  }
  return results
}

/**
 * Test-only. Installs (or clears, via `null`) a hook invoked right after the
 * pre-read fstat is captured and before the bounded read begins, so a test
 * can deterministically simulate "the source changed while it was being
 * read" without depending on a real, timing-sensitive filesystem race.
 * Analogous to __resetActiveInvocationForTests in claudeCliAdapter.ts. Never
 * used by production code.
 */
export function __setTestHookAfterStatBefore(hook: (() => Promise<void> | void) | null): void {
  testHookAfterStatBefore = hook
}
