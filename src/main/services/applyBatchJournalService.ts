import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { withFullDurability } from '../db/durableTransaction'
import type { ApplyAuthorization, ApplyAuthorityService } from './applyAuthorityService'
import { reconstructOriginalBytes, type CodeChangeAuthoritativeReview, type CodeChangeReviewRegistry } from './codeChangeReviewService'
import type { ApplyBatchAdmissionErrorCode } from '@shared/applyBatchTypes'

// Meilenstein 4.8B.2B - Durable Journal + State Machine, ADMISSION ONLY.
//
// FROZEN SCOPE: this module implements EXACTLY ONE state transition -
// (nothing) -> ADMITTED for a batch, (nothing) -> PENDING for its entries.
// It never calls prepareLease/applyModify/createFile/verifyFile/rollbackFile,
// never performs a filesystem mutation, never scans for interrupted batches
// at startup, and never resolves a RECOVERY_REQUIRED/RECOVERY_CONFLICT batch.
// Those are ALL B.2C's responsibility (see M4.8B2B-Implementation-Spec.md
// section 8) - this file adds nothing toward any of them beyond the schema
// (007_apply_batches.ts) already representing the states they will use.
//
// Frozen recovery-authority rule (semantic documentation only - this does not
// change any runtime behavior in B.2B):
//   - Every NEW forward apply requires its own fresh authorizeApply() call.
//     Nothing in this table shortcuts applyAuthorityService.authorizeApply()'s
//     own live, synchronous evaluation (see that module's own file header for
//     why an ApplyAuthorization is only ever valid for the instant it was
//     built).
//   - A durable journal row is NEVER authority for a new, resumed, or
//     replayed forward apply - not at admission time, and not later during
//     any future recovery pass.
//   - Post-crash recovery (B.2C) must NEVER continue unfinished forward work.
//     It may only (a) confirm, from durable native-identity/content evidence,
//     that a batch's work had ALREADY fully finished before the crash, or
//     (b) restore the filesystem back TOWARD the pre-batch state.
//   - Journal evidence therefore gates ONLY that one narrow recovery action
//     (confirm-already-finished, or restore-toward-pre-batch) - it grants no
//     general filesystem authority and, in particular, no forward-apply
//     authority of any kind.

const ERROR_MESSAGES: Record<ApplyBatchAdmissionErrorCode, string> = {
  PROVENANCE_MISMATCH:
    'Die frisch aufgeloeste Autorisierung und die vertrauenswuerdige Review-Provenienz stimmen nicht exakt ueberein.',
  PROJECT_HAS_UNRESOLVED_BATCH: 'Fuer dieses Projekt existiert bereits ein ungeloester Apply-Batch.'
}

export class ApplyBatchAdmissionError extends Error {
  constructor(public readonly code: ApplyBatchAdmissionErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'ApplyBatchAdmissionError'
  }
}

export interface ApplyBatchJournalDependencies {
  db: Database.Database
  applyAuthorityService: ApplyAuthorityService
  reviewRegistry: CodeChangeReviewRegistry
}

/** Minimal, Main-only projection of a newly admitted batch - no IPC/UI consumer exists for this in M4.8B.2B. */
export interface AdmittedApplyBatch {
  batchId: number
  projectId: number
  reviewId: string
  fingerprint: string
  entryCount: number
}

interface PreparedEntry {
  mutationType: 'MODIFY' | 'CREATE'
  relPath: string
  proposedSha256: string
  proposedByteLength: number
  originalBytes: Buffer | null
  originalSha256: string | null
  originalByteLength: number | null
}

/**
 * NULL-safe root-identity comparison. `authRoot` is always complete (the
 * envelope's own INSUFFICIENT_ROOT_IDENTITY gate already guarantees this by
 * the time authorizeApply() returns) - `reviewRoot` comes from a SEPARATE
 * trusted resolution (reviewRegistry.resolveAuthoritative) and is defensively
 * treated as possibly null/incomplete, exactly like applyAuthorityService.ts
 * itself never assumes a second dependency call agrees with the first.
 */
function rootIdentityMatches(
  authRoot: { realPath: string; dev: string | null; ino: string | null },
  reviewRoot: { realPath: string; dev: string | null; ino: string | null } | null
): boolean {
  if (reviewRoot === null) return false
  return authRoot.realPath === reviewRoot.realPath && authRoot.dev === reviewRoot.dev && authRoot.ino === reviewRoot.ino
}

/**
 * Phase 2 of admitBatch() (see M4.8B2B-Implementation-Spec.md section 3.2):
 * cross-checks the FRESH ApplyAuthorization against the FRESH
 * CodeChangeAuthoritativeReview obtained for the SAME projectId/reviewId, and
 * reconstructs+verifies durable MODIFY original_bytes evidence from the
 * review's own proven source provenance. Purely in-memory - no DB access -
 * so ANY mismatch throws before admitBatch() ever opens a transaction.
 *
 * Never trusts a caller-supplied authorization/review pair - both are always
 * resolved by admitBatch() itself, immediately before this function runs
 * (see that function below).
 */
function crossCheckAndPrepareEntries(authorization: ApplyAuthorization, review: CodeChangeAuthoritativeReview): PreparedEntry[] {
  if (authorization.projectId !== review.projectId) throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')
  if (authorization.reviewId !== review.reviewId) throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')
  if (authorization.fingerprint !== review.fingerprint) throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')

  const { provenance, proposal } = review.package

  if (authorization.target.projectFolderPath !== provenance.projectFolderPath) {
    throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')
  }
  if (authorization.target.projectFolderComparisonKey !== provenance.projectFolderComparisonKey) {
    throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')
  }
  if (!rootIdentityMatches(authorization.target.rootIdentity, provenance.rootIdentity)) {
    throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')
  }

  // Reviewed order, never re-sorted or matched by path alone (mirrors
  // applyAuthorityService.ts's own "REVIEWED ORDER... never sorted/
  // reordered/rewritten" discipline).
  if (authorization.mutations.length !== proposal.changes.length) {
    throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')
  }

  const sourceByPath = new Map(provenance.sourceFiles.map((file) => [file.path, file]))
  const prepared: PreparedEntry[] = []

  for (let i = 0; i < authorization.mutations.length; i++) {
    const mutation = authorization.mutations[i]
    const change = proposal.changes[i]
    if (mutation.path !== change.path) throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')
    if (mutation.type !== change.type) throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')

    if (mutation.type === 'MODIFY') {
      const sourceFile = sourceByPath.get(mutation.path)
      if (!sourceFile) throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')

      // The load-bearing check: prove the bytes about to be journaled are
      // EXACTLY the bytes authorization's own hash/length already describe -
      // never bytes merely "found nearby" in a review that happens to share
      // a reviewId. Reuses codeChangeReviewService.ts's own byte-
      // reconstruction rule verbatim - never a second, independent one.
      const reconstructed = reconstructOriginalBytes(sourceFile.content, sourceFile.format)
      const reconstructedSha256 = createHash('sha256').update(reconstructed).digest('hex')
      if (reconstructedSha256 !== mutation.originalSha256) throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')
      if (reconstructed.length !== mutation.originalByteLength) throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')

      prepared.push({
        mutationType: 'MODIFY',
        relPath: mutation.path,
        proposedSha256: mutation.proposedSha256,
        proposedByteLength: mutation.proposedByteLength,
        originalBytes: reconstructed,
        originalSha256: reconstructedSha256,
        originalByteLength: reconstructed.length
      })
    } else if (mutation.type === 'CREATE') {
      // A CREATE must not shadow a captured source file - reuses the exact
      // MODIFY-scope guarantee applyAuthorityService.ts/
      // codeChangeReviewService.ts already rely on elsewhere.
      if (sourceByPath.has(mutation.path)) throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')

      prepared.push({
        mutationType: 'CREATE',
        relPath: mutation.path,
        proposedSha256: mutation.proposedSha256,
        proposedByteLength: mutation.proposedByteLength,
        originalBytes: null,
        originalSha256: null,
        originalByteLength: null
      })
    } else {
      // Structurally unreachable given AuthorizedMutation's own two variants -
      // fails closed rather than silently mis-typing a mutation if that ever
      // changes (mirrors applyAuthorityService.ts's identical defensive style).
      throw new ApplyBatchAdmissionError('PROVENANCE_MISMATCH')
    }
  }

  return prepared
}

function isUnresolvedBatchConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (code !== 'SQLITE_CONSTRAINT_UNIQUE') return false
  return error.message.includes('apply_batches.project_id')
}

/**
 * Builds ONE ApplyBatchJournalService bound to the given trusted
 * dependencies. Mirrors applyAuthorityService.ts's/
 * codeChangeReviewService.ts's own factory shape. No dependency has a
 * default - every one must be supplied explicitly.
 */
export function createApplyBatchJournalService(deps: ApplyBatchJournalDependencies) {
  const { db, applyAuthorityService, reviewRegistry } = deps

  /**
   * The ONLY state transition this module implements: (nothing) -> ADMITTED.
   *
   * `rawRequest` is the SAME untrusted, selection-only shape
   * applyAuthorityService.authorizeApply() itself accepts ({ projectId,
   * reviewId }) - this function never accepts a prebuilt
   * ApplyAuthorization/CodeChangeAuthoritativeReview from a caller. Both are
   * always resolved HERE, fresh, in this exact order:
   *
   *   1. authorizeApply(rawRequest) - the untrusted selection is validated
   *      and fully re-authorized by that module's own live checks. Any
   *      ApplyAuthorityError propagates unchanged.
   *   2. reviewRegistry.resolveAuthoritative(authorization.projectId,
   *      authorization.reviewId) - using the AUTHORIZATION's OWN resolved
   *      identity, never the raw input a second time. Any CodeChangeReviewError
   *      propagates unchanged.
   *   3. Cross-check both trusted snapshots (crossCheckAndPrepareEntries) -
   *      any mismatch throws ApplyBatchAdmissionError('PROVENANCE_MISMATCH')
   *      BEFORE any database write.
   *   4. One durable transaction (withFullDurability) writes the batch
   *      (state='ADMITTED') and its entries (state='PENDING'). A UNIQUE
   *      violation on the one-unresolved-batch-per-project index is caught
   *      and re-thrown as ApplyBatchAdmissionError('PROJECT_HAS_UNRESOLVED_BATCH').
   */
  function admitBatch(rawRequest: unknown): AdmittedApplyBatch {
    const authorization = applyAuthorityService.authorizeApply(rawRequest)
    const review = reviewRegistry.resolveAuthoritative(authorization.projectId, authorization.reviewId)

    const entries = crossCheckAndPrepareEntries(authorization, review)

    try {
      return withFullDurability(db, () => {
        const insertBatch = db.prepare(
          `INSERT INTO apply_batches (project_id, review_id, fingerprint, schema_version, authorization_json)
           VALUES (?, ?, ?, ?, ?)`
        )
        const batchResult = insertBatch.run(
          authorization.projectId,
          authorization.reviewId,
          authorization.fingerprint,
          authorization.schemaVersion,
          JSON.stringify(authorization)
        )
        const batchId = Number(batchResult.lastInsertRowid)

        const insertEntry = db.prepare(
          `INSERT INTO apply_batch_entries
             (batch_id, ordinal, mutation_type, rel_path, proposed_sha256, proposed_byte_length,
              original_bytes, original_sha256, original_byte_length)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        entries.forEach((entry, index) => {
          insertEntry.run(
            batchId,
            index,
            entry.mutationType,
            entry.relPath,
            entry.proposedSha256,
            entry.proposedByteLength,
            entry.originalBytes,
            entry.originalSha256,
            entry.originalByteLength
          )
        })

        const admitted: AdmittedApplyBatch = {
          batchId,
          projectId: authorization.projectId,
          reviewId: authorization.reviewId,
          fingerprint: authorization.fingerprint,
          entryCount: entries.length
        }
        return admitted
      })
    } catch (error) {
      if (isUnresolvedBatchConstraintViolation(error)) {
        throw new ApplyBatchAdmissionError('PROJECT_HAS_UNRESOLVED_BATCH')
      }
      throw error
    }
  }

  return { admitBatch }
}

export type ApplyBatchJournalService = ReturnType<typeof createApplyBatchJournalService>
