// Meilenstein 4.8B.0 - Windows-only native integration tests fuer den
// "guarded mutation"-Prototyp: exklusive MODIFY-Besitznahme, exaktes
// In-Place-MODIFY, exklusives CREATE_NEW, Rollback (beide Arten),
// Byte-Fidelity und deterministische Fault-Injection. Laeuft NUR unter
// Windows (describe.skipIf) - auf anderen Plattformen existiert das native
// Modul gar nicht (siehe binding.gyp's OS=='win'-Bedingung).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  prepareLease,
  applyModify,
  createFile,
  verifyFile,
  rollbackFile,
  closeLease,
  isWindowsSafeApplySupported,
  __setFaultPointForTests,
  type WindowsSafeApplyPlan
} from './windowsSafeApply'

const IS_WINDOWS = process.platform === 'win32'

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-core-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - native module availability', () => {
  it('loads the compiled native module on Windows', () => {
    expect(isWindowsSafeApplySupported()).toBe(true)
  })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - guarded MODIFY', () => {
  it('verifies exact expected state while held, then mutates, flushes and reads back exactly', () => {
    const original = Buffer.from('hello world\n', 'utf8')
    fs.writeFileSync(path.join(root, 'a.txt'), original)
    const proposed = Buffer.from('goodbye cruel world\n', 'utf8')

    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: proposed }]
    }
    const prep = prepareLease(plan)
    expect(prep.modifies[0].code).toBe('OK')
    expect(prep.modifies[0].sha256Hex).toBe(sha256(original))
    expect(prep.modifies[0].length).toBe(original.length)

    const result = applyModify(prep.lease, 0)
    expect(result.code).toBe('OK')
    expect(result.sha256Hex).toBe(sha256(proposed))
    expect(result.length).toBe(proposed.length)

    const verify = verifyFile(prep.lease, 0, false)
    expect(verify.sha256Hex).toBe(sha256(proposed))

    closeLease(prep.lease)
    expect(fs.readFileSync(path.join(root, 'a.txt'))).toEqual(proposed)
  })

  it('rejects (PRECONDITION_FAILED) when the on-disk content does not match the expected hash/length', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'actual content\n')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        {
          path: 'a.txt',
          expectedSha256Hex: sha256(Buffer.from('DIFFERENT expected content\n')),
          expectedLength: 999,
          proposedBytes: Buffer.from('new\n')
        }
      ]
    }
    expect(() => prepareLease(plan)).toThrowError(/PRECONDITION_FAILED/)
    // No mutation may have occurred.
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('actual content\n')
  })

  it('fails closed (NOT_FOUND) when the MODIFY target does not exist', () => {
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'missing.txt', expectedSha256Hex: sha256(Buffer.alloc(0)), expectedLength: 0, proposedBytes: Buffer.from('x') }]
    }
    expect(() => prepareLease(plan)).toThrowError(/NOT_FOUND/)
  })

  it('blocks a competing open of the exact same target while the lease is held (share=0)', () => {
    const original = Buffer.from('locked content\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }]
    }
    const prep = prepareLease(plan)
    expect(() => fs.readFileSync(targetPath)).toThrowError(/EBUSY/)
    closeLease(prep.lease)
    // After close, ordinary access works again.
    expect(() => fs.readFileSync(targetPath)).not.toThrow()
  })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - guarded CREATE', () => {
  it('creates a new file with CREATE_NEW semantics, writes/flushes/verifies exact bytes', () => {
    const proposed = Buffer.from('brand new content\n')
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'new.txt', proposedBytes: proposed }] }
    const prep = prepareLease(plan)
    const result = createFile(prep.lease, 0)
    expect(result.code).toBe('OK')
    expect(result.sha256Hex).toBe(sha256(proposed))
    closeLease(prep.lease)
    expect(fs.readFileSync(path.join(root, 'new.txt'))).toEqual(proposed)
  })

  it('fails closed with PRECONDITION_FAILED (no MODIFY fallback) when the target already exists', () => {
    fs.writeFileSync(path.join(root, 'already.txt'), 'pre-existing\n')
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'already.txt', proposedBytes: Buffer.from('attempted overwrite\n') }] }
    const prep = prepareLease(plan)
    expect(() => createFile(prep.lease, 0)).toThrowError(/PRECONDITION_FAILED/)
    closeLease(prep.lease)
    // The pre-existing content must be completely untouched.
    expect(fs.readFileSync(path.join(root, 'already.txt'), 'utf8')).toBe('pre-existing\n')
  })

  it('fails closed even when the existing colliding content is byte-identical to the proposed content', () => {
    const bytes = Buffer.from('identical\n')
    fs.writeFileSync(path.join(root, 'same.txt'), bytes)
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'same.txt', proposedBytes: bytes }] }
    const prep = prepareLease(plan)
    expect(() => createFile(prep.lease, 0)).toThrowError(/PRECONDITION_FAILED/)
    closeLease(prep.lease)
  })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - rollback (same-process lease only, not restart recovery)', () => {
  it('MODIFY rollback restores exact original bytes while the same lease is still held', () => {
    const original = Buffer.from('original bytes here\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('mutated\n') }]
    }
    const prep = prepareLease(plan)
    applyModify(prep.lease, 0)
    const rollback = rollbackFile(prep.lease, 0, false)
    expect(rollback.code).toBe('OK')
    expect(rollback.sha256Hex).toBe(sha256(original))
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(original)
  })

  it('CREATE rollback removes only the transaction-created fixture file, verifying ownership first', () => {
    const targetPath = path.join(root, 'new.txt')
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'new.txt', proposedBytes: Buffer.from('temp\n') }] }
    const prep = prepareLease(plan)
    createFile(prep.lease, 0)
    expect(fs.existsSync(targetPath)).toBe(true)
    const rollback = rollbackFile(prep.lease, 0, true)
    expect(rollback.code).toBe('OK')
    closeLease(prep.lease)
    expect(fs.existsSync(targetPath)).toBe(false)
  })

  it('rejects a rollback attempt on an entry that was never mutated/created (BAD_HANDLE)', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(Buffer.from('x\n')), expectedLength: 2, proposedBytes: Buffer.from('y\n') }]
    }
    const prep = prepareLease(plan)
    expect(() => rollbackFile(prep.lease, 0, false)).toThrowError(/BAD_HANDLE/)
    closeLease(prep.lease)
  })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - byte fidelity', () => {
  const cases: Array<[string, Buffer]> = [
    ['empty file', Buffer.alloc(0)],
    ['LF only', Buffer.from('line1\nline2\n')],
    ['CRLF only', Buffer.from('line1\r\nline2\r\n')],
    ['no final newline', Buffer.from('no newline at end')],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom text\n')])],
    ['unicode', Buffer.from('héllo wörld – ünïcödé 中文字符\n', 'utf8')],
    ['emoji', Buffer.from('sparkles: ✨🎉🚀 done\n', 'utf8')],
    ['~32 KiB bounded fixture', Buffer.alloc(32 * 1024, 0x41)]
  ]

  for (const [label, bytes] of cases) {
    it(`round-trips a MODIFY for: ${label}`, () => {
      const original = Buffer.from('placeholder original\n')
      const targetPath = path.join(root, 'f.bin')
      fs.writeFileSync(targetPath, original)
      const plan: WindowsSafeApplyPlan = {
        root,
        modifies: [{ path: 'f.bin', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: bytes }]
      }
      const prep = prepareLease(plan)
      const result = applyModify(prep.lease, 0)
      expect(result.code).toBe('OK')
      expect(result.length).toBe(bytes.length)
      closeLease(prep.lease)
      expect(fs.readFileSync(targetPath)).toEqual(bytes)
    })
  }

  it('handles a shrinking file (large -> small)', () => {
    const original = Buffer.alloc(10000, 0x42)
    const targetPath = path.join(root, 'shrink.bin')
    fs.writeFileSync(targetPath, original)
    const proposed = Buffer.from('tiny\n')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'shrink.bin', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: proposed }]
    }
    const prep = prepareLease(plan)
    applyModify(prep.lease, 0)
    closeLease(prep.lease)
    const onDisk = fs.readFileSync(targetPath)
    expect(onDisk).toEqual(proposed)
    expect(onDisk.length).toBe(proposed.length) // no leftover trailing bytes from the larger original
  })

  it('handles a growing file (small -> large)', () => {
    const original = Buffer.from('tiny\n')
    const targetPath = path.join(root, 'grow.bin')
    fs.writeFileSync(targetPath, original)
    const proposed = Buffer.alloc(50000, 0x43)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'grow.bin', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: proposed }]
    }
    const prep = prepareLease(plan)
    applyModify(prep.lease, 0)
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(proposed)
  })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - deterministic fault injection (lease-scoped only)', () => {
  function setupModify(): { prep: ReturnType<typeof prepareLease>; targetPath: string; original: Buffer; proposed: Buffer } {
    const original = Buffer.from('original fault-injection content\n')
    const proposed = Buffer.from('proposed fault-injection content!!\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: proposed }]
    }
    const prep = prepareLease(plan)
    return { prep, targetPath, original, proposed }
  }

  it('FAIL_BEFORE_FIRST_WRITE: reports FAULT_INJECTED and leaves the original bytes fully intact', () => {
    const { prep, targetPath, original } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'FAIL_BEFORE_FIRST_WRITE')
    expect(() => applyModify(prep.lease, 0)).toThrowError(/FAULT_INJECTED/)
    const verify = verifyFile(prep.lease, 0, false)
    expect(verify.sha256Hex).toBe(sha256(original))
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(original)
  })

  it('SHORT_WRITE: internally chunks the write into small pieces and still reaches the exact full correct result', () => {
    const { prep, targetPath, proposed } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'SHORT_WRITE')
    const result = applyModify(prep.lease, 0)
    expect(result.code).toBe('OK')
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(proposed)
  })

  it('FAIL_DURING_WRITE: reports IO_FAILED and honestly leaves a partial (non-atomic) file behind', () => {
    const { prep, targetPath, original, proposed } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'FAIL_DURING_WRITE')
    expect(() => applyModify(prep.lease, 0)).toThrowError(/IO_FAILED/)
    closeLease(prep.lease)
    const onDisk = fs.readFileSync(targetPath)
    // Honesty check for the non-atomicity claim: the file is neither the
    // clean original NOR the clean fully-proposed result - some bytes were
    // written before the injected failure. This is expected/documented
    // behavior for this prototype, not a bug.
    expect(onDisk.equals(original)).toBe(false)
    expect(onDisk.equals(proposed)).toBe(false)
  })

  it('FAIL_BEFORE_FINAL_LENGTH: reports FAULT_INJECTED after the write but before SetEndOfFile', () => {
    const { prep } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'FAIL_BEFORE_FINAL_LENGTH')
    expect(() => applyModify(prep.lease, 0)).toThrowError(/FAULT_INJECTED/)
    closeLease(prep.lease)
  })

  it('FAIL_BEFORE_FLUSH: reports FAULT_INJECTED after SetEndOfFile but before FlushFileBuffers', () => {
    const { prep } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'FAIL_BEFORE_FLUSH')
    expect(() => applyModify(prep.lease, 0)).toThrowError(/FAULT_INJECTED/)
    closeLease(prep.lease)
  })

  it('FAIL_AFTER_FLUSH_BEFORE_VERIFY: reports FAULT_INJECTED after a successful flush, before readback verify', () => {
    const { prep, targetPath, proposed } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'FAIL_AFTER_FLUSH_BEFORE_VERIFY')
    expect(() => applyModify(prep.lease, 0)).toThrowError(/FAULT_INJECTED/)
    closeLease(prep.lease)
    // The bytes were actually flushed to disk already - this proves the
    // fault point fires strictly between flush and verify, not before flush.
    expect(fs.readFileSync(targetPath)).toEqual(proposed)
  })

  it('VERIFY_MISMATCH: reports VERIFY_FAILED even though the on-disk bytes are actually correct', () => {
    const { prep, targetPath, proposed } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'VERIFY_MISMATCH')
    expect(() => applyModify(prep.lease, 0)).toThrowError(/VERIFY_FAILED/)
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(proposed)
  })

  it('ROLLBACK_WRITE_FAILURE: reports FAULT_INJECTED and leaves the mutated (post-applyModify) bytes in place', () => {
    const { prep, targetPath, proposed } = setupModify()
    applyModify(prep.lease, 0)
    __setFaultPointForTests(prep.lease, 0, false, 'ROLLBACK_WRITE_FAILURE')
    expect(() => rollbackFile(prep.lease, 0, false)).toThrowError(/FAULT_INJECTED/)
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(proposed)
  })
})

// V2 Blocker 1/1B: a failed or partial mutation attempt must remain
// rollback-eligible while the SAME lease/handle is still held - a failure
// return from WriteFile/SetEndOfFile/FlushFileBuffers is never treated as
// proof that nothing changed on disk. FAIL_BEFORE_FIRST_WRITE is the one
// exception: it never attempts a write at all, so it must remain provably
// no-mutation, and rollback after it correctly stays rejected.
describe.skipIf(!IS_WINDOWS)('windowsSafeApply - MODIFY rollback-after-failure (V2 Blocker 1)', () => {
  function setupModify(): { prep: ReturnType<typeof prepareLease>; targetPath: string; original: Buffer } {
    const original = Buffer.from('original content for rollback-after-failure test\n')
    const proposed = Buffer.from('proposed content that will fail partway through!!\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: proposed }]
    }
    const prep = prepareLease(plan)
    return { prep, targetPath, original }
  }

  const faultsThatMayHaveMutated: Array<[string, string]> = [
    ['FAIL_DURING_WRITE', 'IO_FAILED'],
    ['FAIL_BEFORE_FINAL_LENGTH', 'FAULT_INJECTED'],
    ['FAIL_BEFORE_FLUSH', 'FAULT_INJECTED'],
    ['FAIL_AFTER_FLUSH_BEFORE_VERIFY', 'FAULT_INJECTED'],
    ['VERIFY_MISMATCH', 'VERIFY_FAILED']
  ]

  for (const [faultName, expectedApplyError] of faultsThatMayHaveMutated) {
    it(`${faultName}: applyModify fails, but the SAME lease can still roll back to the exact original bytes`, () => {
      const { prep, targetPath, original } = setupModify()
      __setFaultPointForTests(prep.lease, 0, false, faultName as Parameters<typeof __setFaultPointForTests>[3])
      expect(() => applyModify(prep.lease, 0)).toThrowError(new RegExp(expectedApplyError))

      const rollback = rollbackFile(prep.lease, 0, false)
      expect(rollback.code).toBe('OK')
      expect(rollback.sha256Hex).toBe(sha256(original))
      closeLease(prep.lease)
      expect(fs.readFileSync(targetPath)).toEqual(original)
    })
  }

  it('FAIL_BEFORE_FIRST_WRITE: remains provably no-mutation - rollback correctly stays rejected (BAD_HANDLE)', () => {
    const { prep, targetPath, original } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'FAIL_BEFORE_FIRST_WRITE')
    expect(() => applyModify(prep.lease, 0)).toThrowError(/FAULT_INJECTED/)
    expect(() => rollbackFile(prep.lease, 0, false)).toThrowError(/BAD_HANDLE/)
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(original)
  })

  it('a failed applyModify blocks re-entry (BAD_HANDLE) until the entry is rolled back', () => {
    const { prep } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'FAIL_DURING_WRITE')
    expect(() => applyModify(prep.lease, 0)).toThrowError(/IO_FAILED/)
    expect(() => applyModify(prep.lease, 0)).toThrowError(/BAD_HANDLE/)
    closeLease(prep.lease)
  })

  it('after a successful rollback, applyModify can be attempted again and succeed cleanly', () => {
    const { prep, targetPath } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'VERIFY_MISMATCH')
    expect(() => applyModify(prep.lease, 0)).toThrowError(/VERIFY_FAILED/)
    rollbackFile(prep.lease, 0, false)
    __setFaultPointForTests(prep.lease, 0, false, 'NONE')
    const retry = applyModify(prep.lease, 0)
    expect(retry.code).toBe('OK')
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('proposed content that will fail partway through!!\n')
  })
})

// V2 Blocker 1B: same principle for CREATE - once CREATE_NEW itself succeeds,
// the lease owns a real filesystem object via that handle regardless of
// whether the subsequent content write succeeds, and same-lease rollback
// (handle-owned delete, never path-based) must still be able to remove it.
describe.skipIf(!IS_WINDOWS)('windowsSafeApply - CREATE rollback-after-failure (V2 Blocker 1B)', () => {
  function setupCreate(): { prep: ReturnType<typeof prepareLease>; targetPath: string } {
    const targetPath = path.join(root, 'new.txt')
    const plan: WindowsSafeApplyPlan = {
      root,
      creates: [{ path: 'new.txt', proposedBytes: Buffer.from('created content that will fail partway through!!\n') }]
    }
    const prep = prepareLease(plan)
    return { prep, targetPath }
  }

  const allCreateFaults: Array<[string, string]> = [
    ['FAIL_BEFORE_FIRST_WRITE', 'FAULT_INJECTED'],
    ['FAIL_DURING_WRITE', 'IO_FAILED'],
    ['FAIL_BEFORE_FINAL_LENGTH', 'FAULT_INJECTED'],
    ['FAIL_BEFORE_FLUSH', 'FAULT_INJECTED'],
    ['FAIL_AFTER_FLUSH_BEFORE_VERIFY', 'FAULT_INJECTED'],
    ['VERIFY_MISMATCH', 'VERIFY_FAILED']
  ]

  for (const [faultName, expectedCreateError] of allCreateFaults) {
    it(`${faultName}: createFile fails after CREATE_NEW already succeeded, but the SAME lease can still roll back (delete) the owned object`, () => {
      const { prep, targetPath } = setupCreate()
      __setFaultPointForTests(prep.lease, 0, true, faultName as Parameters<typeof __setFaultPointForTests>[3])
      expect(() => createFile(prep.lease, 0)).toThrowError(new RegExp(expectedCreateError))

      // CREATE_NEW itself always succeeds before any of these fault points
      // fire (they all fire during/after the content write) - the object
      // therefore exists and is owned, even though createFile threw.
      const rollback = rollbackFile(prep.lease, 0, true)
      expect(rollback.code).toBe('OK')
      closeLease(prep.lease)
      // No unrelated path was changed, and the transaction-created file is
      // gone - never removed via a path-based delete, only via the owned
      // handle (see lease.cc's FileDispositionInfo usage).
      expect(fs.existsSync(targetPath)).toBe(false)
    })
  }

  it('a failed createFile blocks re-entry (BAD_HANDLE) until the entry is rolled back', () => {
    const { prep } = setupCreate()
    __setFaultPointForTests(prep.lease, 0, true, 'FAIL_DURING_WRITE')
    expect(() => createFile(prep.lease, 0)).toThrowError(/IO_FAILED/)
    expect(() => createFile(prep.lease, 0)).toThrowError(/BAD_HANDLE/)
    closeLease(prep.lease)
  })

  it('after a successful rollback, createFile can be attempted again on the same entry and succeed cleanly', () => {
    const { prep, targetPath } = setupCreate()
    __setFaultPointForTests(prep.lease, 0, true, 'VERIFY_MISMATCH')
    expect(() => createFile(prep.lease, 0)).toThrowError(/VERIFY_FAILED/)
    rollbackFile(prep.lease, 0, true)
    __setFaultPointForTests(prep.lease, 0, true, 'NONE')
    const retry = createFile(prep.lease, 0)
    expect(retry.code).toBe('OK')
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('created content that will fail partway through!!\n')
  })
})

// V3 hardening: CaptureNativeIdentity's return value must never be silently
// discarded on a call site that reports an OK outcome - a genuine (rare)
// Win32 identity-query failure must fail closed (INTERNAL_ERROR, never OK
// with a default-constructed/all-zero NativeIdentity), and any mutation that
// already completed and verified before that final capture must keep its
// rollback eligibility exactly as if the capture had succeeded - see
// lease.cc's CaptureIdentityOrFault and the FORCE_IDENTITY_CAPTURE_FAILURE
// fault point (common.h) that lets this be proven deterministically without
// needing a genuine Win32 failure.
describe.skipIf(!IS_WINDOWS)('windowsSafeApply - identity-capture fail-closed (V3 hardening)', () => {
  function setupModify(): { prep: ReturnType<typeof prepareLease>; targetPath: string; original: Buffer; proposed: Buffer } {
    const original = Buffer.from('identity fail-closed original\n')
    const proposed = Buffer.from('identity fail-closed proposed\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: proposed }]
    }
    const prep = prepareLease(plan)
    return { prep, targetPath, original, proposed }
  }

  function setupCreate(): { prep: ReturnType<typeof prepareLease>; targetPath: string; proposed: Buffer } {
    const proposed = Buffer.from('identity fail-closed created\n')
    const targetPath = path.join(root, 'new.txt')
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'new.txt', proposedBytes: proposed }] }
    const prep = prepareLease(plan)
    return { prep, targetPath, proposed }
  }

  it('applyModify: fails closed (INTERNAL_ERROR), never OK - even though the write itself is already correct on disk', () => {
    const { prep, targetPath, original, proposed } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'FORCE_IDENTITY_CAPTURE_FAILURE')
    expect(() => applyModify(prep.lease, 0)).toThrowError(/INTERNAL_ERROR/)
    // The write+flush+readback+hash-verify sequence runs entirely BEFORE the
    // final identity capture, so the correct new content is genuinely on
    // disk even though the call reported failure, not OK. Proven through the
    // SAME still-open exclusive handle (verifyFile) - a separate fs.* read
    // here would itself hit ERROR_SHARING_VIOLATION against our own
    // exclusive handle, same as any other competing opener.
    __setFaultPointForTests(prep.lease, 0, false, 'NONE')
    const verify = verifyFile(prep.lease, 0, false)
    expect(verify.sha256Hex).toBe(sha256(proposed))
    // Rollback eligibility must be preserved exactly as if this had returned
    // OK (mayHaveMutated stays true).
    const rollback = rollbackFile(prep.lease, 0, false)
    expect(rollback.code).toBe('OK')
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(original)
  })

  it('createFile: fails closed (INTERNAL_ERROR), never OK - even though the object is already created and owned', () => {
    const { prep, targetPath, proposed } = setupCreate()
    __setFaultPointForTests(prep.lease, 0, true, 'FORCE_IDENTITY_CAPTURE_FAILURE')
    expect(() => createFile(prep.lease, 0)).toThrowError(/INTERNAL_ERROR/)
    __setFaultPointForTests(prep.lease, 0, true, 'NONE')
    const verify = verifyFile(prep.lease, 0, true)
    expect(verify.sha256Hex).toBe(sha256(proposed))
    // Same-lease rollback (handle-owned delete, never path-based) must still work.
    const rollback = rollbackFile(prep.lease, 0, true)
    expect(rollback.code).toBe('OK')
    closeLease(prep.lease)
    expect(fs.existsSync(targetPath)).toBe(false)
  })

  it('verifyFile (MODIFY): fails closed (INTERNAL_ERROR), never OK', () => {
    const { prep } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'FORCE_IDENTITY_CAPTURE_FAILURE')
    expect(() => verifyFile(prep.lease, 0, false)).toThrowError(/INTERNAL_ERROR/)
    closeLease(prep.lease)
  })

  it('verifyFile (CREATE): fails closed (INTERNAL_ERROR), never OK', () => {
    const { prep } = setupCreate()
    createFile(prep.lease, 0)
    __setFaultPointForTests(prep.lease, 0, true, 'FORCE_IDENTITY_CAPTURE_FAILURE')
    expect(() => verifyFile(prep.lease, 0, true)).toThrowError(/INTERNAL_ERROR/)
    closeLease(prep.lease)
  })

  it('rollbackFile: fails closed (INTERNAL_ERROR) but the content rollback and mayHaveMutated state are still correctly applied', () => {
    const { prep, targetPath, original } = setupModify()
    applyModify(prep.lease, 0)
    __setFaultPointForTests(prep.lease, 0, false, 'FORCE_IDENTITY_CAPTURE_FAILURE')
    expect(() => rollbackFile(prep.lease, 0, false)).toThrowError(/INTERNAL_ERROR/)
    // Content was genuinely restored to original before the failing final
    // identity capture - proven through the SAME still-open handle
    // (verifyFile), fault now cleared.
    __setFaultPointForTests(prep.lease, 0, false, 'NONE')
    const verify = verifyFile(prep.lease, 0, false)
    expect(verify.sha256Hex).toBe(sha256(original))
    // mayHaveMutated must have been correctly flipped to false despite the
    // non-OK return - proven behaviorally: a second rollback attempt is now
    // rejected as BAD_HANDLE, exactly as it would be after a normal
    // successful rollback, not left stuck in a "still needs rollback" state.
    expect(() => rollbackFile(prep.lease, 0, false)).toThrowError(/BAD_HANDLE/)
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(original)
  })
})

// V4 hardening: the old verification pattern computed TWO independently
// fallible SHA-256 hashes and compared their hex strings
// (`Sha256Hex(readback, &actual); Sha256Hex(expected, &expectedHex); actual
// == expectedHex`) - if BOTH calls happened to fail, both strings stayed
// empty and "" == "" would have passed verification with no real SHA-256
// evidence behind it. Content-correctness verification is now exact
// byte-for-byte comparison (readback == proposedBytes / originalBytes,
// both already fully in memory), and the SHA-256 that ends up in the
// returned receipt (outcome.sha256Hex) is computed separately by a single
// CHECKED call (Sha256HexOrFault) that must fail closed (INTERNAL_ERROR,
// never OK with missing/empty evidence) if it fails - see lease.cc's
// FillOutcome, which no longer computes any hash internally at all. The
// FORCE_SHA256_FAILURE fault point lets that checked call be forced to fail
// deterministically without needing a genuine BCrypt failure.
describe.skipIf(!IS_WINDOWS)('windowsSafeApply - SHA-256 receipt fail-closed (V4 hardening)', () => {
  function setupModify(): { prep: ReturnType<typeof prepareLease>; targetPath: string; original: Buffer; proposed: Buffer } {
    const original = Buffer.from('sha256 fail-closed original\n')
    const proposed = Buffer.from('sha256 fail-closed proposed\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: proposed }]
    }
    const prep = prepareLease(plan)
    return { prep, targetPath, original, proposed }
  }

  function setupCreate(): { prep: ReturnType<typeof prepareLease>; targetPath: string; proposed: Buffer } {
    const proposed = Buffer.from('sha256 fail-closed created\n')
    const targetPath = path.join(root, 'new.txt')
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'new.txt', proposedBytes: proposed }] }
    const prep = prepareLease(plan)
    return { prep, targetPath, proposed }
  }

  it('applyModify: fails closed (INTERNAL_ERROR), never OK - even though the write itself is already correct on disk', () => {
    const { prep, targetPath, original, proposed } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'FORCE_SHA256_FAILURE')
    expect(() => applyModify(prep.lease, 0)).toThrowError(/INTERNAL_ERROR/)
    // Content correctness was already proven by exact byte comparison
    // BEFORE the (now-failing) receipt hash - prove it via the still-open
    // handle (verifyFile), fault now cleared.
    __setFaultPointForTests(prep.lease, 0, false, 'NONE')
    const verify = verifyFile(prep.lease, 0, false)
    expect(verify.sha256Hex).toBe(sha256(proposed))
    // Rollback eligibility must be preserved exactly as if applyModify had
    // returned OK (mayHaveMutated stays true).
    const rollback = rollbackFile(prep.lease, 0, false)
    expect(rollback.code).toBe('OK')
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(original)
  })

  it('createFile: fails closed (INTERNAL_ERROR), never OK - even though the object is already created and owned', () => {
    const { prep, targetPath, proposed } = setupCreate()
    __setFaultPointForTests(prep.lease, 0, true, 'FORCE_SHA256_FAILURE')
    expect(() => createFile(prep.lease, 0)).toThrowError(/INTERNAL_ERROR/)
    __setFaultPointForTests(prep.lease, 0, true, 'NONE')
    const verify = verifyFile(prep.lease, 0, true)
    expect(verify.sha256Hex).toBe(sha256(proposed))
    const rollback = rollbackFile(prep.lease, 0, true)
    expect(rollback.code).toBe('OK')
    closeLease(prep.lease)
    expect(fs.existsSync(targetPath)).toBe(false)
  })

  it('verifyFile (MODIFY): fails closed (INTERNAL_ERROR), never OK', () => {
    const { prep } = setupModify()
    __setFaultPointForTests(prep.lease, 0, false, 'FORCE_SHA256_FAILURE')
    expect(() => verifyFile(prep.lease, 0, false)).toThrowError(/INTERNAL_ERROR/)
    closeLease(prep.lease)
  })

  it('verifyFile (CREATE): fails closed (INTERNAL_ERROR), never OK', () => {
    const { prep } = setupCreate()
    createFile(prep.lease, 0)
    __setFaultPointForTests(prep.lease, 0, true, 'FORCE_SHA256_FAILURE')
    expect(() => verifyFile(prep.lease, 0, true)).toThrowError(/INTERNAL_ERROR/)
    closeLease(prep.lease)
  })

  it('rollbackFile: fails closed (INTERNAL_ERROR) but the content rollback and mayHaveMutated state are still correctly applied', () => {
    const { prep, targetPath, original } = setupModify()
    applyModify(prep.lease, 0)
    __setFaultPointForTests(prep.lease, 0, false, 'FORCE_SHA256_FAILURE')
    expect(() => rollbackFile(prep.lease, 0, false)).toThrowError(/INTERNAL_ERROR/)
    // Content was genuinely restored to original before the (now-failing)
    // receipt hash - prove it via the still-open handle (verifyFile), fault
    // now cleared.
    __setFaultPointForTests(prep.lease, 0, false, 'NONE')
    const verify = verifyFile(prep.lease, 0, false)
    expect(verify.sha256Hex).toBe(sha256(original))
    // mayHaveMutated must have been correctly flipped to false despite the
    // non-OK return - proven behaviorally: a second rollback attempt is now
    // rejected as BAD_HANDLE, exactly as it would be after a normal
    // successful rollback, not left stuck in a "still needs rollback" state.
    expect(() => rollbackFile(prep.lease, 0, false)).toThrowError(/BAD_HANDLE/)
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(original)
  })
})
