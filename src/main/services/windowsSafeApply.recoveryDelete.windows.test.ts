// Meilenstein 4.8B.2A - Windows-only Tests fuer die schmale CREATE-Recovery-
// Delete-Primitive (recoverDeleteCreated). Beweist die volle Kette:
// OPEN EXISTING -> HOLD EXCLUSIVE HANDLE -> VERIFY root/target identity ->
// VERIFY content -> DELETE THROUGH SAME HANDLE, und dass JEDE Abweichung
// (falsche Identitaet, falscher Inhalt, Reparse, Hardlink, konkurrierender
// Prozess, fehlerhafte Evidenz an der TS-Grenze, ungueltiger Pfad) die Datei
// vollstaendig unberuehrt laesst. Kein Fault-Injection-Hook noetig - jedes
// Szenario wird mit einem ECHTEN Win32-Fixture nachgestellt (echte
// Neuerstellung, echter Hardlink, echte Junction/Symlink, echter
// konkurrierender Kindprozess), demselben Stil wie die uebrigen
// windowsSafeApply.*.windows.test.ts-Suiten.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  prepareLease,
  createFile,
  closeLease,
  recoverDeleteCreated,
  type WindowsSafeApplyPlan,
  type WindowsSafeApplyRecoverDeleteCreatedRequest,
  type WindowsSafeApplyOutcome
} from './windowsSafeApply'

const IS_WINDOWS = process.platform === 'win32'
const PRODUCTION_BUILD_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'native',
  'windows-safe-apply',
  'build',
  'Release',
  'windows_safe_apply_production.node'
)
const FIXTURE_PATH = path.join(__dirname, '..', '..', '..', 'native', 'windows-safe-apply', 'fixtures', 'competingProcessFixture.js')

function flipFirstHexChar(hex: string): string {
  return (hex[0] === '0' ? '1' : '0') + hex.slice(1)
}

function flipLastHexChar(hex: string): string {
  return hex.slice(0, -1) + (hex.slice(-1) === '0' ? '1' : '0')
}

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-recdel-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/**
 * Simulates "a previous Eclipse CREATE succeeded and the process later
 * restarted": performs a real CREATE, captures the exact evidence a durable
 * journal would have recorded (root identity from prepareLease's own
 * pre-mutation capture, target identity/content from createFile's outcome),
 * then closes the lease - exactly as if the process had exited and a fresh,
 * lease-less recovery call is now the only thing left.
 */
function createFixtureAndCaptureEvidence(
  relPath: string,
  content: Buffer
): { created: WindowsSafeApplyOutcome; rootEvidence: WindowsSafeApplyOutcome } {
  const plan: WindowsSafeApplyPlan = { root, creates: [{ path: relPath, proposedBytes: content }] }
  const prep = prepareLease(plan)
  const created = createFile(prep.lease, 0)
  const rootEvidence = prep.root
  closeLease(prep.lease)
  return { created, rootEvidence }
}

interface HoldingFixture {
  proc: ChildProcessWithoutNullStreams
  waitReady: () => Promise<string>
  release: () => Promise<void>
}

function startHoldingFixture(mode: 'hold-read' | 'hold-write', targetPath: string): HoldingFixture {
  const proc = spawn(process.execPath, [FIXTURE_PATH, mode, targetPath])
  const rl = readline.createInterface({ input: proc.stdout })
  const lines: string[] = []
  const waiters: Array<(line: string) => void> = []
  rl.on('line', (line) => {
    const waiter = waiters.shift()
    if (waiter) waiter(line)
    else lines.push(line)
  })
  function nextLine(): Promise<string> {
    const buffered = lines.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    return new Promise((resolve) => waiters.push(resolve))
  }
  return {
    proc,
    waitReady: () => nextLine(),
    release: async () => {
      proc.stdin.write('go\n')
      await new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    }
  }
}

function requestFor(
  relPath: string,
  created: WindowsSafeApplyOutcome,
  rootEvidence: WindowsSafeApplyOutcome
): WindowsSafeApplyRecoverDeleteCreatedRequest {
  return {
    root,
    relPath,
    expectedRootVolumeSerial: rootEvidence.nativeVolumeSerial,
    expectedRootFileId128Hex: rootEvidence.nativeFileId128Hex,
    expectedVolumeSerial: created.nativeVolumeSerial,
    expectedFileId128Hex: created.nativeFileId128Hex,
    expectedSha256Hex: created.sha256Hex,
    expectedLength: created.length
  }
}

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - recoverDeleteCreated (M4.8B.2A)', () => {
  it('1. happy path: deletes the exact previously-created object using durably captured evidence', () => {
    const targetPath = path.join(root, 'created.txt')
    const content = Buffer.from('recovery target content\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    expect(fs.existsSync(targetPath)).toBe(true)

    const result = recoverDeleteCreated(requestFor('created.txt', created, rootEvidence))
    expect(result.code).toBe('OK')
    expect(fs.existsSync(targetPath)).toBe(false)
  })

  it('2. wrong expected native file id: FAILS closed (PRECONDITION_FAILED), file remains untouched', () => {
    const targetPath = path.join(root, 'created.txt')
    const content = Buffer.from('wrong file id test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    const request = requestFor('created.txt', created, rootEvidence)
    request.expectedFileId128Hex = flipFirstHexChar(created.nativeFileId128Hex)

    expect(() => recoverDeleteCreated(request)).toThrowError(/PRECONDITION_FAILED/)
    expect(fs.existsSync(targetPath)).toBe(true)
    expect(fs.readFileSync(targetPath)).toEqual(content)
  })

  it('3. wrong expected volume serial: FAILS closed (PRECONDITION_FAILED), file remains', () => {
    const targetPath = path.join(root, 'created.txt')
    const content = Buffer.from('wrong volume serial test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    const request = requestFor('created.txt', created, rootEvidence)
    request.expectedVolumeSerial = (BigInt(created.nativeVolumeSerial) + 1n).toString()

    expect(() => recoverDeleteCreated(request)).toThrowError(/PRECONDITION_FAILED/)
    expect(fs.existsSync(targetPath)).toBe(true)
    expect(fs.readFileSync(targetPath)).toEqual(content)
  })

  it('4. wrong expected SHA-256: FAILS closed (PRECONDITION_FAILED), file remains', () => {
    const targetPath = path.join(root, 'created.txt')
    const content = Buffer.from('wrong sha256 test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    const request = requestFor('created.txt', created, rootEvidence)
    request.expectedSha256Hex = flipLastHexChar(created.sha256Hex)

    expect(() => recoverDeleteCreated(request)).toThrowError(/PRECONDITION_FAILED/)
    expect(fs.existsSync(targetPath)).toBe(true)
    expect(fs.readFileSync(targetPath)).toEqual(content)
  })

  it('5. wrong expected length: FAILS closed (PRECONDITION_FAILED), file remains', () => {
    const targetPath = path.join(root, 'created.txt')
    const content = Buffer.from('wrong length test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    const request = requestFor('created.txt', created, rootEvidence)
    request.expectedLength = created.length + 1

    expect(() => recoverDeleteCreated(request)).toThrowError(/PRECONDITION_FAILED/)
    expect(fs.existsSync(targetPath)).toBe(true)
    expect(fs.readFileSync(targetPath)).toEqual(content)
  })

  it('6. root identity mismatch: FAILS closed (PRECONDITION_FAILED), file remains', () => {
    const targetPath = path.join(root, 'created.txt')
    const content = Buffer.from('root mismatch test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    const request = requestFor('created.txt', created, rootEvidence)
    request.expectedRootFileId128Hex = flipFirstHexChar(rootEvidence.nativeFileId128Hex)

    expect(() => recoverDeleteCreated(request)).toThrowError(/PRECONDITION_FAILED/)
    expect(fs.existsSync(targetPath)).toBe(true)
  })

  it('6b. wrong expected root volume serial (value, not format): FAILS closed (PRECONDITION_FAILED), file remains', () => {
    const targetPath = path.join(root, 'created.txt')
    const content = Buffer.from('root volume serial mismatch test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    const request = requestFor('created.txt', created, rootEvidence)
    request.expectedRootVolumeSerial = (BigInt(rootEvidence.nativeVolumeSerial) + 1n).toString()

    expect(() => recoverDeleteCreated(request)).toThrowError(/PRECONDITION_FAILED/)
    expect(fs.existsSync(targetPath)).toBe(true)
  })

  it('7. target replaced before acquisition: stale expected identity no longer matches, replacement remains', () => {
    const targetPath = path.join(root, 'created.txt')
    const originalContent = Buffer.from('original object\n')
    const { created: originalCreated, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', originalContent)
    // An external tool removes the original object and creates a brand-new
    // one at the exact same path before recovery ever runs.
    fs.unlinkSync(targetPath)
    const replacementContent = Buffer.from('replacement object\n')
    fs.writeFileSync(targetPath, replacementContent)

    const request = requestFor('created.txt', originalCreated, rootEvidence)
    expect(() => recoverDeleteCreated(request)).toThrowError(/PRECONDITION_FAILED/)
    expect(fs.readFileSync(targetPath)).toEqual(replacementContent)
  })

  it('8. byte-identical replacement has a DIFFERENT native identity: FAILS, replacement remains', () => {
    const targetPath = path.join(root, 'created.txt')
    const content = Buffer.from('identical bytes replacement test\n')
    const { created: originalCreated, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    fs.unlinkSync(targetPath)
    // SAME bytes, but a brand-new NTFS file object at the same path -> a
    // different native FILE_ID_INFO, even though content/length/hash match.
    fs.writeFileSync(targetPath, content)

    const request = requestFor('created.txt', originalCreated, rootEvidence)
    expect(() => recoverDeleteCreated(request)).toThrowError(/PRECONDITION_FAILED/)
    expect(fs.existsSync(targetPath)).toBe(true)
    expect(fs.readFileSync(targetPath)).toEqual(content)
  })

  let canCreateFileSymlink = false
  beforeAll(() => {
    if (!IS_WINDOWS) return
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-recdel-symlink-probe-'))
    try {
      fs.writeFileSync(path.join(probeDir, 't.txt'), 'x')
      fs.symlinkSync(path.join(probeDir, 't.txt'), path.join(probeDir, 'l.txt'), 'file')
      canCreateFileSymlink = true
    } catch {
      canCreateFileSymlink = false
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true })
    }
  })

  it('9. target replaced by a reparse point (file symlink): FAILS CLOSED (REPARSE_REJECTED) - requires Developer Mode/elevation', (ctx) => {
    if (!canCreateFileSymlink) {
      ctx.skip()
      return
    }
    const targetPath = path.join(root, 'created.txt')
    const content = Buffer.from('reparse recovery test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    fs.unlinkSync(targetPath)
    const realElsewhere = path.join(root, 'elsewhere.txt')
    fs.writeFileSync(realElsewhere, content)
    fs.symlinkSync(realElsewhere, targetPath, 'file')

    const request = requestFor('created.txt', created, rootEvidence)
    expect(() => recoverDeleteCreated(request)).toThrowError(/REPARSE_REJECTED/)
    // The reparse point itself AND its real target must both survive - the
    // symlink is never followed/deleted transparently.
    expect(fs.existsSync(realElsewhere)).toBe(true)
    expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true)
  })

  it('10. hardlink policy: a hardlinked object is rejected (HARDLINK_REJECTED), preserving accepted B.0 policy', () => {
    const targetPath = path.join(root, 'created.txt')
    const linkPath = path.join(root, 'linked.txt')
    const content = Buffer.from('hardlink recovery test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    fs.linkSync(targetPath, linkPath)
    expect(fs.statSync(targetPath).nlink).toBeGreaterThan(1)

    const request = requestFor('created.txt', created, rootEvidence)
    expect(() => recoverDeleteCreated(request)).toThrowError(/HARDLINK_REJECTED/)
    expect(fs.existsSync(targetPath)).toBe(true)
    expect(fs.existsSync(linkPath)).toBe(true)
  })

  // M4.8B.2A V2 (independent-review fix) - recovery_delete.cc now performs a
  // SECOND, back-to-back link-count/identity recheck from the same handle
  // immediately before the delete call, mirroring B.0's own accepted
  // minimum-window mitigation for the identical empirically-proven
  // CreateHardLinkW-under-share=0 race (see lease.cc's ApplyModify/
  // CreateFileEntry "V2 hardening" comments). The test above (10) proves the
  // hardlink-rejection LOGIC works correctly against a real hardlink fixture
  // - since the early check and the late recheck run the exact same
  // CaptureNativeIdentity + linkCount>1 logic, that same real-fixture proof
  // applies to the late recheck too.
  //
  // A test that isolates ONLY the late recheck (i.e. a hardlink created
  // strictly AFTER the early check but strictly BEFORE the late recheck,
  // with content already read/hashed in between) is NOT built here: doing
  // so deterministically would require pausing the native call mid-
  // execution to let an external process race in - recoverDeleteCreated is
  // a single, one-shot, atomic synchronous call with no lease object and no
  // multi-step API to attach a fault point to (unlike Lease's per-entry
  // FaultPoint mechanism, which exists only because ApplyModify/
  // CreateFileEntry/RollbackFile are already separate calls against a
  // long-lived lease). Adding a pause/synchronization point just for this
  // one test would mean either a new production-accessible test hook, or a
  // second internal call-shape solely for testing - both disproportionate
  // to a race the frozen threat model already does not claim immunity to
  // (see recovery_delete.h: "not a claim of immunity to a deliberately
  // malicious same-user race"). The code-level back-to-back recheck is the
  // actual fix; further adversarial timing analysis of this exact window is
  // left to the planned independent Codex review, per the review brief.

  it('11. competing external process: an external holder BEFORE our attempt causes BUSY; after release, recovery succeeds', async () => {
    const targetPath = path.join(root, 'created.txt')
    const content = Buffer.from('competing process recovery test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    const request = requestFor('created.txt', created, rootEvidence)

    const holder = startHoldingFixture('hold-read', targetPath)
    const readyLine = await holder.waitReady()
    expect(readyLine).toBe('READY')

    expect(() => recoverDeleteCreated(request)).toThrowError(/BUSY/)
    expect(fs.existsSync(targetPath)).toBe(true)

    await holder.release()
    const result = recoverDeleteCreated(request)
    expect(result.code).toBe('OK')
    expect(fs.existsSync(targetPath)).toBe(false)
  })

  it('12. missing/malformed identity evidence is rejected at the boundary (INVALID_PLAN) before any native mutation', () => {
    const targetPath = path.join(root, 'created.txt')
    const content = Buffer.from('malformed evidence test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    const base = requestFor('created.txt', created, rootEvidence)

    expect(() => recoverDeleteCreated({ ...base, expectedFileId128Hex: 'short' })).toThrowError(/INVALID_PLAN/)
    expect(() => recoverDeleteCreated({ ...base, expectedFileId128Hex: created.nativeFileId128Hex.toUpperCase() })).toThrowError(
      /INVALID_PLAN/
    )
    expect(() => recoverDeleteCreated({ ...base, expectedVolumeSerial: 'not-a-number' })).toThrowError(/INVALID_PLAN/)
    expect(() => recoverDeleteCreated({ ...base, expectedVolumeSerial: '-1' })).toThrowError(/INVALID_PLAN/)
    // Exactly 20 digits (ULLONG_MAX itself has 20 digits) but numerically
    // larger than ULLONG_MAX (18446744073709551615) - must be rejected by
    // ParseDecimalUint64's overflow check, never silently wrapped/truncated.
    expect(() => recoverDeleteCreated({ ...base, expectedVolumeSerial: '99999999999999999999' })).toThrowError(/INVALID_PLAN/)
    // More than 20 digits - rejected by the length bound before any digit
    // folding/overflow arithmetic even runs.
    expect(() => recoverDeleteCreated({ ...base, expectedVolumeSerial: '123456789012345678901' })).toThrowError(/INVALID_PLAN/)
    expect(() => recoverDeleteCreated({ ...base, expectedSha256Hex: created.sha256Hex.toUpperCase() })).toThrowError(/INVALID_PLAN/)
    expect(() => recoverDeleteCreated({ ...base, expectedSha256Hex: 'abc' })).toThrowError(/INVALID_PLAN/)
    expect(() => recoverDeleteCreated({ ...base, expectedLength: -1 })).toThrowError(/INVALID_PLAN/)
    expect(() => recoverDeleteCreated({ ...base, expectedLength: 1.5 })).toThrowError(/INVALID_PLAN/)

    const missingField = { ...base } as Partial<WindowsSafeApplyRecoverDeleteCreatedRequest>
    delete missingField.expectedRootFileId128Hex
    expect(() => recoverDeleteCreated(missingField as WindowsSafeApplyRecoverDeleteCreatedRequest)).toThrowError(/INVALID_PLAN/)

    expect(fs.existsSync(targetPath)).toBe(true)
    expect(fs.readFileSync(targetPath)).toEqual(content)
  })

  it('13. invalid relative target paths are rejected (reuses the existing path validator)', () => {
    const content = Buffer.from('invalid path test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    const base = requestFor('created.txt', created, rootEvidence)

    expect(() => recoverDeleteCreated({ ...base, relPath: '../escape.txt' })).toThrowError(/UNSUPPORTED_PATH/)
    expect(() => recoverDeleteCreated({ ...base, relPath: 'C:\\absolute.txt' })).toThrowError(/UNSUPPORTED_PATH/)
    expect(() => recoverDeleteCreated({ ...base, relPath: '' })).toThrowError(/INVALID_PLAN/)

    expect(fs.existsSync(path.join(root, 'created.txt'))).toBe(true)
  })

  it('14. root does not exist / path does not resolve to the target: FAILS closed (NOT_FOUND), never treated as success', () => {
    const content = Buffer.from('not found test\n')
    const { created, rootEvidence } = createFixtureAndCaptureEvidence('created.txt', content)
    const request = requestFor('does-not-exist.txt', created, rootEvidence)

    expect(() => recoverDeleteCreated(request)).toThrowError(/NOT_FOUND/)
  })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - recoverDeleteCreated production-shape parity (M4.8B.2A)', () => {
  interface RawNativeAddonWithRecovery {
    prepareLease: (plan: unknown) => { lease: unknown; root: WindowsSafeApplyOutcome }
    createFile: (lease: unknown, index: number) => WindowsSafeApplyOutcome
    closeLease: (lease: unknown) => void
    recoverDeleteCreated?: (request: unknown) => WindowsSafeApplyOutcome
    setFaultPoint?: unknown
  }

  it('15a. the production-shaped build exports recoverDeleteCreated (a legitimate primitive) but still omits setFaultPoint', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const productionBuild = require(PRODUCTION_BUILD_PATH) as RawNativeAddonWithRecovery
    expect(typeof productionBuild.recoverDeleteCreated).toBe('function')
    expect(productionBuild.setFaultPoint).toBeUndefined()
    expect(Object.keys(productionBuild)).toContain('recoverDeleteCreated')
    expect(Object.keys(productionBuild)).not.toContain('setFaultPoint')
  })

  it('15b. the production-shaped build performs a real end-to-end recoverDeleteCreated', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const productionBuild = require(PRODUCTION_BUILD_PATH) as Required<RawNativeAddonWithRecovery>
    const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-recdel-prodshape-'))
    try {
      const content = Buffer.from('production-shape recovery delete\n')
      const targetPath = path.join(prodRoot, 'created.txt')
      const prep = productionBuild.prepareLease({ root: prodRoot, creates: [{ path: 'created.txt', proposedBytes: content }] })
      const created = productionBuild.createFile(prep.lease, 0)
      const rootEvidence = prep.root
      productionBuild.closeLease(prep.lease)
      expect(fs.existsSync(targetPath)).toBe(true)

      const result = productionBuild.recoverDeleteCreated({
        root: prodRoot,
        relPath: 'created.txt',
        expectedRootVolumeSerial: rootEvidence.nativeVolumeSerial,
        expectedRootFileId128Hex: rootEvidence.nativeFileId128Hex,
        expectedVolumeSerial: created.nativeVolumeSerial,
        expectedFileId128Hex: created.nativeFileId128Hex,
        expectedSha256Hex: created.sha256Hex,
        expectedLength: created.length
      })
      expect(result.code).toBe('OK')
      expect(fs.existsSync(targetPath)).toBe(false)
    } finally {
      fs.rmSync(prodRoot, { recursive: true, force: true })
    }
  })
})
