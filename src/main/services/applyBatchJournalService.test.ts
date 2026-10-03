import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../testUtils/testDb'
import { createProject, getProjectById } from './projectsService'
import { createTask } from './taskService'
import { createWorkRequest, getWorkRequestForProject, replaceTaskLinks } from './workRequestService'
import {
  createCodeChangeReviewRegistry,
  computeCodeChangeReviewFingerprint,
  reconstructOriginalBytes,
  type CodeChangeReviewRegistry,
  type CodeChangeAuthoritativeReview
} from './codeChangeReviewService'
import type { CodeChangeGenerationProvenance, ValidatedCodeChangePackage } from './claudeCodeChangeService'
import type { ProjectTextFileFormat, ProjectTextFileIdentityEvidence, ProjectTextFileResult } from '@shared/projectTextReadTypes'
import type { CodeChangeProposal } from '@shared/codeChangeTypes'
import {
  createApplyAuthorityService,
  APPLY_CONSENT_PURPOSE_VERSION,
  type ApplyAuthorityService,
  type ApplyConsentSource,
  type FilesystemWriteCapabilitySource
} from './applyAuthorityService'
import { createApplyBatchJournalService, ApplyBatchAdmissionError } from './applyBatchJournalService'

// ---------------------------------------------------------------------------
// Fixtures - mirrors applyAuthorityService.test.ts's fixture style
// (makeSourceFile/makeProposal/makePackage/setup), since admitBatch()'s first
// two phases are exactly "call authorizeApply(), then resolve the
// authoritative review for the SAME projectId/reviewId" - a meaningful
// admission test needs a genuinely authorized review, exactly like that
// module's own tests do.
// ---------------------------------------------------------------------------

const DEFAULT_FORMAT: ProjectTextFileFormat = { utf8Bom: false, lineEnding: 'LF', finalNewline: true }
const DEFAULT_SOURCE_CONTENT = 'export function add(a, b) {\n  return a + b\n}\n'
const DEFAULT_MODIFIED_CONTENT = 'export function add(a, b) {\n  return a + b + 1\n}\n'

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
  const path_ = overrides.path ?? 'src/math.ts'
  const content = overrides.content ?? DEFAULT_SOURCE_CONTENT
  const format = overrides.format ?? DEFAULT_FORMAT
  const sha256 = overrides.sha256 ?? sha256Of(content, format)
  const identity = overrides.identity ?? makeIdentity()
  return { path: path_, content, sha256, format, identity }
}

function makeProposal(overrides: Partial<CodeChangeProposal> = {}): CodeChangeProposal {
  return {
    summary: 'Update add()',
    changes: [{ type: 'MODIFY', path: 'src/math.ts', content: DEFAULT_MODIFIED_CONTENT }],
    warnings: [],
    ...overrides
  }
}

function makePackage(provenance: CodeChangeGenerationProvenance, proposal: CodeChangeProposal): ValidatedCodeChangePackage {
  return { proposal, sourceSnapshot: provenance.sourceFiles, createPreconditions: provenance.createPreconditions, provenance }
}

function exactConsentSource(reviewId: string, fingerprint: string): ApplyConsentSource {
  return {
    resolveApplyConsent(query) {
      if (query.reviewId !== reviewId || query.fingerprint !== fingerprint) return null
      return { reviewId, fingerprint, purposeVersion: APPLY_CONSENT_PURPOSE_VERSION }
    }
  }
}

function noConsentSource(): ApplyConsentSource {
  return { resolveApplyConsent: () => null }
}

function fixedCapabilitySource(projectId: number): FilesystemWriteCapabilitySource {
  return {
    evaluateFilesystemWriteCapability: () => ({ projectId, capability: 'filesystem.write', decision: 'ALLOW', reason: 'POLICY_ALLOWED' })
  }
}

interface Setup {
  db: Database.Database
  registry: CodeChangeReviewRegistry
  projectId: number
  taskId: number
  workRequestId: number
  tmpDir: string
  reviewId: string
  fingerprint: string
  review: CodeChangeAuthoritativeReview
}

function setup(options: { proposal?: CodeChangeProposal; sourceFiles?: ProjectTextFileResult[] } = {}): Setup {
  const db = createTestDb()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-apply-batch-journal-test-'))

  const project = createProject(db, { name: 'Demo', projectType: 'App', description: 'Fixture project', folderPath: tmpDir })
  const workRequest = createWorkRequest(db, { projectId: project.id, intentMarkdown: 'Do X', createdBy: 'LEON' })
  const task = createTask(db, { projectId: project.id, title: 'Fixture task', createdBy: 'LEON' })
  replaceTaskLinks(db, { projectId: project.id, workRequestId: workRequest.id, taskIds: [task.id] })

  const freshProject = getProjectById(db, project.id)
  const freshWorkRequest = getWorkRequestForProject(db, project.id, workRequest.id)

  const proposal = options.proposal ?? makeProposal()
  const modifyPaths = proposal.changes.filter((c) => c.type === 'MODIFY').map((c) => c.path)
  const createPaths = proposal.changes.filter((c) => c.type === 'CREATE').map((c) => c.path)
  const sourceFiles = options.sourceFiles ?? modifyPaths.map((p) => makeSourceFile({ path: p }))

  const provenance: CodeChangeGenerationProvenance = {
    projectId: project.id,
    taskId: task.id,
    workRequestId: workRequest.id,
    project: { name: freshProject.name, projectType: freshProject.projectType, description: freshProject.description },
    projectFolderPath: freshProject.folderPath,
    projectFolderComparisonKey: freshProject.folderComparisonKey,
    rootIdentity: { realPath: tmpDir, dev: '10', ino: '20' },
    workRequest: { intentMarkdown: freshWorkRequest.intentMarkdown, planMarkdown: freshWorkRequest.planMarkdown, status: freshWorkRequest.status },
    task: {
      title: task.title,
      goalMarkdown: task.goalMarkdown,
      descriptionMarkdown: task.descriptionMarkdown,
      priority: task.priority,
      status: task.status,
      acceptanceCriteriaMarkdown: task.acceptanceCriteriaMarkdown,
      verificationRequirementsMarkdown: task.verificationRequirementsMarkdown
    },
    rules: null,
    context: null,
    decisions: freshWorkRequest.decisions.map((decision) => ({
      questionMarkdown: decision.questionMarkdown,
      status: decision.status,
      resolvedOptionKey: decision.resolvedOptionKey,
      resolutionNote: decision.resolutionNote
    })),
    sourcePaths: modifyPaths,
    modifyPaths,
    createPaths,
    disclosedRelativePaths: [...modifyPaths, ...createPaths],
    sourceFiles,
    createPreconditions: []
  }

  const pkg = makePackage(provenance, proposal)
  const registry = createCodeChangeReviewRegistry()
  const created = registry.createReview(pkg)
  registry.approveReview(project.id, created.reviewId)
  const fingerprint = computeCodeChangeReviewFingerprint(pkg)
  const review = registry.resolveAuthoritative(project.id, created.reviewId)

  return {
    db,
    registry,
    projectId: project.id,
    taskId: task.id,
    workRequestId: workRequest.id,
    tmpDir,
    reviewId: created.reviewId,
    fingerprint,
    review
  }
}

/** Deep-clones a trusted review and applies a mutation - simulates a SEPARATE, misbehaving reviewRegistry dependency disagreeing with the one that actually backed authorizeApply(). */
function alteredReview(review: CodeChangeAuthoritativeReview, mutate: (clone: CodeChangeAuthoritativeReview) => void): CodeChangeAuthoritativeReview {
  const clone = structuredClone(review)
  mutate(clone)
  return clone
}

/** A reviewRegistry whose resolveAuthoritative() always returns ONE fixed (possibly altered) review, regardless of the query - every other method delegates to the real registry (never called by admitBatch(), but required to satisfy the interface). */
function registryReturning(fixed: CodeChangeAuthoritativeReview, real: CodeChangeReviewRegistry): CodeChangeReviewRegistry {
  return {
    createReview: (pkg) => real.createReview(pkg),
    listReviewsForProject: (projectId) => real.listReviewsForProject(projectId),
    getReview: (projectId, reviewId) => real.getReview(projectId, reviewId),
    approveReview: (projectId, reviewId) => real.approveReview(projectId, reviewId),
    requestChanges: (projectId, reviewId, feedback) => real.requestChanges(projectId, reviewId, feedback),
    resolveAuthoritative: () => fixed
  }
}

function buildAuthorityService(s: Setup, consent?: ApplyConsentSource): ApplyAuthorityService {
  return createApplyAuthorityService({
    db: s.db,
    reviewRegistry: s.registry,
    applyConsentSource: consent ?? exactConsentSource(s.reviewId, s.fingerprint),
    capabilitySource: fixedCapabilitySource(s.projectId)
  })
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c
}

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
  tmpDirs.length = 0
})

function track(s: Setup): Setup {
  tmpDirs.push(s.tmpDir)
  return s
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyBatchJournalService - happy path admission', () => {
  it('admits a matching MODIFY+CREATE batch: ADMITTED batch row, PENDING entry rows, exact reconstructed original_bytes', () => {
    const s = track(
      setup({
        proposal: {
          summary: 'Modify one file, create another',
          changes: [
            { type: 'MODIFY', path: 'src/math.ts', content: DEFAULT_MODIFIED_CONTENT },
            { type: 'CREATE', path: 'src/new.ts', content: 'export const x = 1\n' }
          ],
          warnings: []
        }
      })
    )
    const journal = createApplyBatchJournalService({
      db: s.db,
      applyAuthorityService: buildAuthorityService(s),
      reviewRegistry: s.registry
    })

    const admitted = journal.admitBatch({ projectId: s.projectId, reviewId: s.reviewId })
    expect(admitted.projectId).toBe(s.projectId)
    expect(admitted.reviewId).toBe(s.reviewId)
    expect(admitted.fingerprint).toBe(s.fingerprint)
    expect(admitted.entryCount).toBe(2)

    const batchRow = s.db.prepare('SELECT * FROM apply_batches WHERE id = ?').get(admitted.batchId) as Record<string, unknown>
    expect(batchRow.state).toBe('ADMITTED')
    expect(batchRow.pre_recovery_state).toBeNull()
    expect(batchRow.root_native_file_id_128_hex).toBeNull()
    expect(JSON.parse(batchRow.authorization_json as string).reviewId).toBe(s.reviewId)

    const entryRows = s.db
      .prepare('SELECT * FROM apply_batch_entries WHERE batch_id = ? ORDER BY ordinal')
      .all(admitted.batchId) as Array<Record<string, unknown>>
    expect(entryRows).toHaveLength(2)
    expect(entryRows[0].state).toBe('PENDING')
    expect(entryRows[0].mutation_type).toBe('MODIFY')
    expect(entryRows[0].rel_path).toBe('src/math.ts')
    const expectedOriginal = reconstructOriginalBytes(DEFAULT_SOURCE_CONTENT, DEFAULT_FORMAT)
    expect(Buffer.from(entryRows[0].original_bytes as Buffer).equals(expectedOriginal)).toBe(true)
    expect(entryRows[0].original_sha256).toBe(createHash('sha256').update(expectedOriginal).digest('hex'))
    expect(entryRows[0].original_byte_length).toBe(expectedOriginal.length)

    expect(entryRows[1].state).toBe('PENDING')
    expect(entryRows[1].mutation_type).toBe('CREATE')
    expect(entryRows[1].rel_path).toBe('src/new.ts')
    expect(entryRows[1].original_bytes).toBeNull()
    expect(entryRows[1].original_sha256).toBeNull()
    expect(entryRows[1].original_byte_length).toBeNull()
  })

  it('propagates ApplyAuthorityError unchanged when authorizeApply() itself denies (no consent) - no row is written', () => {
    const s = track(setup())
    const journal = createApplyBatchJournalService({
      db: s.db,
      applyAuthorityService: buildAuthorityService(s, noConsentSource()),
      reviewRegistry: s.registry
    })
    expect(() => journal.admitBatch({ projectId: s.projectId, reviewId: s.reviewId })).toThrow()
    expect(countRows(s.db, 'apply_batches')).toBe(0)
  })

  it('restores synchronous=NORMAL after a successful admission (withFullDurability)', () => {
    const s = track(setup())
    const journal = createApplyBatchJournalService({
      db: s.db,
      applyAuthorityService: buildAuthorityService(s),
      reviewRegistry: s.registry
    })
    journal.admitBatch({ projectId: s.projectId, reviewId: s.reviewId })
    expect(s.db.pragma('synchronous', { simple: true })).toBe(1)
  })
})

describe('applyBatchJournalService - one unresolved batch per project', () => {
  it('rejects a second admission for the same project while the first is unresolved, and writes nothing on rejection', () => {
    const s = track(setup())
    const journal = createApplyBatchJournalService({
      db: s.db,
      applyAuthorityService: buildAuthorityService(s),
      reviewRegistry: s.registry
    })
    journal.admitBatch({ projectId: s.projectId, reviewId: s.reviewId })
    expect(countRows(s.db, 'apply_batches')).toBe(1)

    // A second, independently approved review for the SAME project.
    const secondPkg = makePackage(s.review.package.provenance, makeProposal({ summary: 'Second change', changes: [{ type: 'CREATE', path: 'src/second.ts', content: 'x' }] }))
    const secondCreated = s.registry.createReview(secondPkg)
    s.registry.approveReview(s.projectId, secondCreated.reviewId)
    const secondFingerprint = computeCodeChangeReviewFingerprint(secondPkg)
    const secondJournal = createApplyBatchJournalService({
      db: s.db,
      applyAuthorityService: buildAuthorityService(s, exactConsentSource(secondCreated.reviewId, secondFingerprint)),
      reviewRegistry: s.registry
    })

    expect(() => secondJournal.admitBatch({ projectId: s.projectId, reviewId: secondCreated.reviewId })).toThrow(ApplyBatchAdmissionError)
    try {
      secondJournal.admitBatch({ projectId: s.projectId, reviewId: secondCreated.reviewId })
    } catch (error) {
      expect(error).toBeInstanceOf(ApplyBatchAdmissionError)
      expect((error as ApplyBatchAdmissionError).code).toBe('PROJECT_HAS_UNRESOLVED_BATCH')
    }
    expect(countRows(s.db, 'apply_batches')).toBe(1)
  })
})

describe('applyBatchJournalService - provenance cross-check rejects every mismatch before any write', () => {
  function expectRejectedWithNoWrite(s: Setup, review: CodeChangeAuthoritativeReview): void {
    const journal = createApplyBatchJournalService({
      db: s.db,
      applyAuthorityService: buildAuthorityService(s),
      reviewRegistry: registryReturning(review, s.registry)
    })
    let thrown: unknown
    try {
      journal.admitBatch({ projectId: s.projectId, reviewId: s.reviewId })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ApplyBatchAdmissionError)
    expect((thrown as ApplyBatchAdmissionError).code).toBe('PROVENANCE_MISMATCH')
    expect(countRows(s.db, 'apply_batches')).toBe(0)
    expect(countRows(s.db, 'apply_batch_entries')).toBe(0)
  }

  it('1. projectId mismatch', () => {
    const s = track(setup())
    expectRejectedWithNoWrite(s, alteredReview(s.review, (r) => { r.projectId = r.projectId + 999 }))
  })

  it('2. reviewId mismatch', () => {
    const s = track(setup())
    expectRejectedWithNoWrite(s, alteredReview(s.review, (r) => { r.reviewId = 'tampered-review-id' }))
  })

  it('3. fingerprint mismatch', () => {
    const s = track(setup())
    expectRejectedWithNoWrite(s, alteredReview(s.review, (r) => { r.fingerprint = 'f'.repeat(64) }))
  })

  it('4. target projectFolderPath mismatch', () => {
    const s = track(setup())
    expectRejectedWithNoWrite(
      s,
      alteredReview(s.review, (r) => {
        r.package.provenance.projectFolderPath = path.join(s.tmpDir, 'somewhere-else')
      })
    )
  })

  it('5. root identity mismatch', () => {
    const s = track(setup())
    expectRejectedWithNoWrite(
      s,
      alteredReview(s.review, (r) => {
        r.package.provenance.rootIdentity = { realPath: s.tmpDir, dev: 'tampered', ino: 'tampered' }
      })
    )
  })

  it('6. mutation count mismatch (an extra change the authorization never saw)', () => {
    const s = track(setup())
    expectRejectedWithNoWrite(
      s,
      alteredReview(s.review, (r) => {
        r.package.proposal.changes.push({ type: 'CREATE', path: 'extra.ts', content: 'x' })
      })
    )
  })

  it('7. mutation path mismatch', () => {
    const s = track(setup())
    expectRejectedWithNoWrite(
      s,
      alteredReview(s.review, (r) => {
        r.package.proposal.changes[0].path = 'src/different.ts'
      })
    )
  })

  it('8. mutation order mismatch (reviewed order must match exactly, never re-matched by path)', () => {
    const s = track(
      setup({
        proposal: {
          summary: 'Two independent changes',
          changes: [
            { type: 'MODIFY', path: 'src/math.ts', content: DEFAULT_MODIFIED_CONTENT },
            { type: 'CREATE', path: 'src/second.ts', content: 'second\n' }
          ],
          warnings: []
        }
      })
    )
    expectRejectedWithNoWrite(
      s,
      alteredReview(s.review, (r) => {
        r.package.proposal.changes.reverse()
      })
    )
  })

  it('9. mutation type mismatch', () => {
    const s = track(setup())
    expectRejectedWithNoWrite(
      s,
      alteredReview(s.review, (r) => {
        ;(r.package.proposal.changes[0] as { type: string }).type = 'CREATE'
      })
    )
  })

  it('10. MODIFY original content altered (same byte length) - proves a hash-of-reconstruction check, not stored-field or reference equality', () => {
    const s = track(setup())
    const tamperedSameLength = DEFAULT_SOURCE_CONTENT.replace('add', 'sub') // same length, different bytes
    expect(tamperedSameLength.length).toBe(DEFAULT_SOURCE_CONTENT.length)
    expectRejectedWithNoWrite(
      s,
      alteredReview(s.review, (r) => {
        r.package.provenance.sourceFiles[0].content = tamperedSameLength
      })
    )
  })

  it('11. MODIFY original content altered (different byte length)', () => {
    const s = track(setup())
    expectRejectedWithNoWrite(
      s,
      alteredReview(s.review, (r) => {
        r.package.provenance.sourceFiles[0].content = DEFAULT_SOURCE_CONTENT + 'extra line\n'
      })
    )
  })

  it('12. CREATE shadowing an existing captured source file is rejected', () => {
    const s = track(
      setup({
        proposal: { summary: 'Create a new file', changes: [{ type: 'CREATE', path: 'src/new.ts', content: 'export const x = 1\n' }], warnings: [] },
        sourceFiles: []
      })
    )
    expectRejectedWithNoWrite(
      s,
      alteredReview(s.review, (r) => {
        r.package.provenance.sourceFiles.push(makeSourceFile({ path: 'src/new.ts' }))
      })
    )
  })

  it('positive control: an UNALTERED review (resolved via a wrapping registry) still admits successfully', () => {
    const s = track(setup())
    const journal = createApplyBatchJournalService({
      db: s.db,
      applyAuthorityService: buildAuthorityService(s),
      reviewRegistry: registryReturning(s.review, s.registry)
    })
    expect(() => journal.admitBatch({ projectId: s.projectId, reviewId: s.reviewId })).not.toThrow()
    expect(countRows(s.db, 'apply_batches')).toBe(1)
  })
})
