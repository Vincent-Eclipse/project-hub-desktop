// Meilenstein 4.8B.2C - Windows-only, real native addon, real filesystem
// fixtures. Mirrors windowsSafeApply.core.windows.test.ts's/
// windowsSafeApply.recoveryDelete.windows.test.ts's existing harness
// conventions: a real MODIFY/CREATE is performed first (simulating "the
// batch already forward-applied before the crash"), the durable evidence a
// real journal would have captured is read back from the native calls'
// OWN outcomes (never invented), then recovery is driven through the real
// createApplyBatchRecoveryService/realWindowsSafeApplyNativeDependencies -
// never a fake.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../testUtils/testDb'
import { createProject } from './projectsService'
import {
  prepareLease,
  applyModify,
  createFile,
  closeLease,
  type WindowsSafeApplyPlan,
  type WindowsSafeApplyOutcome
} from './windowsSafeApply'
import { createApplyBatchRecoveryService, realWindowsSafeApplyNativeDependencies, type ApplyBatchRecoveryNativeDependencies } from './applyBatchRecoveryService'

const IS_WINDOWS = process.platform === 'win32'

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-recovery-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function insertProject(db: Database.Database): number {
  return createProject(db, { name: 'Demo', projectType: 'App', description: 'Fixture project', folderPath: root }).id
}

function insertBatch(db: Database.Database, projectId: number, rootEvidence: WindowsSafeApplyOutcome, preRecoveryState: string = 'APPLYING'): number {
  const authorizationJson = JSON.stringify({ target: { projectFolderPath: root } })
  const info = db
    .prepare(
      `INSERT INTO apply_batches (project_id, review_id, fingerprint, schema_version, authorization_json, root_native_file_id_128_hex, root_native_volume_serial, state, pre_recovery_state)
       VALUES (?, 'review-1', 'fingerprint-1', '1', ?, ?, ?, 'RECOVERY_REQUIRED', ?)`
    )
    .run(projectId, authorizationJson, rootEvidence.nativeFileId128Hex, rootEvidence.nativeVolumeSerial, preRecoveryState)
  return Number(info.lastInsertRowid)
}

function insertModifyEntry(
  db: Database.Database,
  batchId: number,
  relPath: string,
  original: Buffer,
  proposed: Buffer,
  state: string,
  applied: WindowsSafeApplyOutcome | null,
  prepared: WindowsSafeApplyOutcome
): number {
  const info = db
    .prepare(
      `INSERT INTO apply_batch_entries (
        batch_id, ordinal, mutation_type, rel_path, proposed_sha256, proposed_byte_length,
        original_bytes, original_sha256, original_byte_length,
        prepared_native_file_id_128_hex, prepared_native_volume_serial,
        state, native_file_id_128_hex, native_volume_serial, written_sha256, written_byte_length, failure_note
      ) VALUES (?, 0, 'MODIFY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      batchId,
      relPath,
      sha256(proposed),
      proposed.length,
      original,
      sha256(original),
      original.length,
      prepared.nativeFileId128Hex,
      prepared.nativeVolumeSerial,
      state,
      applied?.nativeFileId128Hex ?? null,
      applied?.nativeVolumeSerial ?? null,
      applied?.sha256Hex ?? null,
      applied?.length ?? null
    )
  return Number(info.lastInsertRowid)
}

function insertCreateEntry(
  db: Database.Database,
  batchId: number,
  relPath: string,
  proposed: Buffer,
  state: string,
  created: WindowsSafeApplyOutcome | null
): number {
  const info = db
    .prepare(
      `INSERT INTO apply_batch_entries (
        batch_id, ordinal, mutation_type, rel_path, proposed_sha256, proposed_byte_length,
        original_bytes, original_sha256, original_byte_length,
        prepared_native_file_id_128_hex, prepared_native_volume_serial,
        state, native_file_id_128_hex, native_volume_serial, written_sha256, written_byte_length, failure_note
      ) VALUES (?, 0, 'CREATE', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL)`
    )
    .run(batchId, relPath, sha256(proposed), proposed.length, state, created?.nativeFileId128Hex ?? null, created?.nativeVolumeSerial ?? null, created?.sha256Hex ?? null, created?.length ?? null)
  return Number(info.lastInsertRowid)
}

function readEntryRow(db: Database.Database, id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM apply_batch_entries WHERE id = ?').get(id) as Record<string, unknown>
}

/** Performs a real forward MODIFY, returning the exact durable evidence a real journal would have captured (never invented). */
function forwardApplyModify(relPath: string, original: Buffer, proposed: Buffer) {
  fs.writeFileSync(path.join(root, relPath), original)
  const plan: WindowsSafeApplyPlan = { root, modifies: [{ path: relPath, expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: proposed }] }
  const prep = prepareLease(plan)
  const rootEvidence = prep.root
  const preparedEvidence = prep.modifies[0] // pre-forward (PREPARED-era) identity
  const appliedEvidence = applyModify(prep.lease, 0) // post-forward (APPLIED-era) identity
  closeLease(prep.lease)
  return { rootEvidence, preparedEvidence, appliedEvidence }
}

/** Performs a real forward CREATE, returning the exact durable evidence a real journal would have captured. */
function forwardCreate(relPath: string, content: Buffer) {
  const plan: WindowsSafeApplyPlan = { root, creates: [{ path: relPath, proposedBytes: content }] }
  const prep = prepareLease(plan)
  const rootEvidence = prep.root
  const createdEvidence = createFile(prep.lease, 0)
  closeLease(prep.lease)
  return { rootEvidence, createdEvidence }
}

/** Wraps realWindowsSafeApplyNativeDependencies with call counters, without altering behavior. */
function countingRealNative(): { native: ApplyBatchRecoveryNativeDependencies; calls: { applyModify: number; recoverDeleteCreated: number; prepareLease: number } } {
  const calls = { applyModify: 0, recoverDeleteCreated: 0, prepareLease: 0 }
  return {
    calls,
    native: {
      prepareLease: (plan) => {
        calls.prepareLease++
        return realWindowsSafeApplyNativeDependencies.prepareLease(plan)
      },
      applyModify: (lease, index) => {
        calls.applyModify++
        return realWindowsSafeApplyNativeDependencies.applyModify(lease, index)
      },
      recoverDeleteCreated: (request) => {
        calls.recoverDeleteCreated++
        return realWindowsSafeApplyNativeDependencies.recoverDeleteCreated(request)
      },
      closeLease: (lease) => realWindowsSafeApplyNativeDependencies.closeLease(lease)
    }
  }
}

describe.skipIf(!IS_WINDOWS)('applyBatchRecoveryService - MODIFY reverse-lease recovery (real native, real fixtures)', () => {
  it('as-applied probe: on-disk content = proposed bytes, root+target identity both match -> ROLLED_BACK, disk content exactly reverted to original', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const original = Buffer.from('hello original\n')
    const proposed = Buffer.from('hello proposed\n')
    const { rootEvidence, preparedEvidence, appliedEvidence } = forwardApplyModify('a.txt', original, proposed)
    // preRecoveryState='ROLLING_BACK' (not 'APPLYING') so CONFIRM mode's own
    // precondition excludes this batch and ROLLBACK mode's Case B actually
    // runs - this test exercises B1/B2 specifically, not CONFIRM's shortcut.
    const batchId = insertBatch(db, projectId, rootEvidence, 'ROLLING_BACK')
    const entryId = insertModifyEntry(db, batchId, 'a.txt', original, proposed, 'APPLIED', appliedEvidence, preparedEvidence)

    const { native } = countingRealNative()
    const result = createApplyBatchRecoveryService({ db, native }).recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
    expect(fs.readFileSync(path.join(root, 'a.txt'))).toEqual(original)
  })

  it('as-applied content matches, but stored root identity is wrong -> RECOVERY_CONFLICT, disk left holding the applied (proposed) bytes, completely untouched', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const original = Buffer.from('root mismatch original\n')
    const proposed = Buffer.from('root mismatch proposed\n')
    const { rootEvidence, preparedEvidence, appliedEvidence } = forwardApplyModify('a.txt', original, proposed)
    const wrongRootEvidence: WindowsSafeApplyOutcome = { ...rootEvidence, nativeFileId128Hex: (rootEvidence.nativeFileId128Hex[0] === '0' ? '1' : '0') + rootEvidence.nativeFileId128Hex.slice(1) }
    const batchId = insertBatch(db, projectId, wrongRootEvidence)
    const entryId = insertModifyEntry(db, batchId, 'a.txt', original, proposed, 'APPLIED', appliedEvidence, preparedEvidence)

    const { native } = countingRealNative()
    const result = createApplyBatchRecoveryService({ db, native }).recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    expect(readEntryRow(db, entryId).state).toBe('RECOVERY_CONFLICT')
    expect(fs.readFileSync(path.join(root, 'a.txt'))).toEqual(proposed)
  })

  it('as-applied target identity mismatches (byte-identical delete+recreate) -> RECOVERY_CONFLICT, disk left completely untouched', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const original = Buffer.from('identity mismatch original\n')
    const proposed = Buffer.from('identity mismatch proposed\n')
    const { rootEvidence, preparedEvidence, appliedEvidence } = forwardApplyModify('a.txt', original, proposed)
    // Byte-identical replacement: same content, new native file object.
    fs.unlinkSync(path.join(root, 'a.txt'))
    fs.writeFileSync(path.join(root, 'a.txt'), proposed)
    const batchId = insertBatch(db, projectId, rootEvidence)
    insertModifyEntry(db, batchId, 'a.txt', original, proposed, 'APPLIED', appliedEvidence, preparedEvidence)

    const { native } = countingRealNative()
    const result = createApplyBatchRecoveryService({ db, native }).recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    expect(fs.readFileSync(path.join(root, 'a.txt'))).toEqual(proposed)
  })

  it('as-original probe: disk already holds original bytes (write already completed, outcome commit did not), pre-forward identity matches -> ROLLED_BACK, applyModify() NEVER invoked', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const original = Buffer.from('resume original\n')
    const proposed = Buffer.from('resume proposed\n')
    const { rootEvidence, preparedEvidence, appliedEvidence } = forwardApplyModify('a.txt', original, proposed)
    // Simulate: applyModify() already reversed the file back to original content before the crash.
    fs.writeFileSync(path.join(root, 'a.txt'), original)
    const batchId = insertBatch(db, projectId, rootEvidence)
    // Entry pre-seeded at ROLLBACK_ATTEMPTING - simulates the marker having already committed durably before the crash (§10's resume row).
    const entryId = insertModifyEntry(db, batchId, 'a.txt', original, proposed, 'ROLLBACK_ATTEMPTING', appliedEvidence, preparedEvidence)

    const { native, calls } = countingRealNative()
    const result = createApplyBatchRecoveryService({ db, native }).recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
    expect(calls.applyModify).toBe(0)
    expect(fs.readFileSync(path.join(root, 'a.txt'))).toEqual(original)
  })

  it('as-original content matches but pre-forward identity mismatches -> RECOVERY_CONFLICT, no write to disk', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const original = Buffer.from('as-original identity mismatch\n')
    const proposed = Buffer.from('proposed content\n')
    const { rootEvidence, preparedEvidence, appliedEvidence } = forwardApplyModify('a.txt', original, proposed)
    fs.writeFileSync(path.join(root, 'a.txt'), original)
    const wrongPrepared: WindowsSafeApplyOutcome = { ...preparedEvidence, nativeFileId128Hex: (preparedEvidence.nativeFileId128Hex[0] === '0' ? '1' : '0') + preparedEvidence.nativeFileId128Hex.slice(1) }
    const batchId = insertBatch(db, projectId, rootEvidence)
    insertModifyEntry(db, batchId, 'a.txt', original, proposed, 'ROLLBACK_ATTEMPTING', appliedEvidence, wrongPrepared)

    const { native } = countingRealNative()
    const result = createApplyBatchRecoveryService({ db, native }).recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    expect(fs.readFileSync(path.join(root, 'a.txt'))).toEqual(original)
  })

  it('closeLease is called on every mismatch path too - immediately reopening the file afterward does not fail with BUSY', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const original = Buffer.from('lease discipline original\n')
    const proposed = Buffer.from('lease discipline proposed\n')
    const { rootEvidence, preparedEvidence, appliedEvidence } = forwardApplyModify('a.txt', original, proposed)
    const wrongRootEvidence: WindowsSafeApplyOutcome = { ...rootEvidence, nativeFileId128Hex: (rootEvidence.nativeFileId128Hex[0] === '0' ? '1' : '0') + rootEvidence.nativeFileId128Hex.slice(1) }
    const batchId = insertBatch(db, projectId, wrongRootEvidence)
    insertModifyEntry(db, batchId, 'a.txt', original, proposed, 'APPLIED', appliedEvidence, preparedEvidence)

    const { native } = countingRealNative()
    createApplyBatchRecoveryService({ db, native }).recoverBatch(batchId)

    expect(() => fs.readFileSync(path.join(root, 'a.txt'))).not.toThrow()
  })
})

describe.skipIf(!IS_WINDOWS)('applyBatchRecoveryService - CREATE recovery (real native, real fixtures)', () => {
  it('evidence present, file exists and matches exactly -> ROLLED_BACK, file confirmed deleted from disk', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const content = Buffer.from('created content\n')
    const { rootEvidence, createdEvidence } = forwardCreate('new.txt', content)
    // preRecoveryState='ROLLING_BACK' so CONFIRM mode's precondition excludes
    // this batch and ROLLBACK mode's Case C actually runs.
    const batchId = insertBatch(db, projectId, rootEvidence, 'ROLLING_BACK')
    const entryId = insertCreateEntry(db, batchId, 'new.txt', content, 'APPLIED', createdEvidence)

    const { native } = countingRealNative()
    const result = createApplyBatchRecoveryService({ db, native }).recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    expect(readEntryRow(db, entryId).state).toBe('ROLLED_BACK')
    expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false)
  })

  it('file already deleted (second crash mid-recovery) -> NOT_FOUND treated as success -> ROLLED_BACK, idempotent', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const content = Buffer.from('already deleted content\n')
    const { rootEvidence, createdEvidence } = forwardCreate('new.txt', content)
    fs.unlinkSync(path.join(root, 'new.txt'))
    const batchId = insertBatch(db, projectId, rootEvidence)
    const entryId = insertCreateEntry(db, batchId, 'new.txt', content, 'ROLLBACK_ATTEMPTING', createdEvidence)

    const { native } = countingRealNative()
    const result = createApplyBatchRecoveryService({ db, native }).recoverBatch(batchId)

    expect(result.finalState).toBe('ROLLED_BACK')
    const row = readEntryRow(db, entryId)
    expect(row.state).toBe('ROLLED_BACK')
    expect(row.failure_note).toBeNull()
  })

  it('on-disk identity/content no longer matches (external replacement) -> RECOVERY_CONFLICT, file left on disk untouched', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const content = Buffer.from('original created content\n')
    const { rootEvidence, createdEvidence } = forwardCreate('new.txt', content)
    fs.unlinkSync(path.join(root, 'new.txt'))
    const replacement = Buffer.from('externally replaced content\n')
    fs.writeFileSync(path.join(root, 'new.txt'), replacement)
    const batchId = insertBatch(db, projectId, rootEvidence)
    const entryId = insertCreateEntry(db, batchId, 'new.txt', content, 'APPLIED', createdEvidence)

    const { native } = countingRealNative()
    const result = createApplyBatchRecoveryService({ db, native }).recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    expect(readEntryRow(db, entryId).state).toBe('RECOVERY_CONFLICT')
    expect(fs.readFileSync(path.join(root, 'new.txt'))).toEqual(replacement)
  })

  it('APPLY_ATTEMPTING with no post-forward evidence, decoy file byte-identical to what would have been proposed -> recoverDeleteCreated NEVER called, decoy left completely untouched', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const content = Buffer.from('decoy content\n')
    const rootPlan: WindowsSafeApplyPlan = { root, creates: [] }
    const rootPrep = prepareLease(rootPlan)
    const rootEvidence = rootPrep.root
    closeLease(rootPrep.lease)
    fs.writeFileSync(path.join(root, 'new.txt'), content) // decoy, planted directly (not through the native module)

    const batchId = insertBatch(db, projectId, rootEvidence)
    const entryId = insertCreateEntry(db, batchId, 'new.txt', content, 'APPLY_ATTEMPTING', null)

    const { native, calls } = countingRealNative()
    const result = createApplyBatchRecoveryService({ db, native }).recoverBatch(batchId)

    expect(result.finalState).toBe('RECOVERY_CONFLICT')
    expect(readEntryRow(db, entryId).failure_note).toBe('CREATE:NO_DURABLE_EVIDENCE')
    expect(calls.recoverDeleteCreated).toBe(0)
    expect(fs.readFileSync(path.join(root, 'new.txt'))).toEqual(content)
  })
})
