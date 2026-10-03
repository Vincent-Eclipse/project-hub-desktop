import { randomUUID, createHash } from 'node:crypto'
import {
  CODE_CHANGE_REVIEW_FEEDBACK_MAX_BYTES,
  CODE_CHANGE_REVIEW_MAX_LIVE_PER_PROJECT,
  CODE_CHANGE_REVIEW_MAX_TOTAL_ROWS,
  CODE_CHANGE_REVIEW_TTL_MS,
  type CodeChangeReviewFile,
  type CodeChangeReviewProjection,
  type CodeChangeReviewState,
  type CodeChangeReviewSummary
} from '@shared/codeChangeReviewTypes'
import type { ProjectTextFileFormat, ProjectTextFileIdentityEvidence, ProjectTextFileResult } from '@shared/projectTextReadTypes'
import type { CodeChangeProposal, CodeFileChange } from '@shared/codeChangeTypes'
import type { CodeChangeGenerationProvenance, ValidatedCodeChangePackage } from './claudeCodeChangeService'
import { CodeChangeDiffTooLargeError, computeCodeChangeDiff } from './codeChangeDiff'

// Meilenstein 4.8A - Code Change Review + Exact Approval Binding. Diese
// Datei ist die EINZIGE Stelle, die (a) ein bereits vollstaendig von
// claudeCodeChangeService.ts geprueftes ValidatedCodeChangePackage in eine
// unveraenderliche Review verwandelt (Byte-Rundreise-Verifikation, Diff-
// Berechnung, Main-eigener Fingerprint), und (b) die kleine In-Memory-
// Review-Registry (Zustand/TTL/Kappung) verwaltet.
//
// KEIN Apply. KEIN Dateisystem-Schreibvorgang. KEIN Git. KEIN Claude-Aufruf.
// KEINE Persistenz - ein App-Neustart loescht absichtlich JEDE Review
// (siehe Vorgabe Teil G "REVIEW LIFETIME"). "Claude VERFASST CODE. Main
// MUTIERT DATEIEN." bleibt vollstaendig eingefroren - approveReview()
// bedeutet AUSSCHLIESSLICH "der Nutzer hat GENAU diesen unveraenderlichen
// Main-Datensatz entschieden", NIEMALS eine Freigabe fuer
// filesystem.write/command.execute/git.write (siehe Vorgabe Teil M).

export const CODE_CHANGE_REVIEW_ERROR_CODES = [
  'REVIEW_NOT_FOUND',
  'REVIEW_EXPIRED',
  'REVIEW_INVALID',
  'REVIEW_TOO_LARGE',
  'REVIEW_LIMIT',
  'REVIEW_ALREADY_DECIDED',
  'PROJECT_MISMATCH'
] as const
export type CodeChangeReviewErrorCode = (typeof CODE_CHANGE_REVIEW_ERROR_CODES)[number]

const ERROR_MESSAGES: Record<CodeChangeReviewErrorCode, string> = {
  REVIEW_NOT_FOUND: 'Die Review wurde nicht gefunden.',
  REVIEW_EXPIRED: 'Die Review ist abgelaufen.',
  REVIEW_INVALID: 'Die Review-Daten sind ungueltig.',
  REVIEW_TOO_LARGE: 'Der Diff dieser Review ueberschreitet ein V1-Groessenlimit.',
  REVIEW_LIMIT: 'Die maximale Anzahl aktiver Reviews fuer dieses Projekt ist erreicht.',
  REVIEW_ALREADY_DECIDED: 'Ueber diese Review wurde bereits entschieden.',
  PROJECT_MISMATCH: 'Die Review gehoert nicht zu diesem Projekt.'
}

export class CodeChangeReviewError extends Error {
  constructor(public readonly code: CodeChangeReviewErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'CodeChangeReviewError'
  }
}

export interface Clock {
  now(): Date
}

const SYSTEM_CLOCK: Clock = { now: () => new Date() }

// ---------------------------------------------------------------------------
// TEIL C - Byte-Rundreise-Verifikation. Eine CodeChangePackage darf NUR dann
// review-faehig werden, wenn JEDE erfasste MODIFY-Quelldatei aus
// content+format EXAKT die urspruenglich gehashten rohen Bytes reproduziert.
// Kein Reparieren/Normalisieren - jede Abweichung lehnt die GESAMTE
// Review-Erstellung ab (siehe Vorgabe Teil C).
// ---------------------------------------------------------------------------

const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf])

// Exported (M4.8B.1) so applyAuthorityService.ts can derive the exact
// originalSha256/originalByteLength for its authorization envelope from the
// SAME rule this file already uses for its own byte round-trip check -
// never a second, independently-maintained byte-reconstruction rule.
export function reconstructOriginalBytes(content: string, format: ProjectTextFileFormat): Buffer {
  const bomPrefix = format.utf8Bom ? UTF8_BOM_BYTES : Buffer.alloc(0)
  return Buffer.concat([bomPrefix, Buffer.from(content, 'utf8')])
}

function assertSourceByteRoundTrip(file: ProjectTextFileResult): void {
  const reconstructed = reconstructOriginalBytes(file.content, file.format)
  const hash = createHash('sha256').update(reconstructed).digest('hex')
  // A hash mismatch already implies any byte-length mismatch too - there is no separately
  // retained raw byte length on ProjectTextFileResult to compare a second time (see
  // claudeCodeChangeService.ts's provenance - only content/sha256/format are kept).
  if (hash !== file.sha256) {
    throw new CodeChangeReviewError('REVIEW_INVALID')
  }
}

// ---------------------------------------------------------------------------
// TEIL D - Vorgeschlagene Byte-Rekonstruktion, NUR fuer die Review (niemals
// geschrieben). MODIFY erbt die BOM-Praesenz der Basisdatei (Main haengt sie
// spaeter selbst an - siehe claudeCodeChangeService.ts's Formtreue-Pruefung,
// die bereits sicherstellt, dass `content` niemals ein literales BOM-Zeichen
// enthaelt). CREATE ist immer UTF-8 ohne BOM.
// ---------------------------------------------------------------------------

const CREATE_FIXED_FORMAT: ProjectTextFileFormat = { utf8Bom: false, lineEnding: 'LF', finalNewline: true }

// Exported (M4.8B.1) alongside reconstructOriginalBytes - same reasoning.
export function reconstructProposedBytes(change: CodeFileChange, baseFormat: ProjectTextFileFormat | null): Buffer {
  if (change.type === 'MODIFY' && baseFormat?.utf8Bom) {
    return Buffer.concat([UTF8_BOM_BYTES, Buffer.from(change.content, 'utf8')])
  }
  return Buffer.from(change.content, 'utf8')
}

// ---------------------------------------------------------------------------
// TEIL H - Review-Fingerprint. EIN explizites, versioniertes Objekt in
// EINER festen Feldreihenfolge, per JSON.stringify gehasht - KEIN
// generisches Canonical-JSON-Framework. Bindet Projekt-/Ordner-/Root-
// Identitaet, Task/Work-Request-Bindung + Inhalt, Rules/Context/
// Entscheidungen, den vollstaendigen Vorschlag (in ORIGINALER Reihenfolge),
// alle gelieferten Quell-Snapshots, die CREATE-Praecondition-Beobachtungen
// und den generierungszeitlichen Scope. KEINE Locale-Sortierung.
// ---------------------------------------------------------------------------

const FINGERPRINT_VERSION = 'eclipse-code-review-v1'
const BYTE_RECONSTRUCTION_VERSION = 'eclipse-byte-reconstruction-v1'

interface FingerprintChangeEntry {
  type: 'MODIFY' | 'CREATE'
  path: string
  originalSha256: string | null
  originalByteLength: number | null
  proposedSha256: string
  proposedByteLength: number
  originalFormat: ProjectTextFileFormat | null
  proposedFormat: ProjectTextFileFormat
}

interface FingerprintSourceFileEntry {
  path: string
  sha256: string
  byteLength: number
  format: ProjectTextFileFormat
  identity: ProjectTextFileIdentityEvidence
}

function computeReviewFingerprint(
  provenance: CodeChangeGenerationProvenance,
  proposal: CodeChangeProposal,
  changeEntries: readonly FingerprintChangeEntry[],
  sourceEntries: readonly FingerprintSourceFileEntry[]
): string {
  // Fixed, explicit field order - never re-derived from Object.keys() of an arbitrary object,
  // never locale-sorted. Reordering these keys would itself be a behavior change to what the
  // fingerprint binds, not just a refactor - keep this literal shape stable.
  const payload = {
    fingerprintVersion: FINGERPRINT_VERSION,
    byteReconstructionVersion: BYTE_RECONSTRUCTION_VERSION,
    projectId: provenance.projectId,
    projectFolderPath: provenance.projectFolderPath,
    projectFolderComparisonKey: provenance.projectFolderComparisonKey,
    rootIdentity: provenance.rootIdentity,
    taskId: provenance.taskId,
    workRequestId: provenance.workRequestId,
    project: provenance.project,
    task: provenance.task,
    workRequest: provenance.workRequest,
    rules: provenance.rules,
    context: provenance.context,
    decisions: provenance.decisions,
    proposalSummary: proposal.summary,
    proposalWarnings: proposal.warnings,
    changes: changeEntries,
    sourceFiles: sourceEntries,
    createPreconditions: provenance.createPreconditions,
    sourcePaths: provenance.sourcePaths,
    modifyPaths: provenance.modifyPaths,
    createPaths: provenance.createPaths,
    disclosedRelativePaths: provenance.disclosedRelativePaths
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

// ---------------------------------------------------------------------------
// Meilenstein 4.8A V2 - Main-eigene defensive Tiefenkopie. Plain,
// JSON-serialisierbare Daten only (ValidatedCodeChangePackage/
// CodeChangeReviewFile enthalten nie Funktionen/Date-Objekte/Klassen-
// Instanzen) - dieselbe dependency-freie Technik, die toProjection() bereits
// fuer `files` verwendet, jetzt als benannter, wiederverwendbarer Helfer.
// ---------------------------------------------------------------------------

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Verteidigung-in-der-Tiefe: `sourceSnapshot` und `provenance.sourceFiles`
 * (bzw. `createPreconditions` und `provenance.createPreconditions`) sind per
 * Konstruktion in claudeCodeChangeService.ts bereits dieselbe Quelle - diese
 * Pruefung stellt das VOR jeder Weiterverarbeitung explizit sicher, statt es
 * stillschweigend anzunehmen. Eine Abweichung (z. B. ein von Hand
 * zusammengesetztes/manipuliertes Package) lehnt die gesamte Review-
 * Erstellung ab.
 */
function assertPackageConsistency(pkg: ValidatedCodeChangePackage): void {
  if (JSON.stringify(pkg.sourceSnapshot) !== JSON.stringify(pkg.provenance.sourceFiles)) {
    throw new CodeChangeReviewError('REVIEW_INVALID')
  }
  if (JSON.stringify(pkg.createPreconditions) !== JSON.stringify(pkg.provenance.createPreconditions)) {
    throw new CodeChangeReviewError('REVIEW_INVALID')
  }
}

// ---------------------------------------------------------------------------
// Interner Main-eigener Review-Datensatz - NIEMALS direkt an den Renderer
// zurueckgegeben (siehe toProjection/toSummary unten, die jeweils eine
// defensive, tiefe Kopie einer renderer-sicheren Teilmenge liefern).
//
// M4.8A V2: `package` retains a defensive, Main-owned copy of the COMPLETE
// ValidatedCodeChangePackage (proposal/sourceSnapshot/createPreconditions/
// full provenance) that produced this review - not just the already-derived
// rendering-ready `files`/`fingerprint`. This is what a future M4.8B Apply
// service will need to resolve the exact approved bytes; it is NEVER
// returned to the renderer (see resolveAuthoritative() below, which is not
// wired to any IPC channel) and is never derived again from a caller-
// supplied object after creation - see createReview()'s cloning order.
// ---------------------------------------------------------------------------

interface CodeChangeReviewRecord {
  reviewId: string
  projectId: number
  taskId: number
  workRequestId: number
  state: CodeChangeReviewState
  summary: string
  warnings: string[]
  files: CodeChangeReviewFile[]
  feedback: string | null
  fingerprint: string
  package: ValidatedCodeChangePackage
  createdAtIso: string
  expiresAtIso: string
  expiresAtMs: number
}

/**
 * M4.8A V2 - Main-only authoritative resolution. Returns the complete
 * retained ValidatedCodeChangePackage plus review metadata - intended for a
 * FUTURE M4.8B Apply service to resolve the exact approved bytes from a
 * reviewId. This type/method is deliberately NOT part of
 * `@shared/codeChangeReviewTypes.ts` and is NEVER called from
 * `registerIpc.ts` - there is no IPC channel that can reach it (confirmed by
 * repo-wide grep, see the M4.8A V2 review report).
 */
export interface CodeChangeAuthoritativeReview {
  reviewId: string
  projectId: number
  taskId: number
  workRequestId: number
  state: CodeChangeReviewState
  fingerprint: string
  package: ValidatedCodeChangePackage
  feedback: string | null
  createdAt: string
  expiresAt: string
}

function validateFeedback(raw: unknown): string {
  if (typeof raw !== 'string') throw new CodeChangeReviewError('REVIEW_INVALID')
  if (Buffer.byteLength(raw, 'utf8') > CODE_CHANGE_REVIEW_FEEDBACK_MAX_BYTES) {
    throw new CodeChangeReviewError('REVIEW_INVALID')
  }
  return raw
}

function toProjection(record: CodeChangeReviewRecord): CodeChangeReviewProjection {
  return {
    reviewId: record.reviewId,
    projectId: record.projectId,
    taskId: record.taskId,
    workRequestId: record.workRequestId,
    state: record.state,
    summary: record.summary,
    warnings: [...record.warnings],
    // Deep, dependency-free defensive copy (plain JSON-serializable data only, see
    // CodeChangeReviewFile) - a caller mutating the returned projection (or any nested
    // array/object inside it) must never be able to reach back into the stored authoritative
    // record (see Vorgabe Teil G: "A renderer must never be able to mutate the stored
    // authoritative object by holding a returned object reference").
    files: deepClone(record.files),
    feedback: record.feedback,
    createdAt: record.createdAtIso,
    expiresAt: record.expiresAtIso
  }
}

/**
 * M4.8A V2 - lightweight listing projection. NEVER includes
 * beforeText/afterText/diff/source contents/provenance/fingerprint - only
 * `fileCount` in place of the full `files` array (see Vorgabe Teil 8). The
 * complete CodeChangeReviewProjection (with diff) remains reachable ONLY
 * through getReview() for one specific review (Teil 9).
 */
function toSummary(record: CodeChangeReviewRecord): CodeChangeReviewSummary {
  return {
    reviewId: record.reviewId,
    projectId: record.projectId,
    taskId: record.taskId,
    workRequestId: record.workRequestId,
    state: record.state,
    summary: record.summary,
    warnings: [...record.warnings],
    fileCount: record.files.length,
    feedback: record.feedback,
    createdAt: record.createdAtIso,
    expiresAt: record.expiresAtIso
  }
}

/** Defensive copy - a caller mutating the returned authoritative snapshot (including its nested `package`) must never be able to reach back into the stored record (see Vorgabe Teil 4). */
function toAuthoritative(record: CodeChangeReviewRecord): CodeChangeAuthoritativeReview {
  return {
    reviewId: record.reviewId,
    projectId: record.projectId,
    taskId: record.taskId,
    workRequestId: record.workRequestId,
    state: record.state,
    fingerprint: record.fingerprint,
    package: deepClone(record.package),
    feedback: record.feedback,
    createdAt: record.createdAtIso,
    expiresAt: record.expiresAtIso
  }
}

interface PreparedReviewMaterials {
  fingerprint: string
  files: CodeChangeReviewFile[]
  totalRows: number
}

/**
 * Fuehrt Teil C (Byte-Rundreise-Verifikation), die Diff-Berechnung je
 * Aenderung (Teil I/K), und den Fingerprint-Aufbau (Teil H) aus - fuer
 * GENAU EIN bereits vollstaendig validiertes ValidatedCodeChangePackage.
 * Wirft CodeChangeReviewError bei jeder Ablehnung (Byte-Rundreise
 * fehlgeschlagen, Diff zu gross). Als eigene Funktion extrahiert (statt
 * inline in createReview()), damit computeCodeChangeReviewFingerprint()
 * unten fuer Tests denselben Weg ohne die Registry selbst durchlaufen kann.
 */
function prepareReviewMaterials(pkg: ValidatedCodeChangePackage): PreparedReviewMaterials {
  const { provenance, proposal } = pkg

  // Part C - every captured MODIFY source must reproduce its originally hashed raw bytes
  // EXACTLY before this package may become reviewable at all.
  for (const file of provenance.sourceFiles) assertSourceByteRoundTrip(file)

  const sourceByPath = new Map(provenance.sourceFiles.map((file) => [file.path, file]))
  const changeEntries: FingerprintChangeEntry[] = []
  const reviewFiles: CodeChangeReviewFile[] = []
  let totalRows = 0

  for (const change of proposal.changes) {
    let base: ProjectTextFileResult | null = null
    if (change.type === 'MODIFY') {
      base = sourceByPath.get(change.path) ?? null
      // Cannot happen given claudeCodeChangeService.ts's own MODIFY-scope guarantee (a MODIFY
      // path is always a member of the disclosed/captured source snapshot) - defensive rather
      // than silently treating an unknown MODIFY as a CREATE (beforeText: null) would.
      if (!base) throw new CodeChangeReviewError('REVIEW_INVALID')
    }

    const beforeText = base ? base.content : null
    // MODIFY inherits the base file's exact format (already validated equal to the proposed
    // content by claudeCodeChangeService.ts) - never re-detected here. CREATE always uses the
    // fixed V1 convention.
    const afterFormatBase: ProjectTextFileFormat = base ? base.format : CREATE_FIXED_FORMAT
    const afterBytes = reconstructProposedBytes(change, base?.format ?? null)
    const afterSha256 = createHash('sha256').update(afterBytes).digest('hex')

    let diffResult
    try {
      diffResult = computeCodeChangeDiff(beforeText, change.content)
    } catch (error) {
      if (error instanceof CodeChangeDiffTooLargeError) throw new CodeChangeReviewError('REVIEW_TOO_LARGE')
      throw error
    }
    totalRows += diffResult.lines.length

    const originalBytesLength = base ? reconstructOriginalBytes(base.content, base.format).length : null

    changeEntries.push({
      type: change.type,
      path: change.path,
      originalSha256: base?.sha256 ?? null,
      originalByteLength: originalBytesLength,
      proposedSha256: afterSha256,
      proposedByteLength: afterBytes.length,
      originalFormat: base?.format ?? null,
      proposedFormat: afterFormatBase
    })

    reviewFiles.push({
      path: change.path,
      type: change.type,
      beforeText,
      afterText: change.content,
      diff: diffResult.lines,
      whitespaceOnlyChangedLines: diffResult.whitespaceOnlyChangedLines,
      invisibleAnnotations: diffResult.invisibleAnnotations,
      beforeFormat: base ? { ...base.format, byteLength: originalBytesLength as number } : null,
      afterFormat: { ...afterFormatBase, byteLength: afterBytes.length }
    })
  }

  if (totalRows > CODE_CHANGE_REVIEW_MAX_TOTAL_ROWS) {
    throw new CodeChangeReviewError('REVIEW_TOO_LARGE')
  }

  const sourceEntries: FingerprintSourceFileEntry[] = provenance.sourceFiles.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    byteLength: reconstructOriginalBytes(file.content, file.format).length,
    format: file.format,
    identity: file.identity
  }))

  const fingerprint = computeReviewFingerprint(provenance, proposal, changeEntries, sourceEntries)

  return { fingerprint, files: reviewFiles, totalRows }
}

/**
 * Exportiert AUSSCHLIESSLICH fuer direkte Fingerprint-Tests (Stabilitaet/
 * Empfindlichkeit) - die oeffentliche Registry-API gibt den Fingerprint
 * niemals an einen Aufrufer zurueck (siehe Vorgabe Teil E/H: "Do NOT expose
 * a renderer-supplied fingerprint as trusted input" / "Main fingerprint
 * internals" bleiben verborgen). Wirft, wenn `pkg` die Byte-Rundreise-
 * Pruefung nicht besteht oder der Diff zu gross ist - identisch zu
 * createReview()'s eigener Ablehnung.
 */
export function computeCodeChangeReviewFingerprint(pkg: ValidatedCodeChangePackage): string {
  return prepareReviewMaterials(pkg).fingerprint
}

export interface CodeChangeReviewRegistry {
  createReview(pkg: ValidatedCodeChangePackage): CodeChangeReviewProjection
  // M4.8A V2: returns lightweight summaries only (see CodeChangeReviewSummary) - never the full
  // diff-bearing projection. getReview() remains the only way to fetch one full review.
  listReviewsForProject(projectId: number): CodeChangeReviewSummary[]
  getReview(projectId: number, reviewId: string): CodeChangeReviewProjection
  approveReview(projectId: number, reviewId: string): CodeChangeReviewProjection
  requestChanges(projectId: number, reviewId: string, rawFeedback: unknown): CodeChangeReviewProjection
  // M4.8A V2 - Main-only, NOT part of CodeChangeReviewRegistry's IPC-exposed surface (registerIpc.ts
  // never calls this). Exists for a future M4.8B Apply service to resolve the exact retained
  // ValidatedCodeChangePackage from a reviewId.
  resolveAuthoritative(projectId: number, reviewId: string): CodeChangeAuthoritativeReview
}

/**
 * Baut EINE kleine, Main-eigene In-Memory-Registry. KEINE DB-Migration,
 * KEINE Persistenz - ein App-Neustart (eine neue Registry-Instanz) loescht
 * absichtlich jede ausstehende Review/Freigabe/Rueckmeldung (siehe Vorgabe
 * Teil G). `clock` ist injizierbar fuer deterministische TTL-Tests.
 */
export function createCodeChangeReviewRegistry(clock: Clock = SYSTEM_CLOCK): CodeChangeReviewRegistry {
  const reviews = new Map<string, CodeChangeReviewRecord>()

  function isExpired(record: CodeChangeReviewRecord): boolean {
    return clock.now().getTime() >= record.expiresAtMs
  }

  /** Entfernt AUSSCHLIESSLICH abgelaufene Eintraege - niemals einen noch gueltigen PENDING/APPROVED/CHANGES_REQUESTED-Datensatz (siehe Vorgabe: "Do NOT silently evict an approved/pending review. Expired entries may be removed safely"). */
  function purgeExpired(): void {
    for (const [id, record] of reviews) {
      if (isExpired(record)) reviews.delete(id)
    }
  }

  function countLiveForProject(projectId: number): number {
    let count = 0
    for (const record of reviews.values()) {
      if (record.projectId === projectId) count++
    }
    return count
  }

  function resolveLiveReview(projectId: number, reviewId: string): CodeChangeReviewRecord {
    const record = reviews.get(reviewId)
    if (!record) throw new CodeChangeReviewError('REVIEW_NOT_FOUND')
    // Project binding checked BEFORE expiry - a guessed/foreign reviewId from another project
    // must never even learn whether that ID happens to be expired (see Vorgabe Teil Q).
    if (record.projectId !== projectId) throw new CodeChangeReviewError('PROJECT_MISMATCH')
    if (isExpired(record)) throw new CodeChangeReviewError('REVIEW_EXPIRED')
    return record
  }

  return {
    createReview(rawPkg: ValidatedCodeChangePackage): CodeChangeReviewProjection {
      purgeExpired()

      // Cheap cap check on the ORIGINAL projectId (a bare number, reading it cannot be affected
      // by any later mutation) before doing any cloning/verification work.
      if (countLiveForProject(rawPkg.provenance.projectId) >= CODE_CHANGE_REVIEW_MAX_LIVE_PER_PROJECT) {
        throw new CodeChangeReviewError('REVIEW_LIMIT')
      }

      // M4.8A V2 (Part 1/3/7): defensive copy IMMEDIATELY, before any further processing. Every
      // subsequent step (consistency checks, byte round-trip, diff, fingerprint) operates
      // exclusively on THIS clone, never on the caller's own `rawPkg` object reference - so a
      // caller mutating their original object after calling createReview() can never
      // retroactively change what becomes (or already became) the authoritative stored record.
      const pkg: ValidatedCodeChangePackage = deepClone(rawPkg)

      // M4.8A V2 (Part 5/6): sourceSnapshot/createPreconditions must exactly match their
      // provenance counterparts - checked BEFORE byte round-trip/diff/fingerprint computation.
      assertPackageConsistency(pkg)

      const { provenance, proposal } = pkg
      const { fingerprint, files } = prepareReviewMaterials(pkg)

      const now = clock.now()
      const record: CodeChangeReviewRecord = {
        reviewId: randomUUID(),
        projectId: provenance.projectId,
        taskId: provenance.taskId,
        workRequestId: provenance.workRequestId,
        state: 'PENDING',
        summary: proposal.summary,
        warnings: [...proposal.warnings],
        files,
        feedback: null,
        fingerprint,
        // M4.8A V2 (Part 1): the registry now exclusively owns this clone - `pkg` is never
        // referenced by any caller outside this function after this point.
        package: pkg,
        createdAtIso: now.toISOString(),
        expiresAtIso: new Date(now.getTime() + CODE_CHANGE_REVIEW_TTL_MS).toISOString(),
        expiresAtMs: now.getTime() + CODE_CHANGE_REVIEW_TTL_MS
      }
      reviews.set(record.reviewId, record)
      return toProjection(record)
    },

    listReviewsForProject(projectId: number): CodeChangeReviewSummary[] {
      purgeExpired()
      const result: CodeChangeReviewSummary[] = []
      for (const record of reviews.values()) {
        if (record.projectId === projectId) result.push(toSummary(record))
      }
      return result
    },

    getReview(projectId: number, reviewId: string): CodeChangeReviewProjection {
      return toProjection(resolveLiveReview(projectId, reviewId))
    },

    approveReview(projectId: number, reviewId: string): CodeChangeReviewProjection {
      const record = resolveLiveReview(projectId, reviewId)
      // Only PENDING -> APPROVED is a valid transition (see Vorgabe Teil F "State rules") - an
      // already-APPROVED review re-approving, or a CHANGES_REQUESTED review being approved, both
      // reject as REVIEW_ALREADY_DECIDED. This also makes a double/concurrent approve() safe: the
      // second call always observes state !== 'PENDING' and rejects.
      if (record.state !== 'PENDING') throw new CodeChangeReviewError('REVIEW_ALREADY_DECIDED')
      record.state = 'APPROVED'
      return toProjection(record)
    },

    requestChanges(projectId: number, reviewId: string, rawFeedback: unknown): CodeChangeReviewProjection {
      const record = resolveLiveReview(projectId, reviewId)
      // PENDING -> CHANGES_REQUESTED and APPROVED -> CHANGES_REQUESTED (an explicit, one-time
      // approval revocation before any future Apply) are both allowed. A review already in
      // CHANGES_REQUESTED cannot be "re-decided" here - a revised proposal must become a NEW
      // review (see Vorgabe Teil F/N): "Do not mutate an existing reviewed proposal."
      if (record.state === 'CHANGES_REQUESTED') throw new CodeChangeReviewError('REVIEW_ALREADY_DECIDED')
      const feedback = validateFeedback(rawFeedback)
      record.state = 'CHANGES_REQUESTED'
      record.feedback = feedback
      return toProjection(record)
    },

    resolveAuthoritative(projectId: number, reviewId: string): CodeChangeAuthoritativeReview {
      return toAuthoritative(resolveLiveReview(projectId, reviewId))
    }
  }
}
