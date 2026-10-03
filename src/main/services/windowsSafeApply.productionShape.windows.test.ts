// Meilenstein 4.8B.0 V2 - beweist, dass der PRODUCTION-foermige Build
// (windows_safe_apply_production.node, kompiliert aus DENSELBEN
// lease.cc/win_path.cc/win_identity.cc/napi_entry.cc-Quelldateien wie der
// Test-Build, aber OHNE das WSA_ENABLE_TEST_HOOKS-Define - siehe binding.gyp)
// den Fault-Injection-Hook (setFaultPoint) und den Case-Sensitivity-Test-Hook
// (setForceCaseSensitiveForTests) UEBERHAUPT NICHT exportiert, waehrend der
// normale Test-Build (windows_safe_apply.node) beide exportiert und der
// echte Mutations-Code in BEIDEN Builds identisch funktioniert (kein
// zweiter, separater Mutations-Pfad).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect } from 'vitest'

const IS_WINDOWS = process.platform === 'win32'
const TEST_BUILD_PATH = path.join(__dirname, '..', '..', '..', 'native', 'windows-safe-apply', 'build', 'Release', 'windows_safe_apply.node')
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

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

interface RawNativeAddon {
  platformSupported: boolean
  prepareLease: (plan: unknown) => { lease: unknown; root: { code: string }; modifies: unknown[] }
  applyModify: (lease: unknown, index: number) => { code: string; sha256Hex: string }
  createFile: (lease: unknown, index: number) => { code: string; sha256Hex: string }
  closeLease: (lease: unknown) => void
  setFaultPoint?: unknown
  setForceCaseSensitiveForTests?: unknown
}

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - production-shaped build omits test hooks (V2)', () => {
  it('the test build exports setFaultPoint and setForceCaseSensitiveForTests', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const testBuild = require(TEST_BUILD_PATH) as RawNativeAddon
    expect(typeof testBuild.setFaultPoint).toBe('function')
    expect(typeof testBuild.setForceCaseSensitiveForTests).toBe('function')
  })

  it('the production-shaped build does NOT export setFaultPoint or setForceCaseSensitiveForTests at all', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const productionBuild = require(PRODUCTION_BUILD_PATH) as RawNativeAddon
    expect(productionBuild.setFaultPoint).toBeUndefined()
    expect(productionBuild.setForceCaseSensitiveForTests).toBeUndefined()
    expect(Object.keys(productionBuild)).not.toContain('setFaultPoint')
    expect(Object.keys(productionBuild)).not.toContain('setForceCaseSensitiveForTests')
  })

  it('the production-shaped build still runs the EXACT SAME real mutation code correctly (MODIFY + CREATE)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const productionBuild = require(PRODUCTION_BUILD_PATH) as RawNativeAddon
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-prodshape-'))
    try {
      const original = Buffer.from('production-shape original\n')
      fs.writeFileSync(path.join(root, 'a.txt'), original)
      const proposed = Buffer.from('production-shape mutated\n')
      const prep = productionBuild.prepareLease({
        root,
        modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: proposed }],
        creates: [{ path: 'new.txt', proposedBytes: Buffer.from('production-shape created\n') }]
      })
      expect(prep.root.code).toBe('OK')
      const modifyResult = productionBuild.applyModify(prep.lease, 0)
      expect(modifyResult.code).toBe('OK')
      const createResult = productionBuild.createFile(prep.lease, 0)
      expect(createResult.code).toBe('OK')
      productionBuild.closeLease(prep.lease)

      expect(fs.readFileSync(path.join(root, 'a.txt'))).toEqual(proposed)
      expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('production-shape created\n')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
