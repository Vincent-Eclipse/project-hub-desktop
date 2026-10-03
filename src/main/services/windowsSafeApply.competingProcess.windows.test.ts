// Meilenstein 4.8B.0 - Windows-only Tests gegen einen ECHTEN, separaten
// konkurrierenden Prozess (native/windows-safe-apply/fixtures/
// competingProcessFixture.js) - ein kleines, FEST verdrahtetes Fixture,
// niemals eine generische Kommando-Bruecke. Synchronisation ausschliesslich
// ueber deterministische stdout/stdin-Zeilen-Barrieren, NIE ueber sleep().
//
// Jedes Ergebnis unten ist entweder (a) unsere eigene Lease-Beschaffung
// schlaegt VOR jeder Mutation fehl, oder (b) die konkurrierende externe
// Operation schlaegt fehl, waehrend wir halten - ein stilles gleichzeitiges
// Ueberschreiben ist in KEINEM Szenario ein akzeptables Ergebnis.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareLease, applyModify, createFile, verifyFile, closeLease, type WindowsSafeApplyPlan } from './windowsSafeApply'

const IS_WINDOWS = process.platform === 'win32'
const FIXTURE_PATH = path.join(__dirname, '..', '..', '..', 'native', 'windows-safe-apply', 'fixtures', 'competingProcessFixture.js')

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function runFixtureOnce(mode: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE_PATH, mode, ...args])
    const rl = readline.createInterface({ input: child.stdout })
    let resolved = false
    rl.once('line', (line) => {
      resolved = true
      resolve(line)
    })
    child.once('error', reject)
    child.once('exit', () => {
      if (!resolved) reject(new Error(`fixture exited with no output (mode=${mode})`))
    })
  })
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

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-competing-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - competing external process scenarios (9 named cases)', () => {
  it('1. other-process-read: an ordinary external read fails while our exclusive MODIFY lease is held', async () => {
    const original = Buffer.from('content\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }]
    }
    const prep = prepareLease(plan)
    const line = await runFixtureOnce('attempt-read', targetPath)
    expect(line).toMatch(/^FAILED:/)
    closeLease(prep.lease)
  })

  it('2. other-process-write: an ordinary external write fails while our exclusive MODIFY lease is held', async () => {
    const original = Buffer.from('content\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }]
    }
    const prep = prepareLease(plan)
    const line = await runFixtureOnce('attempt-write', targetPath)
    expect(line).toMatch(/^FAILED:/)
    closeLease(prep.lease)
  })

  it('3. other-process-write-after-our-lease: an ordinary external write succeeds normally once our lease is released', async () => {
    const original = Buffer.from('content\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }]
    }
    const prep = prepareLease(plan)
    applyModify(prep.lease, 0)
    closeLease(prep.lease)
    const line = await runFixtureOnce('attempt-write', targetPath)
    expect(line).toBe('OK')
  })

  it('4a. other-process-delete-while-active: an external delete of the MODIFY target fails WHILE the lease is still active (not just checked after close)', async () => {
    const original = Buffer.from('content\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }]
    }
    const prep = prepareLease(plan)
    const deleteLine = await runFixtureOnce('attempt-delete', targetPath)
    expect(deleteLine).toMatch(/^FAILED:/)
    // Exact bytes/identity remain unchanged after the failed attempt.
    const verify = verifyFile(prep.lease, 0, false)
    expect(verify.sha256Hex).toBe(sha256(original))
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(original)
  })

  it('4b. other-process-rename-while-active: an external rename of the MODIFY target fails WHILE the lease is still active (not just checked after close)', async () => {
    const original = Buffer.from('content\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }]
    }
    const prep = prepareLease(plan)
    const renameLine = await runFixtureOnce('attempt-rename', targetPath, path.join(root, 'a-renamed.txt'))
    expect(renameLine).toMatch(/^FAILED:/)
    const verify = verifyFile(prep.lease, 0, false)
    expect(verify.sha256Hex).toBe(sha256(original))
    closeLease(prep.lease)
    expect(fs.existsSync(targetPath)).toBe(true)
    expect(fs.existsSync(path.join(root, 'a-renamed.txt'))).toBe(false)
  })

  it('4c. other-process-delete/rename-after-our-lease: external delete+rename succeed normally once our lease is released', async () => {
    const original = Buffer.from('content\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }]
    }
    const prep = prepareLease(plan)
    applyModify(prep.lease, 0)
    closeLease(prep.lease)

    const otherPath = path.join(root, 'b.txt')
    fs.writeFileSync(otherPath, 'to be deleted\n')
    const deleteLine = await runFixtureOnce('attempt-delete', otherPath)
    expect(deleteLine).toBe('OK')

    const renameLine = await runFixtureOnce('attempt-rename', targetPath, path.join(root, 'a-renamed.txt'))
    expect(renameLine).toBe('OK')
  })

  it('5. other-process-CREATE-collision: an external process creates the file first; our CREATE_NEW fails closed (PRECONDITION_FAILED)', async () => {
    const targetPath = path.join(root, 'new.txt')
    const createLine = await runFixtureOnce('attempt-write-file', targetPath, 'external content\n')
    expect(createLine).toBe('OK')

    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'new.txt', proposedBytes: Buffer.from('our content\n') }] }
    const prep = prepareLease(plan)
    expect(() => createFile(prep.lease, 0)).toThrowError(/PRECONDITION_FAILED/)
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('external content\n')
  })

  it('6. other-process-parent-rename-after-parent-guard: external rename of the guarded parent directory fails while a lease under it is held', async () => {
    fs.mkdirSync(path.join(root, 'sub'))
    fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'x\n')
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'sub/new.txt', proposedBytes: Buffer.from('y\n') }] }
    const prep = prepareLease(plan)
    const renameLine = await runFixtureOnce('attempt-rename', path.join(root, 'sub'), path.join(root, 'sub-renamed'))
    expect(renameLine).toMatch(/^FAILED:/)
    closeLease(prep.lease)
  })

  it('7. editor-style replace-save simulation: an external "write-temp-then-rename-over" save fails while our lease holds the target', async () => {
    const original = Buffer.from('original\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('ours\n') }]
    }
    const prep = prepareLease(plan)
    const line = await runFixtureOnce('editor-safe-save', targetPath, 'editor content\n')
    expect(line).toMatch(/^FAILED:/)
    closeLease(prep.lease)
  })

  it('8. context-only-reader-while-guard-held: an ordinary external READ of a "source" file succeeds while we hold our GENERIC_READ+FILE_SHARE_READ context guard', async () => {
    const sourcePath = path.join(root, 'source.txt')
    fs.writeFileSync(sourcePath, 'source content\n')
    const plan: WindowsSafeApplyPlan = { root, sources: [{ path: 'source.txt' }] }
    const prep = prepareLease(plan)
    const line = await runFixtureOnce('attempt-read', sourcePath)
    expect(line).toBe('OK')
    closeLease(prep.lease)
  })

  it('9. context-only-writer-while-guard-held: an ordinary external WRITE to a "source" file fails while we hold our GENERIC_READ+FILE_SHARE_READ context guard', async () => {
    const sourcePath = path.join(root, 'source.txt')
    fs.writeFileSync(sourcePath, 'source content\n')
    const plan: WindowsSafeApplyPlan = { root, sources: [{ path: 'source.txt' }] }
    const prep = prepareLease(plan)
    const line = await runFixtureOnce('attempt-write', sourcePath)
    expect(line).toMatch(/^FAILED:/)
    closeLease(prep.lease)
  })
})

// V2 hardening: empirically, CreateHardLinkW against a target succeeds even
// while this module's exclusive share=0 handle is held on it (confirmed by
// direct experiment during V2 review) - share-mode arbitration blocks
// read/write access through ANY name resolving to the same underlying file
// object, but does NOT block a NEW name (hardlink) being created for that
// object. This is a REAL, disclosed gap in what share=0 alone guarantees -
// see M4.8B0-REVIEW-v2.md's residual-limitations section. The mitigation
// implemented is a link-count re-check via the SAME held handle immediately
// before the first potentially-mutating write (in ApplyModify/
// CreateFileEntry) - these tests prove that mitigation catches a hardlink
// created in the realistically-testable window (between prepareLease/
// createFile succeeding and the next call that would mutate).
describe.skipIf(!IS_WINDOWS)('windowsSafeApply - hardlink-creation race (external CreateHardLinkW during an active lease)', () => {
  it('a hardlink created between prepareLease and applyModify is caught by the pre-write re-check (HARDLINK_REJECTED, no mutation)', async () => {
    const original = Buffer.from('modify target for hardlink race\n')
    const targetPath = path.join(root, 'target.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'target.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('mutated\n') }
      ]
    }
    const prep = prepareLease(plan)

    const linkLine = await runFixtureOnce('attempt-hardlink', targetPath, path.join(root, 'alias.txt'))
    // Documents the actual (surprising) Windows behavior: hardlink CREATION
    // is not blocked by share=0. This assertion is intentionally about what
    // Windows does, not what would be "nicer".
    expect(linkLine).toBe('OK')

    expect(() => applyModify(prep.lease, 0)).toThrowError(/HARDLINK_REJECTED/)
    const verify = verifyFile(prep.lease, 0, false)
    expect(verify.sha256Hex).toBe(sha256(original)) // provably no mutation occurred
    closeLease(prep.lease)
    expect(fs.readFileSync(targetPath)).toEqual(original)
  })

  it('a hardlink created against the target does NOT itself gain read/write access while our lease is held (share-mode is keyed to the file object, not the path)', async () => {
    const original = Buffer.from('modify target for hardlink race 2\n')
    const targetPath = path.join(root, 'target.txt')
    fs.writeFileSync(targetPath, original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'target.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('mutated\n') }
      ]
    }
    const prep = prepareLease(plan)
    const aliasPath = path.join(root, 'alias.txt')
    const linkLine = await runFixtureOnce('attempt-hardlink', targetPath, aliasPath)
    expect(linkLine).toBe('OK')

    const readLine = await runFixtureOnce('attempt-read', aliasPath)
    expect(readLine).toMatch(/^FAILED:/)
    const writeLine = await runFixtureOnce('attempt-write', aliasPath)
    expect(writeLine).toMatch(/^FAILED:/)

    closeLease(prep.lease)
  })

  it('CREATE: normal creation still succeeds end-to-end with the pre-write hardlink re-check present (no regression)', async () => {
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'new.txt', proposedBytes: Buffer.from('created content\n') }] }
    const prep = prepareLease(plan)
    const result = createFile(prep.lease, 0)
    expect(result.code).toBe('OK')
    closeLease(prep.lease)
    expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('created content\n')
  })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - deterministic race ordering (both directions, no sleep-based timing)', () => {
  it('a held external reader BEFORE our lease attempt causes our exclusive MODIFY acquisition to fail closed as BUSY', async () => {
    const original = Buffer.from('content\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)

    const holder = startHoldingFixture('hold-read', targetPath)
    const readyLine = await holder.waitReady()
    expect(readyLine).toBe('READY')

    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }]
    }
    // The fixture's ordinary read handle uses Node's default (permissive)
    // sharing, so our exclusive share=0 acquisition attempt must fail
    // BEFORE any mutation happens - proving lease-acquisition-fails-closed
    // is reachable from the other temporal direction too (external-holds-
    // first, we-attempt-second), not just the reverse tested above.
    expect(() => prepareLease(plan)).toThrowError(/BUSY/)
    expect(fs.readFileSync(targetPath)).toEqual(original)

    await holder.release()
  })

  it('once the external holder releases, our lease acquisition succeeds (ordering is deterministic, not timing-based)', async () => {
    const original = Buffer.from('content\n')
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, original)

    const holder = startHoldingFixture('hold-write', targetPath)
    await holder.waitReady()

    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }]
    }
    expect(() => prepareLease(plan)).toThrowError(/BUSY/)

    await holder.release() // deterministic signal, not a sleep - resolves only once the child has actually closed its handle

    const prep = prepareLease(plan)
    expect(applyModify(prep.lease, 0).code).toBe('OK')
    closeLease(prep.lease)
  })
})
