import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ProjectTextFileFormat, ProjectTextFileIdentityEvidence, ProjectTextFileResult } from '@shared/projectTextReadTypes'
import type { CodeChangeProposal, CodeFileChange } from '@shared/codeChangeTypes'
import { CODE_CHANGE_REVIEW_MAX_LIVE_PER_PROJECT, CODE_CHANGE_REVIEW_TTL_MS } from '@shared/codeChangeReviewTypes'
import type { CodeChangeGenerationProvenance, ValidatedCodeChangePackage } from './claudeCodeChangeService'
import {
  CodeChangeReviewError,
  computeCodeChangeReviewFingerprint,
  createCodeChangeReviewRegistry,
  type Clock
} from './codeChangeReviewService'

// ---------------------------------------------------------------------------
// Fixtures - a minimal, hand-built ValidatedCodeChangePackage. The review
// service takes an already-validated package as input (never a raw/untrusted
// one) - claudeCodeChangeService.ts's own tests already cover how such a
// package is produced; these fixtures independently compute the expected
// SHA-256 relationship (BOM?+UTF-8 -> hash) so byte-round-trip
// accept/reject tests are meaningful, not tautological with the code under
// test.
// ---------------------------------------------------------------------------

const DEFAULT_FORMAT: ProjectTextFileFormat = { utf8Bom: false, lineEnding: 'LF', finalNewline: true }
const DEFAULT_SOURCE_CONTENT = 'export function add(a, b) {\n  return a + b\n}\n'
const DEFAULT_MODIFIED_CONTENT = 'export function add(a, b) {\n  return a + b + 0\n}\n'

function bytesFor(content: string, format: ProjectTextFileFormat): Buffer {
  const bom = format.utf8Bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0)
  return Buffer.concat([bom, Buffer.from(content, 'utf8')])
}

function sha256Of(content: string, format: ProjectTextFileFormat): string {
  return createHash('sha256').update(bytesFor(content, format)).digest('hex')
}

function makeIdentity(overrides: Partial<ProjectTextFileIdentityEvidence> = {}): ProjectTextFileIdentityEvidence {
  return { dev: '111', ino: '222', ...overrides }
}

function makeSourceFile(overrides: Partial<ProjectTextFileResult> = {}): ProjectTextFileResult {
  const path = overrides.path ?? 'src/math.ts'
  const content = overrides.content ?? DEFAULT_SOURCE_CONTENT
  const format = overrides.format ?? DEFAULT_FORMAT
  const sha256 = overrides.sha256 ?? sha256Of(content, format)
  const identity = overrides.identity ?? makeIdentity()
  return { path, content, sha256, format, identity }
}

function makeProvenance(overrides: Partial<CodeChangeGenerationProvenance> = {}): CodeChangeGenerationProvenance {
  return {
    projectId: 1,
    taskId: 1,
    workRequestId: 1,
    project: { name: 'Demo Project', projectType: 'App', description: 'A fixture project' },
    projectFolderPath: 'C:\\demo-project',
    projectFolderComparisonKey: 'c:\\demo-project',
    rootIdentity: { realPath: 'C:\\demo-project', dev: '10', ino: '20' },
    workRequest: { intentMarkdown: 'Do X', planMarkdown: null, status: 'IDEA' },
    task: {
      title: 'Fixture task',
      goalMarkdown: '',
      descriptionMarkdown: '',
      priority: 'MEDIUM',
      status: 'TODO',
      acceptanceCriteriaMarkdown: '',
      verificationRequirementsMarkdown: ''
    },
    rules: null,
    context: null,
    decisions: [],
    sourcePaths: ['src/math.ts'],
    modifyPaths: ['src/math.ts'],
    createPaths: [],
    disclosedRelativePaths: ['src/math.ts'],
    sourceFiles: [makeSourceFile()],
    createPreconditions: [],
    ...overrides
  }
}

function makeProposal(overrides: Partial<CodeChangeProposal> = {}): CodeChangeProposal {
  return {
    summary: 'Update add()',
    changes: [{ type: 'MODIFY', path: 'src/math.ts', content: DEFAULT_MODIFIED_CONTENT }],
    warnings: [],
    ...overrides
  }
}

function makePackage(
  overrides: { provenance?: Partial<CodeChangeGenerationProvenance>; proposal?: Partial<CodeChangeProposal> } = {}
): ValidatedCodeChangePackage {
  const provenance = makeProvenance(overrides.provenance)
  const proposal = makeProposal(overrides.proposal)
  return {
    proposal,
    sourceSnapshot: provenance.sourceFiles,
    createPreconditions: provenance.createPreconditions,
    provenance
  }
}

function advanceableClock(startIso: string): { clock: Clock; advanceMs: (ms: number) => void } {
  let current = new Date(startIso).getTime()
  return { clock: { now: () => new Date(current) }, advanceMs: (ms) => (current += ms) }
}

// ---------------------------------------------------------------------------
// BYTE ROUND TRIP (Part C)
// ---------------------------------------------------------------------------

describe('createReview - byte round-trip verification (Part C)', () => {
  it('accepts an ordinary UTF-8 source file that round-trips exactly', () => {
    const registry = createCodeChangeReviewRegistry()
    expect(() => registry.createReview(makePackage())).not.toThrow()
  })

  it('accepts a UTF-8 BOM source file that round-trips exactly', () => {
    const format: ProjectTextFileFormat = { utf8Bom: true, lineEnding: 'LF', finalNewline: true }
    const file = makeSourceFile({ format })
    const registry = createCodeChangeReviewRegistry()
    expect(() =>
      registry.createReview(makePackage({ provenance: { sourceFiles: [file] } }))
    ).not.toThrow()
  })

  it('accepts a CRLF source file that round-trips exactly', () => {
    const format: ProjectTextFileFormat = { utf8Bom: false, lineEnding: 'CRLF', finalNewline: true }
    const file = makeSourceFile({ content: 'line1\r\nline2\r\n', format })
    const registry = createCodeChangeReviewRegistry()
    expect(() =>
      registry.createReview(makePackage({ provenance: { sourceFiles: [file] } }))
    ).not.toThrow()
  })

  it('accepts a no-final-newline source file that round-trips exactly', () => {
    const format: ProjectTextFileFormat = { utf8Bom: false, lineEnding: 'NONE', finalNewline: false }
    const file = makeSourceFile({ content: 'no newline here', format })
    const registry = createCodeChangeReviewRegistry()
    expect(() =>
      registry.createReview(makePackage({ provenance: { sourceFiles: [file] } }))
    ).not.toThrow()
  })

  it('rejects review creation when the captured raw-byte SHA-256 does not match reconstructed bytes', () => {
    const file = makeSourceFile({ sha256: 'a'.repeat(64) })
    const registry = createCodeChangeReviewRegistry()
    let caught: unknown
    try {
      registry.createReview(makePackage({ provenance: { sourceFiles: [file] } }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_INVALID')
  })

  it('rejects a mismatched BOM flag (content/format say no BOM, but the hash was computed as if a BOM was present)', () => {
    // Simulates the "unusual multiple-BOM / decoder edge case" scenario: the hash on record does
    // not match what content+format would honestly reconstruct.
    const content = 'x\n'
    const wrongHash = sha256Of(content, { utf8Bom: true, lineEnding: 'LF', finalNewline: true })
    const file = makeSourceFile({ content, format: DEFAULT_FORMAT, sha256: wrongHash })
    const registry = createCodeChangeReviewRegistry()
    let caught: unknown
    try {
      registry.createReview(makePackage({ provenance: { sourceFiles: [file] } }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_INVALID')
  })

  it('never normalizes/repairs a failing source file - the whole review creation is rejected', () => {
    const goodFile = makeSourceFile({ path: 'src/good.ts' })
    const badFile = makeSourceFile({ path: 'src/bad.ts', sha256: 'f'.repeat(64) })
    const registry = createCodeChangeReviewRegistry()
    expect(() =>
      registry.createReview(
        makePackage({
          provenance: {
            sourcePaths: ['src/good.ts', 'src/bad.ts'],
            modifyPaths: ['src/good.ts', 'src/bad.ts'],
            disclosedRelativePaths: ['src/good.ts', 'src/bad.ts'],
            sourceFiles: [goodFile, badFile]
          },
          proposal: {
            changes: [
              { type: 'MODIFY', path: 'src/good.ts', content: DEFAULT_MODIFIED_CONTENT },
              { type: 'MODIFY', path: 'src/bad.ts', content: DEFAULT_MODIFIED_CONTENT }
            ]
          }
        })
      )
    ).toThrow(CodeChangeReviewError)
  })
})

// ---------------------------------------------------------------------------
// DIFF INTEGRATION / SIZE LIMITS (Part I/K, delegated to codeChangeDiff.ts)
// ---------------------------------------------------------------------------

describe('createReview - diff integration', () => {
  it('produces a MODIFY diff comparing captured base against exact proposed content', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    expect(review.files).toHaveLength(1)
    expect(review.files[0].type).toBe('MODIFY')
    expect(review.files[0].beforeText).toBe(DEFAULT_SOURCE_CONTENT)
    expect(review.files[0].afterText).toBe(DEFAULT_MODIFIED_CONTENT)
    expect(review.files[0].diff.some((line) => line.type === 'removed')).toBe(true)
    expect(review.files[0].diff.some((line) => line.type === 'added')).toBe(true)
  })

  it('produces a CREATE diff comparing absent (null) against the new content', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(
      makePackage({
        provenance: { sourcePaths: [], modifyPaths: [], disclosedRelativePaths: [], sourceFiles: [] },
        proposal: {
          changes: [{ type: 'CREATE', path: 'src/new.test.ts', content: 'export const ok = true\n' }]
        }
      })
    )
    expect(review.files[0].type).toBe('CREATE')
    expect(review.files[0].beforeText).toBeNull()
    expect(review.files[0].diff.every((line) => line.type === 'added')).toBe(true)
  })

  it('rejects the whole review when a file diff exceeds the size limits, without truncating', () => {
    const bigBefore = 'unrelated single line'
    const bigAfter = Array.from({ length: 20_001 }, (_, i) => `unique-line-${i}`).join('\n')
    const registry = createCodeChangeReviewRegistry()
    let caught: unknown
    try {
      registry.createReview(
        makePackage({
          proposal: { changes: [{ type: 'MODIFY', path: 'src/math.ts', content: bigAfter }] },
          provenance: { sourceFiles: [makeSourceFile({ content: bigBefore, format: { utf8Bom: false, lineEnding: 'NONE', finalNewline: false } })] }
        })
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_TOO_LARGE')
  })
})

// ---------------------------------------------------------------------------
// FORMAT REVIEW (Part J)
// ---------------------------------------------------------------------------

describe('createReview - format metadata', () => {
  it('exposes before/after format metadata with byte lengths for MODIFY', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    expect(review.files[0].beforeFormat).toEqual({ utf8Bom: false, lineEnding: 'LF', finalNewline: true, byteLength: Buffer.byteLength(DEFAULT_SOURCE_CONTENT, 'utf8') })
    expect(review.files[0].afterFormat).toEqual({ utf8Bom: false, lineEnding: 'LF', finalNewline: true, byteLength: Buffer.byteLength(DEFAULT_MODIFIED_CONTENT, 'utf8') })
  })

  it('exposes the fixed CREATE convention with a null before-format', () => {
    const content = 'export const ok = true\n'
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(
      makePackage({
        provenance: { sourcePaths: [], modifyPaths: [], disclosedRelativePaths: [], sourceFiles: [] },
        proposal: { changes: [{ type: 'CREATE', path: 'src/new.test.ts', content }] }
      })
    )
    expect(review.files[0].beforeFormat).toBeNull()
    expect(review.files[0].afterFormat).toEqual({ utf8Bom: false, lineEnding: 'LF', finalNewline: true, byteLength: Buffer.byteLength(content, 'utf8') })
  })
})

// ---------------------------------------------------------------------------
// FINGERPRINT (Part H)
// ---------------------------------------------------------------------------

describe('computeCodeChangeReviewFingerprint - stability and sensitivity', () => {
  it('is stable for an identical authoritative package', () => {
    const a = computeCodeChangeReviewFingerprint(makePackage())
    const b = computeCodeChangeReviewFingerprint(makePackage())
    expect(a).toBe(b)
  })

  it('changes when the project changes', () => {
    const base = computeCodeChangeReviewFingerprint(makePackage())
    const changed = computeCodeChangeReviewFingerprint(makePackage({ provenance: { projectId: 2 } }))
    expect(changed).not.toBe(base)
  })

  it('changes when the task/work-request snapshot changes', () => {
    const base = computeCodeChangeReviewFingerprint(makePackage())
    const changed = computeCodeChangeReviewFingerprint(
      makePackage({ provenance: { task: { ...makeProvenance().task, title: 'Different title' } } })
    )
    expect(changed).not.toBe(base)
  })

  it('changes when Rules/Context content changes', () => {
    const base = computeCodeChangeReviewFingerprint(makePackage())
    const changed = computeCodeChangeReviewFingerprint(
      makePackage({ provenance: { rules: { versionNumber: 1, contentMarkdown: 'be careful' } } })
    )
    expect(changed).not.toBe(base)
  })

  it('changes when the proposal summary changes', () => {
    const base = computeCodeChangeReviewFingerprint(makePackage())
    const changed = computeCodeChangeReviewFingerprint(makePackage({ proposal: { summary: 'Different summary' } }))
    expect(changed).not.toBe(base)
  })

  it('changes when a proposal warning changes', () => {
    const base = computeCodeChangeReviewFingerprint(makePackage())
    const changed = computeCodeChangeReviewFingerprint(makePackage({ proposal: { warnings: ['heads up'] } }))
    expect(changed).not.toBe(base)
  })

  it('changes when the change order differs (order is preserved, never re-sorted)', () => {
    const twoChangeProvenance = {
      sourcePaths: ['src/math.ts', 'src/other.ts'],
      modifyPaths: ['src/math.ts', 'src/other.ts'],
      disclosedRelativePaths: ['src/math.ts', 'src/other.ts'],
      sourceFiles: [makeSourceFile({ path: 'src/math.ts' }), makeSourceFile({ path: 'src/other.ts', content: 'export const y = 1\n' })]
    }
    const changeA: CodeFileChange = { type: 'MODIFY', path: 'src/math.ts', content: DEFAULT_MODIFIED_CONTENT }
    const changeB: CodeFileChange = { type: 'MODIFY', path: 'src/other.ts', content: 'export const y = 2\n' }
    const orderOne = computeCodeChangeReviewFingerprint(
      makePackage({ provenance: twoChangeProvenance, proposal: { changes: [changeA, changeB] } })
    )
    const orderTwo = computeCodeChangeReviewFingerprint(
      makePackage({ provenance: twoChangeProvenance, proposal: { changes: [changeB, changeA] } })
    )
    expect(orderOne).not.toBe(orderTwo)
  })

  it('changes when a change path/type/content changes', () => {
    const base = computeCodeChangeReviewFingerprint(makePackage())
    const differentPath = computeCodeChangeReviewFingerprint(
      makePackage({
        provenance: { sourcePaths: ['src/other.ts'], modifyPaths: ['src/other.ts'], disclosedRelativePaths: ['src/other.ts'], sourceFiles: [makeSourceFile({ path: 'src/other.ts' })] },
        proposal: { changes: [{ type: 'MODIFY', path: 'src/other.ts', content: DEFAULT_MODIFIED_CONTENT }] }
      })
    )
    const differentContent = computeCodeChangeReviewFingerprint(
      makePackage({ proposal: { changes: [{ type: 'MODIFY', path: 'src/math.ts', content: 'export function add(a, b) { return a - b }\n' }] } })
    )
    expect(differentPath).not.toBe(base)
    expect(differentContent).not.toBe(base)
  })

  it('changes when the source hash changes', () => {
    const base = computeCodeChangeReviewFingerprint(makePackage())
    const differentSourceContent = 'export function add(a, b) {\n  return a + b // comment\n}\n'
    const changed = computeCodeChangeReviewFingerprint(
      makePackage({
        provenance: { sourceFiles: [makeSourceFile({ content: differentSourceContent })] },
        proposal: { changes: [{ type: 'MODIFY', path: 'src/math.ts', content: differentSourceContent.replace('comment', 'different comment') }] }
      })
    )
    expect(changed).not.toBe(base)
  })

  it('changes when format metadata changes', () => {
    const base = computeCodeChangeReviewFingerprint(makePackage())
    const crlfFormat: ProjectTextFileFormat = { utf8Bom: false, lineEnding: 'CRLF', finalNewline: true }
    const crlfContent = 'export function add(a, b) {\r\n  return a + b\r\n}\r\n'
    const changed = computeCodeChangeReviewFingerprint(
      makePackage({
        provenance: { sourceFiles: [makeSourceFile({ content: crlfContent, format: crlfFormat })] },
        proposal: { changes: [{ type: 'MODIFY', path: 'src/math.ts', content: crlfContent.replace('a + b', 'a + b + 0') }] }
      })
    )
    expect(changed).not.toBe(base)
  })

  it('changes when the CREATE precondition snapshot changes', () => {
    const base = computeCodeChangeReviewFingerprint(makePackage({ provenance: { createPaths: ['src/new.ts'], createPreconditions: [{ path: 'src/new.ts', verifiedAbsent: true }] } }))
    const changed = computeCodeChangeReviewFingerprint(makePackage({ provenance: { createPaths: ['src/new.ts', 'src/other.ts'], createPreconditions: [{ path: 'src/new.ts', verifiedAbsent: true }, { path: 'src/other.ts', verifiedAbsent: true }] } }))
    expect(changed).not.toBe(base)
  })

  it('changes when the generation-time scope changes', () => {
    const base = computeCodeChangeReviewFingerprint(makePackage())
    const changed = computeCodeChangeReviewFingerprint(makePackage({ provenance: { disclosedRelativePaths: ['src/math.ts', 'src/extra.ts'] } }))
    expect(changed).not.toBe(base)
  })

  it('changes when root identity evidence changes', () => {
    const base = computeCodeChangeReviewFingerprint(makePackage())
    const changed = computeCodeChangeReviewFingerprint(
      makePackage({ provenance: { rootIdentity: { realPath: 'C:\\demo-project', dev: '999', ino: '999' } } })
    )
    expect(changed).not.toBe(base)
  })

  it('does not depend on locale (no locale-aware string comparison/sorting anywhere in the payload)', () => {
    const originalLocale = process.env.LANG
    try {
      process.env.LANG = 'de-DE'
      const a = computeCodeChangeReviewFingerprint(makePackage())
      process.env.LANG = 'en-US'
      const b = computeCodeChangeReviewFingerprint(makePackage())
      expect(a).toBe(b)
    } finally {
      process.env.LANG = originalLocale
    }
  })
})

// ---------------------------------------------------------------------------
// REGISTRY (Part F/G)
// ---------------------------------------------------------------------------

describe('codeChangeReviewService - registry', () => {
  it('assigns an opaque random reviewId, not a predictable sequence', () => {
    const registry = createCodeChangeReviewRegistry()
    const a = registry.createReview(makePackage())
    const b = registry.createReview(makePackage())
    expect(a.reviewId).not.toBe(b.reviewId)
    expect(a.reviewId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('binds a review permanently to its project - a different project cannot get/approve/requestChanges it', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    expect(() => registry.getReview(999, review.reviewId)).toThrow(CodeChangeReviewError)
    expect(() => registry.approveReview(999, review.reviewId)).toThrow(CodeChangeReviewError)
    expect(() => registry.requestChanges(999, review.reviewId, 'feedback')).toThrow(CodeChangeReviewError)
    try {
      registry.getReview(999, review.reviewId)
    } catch (error) {
      expect((error as CodeChangeReviewError).code).toBe('PROJECT_MISMATCH')
    }
  })

  it('listReviewsForProject only returns that project\'s reviews', () => {
    const registry = createCodeChangeReviewRegistry()
    const reviewA = registry.createReview(makePackage({ provenance: { projectId: 1 } }))
    registry.createReview(makePackage({ provenance: { projectId: 2 } }))
    const listForA = registry.listReviewsForProject(1)
    expect(listForA.map((r) => r.reviewId)).toEqual([reviewA.reviewId])
  })

  it('enforces a maximum of 20 live reviews per project and fails explicitly, without silent eviction', () => {
    const registry = createCodeChangeReviewRegistry()
    for (let i = 0; i < CODE_CHANGE_REVIEW_MAX_LIVE_PER_PROJECT; i++) {
      registry.createReview(makePackage())
    }
    expect(registry.listReviewsForProject(1)).toHaveLength(CODE_CHANGE_REVIEW_MAX_LIVE_PER_PROJECT)
    let caught: unknown
    try {
      registry.createReview(makePackage())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_LIMIT')
    // Nothing was evicted to make room - still exactly the cap.
    expect(registry.listReviewsForProject(1)).toHaveLength(CODE_CHANGE_REVIEW_MAX_LIVE_PER_PROJECT)
  })

  it('expires a review after the fixed 2-hour TTL and classifies it as REVIEW_EXPIRED', () => {
    const { clock, advanceMs } = advanceableClock('2026-01-01T00:00:00.000Z')
    const registry = createCodeChangeReviewRegistry(clock)
    const review = registry.createReview(makePackage())
    advanceMs(CODE_CHANGE_REVIEW_TTL_MS)
    let caught: unknown
    try {
      registry.getReview(1, review.reviewId)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_EXPIRED')
  })

  it('does not silently extend the TTL on read, and does not silently refresh approval', () => {
    const { clock, advanceMs } = advanceableClock('2026-01-01T00:00:00.000Z')
    const registry = createCodeChangeReviewRegistry(clock)
    const review = registry.createReview(makePackage())
    advanceMs(CODE_CHANGE_REVIEW_TTL_MS - 1000)
    registry.getReview(1, review.reviewId) // read just before expiry
    advanceMs(2000) // now past the ORIGINAL expiry
    expect(() => registry.getReview(1, review.reviewId)).toThrow(CodeChangeReviewError)
  })

  it('an expired review no longer counts against the per-project live cap (safe removal)', () => {
    const { clock, advanceMs } = advanceableClock('2026-01-01T00:00:00.000Z')
    const registry = createCodeChangeReviewRegistry(clock)
    for (let i = 0; i < CODE_CHANGE_REVIEW_MAX_LIVE_PER_PROJECT; i++) {
      registry.createReview(makePackage())
    }
    advanceMs(CODE_CHANGE_REVIEW_TTL_MS)
    expect(() => registry.createReview(makePackage())).not.toThrow()
  })

  it('a fresh registry (simulating an app restart) loses all pending reviews/approvals/feedback', () => {
    const registry1 = createCodeChangeReviewRegistry()
    const review = registry1.createReview(makePackage())
    registry1.approveReview(1, review.reviewId)

    const registry2 = createCodeChangeReviewRegistry()
    expect(() => registry2.getReview(1, review.reviewId)).toThrow(CodeChangeReviewError)
    try {
      registry2.getReview(1, review.reviewId)
    } catch (error) {
      expect((error as CodeChangeReviewError).code).toBe('REVIEW_NOT_FOUND')
    }
  })

  it('returns defensive copies - mutating a returned projection never affects the stored record', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    review.warnings.push('tampered')
    review.files[0].diff.push({ type: 'added', text: 'tampered', oldLineNumber: null, newLineNumber: 999 })
    ;(review as { summary: string }).summary = 'tampered summary'

    const reFetched = registry.getReview(1, review.reviewId)
    expect(reFetched.warnings).toEqual([])
    expect(reFetched.files[0].diff.some((line) => line.text === 'tampered')).toBe(false)
    expect(reFetched.summary).toBe('Update add()')
  })
})

// ---------------------------------------------------------------------------
// STATE MACHINE (Part F/M/N)
// ---------------------------------------------------------------------------

describe('codeChangeReviewService - review state machine', () => {
  it('starts PENDING', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    expect(review.state).toBe('PENDING')
  })

  it('PENDING -> APPROVED succeeds', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    const approved = registry.approveReview(1, review.reviewId)
    expect(approved.state).toBe('APPROVED')
  })

  it('PENDING -> CHANGES_REQUESTED succeeds and stores feedback', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    const decided = registry.requestChanges(1, review.reviewId, 'please fix X')
    expect(decided.state).toBe('CHANGES_REQUESTED')
    expect(decided.feedback).toBe('please fix X')
  })

  it('APPROVED -> CHANGES_REQUESTED is allowed and revokes approval', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    registry.approveReview(1, review.reviewId)
    const revoked = registry.requestChanges(1, review.reviewId, 'actually, please change Y')
    expect(revoked.state).toBe('CHANGES_REQUESTED')
    expect(revoked.feedback).toBe('actually, please change Y')
  })

  it('CHANGES_REQUESTED cannot become APPROVED again', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    registry.requestChanges(1, review.reviewId, 'fix it')
    let caught: unknown
    try {
      registry.approveReview(1, review.reviewId)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_ALREADY_DECIDED')
  })

  it('a concurrent/double approve() rejects the second call', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    registry.approveReview(1, review.reviewId)
    let caught: unknown
    try {
      registry.approveReview(1, review.reviewId)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_ALREADY_DECIDED')
  })

  it('requestChanges on an already CHANGES_REQUESTED review also rejects (a revised proposal must be a NEW review)', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    registry.requestChanges(1, review.reviewId, 'first feedback')
    let caught: unknown
    try {
      registry.requestChanges(1, review.reviewId, 'second feedback')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_ALREADY_DECIDED')
  })

  it('rejects feedback that is not a string', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    expect(() => registry.requestChanges(1, review.reviewId, 12345)).toThrow(CodeChangeReviewError)
  })

  it('rejects feedback larger than 8 KiB UTF-8', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    const tooLarge = 'x'.repeat(8 * 1024 + 1)
    let caught: unknown
    try {
      registry.requestChanges(1, review.reviewId, tooLarge)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_INVALID')
  })

  it('accepts feedback exactly at the 8 KiB boundary', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    const exactly8Kib = 'x'.repeat(8 * 1024)
    expect(() => registry.requestChanges(1, review.reviewId, exactly8Kib)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// NOT FOUND / MISC
// ---------------------------------------------------------------------------

describe('codeChangeReviewService - not found', () => {
  it('rejects an unknown reviewId with REVIEW_NOT_FOUND', () => {
    const registry = createCodeChangeReviewRegistry()
    let caught: unknown
    try {
      registry.getReview(1, 'does-not-exist')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// M4.8A V2 - authoritative package retention, defensive ownership, and
// list-summary minimization.
// ---------------------------------------------------------------------------

describe('codeChangeReviewService V2 - authoritative package retention', () => {
  it('retains the complete ValidatedCodeChangePackage, resolvable only via the Main-only resolveAuthoritative()', () => {
    const registry = createCodeChangeReviewRegistry()
    const pkg = makePackage()
    const review = registry.createReview(pkg)
    const authoritative = registry.resolveAuthoritative(1, review.reviewId)
    expect(authoritative.package.proposal).toEqual(pkg.proposal)
    expect(authoritative.package.provenance).toEqual(pkg.provenance)
    expect(authoritative.package.sourceSnapshot).toEqual(pkg.sourceSnapshot)
    expect(authoritative.package.createPreconditions).toEqual(pkg.createPreconditions)
    expect(authoritative.fingerprint).toEqual(computeCodeChangeReviewFingerprint(makePackage()))
  })

  it('resolveAuthoritative() enforces the SAME project binding and expiry rules as getReview()', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    expect(() => registry.resolveAuthoritative(999, review.reviewId)).toThrow(CodeChangeReviewError)
    try {
      registry.resolveAuthoritative(999, review.reviewId)
    } catch (error) {
      expect((error as CodeChangeReviewError).code).toBe('PROJECT_MISMATCH')
    }
    expect(() => registry.resolveAuthoritative(1, 'does-not-exist')).toThrow(CodeChangeReviewError)
  })

  it('a caller mutating their ORIGINAL package object after createReview() cannot alter the stored authoritative record', () => {
    const registry = createCodeChangeReviewRegistry()
    const pkg = makePackage()
    const review = registry.createReview(pkg)

    // Mutate the caller's own object graph AFTER the (synchronous) createReview() call returned.
    pkg.proposal.summary = 'TAMPERED SUMMARY'
    pkg.proposal.warnings.push('tampered warning')
    pkg.provenance.sourceFiles[0].content = 'TAMPERED CONTENT'
    pkg.provenance.sourceFiles.push(makeSourceFile({ path: 'src/injected.ts' }))
    pkg.provenance.decisions.push({ questionMarkdown: 'tampered', status: 'OPEN', resolvedOptionKey: null, resolutionNote: '' })

    const authoritative = registry.resolveAuthoritative(1, review.reviewId)
    expect(authoritative.package.proposal.summary).toBe('Update add()')
    expect(authoritative.package.proposal.warnings).toEqual([])
    expect(authoritative.package.provenance.sourceFiles).toHaveLength(1)
    expect(authoritative.package.provenance.sourceFiles[0].content).toBe(DEFAULT_SOURCE_CONTENT)
    expect(authoritative.package.provenance.decisions).toEqual([])

    // The already-derived rendering (fingerprint/diff/projection) is likewise unaffected - it was
    // computed from the defensive clone taken at createReview() time, never re-derived from the
    // caller's mutated object.
    expect(authoritative.fingerprint).toBe(computeCodeChangeReviewFingerprint(makePackage()))
    const reFetched = registry.getReview(1, review.reviewId)
    expect(reFetched.summary).toBe('Update add()')
    expect(reFetched.files[0].beforeText).toBe(DEFAULT_SOURCE_CONTENT)
  })

  it('mutating a RETURNED authoritative snapshot (including its nested package) cannot mutate the registry', () => {
    const registry = createCodeChangeReviewRegistry()
    const review = registry.createReview(makePackage())
    const authoritative = registry.resolveAuthoritative(1, review.reviewId)

    authoritative.package.proposal.summary = 'TAMPERED'
    authoritative.package.provenance.sourceFiles[0].content = 'TAMPERED'
    ;(authoritative as { fingerprint: string }).fingerprint = 'tampered-fingerprint'

    const reResolved = registry.resolveAuthoritative(1, review.reviewId)
    expect(reResolved.package.proposal.summary).toBe('Update add()')
    expect(reResolved.package.provenance.sourceFiles[0].content).toBe(DEFAULT_SOURCE_CONTENT)
    expect(reResolved.fingerprint).not.toBe('tampered-fingerprint')
  })

  it('rejects review creation when sourceSnapshot does not exactly match provenance.sourceFiles', () => {
    const pkg = makePackage()
    const tampered: ValidatedCodeChangePackage = {
      ...pkg,
      sourceSnapshot: [makeSourceFile({ path: 'src/different.ts' })]
    }
    const registry = createCodeChangeReviewRegistry()
    let caught: unknown
    try {
      registry.createReview(tampered)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_INVALID')
  })

  it('rejects review creation when createPreconditions does not exactly match provenance.createPreconditions', () => {
    const pkg = makePackage()
    const tampered: ValidatedCodeChangePackage = {
      ...pkg,
      createPreconditions: [{ path: 'src/sneaky.ts', verifiedAbsent: true }]
    }
    const registry = createCodeChangeReviewRegistry()
    let caught: unknown
    try {
      registry.createReview(tampered)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeChangeReviewError)
    expect((caught as CodeChangeReviewError).code).toBe('REVIEW_INVALID')
  })

  it('accepts a consistent package where sourceSnapshot/createPreconditions exactly match provenance (the normal case)', () => {
    const registry = createCodeChangeReviewRegistry()
    expect(() => registry.createReview(makePackage())).not.toThrow()
  })
})

describe('codeChangeReviewService V2 - list-summary minimization', () => {
  it('listReviewsForProject never includes beforeText/afterText/diff/source contents/provenance/fingerprint', () => {
    const registry = createCodeChangeReviewRegistry()
    registry.createReview(makePackage())
    const [entry] = registry.listReviewsForProject(1)
    const keys = Object.keys(entry).sort()
    expect(keys).toEqual(['createdAt', 'expiresAt', 'feedback', 'fileCount', 'projectId', 'reviewId', 'state', 'summary', 'taskId', 'warnings', 'workRequestId'].sort())
    expect(JSON.stringify(entry)).not.toMatch(/beforeText|afterText|"diff"|provenance|fingerprint|sourceFiles|sha256/i)
  })

  it('reports fileCount instead of the full files array', () => {
    const registry = createCodeChangeReviewRegistry()
    registry.createReview(makePackage())
    const [entry] = registry.listReviewsForProject(1)
    expect(entry.fileCount).toBe(1)
    expect((entry as unknown as { files?: unknown }).files).toBeUndefined()
  })

  it('getReview remains the only way to fetch the full projection with diff content', () => {
    const registry = createCodeChangeReviewRegistry()
    const created = registry.createReview(makePackage())
    const [listed] = registry.listReviewsForProject(1)
    const full = registry.getReview(1, created.reviewId)
    expect((listed as unknown as { files?: unknown }).files).toBeUndefined()
    expect(full.files).toHaveLength(1)
    expect(full.files[0].diff.length).toBeGreaterThan(0)
    expect(full.files[0].beforeText).toBe(DEFAULT_SOURCE_CONTENT)
  })

  it('a mutated list-summary entry cannot affect a subsequent getReview() call (defensive copy)', () => {
    const registry = createCodeChangeReviewRegistry()
    const created = registry.createReview(makePackage())
    const [entry] = registry.listReviewsForProject(1)
    ;(entry as { summary: string }).summary = 'TAMPERED'
    const full = registry.getReview(1, created.reviewId)
    expect(full.summary).toBe('Update add()')
  })
})
