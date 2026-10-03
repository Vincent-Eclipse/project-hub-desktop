// Meilenstein 4.8B.0 V2 - beweist, dass die N-API-Grenze (napi_entry.cc's
// ParsePlan) uebergrosse/fehlerhafte Eingaben VOR jeder Array-Iteration bzw.
// Buffer-Kopie ablehnt - nicht erst spaeter in Lease::Prepare. Jeder Test
// hier bezieht sich auf einen konkreten Grenzwert aus lease.h
// (kMaxEntriesPerKind=16, kMaxProposedBytes=1 MiB) bzw. das neue
// Format-Erfordernis fuer expectedSha256Hex/expectedLength.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareLease, closeLease, type WindowsSafeApplyPlan } from './windowsSafeApply'

const IS_WINDOWS = process.platform === 'win32'
const NATIVE_ADDON_PATH = path.join(__dirname, '..', '..', '..', 'native', 'windows-safe-apply', 'build', 'Release', 'windows_safe_apply.node')

interface RawPrepareResult {
  lease: unknown
  root: { code: string }
}
interface RawNativeAddon {
  prepareLease: (plan: unknown) => RawPrepareResult
  closeLease: (lease: unknown) => void
}

// The three "malformed top-level array field" tests below call the native
// addon DIRECTLY, bypassing the friendly TS wrapper's toNativePlan(), which
// itself calls .map() on plan.modifies/sources/creates - so a non-array
// value there throws a plain TypeError from the WRAPPER before the native
// N-API boundary (napi_entry.cc's ParsePlan/GetOptionalArray) is ever
// reached. That wrapper behavior is a reasonable, additional layer of
// defense-in-depth, but these specific tests are about proving the NATIVE
// boundary itself rejects a malformed (present-but-wrong-type) field, so
// they need the unmediated native call.
function rawNativeAddon(): RawNativeAddon {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(NATIVE_ADDON_PATH) as RawNativeAddon
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-bounds-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - N-API input-boundary hardening (V2)', () => {
  it('rejects more than kMaxEntriesPerKind (16) creates BEFORE iterating/copying any of them', () => {
    const creates = Array.from({ length: 17 }, (_, i) => ({ path: `f${i}.txt`, proposedBytes: Buffer.from('x') }))
    const plan: WindowsSafeApplyPlan = { root, creates }
    expect(() => prepareLease(plan)).toThrowError(/INVALID_PLAN/)
    // Nothing should have been created - the array was rejected before any
    // per-entry work began.
    expect(fs.readdirSync(root)).toHaveLength(0)
  })

  it('accepts exactly kMaxEntriesPerKind (16) creates', () => {
    const creates = Array.from({ length: 16 }, (_, i) => ({ path: `f${i}.txt`, proposedBytes: Buffer.from('x') }))
    const plan: WindowsSafeApplyPlan = { root, creates }
    const prep = prepareLease(plan)
    expect(prep.root.code).toBe('OK')
    closeLease(prep.lease)
  })

  it('rejects a proposedBytes Buffer larger than the 1 MiB fixture-only bound BEFORE copying it into a std::vector', () => {
    const oversized = Buffer.alloc(1024 * 1024 + 1)
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'huge.txt', proposedBytes: oversized }] }
    expect(() => prepareLease(plan)).toThrowError(/INVALID_PLAN/)
    expect(fs.existsSync(path.join(root, 'huge.txt'))).toBe(false)
  })

  it('accepts a proposedBytes Buffer at exactly the 1 MiB bound', () => {
    const atBound = Buffer.alloc(1024 * 1024, 0x41)
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'atbound.txt', proposedBytes: atBound }] }
    const prep = prepareLease(plan)
    expect(prep.root.code).toBe('OK')
    closeLease(prep.lease)
  })

  it('rejects a non-64-character expectedSha256Hex', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: 'abc', expectedLength: 1, proposedBytes: Buffer.from('y') }]
    }
    expect(() => prepareLease(plan)).toThrowError(/INVALID_PLAN/)
  })

  it('rejects an uppercase-hex expectedSha256Hex (must be exact lowercase hex)', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'a.txt', expectedSha256Hex: sha256(Buffer.from('x')).toUpperCase(), expectedLength: 1, proposedBytes: Buffer.from('y') }
      ]
    }
    expect(() => prepareLease(plan)).toThrowError(/INVALID_PLAN/)
  })

  it('rejects a negative expectedLength', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(Buffer.from('x')), expectedLength: -1, proposedBytes: Buffer.from('y') }]
    }
    expect(() => prepareLease(plan)).toThrowError(/INVALID_PLAN/)
  })

  it('rejects a non-integral (fractional) expectedLength', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(Buffer.from('x')), expectedLength: 1.5, proposedBytes: Buffer.from('y') }]
    }
    expect(() => prepareLease(plan)).toThrowError(/INVALID_PLAN/)
  })

  it('rejects a non-finite expectedLength (Infinity/NaN)', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
    const planInf: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'a.txt', expectedSha256Hex: sha256(Buffer.from('x')), expectedLength: Number.POSITIVE_INFINITY, proposedBytes: Buffer.from('y') }
      ]
    }
    expect(() => prepareLease(planInf)).toThrowError(/INVALID_PLAN/)
    const planNaN: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(Buffer.from('x')), expectedLength: Number.NaN, proposedBytes: Buffer.from('y') }]
    }
    expect(() => prepareLease(planNaN)).toThrowError(/INVALID_PLAN/)
  })

  it('rejects an expectedLength larger than the fixture-only bound', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        {
          path: 'a.txt',
          expectedSha256Hex: sha256(Buffer.from('x')),
          expectedLength: 1024 * 1024 + 1,
          proposedBytes: Buffer.from('y')
        }
      ]
    }
    expect(() => prepareLease(plan)).toThrowError(/INVALID_PLAN/)
  })

  it('[native boundary] rejects a plan whose "modifies" field is present but not an array (malformed, not "absent so ignored")', () => {
    const addon = rawNativeAddon()
    expect(() => addon.prepareLease({ root, modifies: 'not-an-array' })).toThrowError(/INVALID_PLAN/)
  })

  it('[native boundary] rejects a plan whose "sources" field is present but not an array', () => {
    const addon = rawNativeAddon()
    expect(() => addon.prepareLease({ root, sources: { path: 'a.txt' } })).toThrowError(/INVALID_PLAN/)
  })

  it('[native boundary] rejects a plan whose "creates" field is present but not an array', () => {
    const addon = rawNativeAddon()
    expect(() => addon.prepareLease({ root, creates: 42 })).toThrowError(/INVALID_PLAN/)
  })

  // V3 hardening: a JS string CAN contain an embedded NUL code point, and
  // Utf8ToWide (napi_entry.cc) converts it using an EXPLICIT length, not
  // NUL-termination - so the resulting std::wstring genuinely carries the
  // NUL in the middle rather than being silently truncated at conversion
  // time. Without an explicit reject, ONLY Win32's own C-string handling
  // (CreateFileW's implicit strlen-at-the-NUL) would ever "truncate" it -
  // which is exactly the kind of silent divergence between what gets
  // validated and what the OS actually opens that this boundary must not
  // rely on. See win_path.cc's OpenRootGuard and this file's ParsePlan.
  it('rejects a root path containing an embedded NUL - fails closed (INVALID_PLAN) at the N-API boundary, before any Lease/Win32 call exists', () => {
    const rootWithEmbeddedNul = root + '\0hidden-suffix'
    const plan: WindowsSafeApplyPlan = { root: rootWithEmbeddedNul, creates: [{ path: 'x.txt', proposedBytes: Buffer.from('y') }] }
    expect(() => prepareLease(plan)).toThrowError(/INVALID_PLAN/)
    // No filesystem mutation of any kind - the real root directory (the
    // valid prefix before the NUL) must remain untouched.
    expect(fs.readdirSync(root)).toHaveLength(0)
  })

  it('a genuinely absent (undefined) optional field is fine - treated as empty, not malformed', () => {
    const plan: WindowsSafeApplyPlan = { root }
    const prep = prepareLease(plan)
    expect(prep.root.code).toBe('OK')
    expect(prep.modifies).toHaveLength(0)
    closeLease(prep.lease)
  })
})
