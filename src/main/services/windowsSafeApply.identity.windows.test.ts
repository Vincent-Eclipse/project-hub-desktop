// Meilenstein 4.8B.0 - vergleicht die STARKE native Windows-Identitaet
// (FILE_ID_INFO: Volume-Seriennummer + 128-bit FileId, ueber das native Modul
// waehrend einer gehaltenen guarded-Lease erfasst) mit Nodes EIGENER
// bigint-Stat-Identitaet (dev/ino, wie sie bereits seit M4.8A in
// ProjectTextFileIdentityEvidence/CodeChangeRootIdentityEvidence verwendet
// wird), fuer DIESELBE Datei. Ziel: eine ehrliche, empirische Aussage
// treffen (siehe Abschlussbericht), NICHT die M4.8A-Provenienz-Codebasis
// anzupassen.
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { prepareLease, closeLease, type WindowsSafeApplyPlan } from './windowsSafeApply'

const IS_WINDOWS = process.platform === 'win32'

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - native identity vs. Node dev/ino (M4.8A comparison)', () => {
  it('captures both identities for the SAME file and records the observed mapping', async () => {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'wsa-identity-'))
    try {
      const original = Buffer.from('identity comparison fixture\n')
      const targetPath = path.join(root, 'a.txt')
      fsSync.writeFileSync(targetPath, original)

      // (A) Node's own bigint stat identity - exactly the fields captured by
      // ProjectTextFileIdentityEvidence in projectTextReadService.ts.
      const handle = await fs.open(targetPath, 'r')
      const nodeStat = await handle.stat({ bigint: true })
      await handle.close()
      const nodeIdentity = { dev: nodeStat.dev.toString(), ino: nodeStat.ino.toString() }

      // (B) The new native identity, captured while our own guarded lease
      // holds an exclusive handle to the SAME file.
      const plan: WindowsSafeApplyPlan = {
        root,
        modifies: [
          { path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: original }
        ]
      }
      const prep = prepareLease(plan)
      const nativeIdentity = prep.modifies[0]
      closeLease(prep.lease)

      // eslint-disable-next-line no-console
      console.log('[M4.8B.0 identity mapping]', {
        node: nodeIdentity,
        native: { volumeSerial: nativeIdentity.nativeVolumeSerial, fileId128Hex: nativeIdentity.nativeFileId128Hex }
      })

      // Both must actually be present (never fabricated/empty).
      expect(nodeIdentity.dev).not.toBeNull()
      expect(nodeIdentity.ino).not.toBeNull()
      expect(nativeIdentity.nativeVolumeSerial.length).toBeGreaterThan(0)
      expect(nativeIdentity.nativeFileId128Hex).toHaveLength(32)

      // Node's bigint ino, reinterpreted, is documented (Node/libuv source)
      // to be the low 64 bits of NTFS's 128-bit file reference number for a
      // BY_HANDLE-style identity on Windows - the SAME low-order bytes this
      // native module's FILE_ID_INFO.FileId carries in its first 8 bytes
      // (little-endian). This assertion is the actual empirical proof point
      // for the M4.8A dev/ino <-> native-identity comparison required by
      // this milestone.
      const nativeLow64Hex = nativeIdentity.nativeFileId128Hex.slice(0, 16)
      const nativeLow64BigIntLE = Buffer.from(nativeLow64Hex, 'hex').reverse().toString('hex')
      const nativeLow64AsBigInt = BigInt('0x' + (nativeLow64BigIntLE || '0'))
      const nodeInoAsBigInt = BigInt(nodeIdentity.ino ?? '0')
      expect(nativeLow64AsBigInt).toBe(nodeInoAsBigInt)
    } finally {
      fsSync.rmSync(root, { recursive: true, force: true })
    }
  })

  it('documents that dev (Node) and volumeSerial (native) are DIFFERENT numeric encodings of the same physical volume', async () => {
    // This is an honesty check, not a numeric-equality check: Node's `dev`
    // on Windows is NOT the raw NTFS volume serial number (it is derived
    // differently internally by libuv) - so this test asserts only that
    // BOTH are stable, non-zero identifiers for repeated stats/opens of
    // files on the SAME volume, never that they are numerically equal.
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'wsa-identity2-'))
    try {
      fsSync.writeFileSync(path.join(root, 'a.txt'), 'a')
      fsSync.writeFileSync(path.join(root, 'b.txt'), 'b')

      const ha = await fs.open(path.join(root, 'a.txt'), 'r')
      const statA = await ha.stat({ bigint: true })
      await ha.close()
      const hb = await fs.open(path.join(root, 'b.txt'), 'r')
      const statB = await hb.stat({ bigint: true })
      await hb.close()

      expect(statA.dev).toBe(statB.dev) // same volume -> same Node dev for both files

      const planA: WindowsSafeApplyPlan = {
        root,
        modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(Buffer.from('a')), expectedLength: 1, proposedBytes: Buffer.from('a') }]
      }
      const planB: WindowsSafeApplyPlan = {
        root,
        modifies: [{ path: 'b.txt', expectedSha256Hex: sha256(Buffer.from('b')), expectedLength: 1, proposedBytes: Buffer.from('b') }]
      }
      const prepA = prepareLease(planA)
      const serialA = prepA.modifies[0].nativeVolumeSerial
      closeLease(prepA.lease)
      const prepB = prepareLease(planB)
      const serialB = prepB.modifies[0].nativeVolumeSerial
      closeLease(prepB.lease)

      expect(serialA).toBe(serialB) // same volume -> same native volume serial for both files
    } finally {
      fsSync.rmSync(root, { recursive: true, force: true })
    }
  })
})
