import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { withFullDurability } from '../db/durableTransaction'
import { assertValidBatchTransition, assertValidEntryTransition, ApplyBatchTransitionError } from './applyBatchTransitionGuard'
import {
  prepareLease as realPrepareLease,
  applyModify as realApplyModify,
  createFile as realCreateFile,
  verifyFile as realVerifyFile,
  closeLease as realCloseLease,
  WindowsSafeApplyUnavailableError,
  type WindowsSafeApplyPlan,
  type WindowsSafeApplyModifyPlan,
  type WindowsSafeApplyCreatePlan,
  type WindowsSafeApplyPrepareResult,
  type WindowsSafeApplyOutcome
} from './windowsSafeApply'
import { reconstructProposedBytes, type CodeChangeReviewRegistry, type CodeChangeAuthoritativeReview } from './codeChangeReviewService'
import type { ApplyBatchJournalService, AdmittedApplyBatch } from './applyBatchJournalService'
import type { ApplyBatchState, ApplyBatchEntryState, ApplyBatchRecoveryOriginState } from '@shared/applyBatchTypes'

// Meilenstein 4.8B.3 Slice 2 (Forward Apply Engine, v2 - corrected). Implements
// EXACTLY ONE public operation, submitApply(rawRequest), which synchronously
// composes fresh admission (journalService.admitBatch(), which itself is the
// SOLE caller of the apply authority service for new forward work
// - this file never calls authorizeApply()/ApplyAuthorityService directly, at
// all) with exactly one live, forward native pass, driven by a private,
// never-exported runner.
//
// FROZEN SCOPE / AUTHORITY BOUNDARIES (M4.8B3-Slice2-ForwardEngine-
// Implementation-Spec-v2.md):
//   - There is NO function in this module, exported or not, that accepts a
//     bare batch identifier from a caller. The only way to reach forward
//     mutation is submitApply(rawRequest) - the same untrusted,
//     selection-only {projectId, reviewId} shape authorizeApply()/
//     admitBatch() already accept - and submitApply() ALWAYS performs its
//     own fresh admitBatch() call (therefore its own fresh authorizeApply())
//     immediately before invoking the private runner, in the SAME
//     synchronous call stack, with the batch admitBatch() JUST returned.
//     There is no persisted, deferred, or externally-suppliable batchId this
//     module will ever act on.
//   - A rejected/revoked ApplyAuthorityError/ApplyBatchAdmissionError from
//     admitBatch() propagates uncaught, BEFORE the private runner is ever
//     invoked - zero review re-resolution, zero native calls.
//   - The private runner never performs a live rollback, retry, or recovery
//     of its own. It stops at the first classified failure and leaves the
//     batch in whichever of {ADMITTED, PREPARED, APPLYING} it last durably,
//     correctly reached - every one already a member of B.2C's
//     scanForUnresolvedBatches() eligible-state list. Recovery from that
//     point on is EXCLUSIVELY applyBatchRecoveryService.ts's job; this file
//     has no reference to it, exports no capability it could call, and a
//     later user attempt MUST create a new batch through fresh admission -
//     there is no code path, public or private, that resumes or replays a
//     PREPARED/APPLYING batch through forward execution.
//   - Every native mutating call this runner issues moves strictly TOWARD
//     the proposal's target bytes (applyModify()/createFile() with
//     RECONSTRUCTED, FRESHLY CROSS-CHECKED proposed bytes) - the mirror
//     image of B.2C's own "always toward the pre-batch state, never toward
//     the proposal" rule. Both rules are enforced by construction: this
//     runner never calls recoverDeleteCreated()/rollbackFile(), and
//     applyBatchRecoveryService.ts never calls createFile()/verifyFile() or
//     constructs an applyModify() call using proposed_* bytes.
//   - Every state write (marker or terminal, at either the entry or batch
//     level) is its own independent withFullDurability transaction -
//     marker -> native operation -> independent durable terminal write,
//     never any other order, never a normal-durability write.

// ---------------------------------------------------------------------------
// Native-call safety wrapper - identical shape to applyBatchRecoveryService.ts's
// own callNative(), duplicated here rather than imported. Slice 2's file list
// is fixed to exactly the two files in this pair; widening it to export this
// ~10-line pure function from applyBatchRecoveryService.ts is not authorized
// for this slice (M4.8B3-Slice2-ForwardEngine-Implementation-Spec-v2.md S2.4).
// ---------------------------------------------------------------------------

type NativeCallResult<T> = { ok: true; value: T } | { ok: false; code: string; nativeModuleUnavailable: boolean }

function callNative<T>(fn: () => T): NativeCallResult<T> {
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    if (err instanceof WindowsSafeApplyUnavailableError) {
      return { ok: false, code: 'NATIVE_MODULE_UNAVAILABLE', nativeModuleUnavailable: true }
    }
    const maybeCoded = err as { code?: unknown }
    const code = err instanceof Error && typeof maybeCoded.code === 'string' ? maybeCoded.code : 'UNKNOWN_ERROR'
    return { ok: false, code, nativeModuleUnavailable: false }
  }
}

// ---------------------------------------------------------------------------
// Root locator resolution - identical algorithm to
// applyBatchRecoveryService.ts's own resolveRecoveryRootLocator(), duplicated
// for the same fixed-file-list reason as callNative() above.
// ---------------------------------------------------------------------------

type ForwardRootLocatorResult = { ok: true; rootPath: string } | { ok: false; rootPath: null }

function resolveForwardRootLocator(authorizationJson: string): ForwardRootLocatorResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(authorizationJson)
  } catch {
    return { ok: false, rootPath: null }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, rootPath: null }
  const target = (parsed as Record<string, unknown>).target
  if (typeof target !== 'object' || target === null) return { ok: false, rootPath: null }
  const rootPath = (target as Record<string, unknown>).projectFolderPath
  if (typeof rootPath !== 'string' || rootPath.length === 0) return { ok: false, rootPath: null }
  return { ok: true, rootPath }
}

// ---------------------------------------------------------------------------
// Native dependency injection - mirrors applyBatchRecoveryService.ts's own
// shape exactly, scoped to only the forward-direction primitives this runner
// needs. recoverDeleteCreated()/rollbackFile() are deliberately absent - this
// runner never reverses anything itself.
// ---------------------------------------------------------------------------

export interface ApplyBatchForwardNativeDependencies {
  prepareLease(plan: WindowsSafeApplyPlan): WindowsSafeApplyPrepareResult
  applyModify(lease: unknown, index: number): WindowsSafeApplyOutcome
  createFile(lease: unknown, index: number): WindowsSafeApplyOutcome
  verifyFile(lease: unknown, index: number, isCreate: boolean): WindowsSafeApplyOutcome
  closeLease(lease: unknown): void
}

export const realWindowsSafeApplyForwardNativeDependencies: ApplyBatchForwardNativeDependencies = {
  prepareLease: realPrepareLease,
  applyModify: realApplyModify,
  createFile: realCreateFile,
  verifyFile: realVerifyFile,
  closeLease: realCloseLease
}

export interface ApplyBatchForwardDependencies {
  db: Database.Database
  native: ApplyBatchForwardNativeDependencies
  reviewRegistry: CodeChangeReviewRegistry
  /**
   * The existing, unmodified ApplyBatchJournalService - remains, exactly as
   * it is today, the single component that ever invokes fresh
   * authorizeApply() for new forward work. This file never calls
   * authorizeApply()/ApplyAuthorityService directly.
   */
  journalService: ApplyBatchJournalService
}

export interface ApplyBatchForwardFailure {
  phase: 'REVIEW_MISMATCH' | 'ROOT_LOCATOR' | 'PREPARE' | 'MUTATE' | 'VERIFY'
  entryId: number | null
  ordinal: number | null
  code: string | null
}

export interface ApplyBatchForwardOutcome {
  batchId: number
  projectId: number
  reviewId: string
  outcome: 'SUCCEEDED' | 'STOPPED'
  entriesApplied: number
  totalEntries: number
  /** null iff outcome === 'SUCCEEDED'. */
  failure: ApplyBatchForwardFailure | null
}

// ---------------------------------------------------------------------------
// Row snapshots. Discriminated on mutationType, mirroring
// applyBatchRecoveryService.ts's own EntrySnapshot discipline - MODIFY's
// mandatory original_sha256/original_byte_length (schema-guaranteed NOT NULL
// for mutation_type='MODIFY') are non-nullable in the type, narrowed
// structurally via the discriminant, never via a `!` non-null assertion.
// (original_bytes, the BLOB column, is not read here at all - the forward
// direction never needs it; only its hash/length, to build the MODIFY plan
// entry's expectedSha256Hex/expectedLength precondition.)
// ---------------------------------------------------------------------------

interface EntrySnapshotBase {
  id: number
  ordinal: number
  relPath: string
  proposedSha256: string
  proposedByteLength: number
  state: ApplyBatchEntryState
}

interface ModifyEntrySnapshot extends EntrySnapshotBase {
  mutationType: 'MODIFY'
  originalSha256: string
  originalByteLength: number
}

interface CreateEntrySnapshot extends EntrySnapshotBase {
  mutationType: 'CREATE'
  originalSha256: null
  originalByteLength: null
}

type EntrySnapshot = ModifyEntrySnapshot | CreateEntrySnapshot

interface BatchSnapshot {
  id: number
  authorizationJson: string
  state: ApplyBatchState
  preRecoveryState: ApplyBatchRecoveryOriginState | null
}

interface ApplyBatchRow {
  id: number
  authorization_json: string
  state: string
  pre_recovery_state: string | null
}

const SELECT_BATCH_BASE = `SELECT id, authorization_json, state, pre_recovery_state FROM apply_batches`

function readBatch(db: Database.Database, batchId: number): BatchSnapshot {
  const row = db.prepare(`${SELECT_BATCH_BASE} WHERE id = ?`).get(batchId) as ApplyBatchRow | undefined
  if (!row) throw new ApplyBatchTransitionError('BATCH_NOT_FOUND', `batchId=${batchId}`)
  return {
    id: row.id,
    authorizationJson: row.authorization_json,
    state: row.state as ApplyBatchState,
    preRecoveryState: row.pre_recovery_state as ApplyBatchRecoveryOriginState | null
  }
}

interface ApplyBatchEntryRow {
  id: number
  ordinal: number
  mutation_type: string
  rel_path: string
  proposed_sha256: string
  proposed_byte_length: number
  original_sha256: string | null
  original_byte_length: number | null
  state: string
}

const SELECT_ENTRY_BASE = `SELECT id, ordinal, mutation_type, rel_path, proposed_sha256, proposed_byte_length, original_sha256, original_byte_length, state FROM apply_batch_entries`

function mapEntryRow(row: ApplyBatchEntryRow): EntrySnapshot {
  const base = {
    id: row.id,
    ordinal: row.ordinal,
    relPath: row.rel_path,
    proposedSha256: row.proposed_sha256,
    proposedByteLength: row.proposed_byte_length,
    state: row.state as ApplyBatchEntryState
  }
  if (row.mutation_type === 'MODIFY') {
    return { ...base, mutationType: 'MODIFY', originalSha256: row.original_sha256 as string, originalByteLength: row.original_byte_length as number }
  }
  return { ...base, mutationType: 'CREATE', originalSha256: null, originalByteLength: null }
}

function readEntries(db: Database.Database, batchId: number): EntrySnapshot[] {
  const rows = db.prepare(`${SELECT_ENTRY_BASE} WHERE batch_id = ? ORDER BY ordinal ASC`).all(batchId) as ApplyBatchEntryRow[]
  return rows.map(mapEntryRow)
}

// ---------------------------------------------------------------------------
// Proposed-bytes reconstruction and cross-check (Spec v2 S2.1). The journal
// durably stores proposed_sha256/proposed_byte_length but NEVER the actual
// proposed bytes - the only place real byte content exists is the review
// registry's own proposal.changes[].content. Every entry's reconstructed
// bytes are cross-checked against the ALREADY-ADMITTED hash/length before
// any native call - a mismatch here means REVIEW_MISMATCH, never a native
// attempt with unverified content.
// ---------------------------------------------------------------------------

interface ReconstructedEntry {
  entryId: number
  proposedBytes: Buffer
}

/** Returns null on ANY cross-check failure (reviewed-order/path/type mismatch, or a hash/length mismatch against the durably-admitted values) - never throws, never partially trusts a subset of entries. */
function reconstructAndCrossCheckProposedBytes(review: CodeChangeAuthoritativeReview, entries: EntrySnapshot[]): ReconstructedEntry[] | null {
  const changes = review.package.proposal.changes
  if (changes.length !== entries.length) return null

  const sourceByPath = new Map(review.package.provenance.sourceFiles.map((file) => [file.path, file]))
  const result: ReconstructedEntry[] = []

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const change = changes[i]
    // Reviewed order, never re-matched by path alone - mirrors
    // applyBatchJournalService.ts's own identical discipline.
    if (change.path !== entry.relPath || change.type !== entry.mutationType) return null

    let proposedBytes: Buffer
    if (entry.mutationType === 'MODIFY') {
      const sourceFile = sourceByPath.get(entry.relPath)
      if (!sourceFile) return null
      proposedBytes = reconstructProposedBytes(change, sourceFile.format)
    } else {
      proposedBytes = reconstructProposedBytes(change, null)
    }

    const hash = createHash('sha256').update(proposedBytes).digest('hex')
    if (hash !== entry.proposedSha256 || proposedBytes.length !== entry.proposedByteLength) return null

    result.push({ entryId: entry.id, proposedBytes })
  }

  return result
}

// ---------------------------------------------------------------------------
// Lease closing - always attempted exactly once on every branch past a
// successful prepareLease() call, its own failure always caught and
// swallowed (logged, never rethrown, never allowed to override the
// already-determined entry/batch outcome - Spec v2 S2.5). By the time this
// runs, the DB state is already fully, correctly determined either way; a
// leaked native handle is a resource-hygiene concern the OS reclaims on
// process exit, never a data-correctness concern.
// ---------------------------------------------------------------------------

function closeLeaseSafely(native: ApplyBatchForwardNativeDependencies, lease: unknown): void {
  try {
    native.closeLease(lease)
  } catch {
    // Swallowed by design - see the comment above.
  }
}

// ---------------------------------------------------------------------------
// The private forward runner. NOT exported. NOT returned by
// createApplyBatchForwardService(). No other function in this file, exported
// or not, ever calls this with a batchId obtained any other way than the
// `admitted` object submitApply() just received from journalService.admitBatch().
// ---------------------------------------------------------------------------

function runForwardPass(
  db: Database.Database,
  native: ApplyBatchForwardNativeDependencies,
  reviewRegistry: CodeChangeReviewRegistry,
  admitted: AdmittedApplyBatch
): ApplyBatchForwardOutcome {
  function stopped(failure: ApplyBatchForwardFailure, entriesApplied: number, totalEntries: number): ApplyBatchForwardOutcome {
    return { batchId: admitted.batchId, projectId: admitted.projectId, reviewId: admitted.reviewId, outcome: 'STOPPED', entriesApplied, totalEntries, failure }
  }

  const batch = readBatch(db, admitted.batchId)

  // Eligibility check, called before any review/native work: {from:'ADMITTED', to:'PREPARED'}
  // is the ONLY row in ALLOWED_BATCH_TRANSITIONS targeting 'PREPARED', so this
  // single, already-existing guard call is a complete eligibility check on
  // its own - it only succeeds when batch.state === 'ADMITTED', i.e. exactly
  // the batch submitApply() just admitted, since no other call path can ever
  // reach this function.
  assertValidBatchTransition({ state: batch.state, preRecoveryState: batch.preRecoveryState }, 'PREPARED')

  const entries = readEntries(db, admitted.batchId)
  const totalEntries = entries.length

  let review: CodeChangeAuthoritativeReview
  try {
    review = reviewRegistry.resolveAuthoritative(admitted.projectId, admitted.reviewId)
  } catch {
    return stopped({ phase: 'REVIEW_MISMATCH', entryId: null, ordinal: null, code: null }, 0, totalEntries)
  }

  // Defensive binding re-check - structurally almost unreachable given
  // codeChangeReviewService.ts's own frozen "never mutated post-approval"
  // invariant AND resolveAuthoritative()'s own projectId/reviewId-keyed
  // lookup, checked anyway per this codebase's "explicit check, never
  // assume" discipline: never trust that a resolved review IS the one just
  // admitted merely because the lookup call didn't throw. All three of the
  // review's own identity fields must exactly equal the freshly admitted
  // values - a registry wiring/cache defect (or a future registry swap)
  // that returned a DIFFERENT project's or review's authoritative record
  // for this lookup must be rejected here, before any byte reconstruction,
  // root resolution, or native call - never inferred merely from the
  // fingerprint alone matching by coincidence.
  if (review.projectId !== admitted.projectId || review.reviewId !== admitted.reviewId || review.fingerprint !== admitted.fingerprint) {
    return stopped({ phase: 'REVIEW_MISMATCH', entryId: null, ordinal: null, code: null }, 0, totalEntries)
  }

  const reconstructed = reconstructAndCrossCheckProposedBytes(review, entries)
  if (reconstructed === null) {
    return stopped({ phase: 'REVIEW_MISMATCH', entryId: null, ordinal: null, code: null }, 0, totalEntries)
  }
  const proposedBytesByEntryId = new Map(reconstructed.map((r) => [r.entryId, r.proposedBytes]))

  const rootLocator = resolveForwardRootLocator(batch.authorizationJson)
  if (!rootLocator.ok) {
    return stopped({ phase: 'ROOT_LOCATOR', entryId: null, ordinal: null, code: null }, 0, totalEntries)
  }
  const rootPath = rootLocator.rootPath

  // One batch-wide plan, two independent per-kind index maps (modifies_/
  // creates_ are separate std::vectors at the native layer - Spec v2 S2.3).
  const modifies: WindowsSafeApplyModifyPlan[] = []
  const creates: WindowsSafeApplyCreatePlan[] = []
  const modifyIndexByEntryId = new Map<number, number>()
  const createIndexByEntryId = new Map<number, number>()

  for (const entry of entries) {
    const proposedBytes = proposedBytesByEntryId.get(entry.id)
    if (proposedBytes === undefined) {
      // Structurally unreachable - reconstructAndCrossCheckProposedBytes
      // covers every entry 1:1 or returns null for the whole batch.
      return stopped({ phase: 'REVIEW_MISMATCH', entryId: entry.id, ordinal: entry.ordinal, code: null }, 0, totalEntries)
    }
    if (entry.mutationType === 'MODIFY') {
      modifyIndexByEntryId.set(entry.id, modifies.length)
      modifies.push({ path: entry.relPath, expectedSha256Hex: entry.originalSha256, expectedLength: entry.originalByteLength, proposedBytes })
    } else {
      createIndexByEntryId.set(entry.id, creates.length)
      creates.push({ path: entry.relPath, proposedBytes })
    }
  }

  const prepareResult = callNative(() => native.prepareLease({ root: rootPath, modifies, creates }))
  if (!prepareResult.ok) {
    // No lease was ever created (napi_entry.cc deletes the native Lease
    // object before throwing on a non-OK Prepare()) - nothing to close.
    return stopped({ phase: 'PREPARE', entryId: null, ordinal: null, code: prepareResult.code }, 0, totalEntries)
  }
  const lease = prepareResult.value.lease

  try {
    // Batch ADMITTED -> PREPARED (+ root evidence), one durable transaction.
    assertValidBatchTransition({ state: batch.state, preRecoveryState: batch.preRecoveryState }, 'PREPARED')
    withFullDurability(db, () => {
      db.prepare(
        `UPDATE apply_batches SET state='PREPARED', root_native_file_id_128_hex=?, root_native_volume_serial=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`
      ).run(prepareResult.value.root.nativeFileId128Hex, prepareResult.value.root.nativeVolumeSerial, batch.id)
    })

    // Per-entry PENDING -> PREPARED, each its own independent transaction.
    for (const entry of entries) {
      assertValidEntryTransition({ state: entry.state }, 'PREPARED')
      if (entry.mutationType === 'MODIFY') {
        const modifyIndex = modifyIndexByEntryId.get(entry.id) as number
        const outcome = prepareResult.value.modifies[modifyIndex]
        withFullDurability(db, () => {
          db.prepare(
            `UPDATE apply_batch_entries SET state='PREPARED', prepared_native_file_id_128_hex=?, prepared_native_volume_serial=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`
          ).run(outcome.nativeFileId128Hex, outcome.nativeVolumeSerial, entry.id)
        })
      } else {
        // CREATE entries carry no PREPARED-era evidence - Prepare() only
        // resolves/opens the parent chain for CREATE, never captures identity.
        withFullDurability(db, () => {
          db.prepare(`UPDATE apply_batch_entries SET state='PREPARED', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(entry.id)
        })
      }
    }

    // Batch PREPARED -> APPLYING.
    assertValidBatchTransition({ state: 'PREPARED', preRecoveryState: null }, 'APPLYING')
    withFullDurability(db, () => {
      db.prepare(`UPDATE apply_batches SET state='APPLYING', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(batch.id)
    })

    // Per-entry mutation loop, ordinal ASC, stopping at the first failure.
    let entriesApplied = 0
    for (const entry of entries) {
      const isCreate = entry.mutationType === 'CREATE'
      const index = (isCreate ? createIndexByEntryId.get(entry.id) : modifyIndexByEntryId.get(entry.id)) as number

      // Write-ahead marker, committed BEFORE the mutating native call.
      assertValidEntryTransition({ state: 'PREPARED' }, 'APPLY_ATTEMPTING')
      withFullDurability(db, () => {
        db.prepare(`UPDATE apply_batch_entries SET state='APPLY_ATTEMPTING', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(entry.id)
      })

      const mutateResult = callNative(() => (isCreate ? native.createFile(lease, index) : native.applyModify(lease, index)))
      if (!mutateResult.ok) {
        return stopped({ phase: 'MUTATE', entryId: entry.id, ordinal: entry.ordinal, code: mutateResult.code }, entriesApplied, totalEntries)
      }

      // Explicit, independent verify call. verifyFile() does NOT itself
      // compare anything against an expected value (lease.cc:432-463) - it
      // is a fresh, independently-timed read. The comparison against the
      // proposed content AND against the mutate call's own identity (the
      // file-swap defense) is this runner's own responsibility.
      const verifyResult = callNative(() => native.verifyFile(lease, index, isCreate))
      if (!verifyResult.ok) {
        return stopped({ phase: 'VERIFY', entryId: entry.id, ordinal: entry.ordinal, code: verifyResult.code }, entriesApplied, totalEntries)
      }
      const verifyOutcome = verifyResult.value
      const contentMatches = verifyOutcome.sha256Hex === entry.proposedSha256 && verifyOutcome.length === entry.proposedByteLength
      const identityMatches =
        verifyOutcome.nativeFileId128Hex === mutateResult.value.nativeFileId128Hex &&
        verifyOutcome.nativeVolumeSerial === mutateResult.value.nativeVolumeSerial
      if (!contentMatches || !identityMatches) {
        return stopped({ phase: 'VERIFY', entryId: entry.id, ordinal: entry.ordinal, code: 'VERIFY_MISMATCH' }, entriesApplied, totalEntries)
      }

      // APPLY_ATTEMPTING -> APPLIED, only after a passing verify, recording
      // the verify outcome's evidence (the last, freshest, independently-
      // confirmed evidence - not the mutate call's own outcome).
      assertValidEntryTransition({ state: 'APPLY_ATTEMPTING' }, 'APPLIED')
      withFullDurability(db, () => {
        db.prepare(
          `UPDATE apply_batch_entries SET state='APPLIED', native_file_id_128_hex=?, native_volume_serial=?, written_sha256=?, written_byte_length=?, failure_note=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`
        ).run(verifyOutcome.nativeFileId128Hex, verifyOutcome.nativeVolumeSerial, verifyOutcome.sha256Hex, verifyOutcome.length, entry.id)
      })
      entriesApplied++
    }

    // Every entry reached APPLIED - batch APPLYING -> SUCCEEDED.
    assertValidBatchTransition({ state: 'APPLYING', preRecoveryState: null }, 'SUCCEEDED')
    withFullDurability(db, () => {
      db.prepare(`UPDATE apply_batches SET state='SUCCEEDED', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(batch.id)
    })

    return {
      batchId: admitted.batchId,
      projectId: admitted.projectId,
      reviewId: admitted.reviewId,
      outcome: 'SUCCEEDED',
      entriesApplied,
      totalEntries,
      failure: null
    }
  } finally {
    // Runs on every exit from the block above - every early `return
    // stopped(...)`, the final success `return`, and any thrown exception
    // (a genuine DB-layer failure) alike. closeLeaseSafely() never throws,
    // so it never overrides whichever of those outcomes is already underway.
    closeLeaseSafely(native, lease)
  }
}

/**
 * Builds ONE ApplyBatchForwardService bound to the given trusted
 * dependencies. Mirrors applyBatchJournalService.ts's/
 * applyBatchRecoveryService.ts's own factory shape. No dependency has a
 * default - every one must be supplied explicitly.
 */
export function createApplyBatchForwardService(deps: ApplyBatchForwardDependencies) {
  const { db, native, reviewRegistry, journalService } = deps
  return {
    /**
     * The ONLY public Slice-2 operation. `rawRequest` is the SAME untrusted,
     * selection-only shape authorizeApply()/admitBatch() already accept
     * ({projectId, reviewId}) - passed through to admitBatch() UNTOUCHED,
     * never independently parsed or validated here (that would be a second,
     * independently-fallible copy of validateApplyAuthorityRequest, which
     * admitBatch()'s own internal authorizeApply() call already performs).
     *
     * Synchronously, in this exact order, within one call stack:
     *   1. journalService.admitBatch(rawRequest) - performs a FRESH
     *      authorizeApply() internally (unchanged, this file never calls it
     *      directly) and, on success, one durable ADMITTED/PENDING write.
     *      Any ApplyAuthorityError/ApplyBatchAdmissionError propagates
     *      unchanged, uncaught, exactly as admitBatch() already does today -
     *      and, critically, propagates BEFORE step 2 ever runs, so a
     *      rejected/revoked authorization reaches ZERO native calls.
     *   2. runForwardPass(db, native, reviewRegistry, admitted) - the
     *      private runner, invoked with the WHOLE admitted-batch object
     *      admitBatch() just returned (not merely its numeric batchId - the
     *      runner also needs admitted.projectId/reviewId/fingerprint for its
     *      own review re-resolution and cross-check, S2.1), in this same
     *      stack frame - never a value read from anywhere else, never
     *      deferred, never re-entrant.
     */
    submitApply(rawRequest: unknown): ApplyBatchForwardOutcome {
      const admitted = journalService.admitBatch(rawRequest)
      return runForwardPass(db, native, reviewRegistry, admitted)
    }
  }
}

export type ApplyBatchForwardService = ReturnType<typeof createApplyBatchForwardService>
