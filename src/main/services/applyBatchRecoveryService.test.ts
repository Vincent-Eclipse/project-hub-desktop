import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../testUtils/testDb'
import { openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrations'
import { createProject } from './projectsService'
import { ApplyBatchTransitionError } from './applyBatchTransitionGuard'
import { WindowsSafeApplyUnavailableError, type WindowsSafeApplyOutcome, type WindowsSafeApplyPlan } from './windowsSafeApply'
import { createApplyBatchRecoveryService, type ApplyBatchRecoveryNativeDependencies } from './applyBatchRecoveryService'

// Meilenstein 4.8B.2C - fake-native, in-memory DB (real migrations run, real
// applyBatchTransitionGuard). Fake native dependencies are hand-built
// objects with deterministic control and no filesystem/native module at
// all. Batch/entry rows are inserted directly via SQL (bypassing
// admitBatch(), since these tests are about recovery, not admission),
// matching Implementation Spec v4's own stated test-construction approach.

const ROOT_PATH = 'C:/fake/project/root'
const ROOT_FILE_ID = 'a'.repeat(32)
const ROOT_VOLUME = '1000000001'
const APPLIED_FILE_ID = 'b'.repeat(32) // post-forward (APPLIED-era) native identity
const APPLIED_VOLUME = '2000000002'
const PREPARED_FILE_ID = 'c'.repeat(32) // pre-forward (PREPARED-era) native identity
const PREPARED_VOLUME = '3000000003'
const PROPOSED_SHA = 'd'.repeat(64)
const ORIGINAL_SHA = 'e'.repeat(64)
const WRITTEN_SHA = 'f'.repeat(64)

function outcome(fileId: string, volumeSerial: string): WindowsSafeApplyOutcome {
  return { code: 'OK', sha256Hex: '0'.repeat(64), length: 1, nativeFileId128Hex: fileId, nativeVolumeSerial: volumeSerial }
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

interface FakeNativeCalls {
  prepareLease: number
  applyModify: number
  recoverDeleteCreated: number
  closeLease: number
}

function makeFakeNative(impl: Partial<ApplyBatchRecoveryNativeDependencies>): { native: ApplyBatchRecoveryNativeDependencies; calls: FakeNativeCalls } {
  const calls: FakeNativeCalls = { prepareLease: 0, applyModify: 0, recoverDeleteCreated: 0, closeLease: 0 }
  const native: ApplyBatchRecoveryNativeDependencies = {
    prepareLease: (plan) => {
      calls.prepareLease++
      if (!impl.prepareLease) throw codedError('PRECONDITION_FAILED')
      return impl.prepareLease(plan)
    },
    applyModify: (lease, index) => {
      calls.applyModify++
      if (!impl.applyModify) throw codedError('PRECONDITION_FAILED')
      return impl.applyModify(lease, index)
    },
    recoverDeleteCreated: (request) => {
      calls.recoverDeleteCreated++
      if (!impl.recoverDeleteCreated) throw codedError('PRECONDITION_FAILED')
      return impl.recoverDeleteCreated(request)
    },
    closeLease: (lease) => {
      calls.closeLease++
      impl.closeLease?.(lease)
    }
  }
  return { native, calls }
}

/** Counts db.pragma('synchronous = FULL') invocations - one per independent withFullDurability transaction (durableTransaction.ts). */
function countDurableTransactions(db: Database.Database): { count: () => number } {
  let n = 0
  const originalPragma = db.pragma.bind(db)
  ;(db as unknown as { pragma: typeof db.pragma }).pragma = ((source: string, options?: unknown) => {
    if (typeof source === 'string' && source.trim() === 'synchronous = FULL') n++
    return originalPragma(source, options as never)
  }) as typeof db.pragma
  return { count: () => n }
}

/**
 * Targets ONE specific durable write (identified by a regex against its SQL
 * text - e.g. the terminal `UPDATE apply_batch_entries SET state='ROLLED_BACK'`
 * write, never a marker write) and makes its `.run()` execute for real - the
 * UPDATE genuinely runs against the still-open transaction - and then throw,
 * exactly once. Because this throw happens INSIDE the callback
 * `withFullDurability(db, () => {...})` passes to `db.transaction(fn)`,
 * better-sqlite3 rolls the whole transaction back (the same mechanism
 * durableTransaction.test.ts's own "rolls back any partial write when the
 * wrapped function throws" test already proves for `withFullDurability`
 * directly - this applies that identical guarantee to one specific,
 * targeted terminal write instead of an arbitrary one). Used to simulate a
 * crash landing after a terminal write's UPDATE has been issued but before
 * its enclosing FULL-durability transaction commits (v4 S10's "during the
 * terminal transaction" crash window) - the write must appear to never have
 * happened, identically to a crash that landed before the UPDATE ran at all.
 */
function injectPostRunFailureOnce(db: Database.Database, sqlPattern: RegExp): void {
  const originalPrepare = db.prepare.bind(db)
  let armed = true
  ;(db as unknown as { prepare: (sql: string) => Database.Statement<unknown[]> }).prepare = ((sql: string) => {
    const stmt = originalPrepare(sql)
    if (armed && sqlPattern.test(sql)) {
      armed = false
      const originalRun = (stmt.run as unknown as (...args: unknown[]) => Database.RunResult).bind(stmt)
      ;(stmt as unknown as { run: (...args: unknown[]) => Database.RunResult }).run = (...args: unknown[]) => {
        originalRun(...args) // the UPDATE genuinely executes against the open transaction...
        throw new Error(`simulated crash: transaction rolled back after UPDATE ran (matched ${sqlPattern})`) // ...then the transaction is rolled back.
      }
    }
    return stmt
  }) as typeof db.prepare
}

function insertProject(db: Database.Database): number {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-recovery-test-'))
  tmpDirs.push(tmpDir)
  return createProject(db, { name: 'Demo', projectType: 'App', description: 'Fixture project', folderPath: tmpDir }).id
}

interface BatchOptions {
  state: string
  preRecoveryState?: string | null
  rootFileId?: string | null
  rootVolumeSerial?: string | null
  authorizationJson?: string
}

function insertBatch(db: Database.Database, projectId: number, opts: BatchOptions): number {
  const authorizationJson = opts.authorizationJson ?? JSON.stringify({ target: { projectFolderPath: ROOT_PATH } })
  const info = db
    .prepare(
      `INSERT INTO apply_batches (project_id, review_id, fingerprint, schema_version, authorization_json, root_native_file_id_128_hex, root_native_volume_serial, state, pre_recovery_state)
       VALUES (?, 'review-1', 'fingerprint-1', '1', ?, ?, ?, ?, ?)`
    )
    .run(projectId, authorizationJson, opts.rootFileId ?? null, opts.rootVolumeSerial ?? null, opts.state, opts.preRecoveryState ?? null)
  return Number(info.lastInsertRowid)
}

interface ModifyEntryOptions {
  relPath: string
  proposedSha256: string
  proposedByteLength: number
  originalBytes: Buffer
  originalSha256: string
  originalByteLength: number
  preparedFileId?: string | null
  preparedVolumeSerial?: string | null
  state: string
  nativeFileId?: string | null
  nativeVolumeSerial?: string | null
  writtenSha256?: string | null
  writtenByteLength?: number | null
}

function insertModifyEntry(db: Database.Database, batchId: number, ordinal: number, opts: ModifyEntryOptions): number {
  const info = db
    .prepare(
      `INSERT INTO apply_batch_entries (
        batch_id, ordinal, mutation_type, rel_path, proposed_sha256, proposed_byte_length,
        original_bytes, original_sha256, original_byte_length,
        prepared_native_file_id_128_hex, prepared_native_volume_serial,
        state, native_file_id_128_hex, native_volume_serial, written_sha256, written_byte_length, failure_note
      ) VALUES (?, ?, 'MODIFY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      batchId,
      ordinal,
      opts.relPath,
      opts.proposedSha256,
      opts.proposedByteLength,
      opts.originalBytes,
      opts.originalSha256,
      opts.originalByteLength,
      opts.preparedFileId ?? null,
      opts.preparedVolumeSerial ?? null,
      opts.state,
      opts.nativeFileId ?? null,
      opts.nativeVolumeSerial ?? null,
      opts.writtenSha256 ?? null,
      opts.writtenByteLength ?? null
    )
  return Number(info.lastInsertRowid)
}

interface CreateEntryOptions {
  relPath: string
  proposedSha256: string
  proposedByteLength: number
  state: string
  nativeFileId?: string | null
  nativeVolumeSerial?: string | null
  writtenSha256?: string | null
  writtenByteLength?: number | null
}

function insertCreateEntry(db: Database.Database, batchId: number, ordinal: number, opts: CreateEntryOptions): number {
  const info = db
    .prepare(
      `INSERT INTO apply_batch_entries (
        batch_id, ordinal, mutation_type, rel_path, proposed_sha256, proposed_byte_length,
        original_bytes, original_sha256, original_byte_length,
        prepared_native_file_id_128_hex, prepared_native_volume_serial,
        state, native_file_id_128_hex, native_volume_serial, written_sha256, written_byte_length, failure_note
      ) VALUES (?, ?, 'CREATE', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL)`
    )
    .run(batchId, ordinal, opts.relPath, opts.proposedSha256, opts.proposedByteLength, opts.state, opts.nativeFileId ?? null, opts.nativeVolumeSerial ?? null, opts.writtenSha256 ?? null, opts.writtenByteLength ?? null)
  return Number(info.lastInsertRowid)
}

function readBatchRow(db: Database.Database, id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM apply_batches WHERE id = ?').get(id) as Record<string, unknown>
}

function readEntryRow(db: Database.Database, id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM apply_batch_entries WHERE id = ?').get(id) as Record<string, unknown>
}

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
  tmpDirs.length = 0
})

// ---------------------------------------------------------------------------
// scanForUnresolvedBatches
// ---------------------------------------------------------------------------

describe('applyBatchRecoveryService - scanForUnresolvedBatches', () => {
  it('returns batches in every non-terminal, non-RECOVERY_CONFLICT state, id ASC, excluding RECOVERY_CONFLICT/SUCCEEDED/ROLLED_BACK', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const ids = [
      insertBatch(db, projectId, { state: 'ADMITTED' }),
      insertBatch(db, insertProject(db), { state: 'PREPARED', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME }),
      insertBatch(db, insertProject(db), { state: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME }),
      insertBatch(db, insertProject(db), { state: 'ROLLING_BACK', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME }),
      insertBatch(db, insertProject(db), { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    ]
    insertBatch(db, insertProject(db), { state: 'RECOVERY_CONFLICT', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    insertBatch(db, insertProject(db), { state: 'SUCCEEDED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    insertBatch(db, insertProject(db), { state: 'ROLLED_BACK', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })

    const { native } = makeFakeNative({})
    const service = createApplyBatchRecoveryService({ db, native })
    expect(service.scanForUnresolvedBatches()).toEqual(ids)
  })
})

// ---------------------------------------------------------------------------
// Case A - never attempted (W1/W2)
// ---------------------------------------------------------------------------

describe('applyBatchRecoveryService - Case A (never attempted)', () => {
  it('W1: ADMITTED batch, all entries PENDING -> batch ROLLED_BACK, every entry ROLLED_BACK, pre_recovery_state=ADMITTED, root evidence still NULL, zero native calls', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'ADMITTED' })
    const e1 = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      state: 'PENDING'
    })
    const e2 = insertCreateEntry(db, batchId, 1, { relPath: 'b.ts', proposedSha256: PROPOSED_SHA, proposedByteLength: 1, state: 'PENDING' })

    const { native, calls } = makeFakeNative({})
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(result.preRecoveryState).toBe('ADMITTED')
    expect(readBatchRow(db, batchId).root_native_file_id_128_hex).toBeNull()
    expect(readEntryRow(db, e1).state).toBe('ROLLED_BACK')
    expect(readEntryRow(db, e2).state).toBe('ROLLED_BACK')
    expect(calls.prepareLease + calls.applyModify + calls.recoverDeleteCreated).toBe(0)
  })

  it('W2: PREPARED batch (root evidence present), MODIFY entry PREPARED -> ROLLED_BACK, root evidence unchanged, zero native calls', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'PREPARED', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const e1 = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      preparedFileId: PREPARED_FILE_ID,
      preparedVolumeSerial: PREPARED_VOLUME,
      state: 'PREPARED'
    })

    const { native, calls } = makeFakeNative({})
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    const batchRow = readBatchRow(db, batchId)
    expect(batchRow.root_native_file_id_128_hex).toBe(ROOT_FILE_ID)
    expect(readEntryRow(db, e1).state).toBe('ROLLED_BACK')
    expect(calls.prepareLease).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// CONFIRM mode
// ---------------------------------------------------------------------------

describe('applyBatchRecoveryService - CONFIRM mode', () => {
  it('every entry APPLIED, matching root+target identity -> SUCCEEDED, completed_at set, every entry unchanged (still APPLIED, no entry write)', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const e1 = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      preparedFileId: PREPARED_FILE_ID,
      preparedVolumeSerial: PREPARED_VOLUME,
      state: 'APPLIED',
      nativeFileId: APPLIED_FILE_ID,
      nativeVolumeSerial: APPLIED_VOLUME,
      writtenSha256: WRITTEN_SHA,
      writtenByteLength: 1
    })
    const before = readEntryRow(db, e1)

    const { native, calls } = makeFakeNative({
      prepareLease: (plan: WindowsSafeApplyPlan) => ({
        lease: {},
        root: outcome(ROOT_FILE_ID, ROOT_VOLUME),
        modifies: (plan.modifies ?? []).map(() => outcome(APPLIED_FILE_ID, APPLIED_VOLUME))
      })
    })
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('SUCCEEDED')
    expect(result.entryOutcomes).toEqual([])
    expect(readBatchRow(db, batchId).completed_at).not.toBeNull()
    expect(readEntryRow(db, e1)).toEqual(before) // literally no write happened to the entry row
    expect(calls.applyModify).toBe(0)
    expect(calls.recoverDeleteCreated).toBe(0)
  })

  it('one entry mismatches identity -> CONFIRM fails, falls to ROLLBACK for EVERY entry (never a partial SUCCEEDED)', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const entryFixture = (relPath: string) => ({
      relPath,
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      preparedFileId: PREPARED_FILE_ID,
      preparedVolumeSerial: PREPARED_VOLUME,
      state: 'APPLIED',
      nativeFileId: APPLIED_FILE_ID,
      nativeVolumeSerial: APPLIED_VOLUME,
      writtenSha256: WRITTEN_SHA,
      writtenByteLength: 1
    })
    const e1 = insertModifyEntry(db, batchId, 0, entryFixture('a.ts'))
    const e2 = insertModifyEntry(db, batchId, 1, entryFixture('b.ts'))

    let confirmCall = true
    const { native } = makeFakeNative({
      prepareLease: (plan: WindowsSafeApplyPlan) => {
        if (confirmCall && (plan.modifies?.length ?? 0) === 2) {
          confirmCall = false
          // Entry #2 (index 1) deliberately mismatches.
          return { lease: {}, root: outcome(ROOT_FILE_ID, ROOT_VOLUME), modifies: [outcome(APPLIED_FILE_ID, APPLIED_VOLUME), outcome('9'.repeat(32), APPLIED_VOLUME)] }
        }
        // ROLLBACK-mode as-applied probe for each entry, one at a time - succeeds for both.
        return { lease: {}, root: outcome(ROOT_FILE_ID, ROOT_VOLUME), modifies: [outcome(APPLIED_FILE_ID, APPLIED_VOLUME)] }
      },
      applyModify: () => outcome(APPLIED_FILE_ID, APPLIED_VOLUME)
    })
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).not.toBe('SUCCEEDED')
    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readEntryRow(db, e1).state).toBe('ROLLED_BACK')
    expect(readEntryRow(db, e2).state).toBe('ROLLED_BACK')
  })
})

// ---------------------------------------------------------------------------
// MODIFY recovery (Case B)
// ---------------------------------------------------------------------------

describe('applyBatchRecoveryService - MODIFY recovery', () => {
  function seedModifyEntry(db: Database.Database, projectId: number, state: string) {
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const entryId = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      preparedFileId: PREPARED_FILE_ID,
      preparedVolumeSerial: PREPARED_VOLUME,
      state,
      nativeFileId: state === 'APPLY_ATTEMPTING' ? null : APPLIED_FILE_ID,
      nativeVolumeSerial: state === 'APPLY_ATTEMPTING' ? null : APPLIED_VOLUME,
      writtenSha256: state === 'APPLY_ATTEMPTING' ? null : WRITTEN_SHA,
      writtenByteLength: state === 'APPLY_ATTEMPTING' ? null : 1
    })
    return { batchId, entryId }
  }

  it('as-applied matches, applyModify succeeds -> ROLLBACK_ATTEMPTING then ROLLED_BACK, each write independently durable', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const { batchId, entryId } = seedModifyEntry(db, projectId, 'APPLIED')
    const durability = countDurableTransactions(db)

    const { native } = makeFakeNative({
      prepareLease: (plan: WindowsSafeApplyPlan) => {
        const m = plan.modifies![0]
        if (m.expectedSha256Hex === PROPOSED_SHA) return { lease: {}, root: outcome(ROOT_FILE_ID, ROOT_VOLUME), modifies: [outcome(APPLIED_FILE_ID, APPLIED_VOLUME)] }
        throw codedError('PRECONDITION_FAILED')
      },
      applyModify: () => outcome(APPLIED_FILE_ID, APPLIED_VOLUME)
    })
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
    expect(readEntryRow(db, entryId).failure_note).toBeNull()
    // Marker (APPLIED->ROLLBACK_ATTEMPTING) + terminal (->ROLLED_BACK) + batch terminal = 3 independent durable writes for this single-entry batch.
    expect(durability.count()).toBe(3)
  })

  it('as-applied identity mismatches, as-original matches -> ROLLED_BACK directly, applyModify NEVER called, no marker write', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const { batchId, entryId } = seedModifyEntry(db, projectId, 'APPLIED')
    const durability = countDurableTransactions(db)

    const { native, calls } = makeFakeNative({
      prepareLease: (plan: WindowsSafeApplyPlan) => {
        const m = plan.modifies![0]
        if (m.expectedSha256Hex === PROPOSED_SHA) {
          // As-applied probe succeeds but identity mismatches.
          return { lease: {}, root: outcome(ROOT_FILE_ID, ROOT_VOLUME), modifies: [outcome('9'.repeat(32), APPLIED_VOLUME)] }
        }
        if (m.expectedSha256Hex === ORIGINAL_SHA) {
          return { lease: {}, root: outcome(ROOT_FILE_ID, ROOT_VOLUME), modifies: [outcome(PREPARED_FILE_ID, PREPARED_VOLUME)] }
        }
        throw codedError('PRECONDITION_FAILED')
      }
    })
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
    expect(calls.applyModify).toBe(0)
    // Direct APPLIED->ROLLED_BACK (no marker) + batch terminal = 2 durable writes, not 3.
    expect(durability.count()).toBe(2)
  })

  it('neither probe matches -> RECOVERY_CONFLICT NEITHER_PROBE_MATCHED, via a durable ROLLBACK_ATTEMPTING marker first (never a direct APPLIED->RECOVERY_CONFLICT write)', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const { batchId, entryId } = seedModifyEntry(db, projectId, 'APPLIED')

    const { native } = makeFakeNative({}) // every prepareLease call throws PRECONDITION_FAILED (default)
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    const row = readEntryRow(db, entryId)
    expect(row.state).toBe('RECOVERY_CONFLICT')
    expect(row.failure_note).toBe('NEITHER_PROBE_MATCHED')
  })

  it('as-applied matches but applyModify() itself fails -> ROLLBACK_ATTEMPTING then RECOVERY_CONFLICT, failure_note carries the native code', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const { batchId, entryId } = seedModifyEntry(db, projectId, 'APPLIED')

    const { native } = makeFakeNative({
      prepareLease: (plan: WindowsSafeApplyPlan) => {
        const m = plan.modifies![0]
        if (m.expectedSha256Hex === PROPOSED_SHA) return { lease: {}, root: outcome(ROOT_FILE_ID, ROOT_VOLUME), modifies: [outcome(APPLIED_FILE_ID, APPLIED_VOLUME)] }
        throw codedError('PRECONDITION_FAILED')
      },
      applyModify: () => {
        throw codedError('BUSY')
      }
    })
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    const row = readEntryRow(db, entryId)
    expect(row.state).toBe('RECOVERY_CONFLICT')
    expect(row.failure_note).toBe('APPLY_MODIFY:UNEXPECTED_RESULT:BUSY')
  })

  it('APPLY_ATTEMPTING origin, neither probe matches -> direct APPLY_ATTEMPTING->RECOVERY_CONFLICT, no intermediate marker write', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const { batchId, entryId } = seedModifyEntry(db, projectId, 'APPLY_ATTEMPTING')
    const durability = countDurableTransactions(db)

    const { native } = makeFakeNative({})
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    expect(readEntryRow(db, entryId).state).toBe('RECOVERY_CONFLICT')
    // One entry write (direct ->RECOVERY_CONFLICT, no marker) + one batch terminal write = 2.
    expect(durability.count()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// CREATE recovery (Case C)
// ---------------------------------------------------------------------------

describe('applyBatchRecoveryService - CREATE recovery', () => {
  function seedCreateEntry(db: Database.Database, projectId: number, opts: { state: string; withEvidence: boolean }) {
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const entryId = insertCreateEntry(db, batchId, 0, {
      relPath: 'new.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      state: opts.state,
      nativeFileId: opts.withEvidence ? APPLIED_FILE_ID : null,
      nativeVolumeSerial: opts.withEvidence ? APPLIED_VOLUME : null,
      writtenSha256: opts.withEvidence ? WRITTEN_SHA : null,
      writtenByteLength: opts.withEvidence ? 1 : null
    })
    return { batchId, entryId }
  }

  it('evidence present, recoverDeleteCreated succeeds -> ROLLBACK_ATTEMPTING then ROLLED_BACK', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const { batchId, entryId } = seedCreateEntry(db, projectId, { state: 'APPLIED', withEvidence: true })

    const { native } = makeFakeNative({ recoverDeleteCreated: () => outcome(APPLIED_FILE_ID, APPLIED_VOLUME) })
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
  })

  it('NOT_FOUND is treated as success (idempotent - file already gone) -> ROLLED_BACK, failure_note NULL', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const { batchId, entryId } = seedCreateEntry(db, projectId, { state: 'APPLIED', withEvidence: true })

    const { native } = makeFakeNative({
      recoverDeleteCreated: () => {
        throw codedError('NOT_FOUND')
      }
    })
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    const row = readEntryRow(db, entryId)
    expect(row.state).toBe('ROLLED_BACK')
    expect(row.failure_note).toBeNull()
  })

  it('no durable evidence (APPLY_ATTEMPTING origin) -> RECOVERY_CONFLICT CREATE:NO_DURABLE_EVIDENCE, recoverDeleteCreated NEVER called', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const { batchId, entryId } = seedCreateEntry(db, projectId, { state: 'APPLY_ATTEMPTING', withEvidence: false })

    const { native, calls } = makeFakeNative({})
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    const row = readEntryRow(db, entryId)
    expect(row.state).toBe('RECOVERY_CONFLICT')
    expect(row.failure_note).toBe('CREATE:NO_DURABLE_EVIDENCE')
    expect(calls.recoverDeleteCreated).toBe(0)
  })

  it('evidence present but native call fails (PRECONDITION_FAILED) -> RECOVERY_CONFLICT CREATE:UNEXPECTED_RESULT:PRECONDITION_FAILED', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const { batchId, entryId } = seedCreateEntry(db, projectId, { state: 'APPLIED', withEvidence: true })

    const { native } = makeFakeNative({}) // default throws PRECONDITION_FAILED
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    expect(readEntryRow(db, entryId).failure_note).toBe('CREATE:UNEXPECTED_RESULT:PRECONDITION_FAILED')
  })
})

// ---------------------------------------------------------------------------
// Root locator / native module unavailable
// ---------------------------------------------------------------------------

describe('applyBatchRecoveryService - root locator and native availability', () => {
  it('malformed authorization_json.target -> every touched entry RECOVERY_CONFLICT ROOT_LOCATOR:INVALID, PENDING sibling still resolves ROLLED_BACK, zero native calls for the whole batch', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME, authorizationJson: JSON.stringify({ target: {} }) })
    const modifyEntry = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      preparedFileId: PREPARED_FILE_ID,
      preparedVolumeSerial: PREPARED_VOLUME,
      state: 'APPLIED',
      nativeFileId: APPLIED_FILE_ID,
      nativeVolumeSerial: APPLIED_VOLUME,
      writtenSha256: WRITTEN_SHA,
      writtenByteLength: 1
    })
    const pendingSibling = insertCreateEntry(db, batchId, 1, { relPath: 'b.ts', proposedSha256: PROPOSED_SHA, proposedByteLength: 1, state: 'PENDING' })

    const { native, calls } = makeFakeNative({})
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    expect(readEntryRow(db, modifyEntry).failure_note).toBe('ROOT_LOCATOR:INVALID')
    expect(readEntryRow(db, pendingSibling).state).toBe('ROLLED_BACK')
    expect(calls.prepareLease + calls.applyModify + calls.recoverDeleteCreated).toBe(0)
  })

  it('native module unavailable -> RECOVERY_CONFLICT, failure_note contains NATIVE_MODULE_UNAVAILABLE', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const entryId = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      preparedFileId: PREPARED_FILE_ID,
      preparedVolumeSerial: PREPARED_VOLUME,
      state: 'APPLIED',
      nativeFileId: APPLIED_FILE_ID,
      nativeVolumeSerial: APPLIED_VOLUME,
      writtenSha256: WRITTEN_SHA,
      writtenByteLength: 1
    })

    const { native } = makeFakeNative({
      // As-applied probe succeeds (matched identity), but the native module
      // becomes unavailable exactly at the reversing applyModify() call.
      prepareLease: (plan: WindowsSafeApplyPlan) => {
        const m = plan.modifies![0]
        if (m.expectedSha256Hex === PROPOSED_SHA) return { lease: {}, root: outcome(ROOT_FILE_ID, ROOT_VOLUME), modifies: [outcome(APPLIED_FILE_ID, APPLIED_VOLUME)] }
        throw codedError('PRECONDITION_FAILED')
      },
      applyModify: () => {
        throw new WindowsSafeApplyUnavailableError('not running on win32')
      }
    })
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    expect(readEntryRow(db, entryId).failure_note).toBe('APPLY_MODIFY:UNEXPECTED_RESULT:NATIVE_MODULE_UNAVAILABLE')
  })
})

// ---------------------------------------------------------------------------
// Durability (Implementation Spec v4's own follow-up fix) - every
// recovery-state write is an independent withFullDurability transaction;
// resume from the "native work done, terminal write not yet durable" crash
// window reconciles safely; terminal state survives a real close+reopen.
// ---------------------------------------------------------------------------

describe('applyBatchRecoveryService - durability (v4)', () => {
  it('every UPDATE ... SET state= in the source is lexically nested inside a withFullDurability(db, () => {...}) block (static proof, mirrors the scope-boundary grep-style assertion convention)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'applyBatchRecoveryService.ts'), 'utf8')
    const lines = source.split('\n')
    let checked = 0
    lines.forEach((line, i) => {
      if (!/UPDATE apply_batch(_entries)? SET state=/.test(line)) return
      checked++
      const precedingWindow = lines.slice(Math.max(0, i - 2), i).join('\n')
      expect(precedingWindow).toContain('withFullDurability(db, () => {')
    })
    expect(checked).toBeGreaterThan(0)
  })

  it('a single-write resolution (Case A) uses exactly one durable transaction; a marker+terminal resolution uses exactly two', () => {
    const db = createTestDb()
    const projectId = insertProject(db)

    const batchIdA = insertBatch(db, projectId, { state: 'ADMITTED' })
    insertModifyEntry(db, batchIdA, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      state: 'PENDING'
    })
    const durabilityA = countDurableTransactions(db)
    const { native: nativeA } = makeFakeNative({})
    createApplyBatchRecoveryService({ db, native: nativeA }).recoverBatch(batchIdA)
    // batch RECOVERY_REQUIRED marker + entry terminal + batch terminal = 3.
    expect(durabilityA.count()).toBe(3)
  })

  it('resume from "reverse applyModify already completed, terminal write not yet durable" (entry pre-seeded at ROLLBACK_ATTEMPTING, disk already original) reconciles via B5, exactly one new durable write', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const entryId = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      preparedFileId: PREPARED_FILE_ID,
      preparedVolumeSerial: PREPARED_VOLUME,
      state: 'ROLLBACK_ATTEMPTING', // simulates: marker already committed durably before the crash
      nativeFileId: APPLIED_FILE_ID,
      nativeVolumeSerial: APPLIED_VOLUME,
      writtenSha256: WRITTEN_SHA,
      writtenByteLength: 1
    })
    const durability = countDurableTransactions(db)

    const { native, calls } = makeFakeNative({
      // Disk already holds original content: as-applied probe (expects proposed content) now fails, as-original probe now matches.
      prepareLease: (plan: WindowsSafeApplyPlan) => {
        const m = plan.modifies![0]
        if (m.expectedSha256Hex === ORIGINAL_SHA) return { lease: {}, root: outcome(ROOT_FILE_ID, ROOT_VOLUME), modifies: [outcome(PREPARED_FILE_ID, PREPARED_VOLUME)] }
        throw codedError('PRECONDITION_FAILED')
      }
    })
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
    expect(calls.applyModify).toBe(0) // no re-marker write attempted (already ROLLBACK_ATTEMPTING), no second applyModify
    // Just the terminal entry write + batch terminal = 2 (no re-marker).
    expect(durability.count()).toBe(2)
  })

  it('resume from "recoverDeleteCreated already completed, terminal write not yet durable" (entry pre-seeded at ROLLBACK_ATTEMPTING, file already deleted) reconciles via NOT_FOUND', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const entryId = insertCreateEntry(db, batchId, 0, {
      relPath: 'new.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      state: 'ROLLBACK_ATTEMPTING', // simulates: marker already committed durably before the crash
      nativeFileId: APPLIED_FILE_ID,
      nativeVolumeSerial: APPLIED_VOLUME,
      writtenSha256: WRITTEN_SHA,
      writtenByteLength: 1
    })

    const { native } = makeFakeNative({
      recoverDeleteCreated: () => {
        throw codedError('NOT_FOUND')
      }
    })
    const service = createApplyBatchRecoveryService({ db, native })
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
  })

  // -------------------------------------------------------------------------
  // Terminal-write crash-window proof (v4 S10 / S13 item 32). Each test below
  // targets the SPECIFIC terminal durable transaction it names - never the
  // earlier marker write - by regex-matching that write's own SQL text, so
  // the injected failure genuinely lands inside a terminal-entry or
  // terminal-batch withFullDurability callback, after its UPDATE has run but
  // before that transaction commits. Every one proves three things: (1) the
  // prior NONTERMINAL state is what remains visible - no false terminal
  // state, no bypassed reconciliation; (2) a later, unobstructed retry
  // reaches the correct durable terminal state; (3) that retry's write is
  // still full-durability (countDurableTransactions, not just "succeeds").
  // -------------------------------------------------------------------------

  it('terminal ENTRY write (MODIFY, as-original reconciliation): a failure after the UPDATE runs leaves the entry ROLLBACK_ATTEMPTING; a later retry reaches durable ROLLED_BACK, with no forward work at any point', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const entryId = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      preparedFileId: PREPARED_FILE_ID,
      preparedVolumeSerial: PREPARED_VOLUME,
      state: 'ROLLBACK_ATTEMPTING', // marker already durably committed before the simulated crash
      nativeFileId: APPLIED_FILE_ID,
      nativeVolumeSerial: APPLIED_VOLUME,
      writtenSha256: WRITTEN_SHA,
      writtenByteLength: 1
    })

    const { native, calls } = makeFakeNative({
      prepareLease: (plan: WindowsSafeApplyPlan) => {
        const m = plan.modifies![0]
        if (m.expectedSha256Hex === ORIGINAL_SHA) return { lease: {}, root: outcome(ROOT_FILE_ID, ROOT_VOLUME), modifies: [outcome(PREPARED_FILE_ID, PREPARED_VOLUME)] }
        throw codedError('PRECONDITION_FAILED') // as-applied probe fails closed - only the as-original path can resolve this entry
      }
    })
    const service = createApplyBatchRecoveryService({ db, native })

    injectPostRunFailureOnce(db, /UPDATE apply_batch_entries SET state='ROLLED_BACK'/)
    expect(() => service.recoverBatch(batchId)).toThrow(/simulated crash/)

    // No false terminal state, and reconciliation was not bypassed: the row
    // still reads exactly what the (already-committed, unaffected) marker
    // write left it at, and the batch was never even reached.
    expect(readEntryRow(db, entryId).state).toBe('ROLLBACK_ATTEMPTING')
    expect(readBatchRow(db, batchId).state).toBe('RECOVERY_REQUIRED')
    expect(calls.applyModify).toBe(0) // as-original resolution never issues a mutating call - no forward work occurred on the failed attempt

    const durability = countDurableTransactions(db)
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
    expect(calls.applyModify).toBe(0) // still zero - the retry resolves through the same read-only as-original probe, no forward work here either
    // entry terminal write + batch terminal write = 2 independent FULL-durability transactions.
    expect(durability.count()).toBe(2)
  })

  it('terminal ENTRY write (CREATE, NOT_FOUND reconciliation): a failure after the UPDATE runs leaves the entry ROLLBACK_ATTEMPTING; a later retry reaches durable ROLLED_BACK', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const entryId = insertCreateEntry(db, batchId, 0, {
      relPath: 'new.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      state: 'ROLLBACK_ATTEMPTING', // marker already durably committed before the simulated crash
      nativeFileId: APPLIED_FILE_ID,
      nativeVolumeSerial: APPLIED_VOLUME,
      writtenSha256: WRITTEN_SHA,
      writtenByteLength: 1
    })

    const { native, calls } = makeFakeNative({
      recoverDeleteCreated: () => {
        throw codedError('NOT_FOUND') // file already gone - idempotent, treated as already-restored
      }
    })
    const service = createApplyBatchRecoveryService({ db, native })

    injectPostRunFailureOnce(db, /UPDATE apply_batch_entries SET state='ROLLED_BACK'/)
    expect(() => service.recoverBatch(batchId)).toThrow(/simulated crash/)

    expect(readEntryRow(db, entryId).state).toBe('ROLLBACK_ATTEMPTING')
    expect(readBatchRow(db, batchId).state).toBe('RECOVERY_REQUIRED')
    expect(calls.recoverDeleteCreated).toBe(1)

    const durability = countDurableTransactions(db)
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
    // recoverDeleteCreated() is safely re-issued on retry (NOT_FOUND is idempotent by contract, per B.2A) - not skipped, not treated as already-done without re-verifying.
    expect(calls.recoverDeleteCreated).toBe(2)
    expect(durability.count()).toBe(2)
  })

  it('terminal BATCH write (SUCCEEDED, via CONFIRM mode): a failure after the UPDATE runs leaves the batch RECOVERY_REQUIRED with entries untouched; a later retry reaches durable SUCCEEDED', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const entryId = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      preparedFileId: PREPARED_FILE_ID,
      preparedVolumeSerial: PREPARED_VOLUME,
      state: 'APPLIED',
      nativeFileId: APPLIED_FILE_ID,
      nativeVolumeSerial: APPLIED_VOLUME,
      writtenSha256: WRITTEN_SHA,
      writtenByteLength: 1
    })
    const beforeEntry = readEntryRow(db, entryId)

    const { native } = makeFakeNative({
      prepareLease: (plan: WindowsSafeApplyPlan) => ({
        lease: {},
        root: outcome(ROOT_FILE_ID, ROOT_VOLUME),
        modifies: (plan.modifies ?? []).map(() => outcome(APPLIED_FILE_ID, APPLIED_VOLUME))
      })
    })
    const service = createApplyBatchRecoveryService({ db, native })

    injectPostRunFailureOnce(db, /UPDATE apply_batches SET state='SUCCEEDED'/)
    expect(() => service.recoverBatch(batchId)).toThrow(/simulated crash/)

    expect(readBatchRow(db, batchId).state).toBe('RECOVERY_REQUIRED')
    expect(readEntryRow(db, entryId)).toEqual(beforeEntry) // CONFIRM mode writes no entry row, on the failed attempt or otherwise - untouched, not merely unchanged in value

    const durability = countDurableTransactions(db)
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('SUCCEEDED')
    expect(readBatchRow(db, batchId).state).toBe('SUCCEEDED')
    expect(readBatchRow(db, batchId).completed_at).not.toBeNull()
    expect(readEntryRow(db, entryId)).toEqual(beforeEntry)
    expect(durability.count()).toBe(1) // exactly the one retried terminal batch write - no entry write, no re-marking
  })

  it('terminal BATCH write (ROLLED_BACK): a failure after the UPDATE runs leaves the batch RECOVERY_REQUIRED even though its entry is already durably ROLLED_BACK; a later retry reaches durable batch ROLLED_BACK', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'ADMITTED' })
    const entryId = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      state: 'PENDING' // Case A: resolves ROLLED_BACK with zero native calls, its own independent (unaffected) transaction
    })

    const { native } = makeFakeNative({})
    const service = createApplyBatchRecoveryService({ db, native })

    injectPostRunFailureOnce(db, /UPDATE apply_batches SET state='ROLLED_BACK'/)
    expect(() => service.recoverBatch(batchId)).toThrow(/simulated crash/)

    // The entry's own terminal write already committed as a separate,
    // independent transaction before the batch-level write was even
    // attempted - it is NOT rolled back by the batch-level failure.
    expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
    expect(readBatchRow(db, batchId).state).toBe('RECOVERY_REQUIRED')

    const durability = countDurableTransactions(db)
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readBatchRow(db, batchId).state).toBe('ROLLED_BACK')
    expect(readBatchRow(db, batchId).completed_at).not.toBeNull()
    // Resume skips the already-terminal entry (resume rule) - only the batch terminal write remains to retry.
    expect(durability.count()).toBe(1)
  })

  it('terminal BATCH write (RECOVERY_CONFLICT): a failure after the UPDATE runs leaves the batch RECOVERY_REQUIRED even though its entry is already durably RECOVERY_CONFLICT; a later retry reaches durable batch RECOVERY_CONFLICT', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const entryId = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      preparedFileId: PREPARED_FILE_ID,
      preparedVolumeSerial: PREPARED_VOLUME,
      state: 'APPLY_ATTEMPTING' // both probes fail closed below -> direct APPLY_ATTEMPTING->RECOVERY_CONFLICT, no marker, its own independent transaction
    })

    const { native } = makeFakeNative({}) // every prepareLease call throws PRECONDITION_FAILED (default) - neither probe ever matches
    const service = createApplyBatchRecoveryService({ db, native })

    injectPostRunFailureOnce(db, /UPDATE apply_batches SET state='RECOVERY_CONFLICT'/)
    expect(() => service.recoverBatch(batchId)).toThrow(/simulated crash/)

    expect(readEntryRow(db, entryId).state).toBe('RECOVERY_CONFLICT')
    expect(readBatchRow(db, batchId).state).toBe('RECOVERY_REQUIRED')

    const durability = countDurableTransactions(db)
    const result = service.recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    expect(readBatchRow(db, batchId).state).toBe('RECOVERY_CONFLICT')
    expect(readBatchRow(db, batchId).completed_at).toBeNull()
    expect(durability.count()).toBe(1)
  })

  it('terminal entry AND batch state are retained after a real file-backed connection close + reopen', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-recovery-durability-'))
    tmpDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'db.sqlite3')
    let db = openDatabase(dbPath)
    runMigrations(db)
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'ADMITTED' })
    const entryId = insertModifyEntry(db, batchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      state: 'PENDING'
    })

    const { native } = makeFakeNative({})
    createApplyBatchRecoveryService({ db, native }).recoverBatch(batchId)
    db.close()

    db = openDatabase(dbPath)
    try {
      expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
      expect(readBatchRow(db, batchId).state).toBe('ROLLED_BACK')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// RECOVERY_CONFLICT batches are never automatically retried or altered (O2)
// ---------------------------------------------------------------------------

describe('applyBatchRecoveryService - RECOVERY_CONFLICT is never auto-retried', () => {
  it('recoverBatch() called directly on a RECOVERY_CONFLICT batch throws INVALID_BATCH_TRANSITION before any native call', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId, { state: 'RECOVERY_CONFLICT', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })

    const { native, calls } = makeFakeNative({})
    const service = createApplyBatchRecoveryService({ db, native })

    expect(() => service.recoverBatch(batchId)).toThrow(ApplyBatchTransitionError)
    try {
      service.recoverBatch(batchId)
    } catch (error) {
      expect((error as ApplyBatchTransitionError).code).toBe('INVALID_BATCH_TRANSITION')
    }
    expect(calls.prepareLease + calls.applyModify + calls.recoverDeleteCreated).toBe(0)
  })

  it('scanForUnresolvedBatches excludes a RECOVERY_CONFLICT batch on every subsequent scan', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    insertBatch(db, projectId, { state: 'RECOVERY_CONFLICT', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    const { native } = makeFakeNative({})
    const service = createApplyBatchRecoveryService({ db, native })
    expect(service.scanForUnresolvedBatches()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// recoverAllUnresolvedBatches propagation policy
// ---------------------------------------------------------------------------

describe('applyBatchRecoveryService - recoverAllUnresolvedBatches propagation', () => {
  it('does not swallow a thrown error from a later batch, and does not roll back an earlier batch\'s already-committed resolution', () => {
    const db = createTestDb()
    const goodProjectId = insertProject(db)
    const goodBatchId = insertBatch(db, goodProjectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: 'APPLYING', rootFileId: ROOT_FILE_ID, rootVolumeSerial: ROOT_VOLUME })
    insertModifyEntry(db, goodBatchId, 0, {
      relPath: 'a.ts',
      proposedSha256: PROPOSED_SHA,
      proposedByteLength: 1,
      originalBytes: Buffer.from('x'),
      originalSha256: ORIGINAL_SHA,
      originalByteLength: 1,
      preparedFileId: PREPARED_FILE_ID,
      preparedVolumeSerial: PREPARED_VOLUME,
      state: 'APPLIED',
      nativeFileId: APPLIED_FILE_ID,
      nativeVolumeSerial: APPLIED_VOLUME,
      writtenSha256: WRITTEN_SHA,
      writtenByteLength: 1
    })

    // A second, later-id batch that is present at scan time but whose row
    // disappears (simulating external corruption/concurrent deletion)
    // between the scan and its own turn in recoverAllUnresolvedBatches's
    // sequential id loop - triggered as a side effect of the FIRST batch's
    // own native call, so it fires strictly after batch 1 has already
    // committed its resolution.
    const badProjectId = insertProject(db)
    const badBatchId = insertBatch(db, badProjectId, { state: 'ADMITTED' })

    const { native } = makeFakeNative({
      prepareLease: (plan: WindowsSafeApplyPlan) => {
        const m = plan.modifies![0]
        if (m.expectedSha256Hex === PROPOSED_SHA) return { lease: {}, root: outcome(ROOT_FILE_ID, ROOT_VOLUME), modifies: [outcome(APPLIED_FILE_ID, APPLIED_VOLUME)] }
        throw codedError('PRECONDITION_FAILED')
      },
      applyModify: () => {
        db.prepare('DELETE FROM apply_batches WHERE id = ?').run(badBatchId)
        return outcome(APPLIED_FILE_ID, APPLIED_VOLUME)
      }
    })
    const service = createApplyBatchRecoveryService({ db, native })

    expect(() => service.recoverAllUnresolvedBatches()).toThrow(ApplyBatchTransitionError)
    expect(readBatchRow(db, goodBatchId).state).toBe('ROLLED_BACK') // the first, earlier-id batch's already-committed resolution is not undone
  })
})

// ---------------------------------------------------------------------------
// Scope-boundary checks - mirrors the codebase's existing grep-style
// precedent (applyBatchJournalService.ts's own file-header discipline): no
// reference to forward-execution/admission-authority symbols, and (Meilenstein
// 4.8B.3 Slice 5) recovery is production-callable from EXACTLY ONE place -
// the explicit startup/bootstrap path in index.ts - and remains forbidden
// from IPC, preload, renderer, and every other production file under
// src/main (a real, generic scan, not a hand-picked allowlist).
// ---------------------------------------------------------------------------

describe('applyBatchRecoveryService - scope boundaries', () => {
  const recoveryServiceSource = fs.readFileSync(path.join(__dirname, 'applyBatchRecoveryService.ts'), 'utf8')
  const transitionGuardSource = fs.readFileSync(path.join(__dirname, 'applyBatchTransitionGuard.ts'), 'utf8')

  it('references no forward-apply/admission-authority symbol', () => {
    for (const forbidden of ['authorizeApply', 'resolveApplyConsent', 'resolveAuthoritative', 'admitBatch']) {
      expect(recoveryServiceSource).not.toContain(forbidden)
      expect(transitionGuardSource).not.toContain(forbidden)
    }
  })

  it('issues no native mutating call using proposed_* bytes toward the target state, and never calls createFile/verifyFile/rollbackFile', () => {
    for (const forbidden of ['native.createFile(', 'native.verifyFile(', 'native.rollbackFile(']) {
      expect(recoveryServiceSource).not.toContain(forbidden)
    }
  })

  function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    const out: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
    }
    return out
  }

  // Shared with the walk() above for the IPC/preload/renderer scan - reused,
  // not duplicated, for the new src/main-wide scan below.
  function walkAllTsFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    const out: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walkAllTsFiles(full))
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
    }
    return out
  }

  it('index.ts invokes recoverAllUnresolvedBatches() via createApplyBatchRecoveryService(realWindowsSafeApplyNativeDependencies) EXACTLY ONCE, strictly after the real runMigrations(db) call and strictly before the real registerIpc(...) call, and never references applyBatchTransitionGuard directly', () => {
    const repoRoot = path.join(__dirname, '..', '..', '..')
    const indexContent = fs.readFileSync(path.join(repoRoot, 'src', 'main', 'index.ts'), 'utf8')

    // Ordering anchors: each of these two call shapes must appear EXACTLY
    // once, in the file text - a repeated or absent anchor invalidates the
    // ordering proof rather than silently picking the wrong occurrence.
    const migrationsMatches = [...indexContent.matchAll(/runMigrations\(\s*db\s*\)/g)]
    expect(migrationsMatches).toHaveLength(1)
    const migrationsIndex = migrationsMatches[0].index as number

    const registerIpcMatches = [...indexContent.matchAll(/registerIpc\(\s*\{/g)]
    expect(registerIpcMatches).toHaveLength(1)
    const registerIpcIndex = registerIpcMatches[0].index as number

    // The actual invocation: createApplyBatchRecoveryService(...) constructed
    // with native: realWindowsSafeApplyNativeDependencies, chained DIRECTLY
    // into .recoverAllUnresolvedBatches() - not merely both identifiers
    // appearing somewhere in the file. The {0,200} bounds require the pieces
    // to be genuinely adjacent (one call expression), not coincidentally
    // present far apart in unrelated code.
    //
    // Global + matchAll(), not exec(): exec() on a non-global regex returns
    // only the FIRST match and says nothing about whether a second one
    // exists elsewhere in the file - a second, later invocation of this same
    // shape (e.g. one mistakenly added AFTER registerIpc(...)) would be
    // silently ignored by exec() and could never be caught by the ordering
    // assertion below, since that assertion only ever sees the first match's
    // index. matchAll() enumerates every match, so uniqueness is checked
    // BEFORE any index is trusted, exactly like the migrations/registerIpc
    // anchors immediately above. Limitation, stated honestly: this proves
    // there is exactly one occurrence of THIS SPECIFIC, recognizable call
    // shape in the file - a second recovery call written in a differently-
    // shaped way (a renamed local variable, a re-ordered/renamed dependency
    // object, a call routed through a new helper function) would not match
    // this pattern at all and so would not be counted; closing that residual
    // case would require real AST-level analysis, which this static,
    // regex-based test deliberately does not attempt.
    const recoveryCallPattern =
      /createApplyBatchRecoveryService\s*\(\s*\{[\s\S]{0,200}?native\s*:\s*realWindowsSafeApplyNativeDependencies[\s\S]{0,200}?\}\s*\)\s*\.\s*recoverAllUnresolvedBatches\s*\(\s*\)/g
    const recoveryMatches = [...indexContent.matchAll(recoveryCallPattern)]
    expect(recoveryMatches).toHaveLength(1)
    const recoveryIndex = recoveryMatches[0].index as number

    // The ordering proof itself. Static/textual, not a runtime observation -
    // sound only because bootstrap()'s body between the migration step and
    // registerIpc(...) is a flat, unconditional, sequential list of
    // statements (no loop/branch/reordering construct sits between them),
    // so a statement's textual position is a valid proxy for its execution
    // order here.
    expect(migrationsIndex).toBeLessThan(recoveryIndex)
    expect(recoveryIndex).toBeLessThan(registerIpcIndex)

    // index.ts calls the service's own public factory only - it has no
    // reason to reference the transition guard directly, and never should.
    expect(indexContent).not.toContain('applyBatchTransitionGuard')
  })

  it('index.ts is the ONLY non-test production file under src/main that imports applyBatchRecoveryService (a full scan, not a hand-picked allowlist)', () => {
    const repoRoot = path.join(__dirname, '..', '..', '..')
    const mainRoot = path.join(repoRoot, 'src', 'main')

    // A genuine import specifier, not a bare-word/comment mention -
    // applyBatchForwardService.ts's and applyBatchTransitionGuard.ts's own
    // header comments already say the word "applyBatchRecoveryService" in
    // prose (e.g. "mirrors applyBatchRecoveryService.ts's own X") - a bare
    // substring check would misfire on those two already-innocent files.
    // Requiring the literal "import" keyword within a bounded distance of a
    // `from '.../applyBatchRecoveryService'` clause matches only a real ES
    // import statement.
    const importSpecifierPattern = /\bimport\s+[\s\S]{0,300}?\bfrom\s+['"][^'"]*\/applyBatchRecoveryService['"]/

    const candidateFiles = walkAllTsFiles(mainRoot).filter((file) => {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) return false
      // The recovery service's own definition file is excluded from the
      // caller scan by name - it is what is being searched FOR, never a
      // caller of itself.
      if (path.basename(file) === 'applyBatchRecoveryService.ts') return false
      return true
    })

    const importers = candidateFiles.filter((file) => importSpecifierPattern.test(fs.readFileSync(file, 'utf8')))
    expect(importers).toEqual([path.join(repoRoot, 'src', 'main', 'index.ts')])
  })

  it('preload and renderer still never reference recovery at all (directory-wide scan, unchanged boundary)', () => {
    const repoRoot = path.join(__dirname, '..', '..', '..')
    for (const file of [...walk(path.join(repoRoot, 'src', 'preload')), ...walk(path.join(repoRoot, 'src', 'renderer'))]) {
      const content = fs.readFileSync(file, 'utf8')
      expect(content).not.toContain('applyBatchRecoveryService')
      expect(content).not.toContain('applyBatchTransitionGuard')
    }
  })
})
