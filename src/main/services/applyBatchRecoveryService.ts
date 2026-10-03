import type Database from 'better-sqlite3'
import { withFullDurability } from '../db/durableTransaction'
import { assertValidBatchTransition, assertValidEntryTransition, ApplyBatchTransitionError } from './applyBatchTransitionGuard'
import {
  prepareLease as realPrepareLease,
  applyModify as realApplyModify,
  recoverDeleteCreated as realRecoverDeleteCreated,
  closeLease as realCloseLease,
  WindowsSafeApplyUnavailableError,
  type WindowsSafeApplyPlan,
  type WindowsSafeApplyModifyPlan,
  type WindowsSafeApplyPrepareResult,
  type WindowsSafeApplyOutcome,
  type WindowsSafeApplyRecoverDeleteCreatedRequest
} from './windowsSafeApply'
import type {
  ApplyBatchState,
  ApplyBatchEntryState,
  ApplyBatchRecoveryOriginState,
  ApplyBatchEntryMutationType
} from '@shared/applyBatchTypes'
import type { ApplyBatchRecoveryBatchOutcome, ApplyBatchRecoveryFailureNote } from '@shared/applyBatchRecoveryTypes'

// Meilenstein 4.8B.2C (Recovery Core). Implements EXACTLY:
//   - scanForUnresolvedBatches()/recoverBatch()/recoverAllUnresolvedBatches()
//   - CONFIRM mode (already-fully-finished confirmation)
//   - ROLLBACK mode (restore-toward-pre-batch-state), MODIFY via the
//     existing reverse-lease mechanism, CREATE via B.2A's recoverDeleteCreated
//   - applyBatchTransitionGuard-mediated state transitions only
//
// FROZEN SCOPE, same discipline as applyBatchJournalService.ts:
//   - This module NEVER continues, resumes, or completes unfinished forward
//     work. Every native mutating call it issues moves strictly TOWARD the
//     pre-batch state (applyModify() with original_bytes, recoverDeleteCreated())
//     - never toward the batch's originally-proposed target state. It never
//     calls createFile()/verifyFile()/rollbackFile() and never constructs an
//     applyModify() call using proposed_* bytes.
//   - A durable apply_batches/apply_batch_entries row is NEVER treated as
//     fresh authority for a new, resumed, or replayed forward apply - it is
//     read-only evidence this service uses to either (a) confirm, from
//     durable native-identity/content evidence, that a batch's work had
//     ALREADY fully finished before the crash, or (b) restore the
//     filesystem back TOWARD the pre-batch state.
//   - RECOVERY_CONFLICT is reachable only from APPLY_ATTEMPTING or
//     ROLLBACK_ATTEMPTING (applyBatchTransitionGuard.ts's frozen table). An
//     APPLIED-origin entry that must reach RECOVERY_CONFLICT is always first
//     durably normalized to ROLLBACK_ATTEMPTING (ensureNotDirectlyApplied,
//     used by resolveEntryConflict). The one exception - APPLIED->ROLLED_BACK
//     directly, no marker - is reserved for the as-original-probe-matched
//     MODIFY case, which can never resolve to RECOVERY_CONFLICT.
//   - Every recovery-state write (marker, RECOVERY_CONFLICT, or terminal
//     ROLLED_BACK/SUCCEEDED/RECOVERY_CONFLICT, at either the entry or batch
//     level) is its own independent withFullDurability transaction - marker
//     -> native operation/probe -> independent durable terminal write, never
//     any other order, never a normal-durability write of a terminal state.
//   - This service only ever writes apply_batches.state/pre_recovery_state
//     (exactly once, at the <origin>->RECOVERY_REQUIRED transition)/
//     completed_at/updated_at, and apply_batch_entries.state/failure_note/
//     updated_at. It never writes root_native_*/prepared_native_*/native_*/
//     written_*/original_*/proposed_* - all of that is read-only evidence
//     from this service's point of view.

// ---------------------------------------------------------------------------
// Native-call safety wrapper (native-call throw/catch contract).
//
// prepareLease(), applyModify(), and recoverDeleteCreated() all throw a JS
// Error with a string .code property for every non-OK result
// [napi_entry.cc PrepareLease/ApplyModify/RecoverDeleteCreated - ThrowCoded/
// err.Set("code", ...)], including recoverDeleteCreated()'s NOT_FOUND.
// loadAddon() throws WindowsSafeApplyUnavailableError (no .code) if the
// native module cannot be loaded at all. No native call anywhere in this
// service is ever made without going through callNative() - this is the
// single point that guarantees an unexpected native throw can never
// propagate out of recoverBatch() and abort recovery for other, unrelated
// entries or batches; every native-layer failure is converted into a
// classified, in-band RECOVERY_CONFLICT for the one entry it concerns.
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
// Native dependency injection - production callers (and .windows.test.ts)
// pass realWindowsSafeApplyNativeDependencies verbatim; fake-native
// .test.ts callers pass a hand-built object with the identical shape, giving
// deterministic control with no filesystem and no native module at all. No
// dependency has a default, mirroring applyAuthorityService.ts's/
// applyBatchJournalService.ts's own "no dependency has a default" discipline.
// ---------------------------------------------------------------------------

export interface ApplyBatchRecoveryNativeDependencies {
  prepareLease(plan: WindowsSafeApplyPlan): WindowsSafeApplyPrepareResult
  applyModify(lease: unknown, index: number): WindowsSafeApplyOutcome
  recoverDeleteCreated(request: WindowsSafeApplyRecoverDeleteCreatedRequest): WindowsSafeApplyOutcome
  closeLease(lease: unknown): void
}

export const realWindowsSafeApplyNativeDependencies: ApplyBatchRecoveryNativeDependencies = {
  prepareLease: realPrepareLease,
  applyModify: realApplyModify,
  recoverDeleteCreated: realRecoverDeleteCreated,
  closeLease: realCloseLease
}

export interface ApplyBatchRecoveryDependencies {
  db: Database.Database
  native: ApplyBatchRecoveryNativeDependencies
}

export interface ApplyBatchRecoveryEntryOutcome {
  entryId: number
  ordinal: number
  finalState: 'ROLLED_BACK' | 'RECOVERY_CONFLICT'
  /** The exact value persisted to apply_batch_entries.failure_note, or null when finalState is ROLLED_BACK (failure_note is always NULL on every ROLLED_BACK write). */
  failureReason: ApplyBatchRecoveryFailureNote | null
}

export interface ApplyBatchRecoveryResult {
  batchId: number
  finalState: ApplyBatchRecoveryBatchOutcome
  preRecoveryState: ApplyBatchRecoveryOriginState
  /** Empty when finalState === 'SUCCEEDED' (CONFIRM mode writes no entry row - every entry remains APPLIED, already correct and durable). */
  entryOutcomes: ApplyBatchRecoveryEntryOutcome[]
}

// ---------------------------------------------------------------------------
// Row snapshots. EntrySnapshot is a discriminated union on mutationType so
// that MODIFY's mandatory original_*/proposed_* fields (schema-guaranteed
// NOT NULL for mutation_type='MODIFY' - 007_apply_batches.ts's XOR CHECK)
// are non-nullable in the type, with no `!` non-null assertion anywhere in
// this file - the discriminant check (`entry.mutationType === 'MODIFY'`)
// narrows structurally instead. This is deliberately NOT extended to
// native_file_id_128_hex/native_volume_serial/written_sha256/
// written_byte_length (the post-APPLIED CREATE evidence) - completeness of
// THAT evidence at ROLLBACK_ATTEMPTING is NOT schema-guaranteed (a CREATE
// entry can legally sit at ROLLBACK_ATTEMPTING with incomplete evidence, via
// a live forward-execution rollback interrupted by a crash before it could
// record ROLLED_BACK/RECOVERY_CONFLICT) - it is always checked explicitly,
// at runtime, immediately before use (resolveCreateEntry).
// ---------------------------------------------------------------------------

interface EntrySnapshotBase {
  id: number
  batchId: number
  ordinal: number
  relPath: string
  proposedSha256: string
  proposedByteLength: number
  state: ApplyBatchEntryState
  nativeFileId128Hex: string | null
  nativeVolumeSerial: string | null
  writtenSha256: string | null
  writtenByteLength: number | null
  failureNote: string | null
}

interface ModifyEntrySnapshot extends EntrySnapshotBase {
  mutationType: 'MODIFY'
  originalBytes: Buffer
  originalSha256: string
  originalByteLength: number
  preparedNativeFileId128Hex: string | null
  preparedNativeVolumeSerial: string | null
}

interface CreateEntrySnapshot extends EntrySnapshotBase {
  mutationType: 'CREATE'
  originalBytes: null
  originalSha256: null
  originalByteLength: null
  preparedNativeFileId128Hex: null
  preparedNativeVolumeSerial: null
}

type EntrySnapshot = ModifyEntrySnapshot | CreateEntrySnapshot

/** Minimal shape resolveEntryConflict()/resolveEntryRolledBack()/markBeforeMutatingCall()/ensureNotDirectlyApplied() actually need - both EntrySnapshot variants satisfy this structurally. */
interface EntryIdentity {
  id: number
  state: ApplyBatchEntryState
}

interface BatchSnapshot {
  id: number
  authorizationJson: string
  rootNativeFileId128Hex: string | null
  rootNativeVolumeSerial: string | null
  state: ApplyBatchState
  preRecoveryState: ApplyBatchRecoveryOriginState | null
}

interface ApplyBatchRow {
  id: number
  authorization_json: string
  root_native_file_id_128_hex: string | null
  root_native_volume_serial: string | null
  state: string
  pre_recovery_state: string | null
}

const SELECT_BATCH_BASE = `SELECT id, authorization_json, root_native_file_id_128_hex, root_native_volume_serial, state, pre_recovery_state FROM apply_batches`

function mapBatchRow(row: ApplyBatchRow): BatchSnapshot {
  return {
    id: row.id,
    authorizationJson: row.authorization_json,
    rootNativeFileId128Hex: row.root_native_file_id_128_hex,
    rootNativeVolumeSerial: row.root_native_volume_serial,
    state: row.state as ApplyBatchState,
    preRecoveryState: row.pre_recovery_state as ApplyBatchRecoveryOriginState | null
  }
}

function readBatch(db: Database.Database, batchId: number): BatchSnapshot {
  const row = db.prepare(`${SELECT_BATCH_BASE} WHERE id = ?`).get(batchId) as ApplyBatchRow | undefined
  if (!row) throw new ApplyBatchTransitionError('BATCH_NOT_FOUND', `batchId=${batchId}`)
  return mapBatchRow(row)
}

interface ApplyBatchEntryRow {
  id: number
  batch_id: number
  ordinal: number
  mutation_type: string
  rel_path: string
  proposed_sha256: string
  proposed_byte_length: number
  original_bytes: Buffer | null
  original_sha256: string | null
  original_byte_length: number | null
  prepared_native_file_id_128_hex: string | null
  prepared_native_volume_serial: string | null
  state: string
  native_file_id_128_hex: string | null
  native_volume_serial: string | null
  written_sha256: string | null
  written_byte_length: number | null
  failure_note: string | null
}

const SELECT_ENTRY_BASE = `SELECT
    id, batch_id, ordinal, mutation_type, rel_path, proposed_sha256, proposed_byte_length,
    original_bytes, original_sha256, original_byte_length,
    prepared_native_file_id_128_hex, prepared_native_volume_serial,
    state, native_file_id_128_hex, native_volume_serial, written_sha256, written_byte_length, failure_note
  FROM apply_batch_entries`

function mapEntryRow(row: ApplyBatchEntryRow): EntrySnapshot {
  const base = {
    id: row.id,
    batchId: row.batch_id,
    ordinal: row.ordinal,
    relPath: row.rel_path,
    proposedSha256: row.proposed_sha256,
    proposedByteLength: row.proposed_byte_length,
    state: row.state as ApplyBatchEntryState,
    nativeFileId128Hex: row.native_file_id_128_hex,
    nativeVolumeSerial: row.native_volume_serial,
    writtenSha256: row.written_sha256,
    writtenByteLength: row.written_byte_length,
    failureNote: row.failure_note
  }
  const mutationType = row.mutation_type as ApplyBatchEntryMutationType
  if (mutationType === 'MODIFY') {
    // Schema-guaranteed NOT NULL for mutation_type='MODIFY' (007_apply_batches.ts's XOR CHECK) - cast at this one row-mapping boundary only, mirroring projectsService.ts's own `row.status as ProjectStatus` convention.
    return {
      ...base,
      mutationType: 'MODIFY',
      originalBytes: row.original_bytes as Buffer,
      originalSha256: row.original_sha256 as string,
      originalByteLength: row.original_byte_length as number,
      preparedNativeFileId128Hex: row.prepared_native_file_id_128_hex,
      preparedNativeVolumeSerial: row.prepared_native_volume_serial
    }
  }
  return {
    ...base,
    mutationType: 'CREATE',
    originalBytes: null,
    originalSha256: null,
    originalByteLength: null,
    preparedNativeFileId128Hex: null,
    preparedNativeVolumeSerial: null
  }
}

function readEntries(db: Database.Database, batchId: number): EntrySnapshot[] {
  const rows = db.prepare(`${SELECT_ENTRY_BASE} WHERE batch_id = ? ORDER BY ordinal ASC`).all(batchId) as ApplyBatchEntryRow[]
  return rows.map(mapEntryRow)
}

// ---------------------------------------------------------------------------
// Root locator resolution (authorization_json.target.projectFolderPath used
// as an untrusted locator only). authorization_json is already guaranteed
// syntactically valid JSON by the json_valid() CHECK (007_apply_batches.ts) -
// JSON.parse can only fail here if the column were corrupted by something
// outside this application's own write path, which this function still
// defends against explicitly. Beyond "is it a non-empty string at the
// expected nested key," no further shape or path-format validation is
// performed here - every other way this string could be wrong (relative
// path, wrong drive, reparse point, wrong volume type, ...) is already,
// independently, exhaustively rejected by the native OpenRootGuard the first
// time this locator is actually used in a prepareLease()/
// recoverDeleteCreated() call; any native rejection is captured by
// callNative() and folds into the ordinary "probe inconclusive ->
// RECOVERY_CONFLICT" path. Resolved once per batch, reused throughout.
// ---------------------------------------------------------------------------

type RecoveryRootLocatorResult = { ok: true; rootPath: string } | { ok: false; rootPath: null }

function resolveRecoveryRootLocator(authorizationJson: string): RecoveryRootLocatorResult {
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
// Durable write helpers. EVERY recovery-state mutation - marker,
// RECOVERY_CONFLICT, or terminal ROLLED_BACK - is its own independent
// withFullDurability transaction: marker -> native operation/probe ->
// independent durable terminal write, never any other order, never a
// normal-durability write of a terminal state.
// ---------------------------------------------------------------------------

/**
 * Used ONLY immediately before a RECOVERY_CONFLICT write. Normalizes an
 * APPLIED-origin entry to ROLLBACK_ATTEMPTING first (durable, unconditional)
 * so that the RECOVERY_CONFLICT transition resolveEntryConflict() is about
 * to request is always taken from a frozen-vocabulary-legal source
 * (APPLY_ATTEMPTING or ROLLBACK_ATTEMPTING - never APPLIED). A no-op for an
 * entry already at APPLY_ATTEMPTING or ROLLBACK_ATTEMPTING.
 */
function ensureNotDirectlyApplied(db: Database.Database, entry: EntryIdentity): ApplyBatchEntryState {
  if (entry.state !== 'APPLIED') return entry.state
  assertValidEntryTransition({ state: 'APPLIED' }, 'ROLLBACK_ATTEMPTING')
  withFullDurability(db, () => {
    db.prepare(`UPDATE apply_batch_entries SET state='ROLLBACK_ATTEMPTING', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(entry.id)
  })
  return 'ROLLBACK_ATTEMPTING'
}

/** Every RECOVERY_CONFLICT resolution in this module goes through this. */
function resolveEntryConflict(db: Database.Database, entry: EntryIdentity, note: ApplyBatchRecoveryFailureNote): void {
  const normalizedState = ensureNotDirectlyApplied(db, entry)
  assertValidEntryTransition({ state: normalizedState }, 'RECOVERY_CONFLICT')
  withFullDurability(db, () => {
    db.prepare(`UPDATE apply_batch_entries SET state='RECOVERY_CONFLICT', failure_note=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(note, entry.id)
  })
}

/**
 * Every terminal ROLLED_BACK entry write in this module goes through this.
 * ROLLED_BACK is directly legal from PENDING, PREPARED, APPLIED,
 * APPLY_ATTEMPTING, and ROLLBACK_ATTEMPTING (applyBatchTransitionGuard.ts) -
 * no normalization step is needed or performed here, unlike
 * resolveEntryConflict's RECOVERY_CONFLICT-specific requirement.
 */
function resolveEntryRolledBack(db: Database.Database, entry: EntryIdentity): void {
  assertValidEntryTransition({ state: entry.state }, 'ROLLED_BACK')
  withFullDurability(db, () => {
    db.prepare(`UPDATE apply_batch_entries SET state='ROLLED_BACK', failure_note=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(entry.id)
  })
}

/**
 * Used ONLY immediately before an actual native mutating call
 * (applyModify()/recoverDeleteCreated()) is about to be issued. A no-op if
 * already ROLLBACK_ATTEMPTING (resumed). After this returns, the caller may
 * assume the entry's durable state is ROLLBACK_ATTEMPTING.
 */
function markBeforeMutatingCall(db: Database.Database, entry: EntryIdentity): void {
  if (entry.state === 'ROLLBACK_ATTEMPTING') return
  assertValidEntryTransition({ state: entry.state }, 'ROLLBACK_ATTEMPTING')
  withFullDurability(db, () => {
    db.prepare(`UPDATE apply_batch_entries SET state='ROLLBACK_ATTEMPTING', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(entry.id)
  })
}

// ---------------------------------------------------------------------------
// ROLLBACK mode - Case A (never attempted).
// ---------------------------------------------------------------------------

function resolveNeverAttemptedEntry(db: Database.Database, entry: EntryIdentity): void {
  resolveEntryRolledBack(db, entry)
}

// ---------------------------------------------------------------------------
// ROLLBACK mode - Case B (MODIFY, state in {APPLIED, APPLY_ATTEMPTING, ROLLBACK_ATTEMPTING}).
// ---------------------------------------------------------------------------

function resolveModifyEntry(
  db: Database.Database,
  native: ApplyBatchRecoveryNativeDependencies,
  entry: ModifyEntrySnapshot,
  batch: BatchSnapshot,
  rootLocator: RecoveryRootLocatorResult
): void {
  if (!rootLocator.ok) {
    resolveEntryConflict(db, entry, 'ROOT_LOCATOR:INVALID')
    return
  }
  const rootPath = rootLocator.rootPath

  // B1 - as-applied probe: does the disk currently hold the proposed content
  // at the applied-era identity?
  const planA: WindowsSafeApplyPlan = {
    root: rootPath,
    modifies: [{ path: entry.relPath, expectedSha256Hex: entry.proposedSha256, expectedLength: entry.proposedByteLength, proposedBytes: entry.originalBytes }]
  }
  const resA = callNative(() => native.prepareLease(planA))
  if (resA.ok) {
    const outcome = resA.value.modifies[0]
    const identityMatches =
      resA.value.root.nativeFileId128Hex === batch.rootNativeFileId128Hex &&
      resA.value.root.nativeVolumeSerial === batch.rootNativeVolumeSerial &&
      outcome.nativeFileId128Hex === entry.nativeFileId128Hex &&
      outcome.nativeVolumeSerial === entry.nativeVolumeSerial
    if (identityMatches) {
      // B2 - as-applied match: write-ahead marker, then the reversing call.
      resolveModifyAsAppliedMatch(db, native, entry, resA.value.lease)
      return
    }
    native.closeLease(resA.value.lease)
  }

  // B3 - as-original probe: does the disk already hold the pre-batch content
  // at the pre-forward (PREPARED-era) identity?
  const planO: WindowsSafeApplyPlan = {
    root: rootPath,
    modifies: [{ path: entry.relPath, expectedSha256Hex: entry.originalSha256, expectedLength: entry.originalByteLength, proposedBytes: entry.originalBytes }]
  }
  const resO = callNative(() => native.prepareLease(planO))
  if (resO.ok) {
    const outcome = resO.value.modifies[0]
    const identityMatches =
      resO.value.root.nativeFileId128Hex === batch.rootNativeFileId128Hex &&
      resO.value.root.nativeVolumeSerial === batch.rootNativeVolumeSerial &&
      outcome.nativeFileId128Hex === entry.preparedNativeFileId128Hex &&
      outcome.nativeVolumeSerial === entry.preparedNativeVolumeSerial
    native.closeLease(resO.value.lease)
    if (identityMatches) {
      // B5 - as-original matched: direct resolution, no native mutating call ever attempted.
      resolveEntryRolledBack(db, entry)
      return
    }
  }

  // B4 - neither probe matched.
  resolveEntryConflict(db, entry, 'NEITHER_PROBE_MATCHED')
}

function resolveModifyAsAppliedMatch(
  db: Database.Database,
  native: ApplyBatchRecoveryNativeDependencies,
  entry: ModifyEntrySnapshot,
  lease: unknown
): void {
  markBeforeMutatingCall(db, entry) // durable, committed BEFORE the reversing call below; entry is now ROLLBACK_ATTEMPTING
  const markedEntry: EntryIdentity = { id: entry.id, state: 'ROLLBACK_ATTEMPTING' }
  const resWrite = callNative(() => native.applyModify(lease, 0))
  native.closeLease(lease)
  if (resWrite.ok) {
    resolveEntryRolledBack(db, markedEntry)
  } else {
    resolveEntryConflict(db, markedEntry, `APPLY_MODIFY:UNEXPECTED_RESULT:${resWrite.code}`)
  }
}

// ---------------------------------------------------------------------------
// ROLLBACK mode - Case C (CREATE, state in {APPLIED, APPLY_ATTEMPTING, ROLLBACK_ATTEMPTING}).
// ---------------------------------------------------------------------------

function resolveCreateEntry(
  db: Database.Database,
  native: ApplyBatchRecoveryNativeDependencies,
  entry: CreateEntrySnapshot,
  batch: BatchSnapshot,
  rootLocator: RecoveryRootLocatorResult
): void {
  if (!rootLocator.ok) {
    resolveEntryConflict(db, entry, 'ROOT_LOCATOR:INVALID')
    return
  }

  // Evidence completeness check: all four entry fields plus both batch-root
  // fields, every one an explicit === null comparison, never a `!`
  // assertion. NOT structurally guaranteed at ROLLBACK_ATTEMPTING (only at
  // APPLIED) - a CREATE entry can legally sit at ROLLBACK_ATTEMPTING with
  // incomplete evidence, reached via a live, non-crash forward-execution
  // rollback whose own native call had already failed with no evidence ever
  // captured, then interrupted by a crash before the DB recorded
  // ROLLED_BACK/RECOVERY_CONFLICT.
  const { nativeFileId128Hex, nativeVolumeSerial, writtenSha256, writtenByteLength } = entry
  const { rootNativeFileId128Hex, rootNativeVolumeSerial } = batch
  if (
    nativeFileId128Hex === null ||
    nativeVolumeSerial === null ||
    writtenSha256 === null ||
    writtenByteLength === null ||
    rootNativeFileId128Hex === null ||
    rootNativeVolumeSerial === null
  ) {
    resolveEntryConflict(db, entry, 'CREATE:NO_DURABLE_EVIDENCE')
    return
  }

  markBeforeMutatingCall(db, entry) // durable, committed BEFORE the call below; entry is now ROLLBACK_ATTEMPTING
  const markedEntry: EntryIdentity = { id: entry.id, state: 'ROLLBACK_ATTEMPTING' }

  // Uses only the locally destructured, already-null-checked constants above
  // - no field of this request object is ever populated via a non-null assertion.
  const res = callNative(() =>
    native.recoverDeleteCreated({
      root: rootLocator.rootPath,
      relPath: entry.relPath,
      expectedRootVolumeSerial: rootNativeVolumeSerial,
      expectedRootFileId128Hex: rootNativeFileId128Hex,
      expectedVolumeSerial: nativeVolumeSerial,
      expectedFileId128Hex: nativeFileId128Hex,
      expectedSha256Hex: writtenSha256,
      expectedLength: writtenByteLength
    })
  )
  if (res.ok || (!res.ok && res.code === 'NOT_FOUND')) {
    // NOT_FOUND means the file is already gone (a prior, interrupted
    // recovery pass, or the live rollback in progress at crash time) -
    // idempotent, already at the pre-batch state, not an error.
    resolveEntryRolledBack(db, markedEntry)
  } else {
    resolveEntryConflict(db, markedEntry, `CREATE:UNEXPECTED_RESULT:${res.code}`)
  }
}

// ---------------------------------------------------------------------------
// ROLLBACK mode dispatcher - one entry.
// ---------------------------------------------------------------------------

function resolveEntryRollback(
  db: Database.Database,
  native: ApplyBatchRecoveryNativeDependencies,
  entry: EntrySnapshot,
  batch: BatchSnapshot,
  rootLocator: RecoveryRootLocatorResult
): void {
  if (entry.state === 'PENDING' || entry.state === 'PREPARED') {
    resolveNeverAttemptedEntry(db, entry)
    return
  }
  if (entry.mutationType === 'MODIFY') {
    resolveModifyEntry(db, native, entry, batch, rootLocator)
  } else {
    resolveCreateEntry(db, native, entry, batch, rootLocator)
  }
}

// ---------------------------------------------------------------------------
// CONFIRM mode - the "already fully finished" pass. Mutation-type-agnostic:
// resolves the whole batch in one native call, since prepareLease()'s
// Prepare() phase is a pure, read-only content/identity check regardless of
// how the file at that path was originally produced. Preconditions, checked
// in this order: (a) batch.preRecoveryState === 'APPLYING'; (b) every
// entry's current state === 'APPLIED'; (c) the root locator resolves. If any
// is false, CONFIRM mode is not attempted at all.
// ---------------------------------------------------------------------------

function finalizeBatchSucceeded(db: Database.Database, batch: BatchSnapshot): void {
  assertValidBatchTransition({ state: batch.state, preRecoveryState: batch.preRecoveryState }, 'SUCCEEDED')
  withFullDurability(db, () => {
    db.prepare(`UPDATE apply_batches SET state='SUCCEEDED', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(batch.id)
  })
}

function attemptConfirm(
  db: Database.Database,
  native: ApplyBatchRecoveryNativeDependencies,
  batch: BatchSnapshot,
  entries: EntrySnapshot[],
  rootPath: string
): boolean {
  if (entries.length === 0) {
    // An admitted batch with an empty mutation set - not forbidden by any CHECK. Trivially succeeds, zero native calls.
    finalizeBatchSucceeded(db, batch)
    return true
  }

  const modifies: WindowsSafeApplyModifyPlan[] = []
  for (const entry of entries) {
    // Mandatory-once-APPLIED evidence (007_apply_batches.ts) - every entry
    // here is already known APPLIED by attemptConfirm's caller, so this can
    // never actually be null; checked explicitly anyway rather than assumed.
    if (entry.writtenSha256 === null || entry.writtenByteLength === null) return false
    modifies.push({ path: entry.relPath, expectedSha256Hex: entry.writtenSha256, expectedLength: entry.writtenByteLength, proposedBytes: Buffer.alloc(0) })
  }

  const plan: WindowsSafeApplyPlan = { root: rootPath, modifies }
  const result = callNative(() => native.prepareLease(plan))
  if (!result.ok) return false

  const rootMatches =
    result.value.root.nativeFileId128Hex === batch.rootNativeFileId128Hex && result.value.root.nativeVolumeSerial === batch.rootNativeVolumeSerial
  const entriesMatch = entries.every((entry, i) => {
    const outcome = result.value.modifies[i]
    return outcome.nativeFileId128Hex === entry.nativeFileId128Hex && outcome.nativeVolumeSerial === entry.nativeVolumeSerial
  })
  native.closeLease(result.value.lease)

  if (!rootMatches || !entriesMatch) return false
  finalizeBatchSucceeded(db, batch)
  return true
}

// ---------------------------------------------------------------------------
// Batch-level ROLLBACK resolution.
// ---------------------------------------------------------------------------

function finalizeBatchRolledBack(db: Database.Database, batch: BatchSnapshot): void {
  assertValidBatchTransition({ state: batch.state, preRecoveryState: batch.preRecoveryState }, 'ROLLED_BACK')
  withFullDurability(db, () => {
    db.prepare(`UPDATE apply_batches SET state='ROLLED_BACK', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(batch.id)
  })
}

function finalizeBatchRecoveryConflict(db: Database.Database, batch: BatchSnapshot): void {
  assertValidBatchTransition({ state: batch.state, preRecoveryState: batch.preRecoveryState }, 'RECOVERY_CONFLICT')
  withFullDurability(db, () => {
    db.prepare(`UPDATE apply_batches SET state='RECOVERY_CONFLICT', completed_at=NULL WHERE id=?`).run(batch.id)
  })
}

/** Every entry is guaranteed ROLLED_BACK or RECOVERY_CONFLICT after ROLLBACK mode's loop (Case A/B/C's branches are exhaustive) - checked explicitly rather than cast, so a violated invariant fails loudly instead of silently mistyping a row. */
function toTerminalEntryState(state: ApplyBatchEntryState, entryId: number): 'ROLLED_BACK' | 'RECOVERY_CONFLICT' {
  if (state === 'ROLLED_BACK' || state === 'RECOVERY_CONFLICT') return state
  throw new Error(`invariant violated: entry ${entryId} is not terminal after ROLLBACK mode (state=${state})`)
}

// ---------------------------------------------------------------------------
// Public service.
// ---------------------------------------------------------------------------

function scanForUnresolvedBatches(db: Database.Database): number[] {
  const rows = db
    .prepare(`SELECT id FROM apply_batches WHERE state IN ('ADMITTED','PREPARED','APPLYING','ROLLING_BACK','RECOVERY_REQUIRED') ORDER BY id ASC`)
    .all() as Array<{ id: number }>
  return rows.map((r) => r.id)
}

/**
 * Full single-batch resolution. Throws ApplyBatchTransitionError (via
 * assertValidBatchTransition) if called directly on a batch not in
 * {ADMITTED,PREPARED,APPLYING,ROLLING_BACK,RECOVERY_REQUIRED} - in
 * particular, on a RECOVERY_CONFLICT/SUCCEEDED/ROLLED_BACK batch, by
 * construction (RECOVERY_CONFLICT batches are never automatically retried
 * or altered) - before any native call and before the root locator is ever
 * resolved.
 */
function recoverBatch(db: Database.Database, native: ApplyBatchRecoveryNativeDependencies, batchId: number): ApplyBatchRecoveryResult {
  let batch = readBatch(db, batchId)

  if (batch.state !== 'RECOVERY_REQUIRED') {
    assertValidBatchTransition({ state: batch.state, preRecoveryState: batch.preRecoveryState }, 'RECOVERY_REQUIRED')
    // The assert above already proved batch.state is one of exactly
    // ADMITTED/PREPARED/APPLYING/ROLLING_BACK (the only legal sources for
    // this transition besides RECOVERY_REQUIRED itself, which this branch excludes).
    const originState = batch.state as ApplyBatchRecoveryOriginState
    withFullDurability(db, () => {
      db.prepare(
        `UPDATE apply_batches SET state='RECOVERY_REQUIRED', pre_recovery_state=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`
      ).run(originState, batch.id)
    })
    batch = readBatch(db, batchId)
  }

  if (batch.preRecoveryState === null) {
    // Structurally unreachable: schema CHECK guarantees pre_recovery_state
    // NOT NULL once state='RECOVERY_REQUIRED' (007_apply_batches.ts).
    throw new Error(`invariant violated: batch ${batch.id} is RECOVERY_REQUIRED with a NULL pre_recovery_state`)
  }
  const preRecoveryState = batch.preRecoveryState

  const rootLocator = resolveRecoveryRootLocator(batch.authorizationJson)
  const entries = readEntries(db, batchId)

  let confirmed = false
  if (preRecoveryState === 'APPLYING' && entries.every((e) => e.state === 'APPLIED') && rootLocator.ok) {
    confirmed = attemptConfirm(db, native, batch, entries, rootLocator.rootPath)
  }

  if (confirmed) {
    return { batchId: batch.id, finalState: 'SUCCEEDED', preRecoveryState, entryOutcomes: [] }
  }

  // ROLLBACK mode. Resume rule: skip any entry already terminal-for-recovery
  // (ROLLED_BACK or RECOVERY_CONFLICT) from an earlier, interrupted pass.
  for (const entry of entries) {
    if (entry.state === 'ROLLED_BACK' || entry.state === 'RECOVERY_CONFLICT') continue
    resolveEntryRollback(db, native, entry, batch, rootLocator)
  }

  const finalEntries = readEntries(db, batchId)
  const allRolledBack = finalEntries.every((e) => e.state === 'ROLLED_BACK')
  if (allRolledBack) {
    finalizeBatchRolledBack(db, batch)
  } else {
    finalizeBatchRecoveryConflict(db, batch)
  }

  return {
    batchId: batch.id,
    finalState: allRolledBack ? 'ROLLED_BACK' : 'RECOVERY_CONFLICT',
    preRecoveryState,
    entryOutcomes: finalEntries.map((e) => ({
      entryId: e.id,
      ordinal: e.ordinal,
      finalState: toTerminalEntryState(e.state, e.id),
      failureReason: e.failureNote as ApplyBatchRecoveryFailureNote | null
    }))
  }
}

/**
 * scanForUnresolvedBatches() + recoverBatch() per id, id ASC. Does NOT catch
 * per-batch errors - every expected failure mode is already converted to a
 * RECOVERY_CONFLICT entry/batch outcome inside recoverBatch() itself via
 * callNative(); anything that still throws past that is a genuine bug or a
 * DB-layer failure, and this function lets it propagate rather than
 * silently skipping a batch, matching this codebase's fail-loud discipline
 * for DB/migration failures.
 */
function recoverAllUnresolvedBatches(db: Database.Database, native: ApplyBatchRecoveryNativeDependencies): ApplyBatchRecoveryResult[] {
  const ids = scanForUnresolvedBatches(db)
  return ids.map((id) => recoverBatch(db, native, id))
}

/**
 * Builds ONE ApplyBatchRecoveryService bound to the given trusted
 * dependencies. Mirrors applyAuthorityService.ts's/applyBatchJournalService.ts's
 * own factory shape. No dependency has a default - every one must be
 * supplied explicitly.
 */
export function createApplyBatchRecoveryService(deps: ApplyBatchRecoveryDependencies) {
  const { db, native } = deps
  return {
    scanForUnresolvedBatches: () => scanForUnresolvedBatches(db),
    recoverBatch: (batchId: number) => recoverBatch(db, native, batchId),
    recoverAllUnresolvedBatches: () => recoverAllUnresolvedBatches(db, native)
  }
}

export type ApplyBatchRecoveryService = ReturnType<typeof createApplyBatchRecoveryService>
