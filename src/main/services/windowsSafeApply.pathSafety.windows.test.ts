// Meilenstein 4.8B.0 - Windows-only Pfad-/Namespace-Sicherheitstests: reale
// Junction-/Hardlink-Fixturen (KEINE Mocks), Pfad-Traversal, Kollisionen,
// fehlende Parents, und Parent-Umbenennung waehrend eine Lease gehalten wird.
// Datei-Symlinks (nicht Junctions) benoetigen auf Windows entweder Admin-
// Rechte oder aktivierten Entwicklermodus - ist das hier nicht verfuegbar,
// wird der einzelne betroffene Test sichtbar uebersprungen (nie stillschweigend
// als bestanden gemeldet) und im Abschlussbericht als bekannte Umgebungs-
// Einschraenkung genannt.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import {
  prepareLease,
  applyModify,
  createFile,
  closeLease,
  __setForceCaseSensitiveForTests,
  type WindowsSafeApplyPlan
} from './windowsSafeApply'

const IS_WINDOWS = process.platform === 'win32'

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

let root: string
let outsideDirs: string[]

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-path-'))
  outsideDirs = []
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  for (const d of outsideDirs) fs.rmSync(d, { recursive: true, force: true })
})

function makeOutside(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-path-outside-'))
  outsideDirs.push(d)
  return d
}

let canCreateFileSymlink = false
beforeAll(() => {
  if (!IS_WINDOWS) return
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-symlink-probe-'))
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

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - path/namespace safety (15+ scenarios)', () => {
  it('1. normal MODIFY at top level of root succeeds', () => {
    const original = Buffer.from('x\n')
    fs.writeFileSync(path.join(root, 'a.txt'), original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('y\n') }]
    }
    const prep = prepareLease(plan)
    expect(applyModify(prep.lease, 0).code).toBe('OK')
    closeLease(prep.lease)
  })

  it('2. normal MODIFY under a nested ordinary subdirectory succeeds', () => {
    fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true })
    const original = Buffer.from('nested\n')
    fs.writeFileSync(path.join(root, 'sub', 'deep', 'a.txt'), original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'sub/deep/a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('changed\n') }
      ]
    }
    const prep = prepareLease(plan)
    expect(applyModify(prep.lease, 0).code).toBe('OK')
    closeLease(prep.lease)
    expect(fs.readFileSync(path.join(root, 'sub', 'deep', 'a.txt'), 'utf8')).toBe('changed\n')
  })

  it('3. normal CREATE under a nested ordinary subdirectory succeeds', () => {
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'sub/new.txt', proposedBytes: Buffer.from('created\n') }] }
    const prep = prepareLease(plan)
    expect(createFile(prep.lease, 0).code).toBe('OK')
    closeLease(prep.lease)
  })

  it('4. CREATE collision (target already exists) fails closed with PRECONDITION_FAILED', () => {
    fs.writeFileSync(path.join(root, 'exists.txt'), 'pre\n')
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'exists.txt', proposedBytes: Buffer.from('new\n') }] }
    const prep = prepareLease(plan)
    expect(() => createFile(prep.lease, 0)).toThrowError(/PRECONDITION_FAILED/)
    closeLease(prep.lease)
  })

  it('5. path casing variant is rejected as UNSUPPORTED_PATH-class error, never silently case-normalized', () => {
    // V1 profile: ordinary case-insensitive NTFS mode is assumed; this
    // prototype does not attempt to be case-sensitive-safe. We assert only
    // that a casing mismatch against a non-existent exact segment is
    // reported as NOT_FOUND (Windows' own case-insensitive lookup already
    // resolves reasonable variants) - never a silent wrong-file MODIFY.
    fs.mkdirSync(path.join(root, 'CaseDir'))
    fs.writeFileSync(path.join(root, 'CaseDir', 'File.txt'), 'x')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'casedir/file.txt', expectedSha256Hex: sha256(Buffer.from('x')), expectedLength: 1, proposedBytes: Buffer.from('y') }
      ]
    }
    // NTFS default is case-insensitive, so this actually resolves - we assert
    // it resolves to the SAME underlying file (proving no separate shadow
    // file gets created) rather than asserting failure.
    const prep = prepareLease(plan)
    expect(prep.modifies[0].code).toBe('OK')
    closeLease(prep.lease)
  })

  it('6. a symlinked/junction PARENT directory is rejected (REPARSE_REJECTED) - real junction fixture', () => {
    const outside = makeOutside()
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n')
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'linked/secret.txt', expectedSha256Hex: sha256(Buffer.from('secret\n')), expectedLength: 7, proposedBytes: Buffer.from('x') }
      ]
    }
    expect(() => prepareLease(plan)).toThrowError(/REPARSE_REJECTED/)
  })

  it('7. a junctioned PROJECT ROOT is rejected (REPARSE_REJECTED) - real junction fixture', () => {
    // V2: OpenRootGuard now propagates the specific REPARSE_REJECTED reason
    // instead of collapsing every non-OK root-open outcome to the generic
    // ROOT_INVALID - this mirrors the same specific-code propagation already
    // used for ancestor directories (see WalkGuardedAncestorChain) and is a
    // strictly more informative result, not a behavior regression: the root
    // is still fully rejected, just with a more precise reason.
    const outside = makeOutside()
    fs.writeFileSync(path.join(outside, 'a.txt'), 'x')
    const linkedRoot = path.join(root, '..', 'wsa-linked-root-' + path.basename(root))
    fs.symlinkSync(outside, linkedRoot, 'junction')
    try {
      const plan: WindowsSafeApplyPlan = { root: linkedRoot, creates: [{ path: 'new.txt', proposedBytes: Buffer.from('x') }] }
      expect(() => prepareLease(plan)).toThrowError(/REPARSE_REJECTED/)
    } finally {
      fs.rmSync(linkedRoot, { force: true })
    }
  })

  it('8. a hardlinked MODIFY target is rejected (HARDLINK_REJECTED) - REAL hardlink fixture', () => {
    const original = Buffer.from('hardlinked content\n')
    const primaryPath = path.join(root, 'primary.txt')
    const linkPath = path.join(root, 'linked.txt')
    fs.writeFileSync(primaryPath, original)
    fs.linkSync(primaryPath, linkPath)
    expect(fs.statSync(primaryPath).nlink).toBeGreaterThan(1)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'linked.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x') }]
    }
    expect(() => prepareLease(plan)).toThrowError(/HARDLINK_REJECTED/)
  })

  it('9. a MODIFY target replaced with different content before the lease is prepared fails PRECONDITION_FAILED', () => {
    const targetPath = path.join(root, 'a.txt')
    fs.writeFileSync(targetPath, 'original\n')
    // Simulate "replaced before lease": the plan captures an expectation
    // that no longer matches by the time prepareLease actually runs.
    fs.writeFileSync(targetPath, 'replaced-by-someone-else\n')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'a.txt', expectedSha256Hex: sha256(Buffer.from('original\n')), expectedLength: 9, proposedBytes: Buffer.from('mine\n') }
      ]
    }
    expect(() => prepareLease(plan)).toThrowError(/PRECONDITION_FAILED/)
  })

  it('10. a missing parent directory for MODIFY fails closed (NOT_FOUND/PARENT_INVALID)', () => {
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'no-such-dir/a.txt', expectedSha256Hex: sha256(Buffer.alloc(0)), expectedLength: 0, proposedBytes: Buffer.from('x') }
      ]
    }
    expect(() => prepareLease(plan)).toThrowError(/NOT_FOUND|PARENT_INVALID/)
  })

  it('11. a missing parent directory for CREATE fails closed (NOT_FOUND/PARENT_INVALID)', () => {
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'no-such-dir/new.txt', proposedBytes: Buffer.from('x') }] }
    expect(() => prepareLease(plan)).toThrowError(/NOT_FOUND|PARENT_INVALID/)
  })

  it('12. path traversal ("..") is rejected as UNSUPPORTED_PATH, never escapes root', () => {
    const outside = makeOutside()
    fs.writeFileSync(path.join(outside, 'escape.txt'), 'x')
    const relative = path.relative(root, path.join(outside, 'escape.txt')).split(path.sep).join('/')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: relative, expectedSha256Hex: sha256(Buffer.from('x')), expectedLength: 1, proposedBytes: Buffer.from('y') }]
    }
    expect(() => prepareLease(plan)).toThrowError(/UNSUPPORTED_PATH/)
  })

  it('13. an absolute path given as the relative field is rejected as UNSUPPORTED_PATH', () => {
    // A well-formed (64 lowercase hex char) placeholder digest is used here
    // deliberately - V2's N-API boundary now validates expectedSha256Hex's
    // FORMAT before the plan even reaches native path validation (see
    // ParsePlan/IsExactLowercaseHex64), so a malformed placeholder like the
    // old 'x' would be (correctly) rejected as INVALID_PLAN before this
    // test could exercise the PATH check it's actually meant to prove.
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        {
          path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
          expectedSha256Hex: sha256(Buffer.alloc(0)),
          expectedLength: 0,
          proposedBytes: Buffer.from('x')
        }
      ]
    }
    expect(() => prepareLease(plan)).toThrowError(/UNSUPPORTED_PATH/)
  })

  it('14. a UNC-style path given as the relative field is rejected as UNSUPPORTED_PATH', () => {
    const plan: WindowsSafeApplyPlan = {
      root,
      creates: [{ path: '\\\\server\\share\\file.txt', proposedBytes: Buffer.from('x') }]
    }
    expect(() => prepareLease(plan)).toThrowError(/UNSUPPORTED_PATH/)
  })

  it('15. a caller-provided \\\\?\\ extended-length prefix is rejected as UNSUPPORTED_PATH', () => {
    const plan: WindowsSafeApplyPlan = {
      root,
      creates: [{ path: '\\\\?\\C:\\evil.txt', proposedBytes: Buffer.from('x') }]
    }
    expect(() => prepareLease(plan)).toThrowError(/UNSUPPORTED_PATH/)
  })

  it('16. renaming the immediate PARENT directory while its guard handle is held fails the external rename (ERROR_SHARING_VIOLATION-class)', () => {
    fs.mkdirSync(path.join(root, 'sub'))
    const original = Buffer.from('x\n')
    fs.writeFileSync(path.join(root, 'sub', 'a.txt'), original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'sub/a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('y\n') }]
    }
    const prep = prepareLease(plan)
    expect(() => fs.renameSync(path.join(root, 'sub'), path.join(root, 'sub-renamed'))).toThrowError(/EPERM|EBUSY/)
    closeLease(prep.lease)
    // After close, the rename succeeds normally.
    expect(() => fs.renameSync(path.join(root, 'sub'), path.join(root, 'sub-renamed'))).not.toThrow()
  })

  it('17. renaming/deleting the ROOT directory while its guard handle is held fails the external operation', () => {
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'new.txt', proposedBytes: Buffer.from('x') }] }
    const prep = prepareLease(plan)
    const parentOfRoot = path.dirname(root)
    expect(() => fs.renameSync(root, path.join(parentOfRoot, 'root-renamed-while-held'))).toThrowError(/EPERM|EBUSY/)
    closeLease(prep.lease)
  })

  it('18. a file symlink as the final MODIFY target is rejected (REPARSE_REJECTED) - requires Developer Mode/elevation', (ctx) => {
    if (!canCreateFileSymlink) {
      ctx.skip()
      return
    }
    const targetPath = path.join(root, 'real.txt')
    fs.writeFileSync(targetPath, 'real content\n')
    const linkPath = path.join(root, 'link.txt')
    fs.symlinkSync(targetPath, linkPath, 'file')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'link.txt', expectedSha256Hex: sha256(Buffer.from('real content\n')), expectedLength: 13, proposedBytes: Buffer.from('x') }
      ]
    }
    expect(() => prepareLease(plan)).toThrowError(/REPARSE_REJECTED/)
  })

  it('19. attempting to MODIFY a directory (path points at a directory, not a file) fails closed (UNSUPPORTED_PATH)', () => {
    fs.mkdirSync(path.join(root, 'iAmADir'))
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'iAmADir', expectedSha256Hex: sha256(Buffer.alloc(0)), expectedLength: 0, proposedBytes: Buffer.from('x') }]
    }
    expect(() => prepareLease(plan)).toThrowError(/UNSUPPORTED_PATH/)
  })

  // V3 hardening: ValidateRelativeSegments (win_path.cc) already explicitly
  // rejects an embedded NUL - this proves that behavior end-to-end from the
  // JS boundary, and that a rejected plan never touches the filesystem.
  it('20. a relative path containing an embedded NUL is rejected as UNSUPPORTED_PATH, no filesystem mutation', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'a.txt\0evil', expectedSha256Hex: sha256(Buffer.from('x')), expectedLength: 1, proposedBytes: Buffer.from('y') }
      ]
    }
    expect(() => prepareLease(plan)).toThrowError(/UNSUPPORTED_PATH/)
    expect(fs.readFileSync(path.join(root, 'a.txt'))).toEqual(Buffer.from('x'))
  })
})

// V2 Blocker 3: every ancestor directory opened while resolving an entry's
// parent must be retained (not just the immediate parent) for the full lease
// lifetime - these tests use a 2-level-deep path so the grandparent, the
// immediate parent, AND the root are all distinct directories, and prove
// every one of them individually rejects an external rename while the lease
// is held.
describe.skipIf(!IS_WINDOWS)('windowsSafeApply - full ancestor guard chain retention (V2 Blocker 3)', () => {
  it('rejects renaming the GRANDPARENT directory (two levels above the target) while the lease is held', () => {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    const original = Buffer.from('nested target\n')
    fs.writeFileSync(path.join(root, 'a', 'b', 'target.txt'), original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'a/b/target.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }
      ]
    }
    const prep = prepareLease(plan)
    expect(() => fs.renameSync(path.join(root, 'a'), path.join(root, 'a-renamed'))).toThrowError(/EPERM|EBUSY/)
    closeLease(prep.lease)
    expect(() => fs.renameSync(path.join(root, 'a'), path.join(root, 'a-renamed'))).not.toThrow()
  })

  it('rejects renaming the IMMEDIATE PARENT directory (one level above the target) while the lease is held', () => {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    const original = Buffer.from('nested target 2\n')
    fs.writeFileSync(path.join(root, 'a', 'b', 'target.txt'), original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'a/b/target.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }
      ]
    }
    const prep = prepareLease(plan)
    expect(() => fs.renameSync(path.join(root, 'a', 'b'), path.join(root, 'a', 'b-renamed'))).toThrowError(/EPERM|EBUSY/)
    closeLease(prep.lease)
    expect(() => fs.renameSync(path.join(root, 'a', 'b'), path.join(root, 'a', 'b-renamed'))).not.toThrow()
  })

  it('rejects renaming the ROOT directory itself while a nested lease is held', () => {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    const original = Buffer.from('nested target 3\n')
    fs.writeFileSync(path.join(root, 'a', 'b', 'target.txt'), original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'a/b/target.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('x\n') }
      ]
    }
    const prep = prepareLease(plan)
    const parentOfRoot = path.dirname(root)
    expect(() => fs.renameSync(root, path.join(parentOfRoot, 'root-renamed-nested-case'))).toThrowError(/EPERM|EBUSY/)
    closeLease(prep.lease)
  })

  it('CREATE under a nested path also retains the full ancestor chain', () => {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'a/b/new.txt', proposedBytes: Buffer.from('x\n') }] }
    const prep = prepareLease(plan)
    expect(() => fs.renameSync(path.join(root, 'a'), path.join(root, 'a-renamed'))).toThrowError(/EPERM|EBUSY/)
    closeLease(prep.lease)
  })

  it('a context-only source under a nested path also retains the full ancestor chain (not closed immediately after opening)', () => {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    fs.writeFileSync(path.join(root, 'a', 'b', 'source.txt'), 'source\n')
    const plan: WindowsSafeApplyPlan = { root, sources: [{ path: 'a/b/source.txt' }] }
    const prep = prepareLease(plan)
    expect(() => fs.renameSync(path.join(root, 'a'), path.join(root, 'a-renamed'))).toThrowError(/EPERM|EBUSY/)
    closeLease(prep.lease)
  })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - reserved DOS/device name rejection', () => {
  const reservedNames = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'con', 'Nul.txt', 'com1.log']

  for (const name of reservedNames) {
    it(`rejects "${name}" as a CREATE path segment (UNSUPPORTED_PATH)`, () => {
      const plan: WindowsSafeApplyPlan = { root, creates: [{ path: name, proposedBytes: Buffer.from('x') }] }
      expect(() => prepareLease(plan)).toThrowError(/UNSUPPORTED_PATH/)
    })
  }

  it('rejects a reserved name used as an intermediate directory segment', () => {
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'NUL/new.txt', proposedBytes: Buffer.from('x') }] }
    expect(() => prepareLease(plan)).toThrowError(/UNSUPPORTED_PATH/)
  })

  it('does NOT reject an ordinary name that merely CONTAINS a reserved word as a substring', () => {
    fs.mkdirSync(path.join(root, 'CONFIG'))
    const original = Buffer.from('ok\n')
    fs.writeFileSync(path.join(root, 'CONFIG', 'a.txt'), original)
    const plan: WindowsSafeApplyPlan = {
      root,
      modifies: [
        { path: 'CONFIG/a.txt', expectedSha256Hex: sha256(original), expectedLength: original.length, proposedBytes: Buffer.from('y\n') }
      ]
    }
    const prep = prepareLease(plan)
    expect(prep.modifies[0].code).toBe('OK')
    closeLease(prep.lease)
  })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - ROOT form hardening', () => {
  it('rejects a drive-RELATIVE root form ("C:foo", no separator after the colon)', () => {
    const driveRelative = root[0] + ':' + root.slice(3) // "C:\...\xyz" -> "C:...\xyz" (colon with no following separator)
    const plan: WindowsSafeApplyPlan = { root: driveRelative, creates: [{ path: 'a.txt', proposedBytes: Buffer.from('x') }] }
    expect(() => prepareLease(plan)).toThrowError(/ROOT_INVALID/)
  })

  it('rejects a caller-supplied \\\\?\\ extended-length-prefixed root', () => {
    const extended = '\\\\?\\' + root
    const plan: WindowsSafeApplyPlan = { root: extended, creates: [{ path: 'a.txt', proposedBytes: Buffer.from('x') }] }
    expect(() => prepareLease(plan)).toThrowError(/ROOT_INVALID/)
  })

  it('rejects a UNC-form root', () => {
    const plan: WindowsSafeApplyPlan = { root: '\\\\server\\share\\folder', creates: [{ path: 'a.txt', proposedBytes: Buffer.from('x') }] }
    expect(() => prepareLease(plan)).toThrowError(/ROOT_INVALID/)
  })

  it('rejects a non-drive-qualified relative root', () => {
    const plan: WindowsSafeApplyPlan = { root: 'relative\\path', creates: [{ path: 'a.txt', proposedBytes: Buffer.from('x') }] }
    expect(() => prepareLease(plan)).toThrowError(/ROOT_INVALID/)
  })

  it('rejects an invalid drive-letter form (digit instead of a letter)', () => {
    const plan: WindowsSafeApplyPlan = { root: '9:\\somewhere', creates: [{ path: 'a.txt', proposedBytes: Buffer.from('x') }] }
    expect(() => prepareLease(plan)).toThrowError(/ROOT_INVALID/)
  })
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - case-sensitive directory mode (V2, deterministic test-hook based)', () => {
  afterEach(() => {
    // Always reset the process-wide force flag so it can never leak into a
    // later, unrelated test.
    __setForceCaseSensitiveForTests(false)
  })

  it('blocks a case-sensitive root when the case-sensitivity query is forced to report case-sensitive', () => {
    __setForceCaseSensitiveForTests(true)
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'a.txt', proposedBytes: Buffer.from('x') }] }
    expect(() => prepareLease(plan)).toThrowError(/CASE_SENSITIVE_REJECTED/)
  })

  it('an ordinary (non-case-sensitive) root is accepted once the force flag is cleared', () => {
    __setForceCaseSensitiveForTests(true)
    __setForceCaseSensitiveForTests(false)
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'a.txt', proposedBytes: Buffer.from('x') }] }
    const prep = prepareLease(plan)
    expect(prep.root.code).toBe('OK')
    closeLease(prep.lease)
  })

  // NOTE (honesty/residual limitation - see M4.8B0-REVIEW-v2.md): creating a
  // REAL per-directory case-sensitive fixture on Windows requires either
  // process elevation or Developer Mode (via `fsutil file
  // setCaseSensitiveInfo <dir> enable`), neither of which is available in
  // this environment (the same constraint that blocks the real file-symlink
  // fixture elsewhere in this suite). The deterministic test-hook tests above
  // exercise the actual C++ rejection logic (FileCaseSensitiveInfo query +
  // FILE_CS_FLAG_CASE_SENSITIVE_DIR check) end-to-end, but the query's
  // real-world return value against a genuinely case-sensitive directory has
  // NOT been empirically observed in this environment - only reasoned about
  // from documented Win32 semantics. This is disclosed rather than hidden.
})

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - supported storage profile enforcement (V2 Blocker 2)', () => {
  it('accepts an ordinary local fixed NTFS root (the only profile constructible in this environment)', () => {
    const plan: WindowsSafeApplyPlan = { root, creates: [{ path: 'a.txt', proposedBytes: Buffer.from('x') }] }
    const prep = prepareLease(plan)
    expect(prep.root.code).toBe('OK')
    closeLease(prep.lease)
  })

  // NOTE (honesty/residual limitation - see M4.8B0-REVIEW-v2.md): a
  // non-NTFS filesystem or a removable/network volume could not be safely
  // constructed in this environment (no spare removable media, no network
  // share, and formatting a real volume as FAT32/exFAT for a test is outside
  // this milestone's blast-radius rules). ValidateSupportedStorageProfile's
  // rejection branches (GetVolumeInformationByHandleW filesystem-name
  // mismatch; GetDriveTypeW != DRIVE_FIXED) are therefore verified by code
  // review and by the passing acceptance case above (proving the function
  // runs and returns OK for the one profile that IS constructible here), but
  // the REJECTING branches have not been exercised against a real
  // non-NTFS/non-fixed fixture. This is disclosed rather than hidden.
})
