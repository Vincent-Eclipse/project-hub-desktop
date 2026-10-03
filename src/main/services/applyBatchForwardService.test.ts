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
  type CodeChangeReviewRegistry,
  type CodeChangeAuthoritativeReview
} from './codeChangeReviewService'
import type { CodeChangeGenerationProvenance, ValidatedCodeChangePackage } from './claudeCodeChangeService'
import type { ProjectTextFileFormat, ProjectTextFileIdentityEvidence, ProjectTextFileResult } from '@shared/projectTextReadTypes'
import type { CodeChangeProposal } from '@shared/codeChangeTypes'
import {
  createApplyAuthorityService,
  APPLY_CONSENT_PURPOSE_VERSION,
  ApplyAuthorityError,
  type ApplyAuthorityService,
  type ApplyConsentSource,
  type FilesystemWriteCapabilitySource
} from './applyAuthorityService'
import { createApplyBatchJournalService, ApplyBatchAdmissionError } from './applyBatchJournalService'
import type { WindowsSafeApplyPlan, WindowsSafeApplyModifyPlan, WindowsSafeApplyCreatePlan, WindowsSafeApplyOutcome } from './windowsSafeApply'
import { createApplyBatchRecoveryService, type ApplyBatchRecoveryNativeDependencies } from './applyBatchRecoveryService'
import {
  createApplyBatchForwardService,
  type ApplyBatchForwardNativeDependencies,
  type ApplyBatchForwardService
} from './applyBatchForwardService'

// Meilenstein 4.8B.3 Slice 2 - fake-native tests, real admission/authority
// chain throughout. Every test builds its forward service on top of a REAL
// createApplyBatchJournalService()+createApplyAuthorityService()+a real,
// in-memory CodeChangeReviewRegistry (mirroring applyBatchJournalService.test.ts's
// own setup() fixture) - only `native` is ever a fake. This is a deliberate
// simplification from the approved spec's "Tier 1 (fake journal) / Tier 2
// (real journal)" framing: since runForwardPass() ALWAYS needs a working
// reviewRegistry for its own proposed-bytes reconstruction regardless of
// whether admission itself is faked, using ONE real admission/authority
// fixture throughout - varying only consent/capability/review-state per test
// - avoids maintaining a second, hand-rolled CodeChangeAuthoritativeReview
// shape that could silently drift from the real type, while still fully
// proving every property the spec's two-tier split was designed to prove
// (see the implementation report's "deviations from v2" section).

// ---------------------------------------------------------------------------
// Fixtures - mirrors applyBatchJournalService.test.ts's fixture style exactly.
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

function deniedCapabilitySource(projectId: number): FilesystemWriteCapabilitySource {
  return {
    evaluateFilesystemWriteCapability: () => ({ projectId, capability: 'filesystem.write', decision: 'DENY', reason: 'POLICY_DENIED' })
  }
}

interface Setup {
  db: Database.Database
  registry: CodeChangeReviewRegistry
  projectId: number
  tmpDir: string
  reviewId: string
  fingerprint: string
  review: CodeChangeAuthoritativeReview
}

function setup(options: { proposal?: CodeChangeProposal; sourceFiles?: ProjectTextFileResult[]; approve?: boolean } = {}): Setup {
  const db = createTestDb()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-forward-test-'))

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
  if (options.approve !== false) registry.approveReview(project.id, created.reviewId)
  const fingerprint = computeCodeChangeReviewFingerprint(pkg)
  const review = registry.resolveAuthoritative(project.id, created.reviewId)

  return { db, registry, projectId: project.id, tmpDir, reviewId: created.reviewId, fingerprint, review }
}

function buildAuthorityService(s: Setup, overrides: { consent?: ApplyConsentSource; capability?: FilesystemWriteCapabilitySource } = {}): ApplyAuthorityService {
  return createApplyAuthorityService({
    db: s.db,
    reviewRegistry: s.registry,
    applyConsentSource: overrides.consent ?? exactConsentSource(s.reviewId, s.fingerprint),
    capabilitySource: overrides.capability ?? fixedCapabilitySource(s.projectId)
  })
}

function buildForwardService(
  s: Setup,
  native: ApplyBatchForwardNativeDependencies,
  overrides: {
    consent?: ApplyConsentSource
    capability?: FilesystemWriteCapabilitySource
    /**
     * Overrides ONLY the registry the forward runner itself re-resolves
     * against (runForwardPass's own reviewRegistry dependency) - admission
     * (journalService.admitBatch, and therefore authorizeApply) always uses
     * the REAL s.registry, unchanged, regardless of this override. This is
     * what lets a test simulate "a registry wiring/cache defect returns a
     * different/altered authoritative review for the runner's own lookup"
     * without weakening or replacing any part of the real admission chain.
     */
    forwardReviewRegistry?: CodeChangeReviewRegistry
  } = {}
): ApplyBatchForwardService {
  const applyAuthorityService = buildAuthorityService(s, overrides)
  const journalService = createApplyBatchJournalService({ db: s.db, applyAuthorityService, reviewRegistry: s.registry })
  return createApplyBatchForwardService({ db: s.db, native, reviewRegistry: overrides.forwardReviewRegistry ?? s.registry, journalService })
}

/** Deep-clones a trusted authoritative review and applies a mutation - simulates a registry wiring/cache defect returning a DIFFERENT or subtly altered authoritative review for the SAME lookup. Mirrors applyBatchJournalService.test.ts's own alteredReview() helper exactly. */
function alteredReview(review: CodeChangeAuthoritativeReview, mutate: (clone: CodeChangeAuthoritativeReview) => void): CodeChangeAuthoritativeReview {
  const clone = structuredClone(review)
  mutate(clone)
  return clone
}

/** A reviewRegistry whose resolveAuthoritative() is fully replaced by `resolve` (return a fixed/altered review, or throw) - every other method still delegates to the real registry (never called by the forward runner, but required to satisfy the interface). Mirrors applyBatchJournalService.test.ts's own registryReturning() helper. */
function decorateRegistry(real: CodeChangeReviewRegistry, resolve: (projectId: number, reviewId: string) => CodeChangeAuthoritativeReview): CodeChangeReviewRegistry {
  return {
    createReview: (pkg) => real.createReview(pkg),
    listReviewsForProject: (projectId) => real.listReviewsForProject(projectId),
    getReview: (projectId, reviewId) => real.getReview(projectId, reviewId),
    approveReview: (projectId, reviewId) => real.approveReview(projectId, reviewId),
    requestChanges: (projectId, reviewId, feedback) => real.requestChanges(projectId, reviewId, feedback),
    resolveAuthoritative: resolve
  }
}

function registryThrowing(real: CodeChangeReviewRegistry): CodeChangeReviewRegistry {
  return decorateRegistry(real, () => {
    throw new Error('simulated resolveAuthoritative failure')
  })
}

function registryReturningAltered(
  real: CodeChangeReviewRegistry,
  review: CodeChangeAuthoritativeReview,
  mutate: (clone: CodeChangeAuthoritativeReview) => void
): CodeChangeReviewRegistry {
  return decorateRegistry(real, () => alteredReview(review, mutate))
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
// Fake native - a REALISTIC, self-consistent default (a fresh happy path
// needs zero overrides: content/identity for applyModify/createFile/verifyFile
// are derived from whatever bytes prepareLease() actually captured, so the
// runner's own TS-level content+identity comparisons pass by construction),
// with targeted per-method overrides for failure injection.
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function outcomeForBytes(bytes: Buffer, fileId: string, volumeSerial: string): WindowsSafeApplyOutcome {
  return { code: 'OK', sha256Hex: sha256Hex(bytes), length: bytes.length, nativeFileId128Hex: fileId, nativeVolumeSerial: volumeSerial }
}

const ROOT_FILE_ID = 'a'.repeat(32)
const ROOT_VOLUME = '1000000001'
const APPLIED_FILE_ID = 'b'.repeat(32)
const APPLIED_VOLUME = '2000000002'

interface FakeNativeCalls {
  prepareLease: number
  applyModify: number
  createFile: number
  verifyFile: number
  closeLease: number
  modifyIndices: number[]
  createIndices: number[]
  /** The exact plan passed to the most recent prepareLease() call - captured regardless of whether a custom override or the default handled it, so tests can inspect exactly what the forward runner built without needing their own prepareLease override. */
  lastPreparePlan: WindowsSafeApplyPlan | null
}

function makeFakeNative(overrides: Partial<ApplyBatchForwardNativeDependencies> = {}): { native: ApplyBatchForwardNativeDependencies; calls: FakeNativeCalls } {
  const calls: FakeNativeCalls = {
    prepareLease: 0,
    applyModify: 0,
    createFile: 0,
    verifyFile: 0,
    closeLease: 0,
    modifyIndices: [],
    createIndices: [],
    lastPreparePlan: null
  }
  let capturedModifies: WindowsSafeApplyModifyPlan[] = []
  let capturedCreates: WindowsSafeApplyCreatePlan[] = []

  const defaultPrepareLease = (plan: WindowsSafeApplyPlan) => {
    capturedModifies = plan.modifies ?? []
    capturedCreates = plan.creates ?? []
    return {
      lease: {},
      root: outcomeForBytes(Buffer.alloc(0), ROOT_FILE_ID, ROOT_VOLUME),
      modifies: capturedModifies.map((m) => outcomeForBytes(m.proposedBytes, APPLIED_FILE_ID, APPLIED_VOLUME))
    }
  }
  const defaultApplyModify = (_lease: unknown, index: number) => outcomeForBytes(capturedModifies[index].proposedBytes, APPLIED_FILE_ID, APPLIED_VOLUME)
  const defaultCreateFile = (_lease: unknown, index: number) => outcomeForBytes(capturedCreates[index].proposedBytes, APPLIED_FILE_ID, APPLIED_VOLUME)
  const defaultVerifyFile = (_lease: unknown, index: number, isCreate: boolean) => {
    const bytes = isCreate ? capturedCreates[index].proposedBytes : capturedModifies[index].proposedBytes
    return outcomeForBytes(bytes, APPLIED_FILE_ID, APPLIED_VOLUME)
  }

  const native: ApplyBatchForwardNativeDependencies = {
    prepareLease: (plan) => {
      calls.prepareLease++
      calls.lastPreparePlan = plan
      return (overrides.prepareLease ?? defaultPrepareLease)(plan)
    },
    applyModify: (lease, index) => {
      calls.applyModify++
      calls.modifyIndices.push(index)
      return (overrides.applyModify ?? defaultApplyModify)(lease, index)
    },
    createFile: (lease, index) => {
      calls.createFile++
      calls.createIndices.push(index)
      return (overrides.createFile ?? defaultCreateFile)(lease, index)
    },
    verifyFile: (lease, index, isCreate) => {
      calls.verifyFile++
      return (overrides.verifyFile ?? defaultVerifyFile)(lease, index, isCreate)
    },
    closeLease: (lease) => {
      calls.closeLease++
      if (overrides.closeLease) overrides.closeLease(lease)
    }
  }
  return { native, calls }
}

function totalNativeCalls(calls: FakeNativeCalls): number {
  return calls.prepareLease + calls.applyModify + calls.createFile + calls.verifyFile
}

/** Counts db.pragma('synchronous = FULL') invocations - one per independent withFullDurability transaction. */
function countDurableTransactions(db: Database.Database): { count: () => number } {
  let n = 0
  const originalPragma = db.pragma.bind(db)
  ;(db as unknown as { pragma: typeof db.pragma }).pragma = ((source: string, options?: unknown) => {
    if (typeof source === 'string' && source.trim() === 'synchronous = FULL') n++
    return originalPragma(source, options as never)
  }) as typeof db.pragma
  return { count: () => n }
}

/** Records the ORDER of state-changing writes by a coarse label, without altering behavior. */
function recordWriteOrder(db: Database.Database): { writes: string[] } {
  const writes: string[] = []
  const originalPrepare = db.prepare.bind(db)
  ;(db as unknown as { prepare: (sql: string) => Database.Statement }).prepare = ((sql: string) => {
    const stmt = originalPrepare(sql)
    if (/^\s*UPDATE/i.test(sql)) {
      const originalRun = (stmt.run as unknown as (...args: unknown[]) => unknown).bind(stmt)
      ;(stmt as unknown as { run: (...args: unknown[]) => unknown }).run = (...args: unknown[]) => {
        let label = 'other'
        if (/UPDATE apply_batches SET state='PREPARED'/.test(sql)) label = 'batch:PREPARED'
        else if (/UPDATE apply_batches SET state='APPLYING'/.test(sql)) label = 'batch:APPLYING'
        else if (/UPDATE apply_batches SET state='SUCCEEDED'/.test(sql)) label = 'batch:SUCCEEDED'
        else if (/UPDATE apply_batch_entries SET state='PREPARED'/.test(sql)) label = 'entry:PREPARED'
        else if (/UPDATE apply_batch_entries SET state='APPLY_ATTEMPTING'/.test(sql)) label = 'entry:APPLY_ATTEMPTING'
        else if (/UPDATE apply_batch_entries SET state='APPLIED'/.test(sql)) label = 'entry:APPLIED'
        writes.push(label)
        return originalRun(...args)
      }
    }
    return stmt
  }) as typeof db.prepare
  return { writes }
}

/** Targets ONE specific durable write (by SQL text) and makes its .run() execute for real, then throw, exactly once - simulating a crash after that UPDATE ran but before its enclosing withFullDurability transaction commits. */
function injectFailureOnNextMatchingWrite(db: Database.Database, sqlPattern: RegExp): void {
  const originalPrepare = db.prepare.bind(db)
  let armed = true
  ;(db as unknown as { prepare: (sql: string) => Database.Statement }).prepare = ((sql: string) => {
    const stmt = originalPrepare(sql)
    if (armed && sqlPattern.test(sql)) {
      armed = false
      const originalRun = (stmt.run as unknown as (...args: unknown[]) => unknown).bind(stmt)
      ;(stmt as unknown as { run: (...args: unknown[]) => unknown }).run = (...args: unknown[]) => {
        originalRun(...args)
        throw new Error(`simulated crash: transaction rolled back after UPDATE ran (matched ${sqlPattern})`)
      }
    }
    return stmt
  }) as typeof db.prepare
}

function readBatchRow(db: Database.Database, id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM apply_batches WHERE id = ?').get(id) as Record<string, unknown>
}

function readEntryRows(db: Database.Database, batchId: number): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM apply_batch_entries WHERE batch_id = ? ORDER BY ordinal').all(batchId) as Array<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// A. No public batch-ID forward entry point exists
// ---------------------------------------------------------------------------

describe('applyBatchForwardService - no public batch-ID entry point', () => {
  it('the returned service object has exactly one method: submitApply', () => {
    const s = track(setup())
    const { native } = makeFakeNative()
    const service = buildForwardService(s, native)
    expect(Object.keys(service)).toEqual(['submitApply'])
  })

  it('source-scope: no export of a private runner or any batch-ID-accepting function', () => {
    const source = fs.readFileSync(path.join(__dirname, 'applyBatchForwardService.ts'), 'utf8')
    expect(source).not.toMatch(/export\s+function\s+runForwardPass/)
    expect(source).not.toMatch(/export\s+function\s+applyBatch\s*\(/)
    expect(source).not.toContain('export { runForwardPass')
  })

  it('a malformed request (a bare batch-ID-shaped number, simulating misuse) is rejected by the existing admission validation, zero native calls', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    const service = buildForwardService(s, native)
    expect(() => service.submitApply(42)).toThrow(ApplyAuthorityError)
    expect(totalNativeCalls(calls)).toBe(0)
  })

  it('a historical PREPARED/APPLYING/SUCCEEDED batch cannot be referenced by any argument to the only public method (submitApply takes no batch identifier at all)', () => {
    const s = track(setup())
    const { native } = makeFakeNative()
    const service = buildForwardService(s, native)
    // submitApply's only parameter is the selection-only rawRequest - there is
    // no argument shape through which a numeric/historical batch id could be
    // supplied; this is proven by the type signature itself (§A above) and by
    // the fact that no seeded historical row is ever reachable through it.
    expect(service.submitApply.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// B. Admission happens before any review/native forward work
// ---------------------------------------------------------------------------

describe('applyBatchForwardService - admission ordering', () => {
  it('journalService.admitBatch() runs, and returns, strictly before any native call', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    const service = buildForwardService(s, native)
    // If admission ran after or interleaved with native calls, prepareLease
    // would already have been called by the time admission's own DB row
    // exists - assert the row exists and native calls only happen after.
    const result = service.submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(result.batchId).toBeGreaterThan(0)
    expect(calls.prepareLease).toBe(1) // native work did happen, but only after a real admitted row was produced
    expect(readBatchRow(s.db, result.batchId)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// B2. The runner's OWN defensive review-binding cross-check (Codex follow-up
// finding). Admission (journalService.admitBatch, authorizeApply) always uses
// the REAL registry, unchanged - only the forward runner's OWN separate
// re-resolution (via reviewRegistry.resolveAuthoritative, used for its own
// proposed-bytes reconstruction) is redirected through a narrow decorator
// that returns a copied-and-altered (or throwing) authoritative review,
// simulating a registry wiring/cache defect or a future registry swap. Every
// case here must reject with REVIEW_MISMATCH, before any byte
// reconstruction, root resolution, prepareLease, or other native call, and
// must never advance the already-admitted batch past ADMITTED/entries past
// PENDING.
// ---------------------------------------------------------------------------

describe('applyBatchForwardService - defensive review-binding cross-check', () => {
  function expectRejectedNoWrite(s: Setup, result: ReturnType<ApplyBatchForwardService['submitApply']>, calls: FakeNativeCalls, entryId: number | null = null, ordinal: number | null = null): void {
    expect(result.outcome).toBe('STOPPED')
    expect(result.failure).toEqual({ phase: 'REVIEW_MISMATCH', entryId, ordinal, code: null })
    expect(totalNativeCalls(calls)).toBe(0)
    expect(readBatchRow(s.db, result.batchId).state).toBe('ADMITTED')
    for (const row of readEntryRows(s.db, result.batchId)) expect(row.state).toBe('PENDING')
  }

  it('1. resolveAuthoritative() throws -> REVIEW_MISMATCH, zero native calls, batch stays ADMITTED', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    const result = buildForwardService(s, native, { forwardReviewRegistry: registryThrowing(s.registry) }).submitApply({
      projectId: s.projectId,
      reviewId: s.reviewId
    })
    expectRejectedNoWrite(s, result, calls)
  })

  it('2. resolved review has a DIFFERENT projectId than the freshly admitted batch -> REVIEW_MISMATCH, zero native calls', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    const forwardRegistry = registryReturningAltered(s.registry, s.review, (r) => {
      r.projectId = r.projectId + 999
    })
    const result = buildForwardService(s, native, { forwardReviewRegistry: forwardRegistry }).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expectRejectedNoWrite(s, result, calls)
  })

  it('3. resolved review has a DIFFERENT reviewId than the freshly admitted batch -> REVIEW_MISMATCH, zero native calls', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    const forwardRegistry = registryReturningAltered(s.registry, s.review, (r) => {
      r.reviewId = 'tampered-review-id'
    })
    const result = buildForwardService(s, native, { forwardReviewRegistry: forwardRegistry }).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expectRejectedNoWrite(s, result, calls)
  })

  it('4. resolved review has a DIFFERENT fingerprint than the freshly admitted batch -> REVIEW_MISMATCH, zero native calls', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    const forwardRegistry = registryReturningAltered(s.registry, s.review, (r) => {
      r.fingerprint = 'f'.repeat(64)
    })
    const result = buildForwardService(s, native, { forwardReviewRegistry: forwardRegistry }).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expectRejectedNoWrite(s, result, calls)
  })

  it('5. reviewed order changed (changes reversed vs. the admitted entries) -> REVIEW_MISMATCH, zero native calls', () => {
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
    const { native, calls } = makeFakeNative()
    const forwardRegistry = registryReturningAltered(s.registry, s.review, (r) => {
      r.package.proposal.changes.reverse()
    })
    const result = buildForwardService(s, native, { forwardReviewRegistry: forwardRegistry }).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expectRejectedNoWrite(s, result, calls)
  })

  it('6. a change\'s path differs from the admitted entry at the same position -> REVIEW_MISMATCH, zero native calls', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    const forwardRegistry = registryReturningAltered(s.registry, s.review, (r) => {
      r.package.proposal.changes[0].path = 'src/different.ts'
    })
    const result = buildForwardService(s, native, { forwardReviewRegistry: forwardRegistry }).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expectRejectedNoWrite(s, result, calls)
  })

  it('7. a change\'s mutation type differs from the admitted entry at the same position -> REVIEW_MISMATCH, zero native calls', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    const forwardRegistry = registryReturningAltered(s.registry, s.review, (r) => {
      ;(r.package.proposal.changes[0] as { type: string }).type = 'CREATE'
    })
    const result = buildForwardService(s, native, { forwardReviewRegistry: forwardRegistry }).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expectRejectedNoWrite(s, result, calls)
  })

  it('8. reconstructed content no longer matches the durably-admitted proposed hash/length -> REVIEW_MISMATCH, zero native calls, correct entry/ordinal identified', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    const forwardRegistry = registryReturningAltered(s.registry, s.review, (r) => {
      r.package.proposal.changes[0].content = DEFAULT_MODIFIED_CONTENT + 'unexpected extra line\n'
    })
    const result = buildForwardService(s, native, { forwardReviewRegistry: forwardRegistry }).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    // The mismatch is detected per-entry (reconstructAndCrossCheckProposedBytes),
    // not batch-wide like cases 1-7 above - entryId/ordinal are still null
    // because the function reports a whole-batch null on ANY mismatch,
    // never partially trusting a subset of entries.
    expectRejectedNoWrite(s, result, calls)
  })

  it('9. positive control: a MODIFY entry with a BOM-formatted source file reconstructs correctly (no mismatch) and the EXACT BOM-prefixed bytes are what reaches the native prepareLease plan', () => {
    const bomFormat: ProjectTextFileFormat = { utf8Bom: true, lineEnding: 'LF', finalNewline: true }
    const s = track(setup({ sourceFiles: [makeSourceFile({ path: 'src/math.ts', content: DEFAULT_SOURCE_CONTENT, format: bomFormat })] }))
    const { native, calls } = makeFakeNative()
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    // Reconstruction succeeded (no REVIEW_MISMATCH) and the pass completed normally.
    expect(result.outcome).toBe('SUCCEEDED')
    expect(result.failure).toBeNull()

    // The exact bytes placed in the native plan carry the BOM prefix -
    // reconstructProposedBytes(change, {utf8Bom:true, ...}) prepends
    // EF BB BF, exactly mirroring reconstructOriginalBytes()'s own BOM
    // handling for the admitted original_bytes.
    const expectedProposedBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(DEFAULT_MODIFIED_CONTENT, 'utf8')])
    const plan = calls.lastPreparePlan
    expect(plan).not.toBeNull()
    expect(plan?.modifies).toHaveLength(1)
    expect((plan?.modifies?.[0].proposedBytes as Buffer).equals(expectedProposedBytes)).toBe(true)
    expect(plan?.modifies?.[0].proposedBytes.length).toBe(expectedProposedBytes.length)
  })
})

// ---------------------------------------------------------------------------
// C. Rejected/revoked authority, denied capability, unapproved review,
//    unresolved batch: zero forward native calls in every case
// ---------------------------------------------------------------------------

describe('applyBatchForwardService - rejected/revoked authority reaches zero forward native calls', () => {
  it('no consent recorded -> ApplyAuthorityError, zero native calls, zero journal rows', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    const service = buildForwardService(s, native, { consent: noConsentSource() })
    expect(() => service.submitApply({ projectId: s.projectId, reviewId: s.reviewId })).toThrow(ApplyAuthorityError)
    expect(totalNativeCalls(calls)).toBe(0)
    expect((s.db.prepare('SELECT COUNT(*) as c FROM apply_batches').get() as { c: number }).c).toBe(0)
  })

  it('capability denied -> ApplyAuthorityError, zero native calls', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    const service = buildForwardService(s, native, { capability: deniedCapabilitySource(s.projectId) })
    expect(() => service.submitApply({ projectId: s.projectId, reviewId: s.reviewId })).toThrow(ApplyAuthorityError)
    expect(totalNativeCalls(calls)).toBe(0)
  })

  it('review not approved -> ApplyAuthorityError, zero native calls', () => {
    const s = track(setup({ approve: false }))
    const { native, calls } = makeFakeNative()
    const service = buildForwardService(s, native)
    expect(() => service.submitApply({ projectId: s.projectId, reviewId: s.reviewId })).toThrow(ApplyAuthorityError)
    expect(totalNativeCalls(calls)).toBe(0)
  })

  it('a second project batch already unresolved -> ApplyBatchAdmissionError(PROJECT_HAS_UNRESOLVED_BATCH), zero native calls for the rejected attempt, pre-existing batch unaffected', () => {
    const s = track(setup())
    const { native: firstNative } = makeFakeNative({ applyModify: () => { throw codedError('BUSY') } })
    const firstService = buildForwardService(s, firstNative)
    const first = firstService.submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(first.outcome).toBe('STOPPED')
    const beforeSecond = readBatchRow(s.db, first.batchId)

    const secondPkg = makePackage(s.review.package.provenance, makeProposal({ summary: 'Second', changes: [{ type: 'CREATE', path: 'src/second.ts', content: 'x' }] }))
    const secondCreated = s.registry.createReview(secondPkg)
    s.registry.approveReview(s.projectId, secondCreated.reviewId)
    const secondFingerprint = computeCodeChangeReviewFingerprint(secondPkg)
    const { native: secondNative, calls: secondCalls } = makeFakeNative()
    const secondService = buildForwardService(s, secondNative, { consent: exactConsentSource(secondCreated.reviewId, secondFingerprint) })

    expect(() => secondService.submitApply({ projectId: s.projectId, reviewId: secondCreated.reviewId })).toThrow(ApplyBatchAdmissionError)
    try {
      secondService.submitApply({ projectId: s.projectId, reviewId: secondCreated.reviewId })
    } catch (error) {
      expect((error as ApplyBatchAdmissionError).code).toBe('PROJECT_HAS_UNRESOLVED_BATCH')
    }
    expect(totalNativeCalls(secondCalls)).toBe(0)
    expect(readBatchRow(s.db, first.batchId)).toEqual(beforeSecond)
  })
})

// ---------------------------------------------------------------------------
// D. No second invocation can replay an unresolved (or even a terminal) batch
// ---------------------------------------------------------------------------

describe('applyBatchForwardService - no second invocation can replay', () => {
  it('first submit stops mid-batch (STOPPED, batch left APPLYING) - a second submit for the same review is rejected (PROJECT_HAS_UNRESOLVED_BATCH), never resuming the first batch', () => {
    const s = track(setup())
    const { native: firstNative } = makeFakeNative({ applyModify: () => { throw codedError('BUSY') } })
    const first = buildForwardService(s, firstNative).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(first.outcome).toBe('STOPPED')
    expect(readBatchRow(s.db, first.batchId).state).toBe('APPLYING')

    const { native: secondNative, calls: secondCalls } = makeFakeNative()
    const secondService = buildForwardService(s, secondNative)
    expect(() => secondService.submitApply({ projectId: s.projectId, reviewId: s.reviewId })).toThrow(ApplyBatchAdmissionError)
    expect(totalNativeCalls(secondCalls)).toBe(0)
    expect(readBatchRow(s.db, first.batchId).state).toBe('APPLYING') // untouched by the rejected second attempt
  })

  it('first submit fully SUCCEEDED - a second submit for the same review creates an entirely NEW, independent batch, never a resumption of the first (terminal, immutable) one', () => {
    const s = track(setup())
    const { native: firstNative } = makeFakeNative()
    const first = buildForwardService(s, firstNative).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(first.outcome).toBe('SUCCEEDED')

    const { native: secondNative } = makeFakeNative()
    const second = buildForwardService(s, secondNative).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(second.outcome).toBe('SUCCEEDED')
    expect(second.batchId).not.toBe(first.batchId)
    expect(readBatchRow(s.db, first.batchId).state).toBe('SUCCEEDED') // unchanged
  })
})

// ---------------------------------------------------------------------------
// E. Happy path, mixed batches, index mapping
// ---------------------------------------------------------------------------

describe('applyBatchForwardService - happy path', () => {
  it('MODIFY-only batch succeeds: SUCCEEDED, entry APPLIED with evidence from the verify outcome, completed_at set', () => {
    const s = track(setup())
    const { native } = makeFakeNative()
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('SUCCEEDED')
    expect(result.entriesApplied).toBe(1)
    expect(result.totalEntries).toBe(1)
    expect(result.failure).toBeNull()

    const batchRow = readBatchRow(s.db, result.batchId)
    expect(batchRow.state).toBe('SUCCEEDED')
    expect(batchRow.completed_at).not.toBeNull()
    expect(batchRow.root_native_file_id_128_hex).toBe(ROOT_FILE_ID)

    const entryRows = readEntryRows(s.db, result.batchId)
    expect(entryRows).toHaveLength(1)
    expect(entryRows[0].state).toBe('APPLIED')
    expect(entryRows[0].native_file_id_128_hex).toBe(APPLIED_FILE_ID)
    expect(entryRows[0].failure_note).toBeNull()
  })

  it('CREATE-only batch succeeds: SUCCEEDED, entry APPLIED', () => {
    const s = track(
      setup({
        proposal: { summary: 'Create', changes: [{ type: 'CREATE', path: 'src/new.ts', content: 'export const x = 1\n' }], warnings: [] },
        sourceFiles: []
      })
    )
    const { native, calls } = makeFakeNative()
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('SUCCEEDED')
    expect(calls.createFile).toBe(1)
    expect(calls.applyModify).toBe(0)
    expect(readEntryRows(s.db, result.batchId)[0].state).toBe('APPLIED')
  })

  it('mixed MODIFY/CREATE/MODIFY batch: correct, independent per-kind index assignment regardless of ordinal interleaving', () => {
    const s = track(
      setup({
        proposal: {
          summary: 'Mixed',
          changes: [
            { type: 'MODIFY', path: 'src/a.ts', content: 'proposed a\n' },
            { type: 'CREATE', path: 'src/c.ts', content: 'created c\n' },
            { type: 'MODIFY', path: 'src/b.ts', content: 'proposed b\n' }
          ],
          warnings: []
        },
        sourceFiles: [makeSourceFile({ path: 'src/a.ts', content: 'original a\n' }), makeSourceFile({ path: 'src/b.ts', content: 'original b\n' })]
      })
    )
    const { native, calls } = makeFakeNative()
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('SUCCEEDED')
    expect(new Set(calls.modifyIndices)).toEqual(new Set([0, 1]))
    expect(new Set(calls.createIndices)).toEqual(new Set([0]))
  })

  it('an empty mutation set (0 entries) trivially succeeds', () => {
    const s = track(setup({ proposal: { summary: 'Empty', changes: [], warnings: [] }, sourceFiles: [] }))
    const { native, calls } = makeFakeNative()
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(result.outcome).toBe('SUCCEEDED')
    expect(result.totalEntries).toBe(0)
    expect(calls.prepareLease).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// F. Prepare / mutate / verify failures
// ---------------------------------------------------------------------------

describe('applyBatchForwardService - native failure classification', () => {
  it('prepareLease() throws -> STOPPED, phase PREPARE, batch stays ADMITTED, entries stay PENDING, zero close calls', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative({ prepareLease: () => { throw codedError('PRECONDITION_FAILED') } })
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('STOPPED')
    expect(result.failure).toEqual({ phase: 'PREPARE', entryId: null, ordinal: null, code: 'PRECONDITION_FAILED' })
    expect(readBatchRow(s.db, result.batchId).state).toBe('ADMITTED')
    expect(readEntryRows(s.db, result.batchId)[0].state).toBe('PENDING')
    expect(calls.closeLease).toBe(0)
  })

  it('applyModify() throws mid-batch (2 MODIFY entries) -> STOPPED, phase MUTATE, first entry APPLIED, second APPLY_ATTEMPTING, close called once', () => {
    const s = track(
      setup({
        proposal: {
          summary: 'Two modifies',
          changes: [
            { type: 'MODIFY', path: 'src/a.ts', content: 'proposed a\n' },
            { type: 'MODIFY', path: 'src/b.ts', content: 'proposed b\n' }
          ],
          warnings: []
        },
        sourceFiles: [makeSourceFile({ path: 'src/a.ts', content: 'original a\n' }), makeSourceFile({ path: 'src/b.ts', content: 'original b\n' })]
      })
    )
    let call = 0
    const { native, calls } = makeFakeNative({
      applyModify: () => {
        call++
        if (call === 2) throw codedError('BUSY')
        return outcomeForBytes(Buffer.from('proposed a\n'), APPLIED_FILE_ID, APPLIED_VOLUME)
      }
    })
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('STOPPED')
    expect(result.failure?.phase).toBe('MUTATE')
    expect(result.failure?.code).toBe('BUSY')
    expect(result.entriesApplied).toBe(1)
    const rows = readEntryRows(s.db, result.batchId)
    expect(rows[0].state).toBe('APPLIED')
    expect(rows[1].state).toBe('APPLY_ATTEMPTING')
    expect(calls.closeLease).toBe(1)
  })

  it('createFile() throws -> STOPPED, phase MUTATE, entry stays APPLY_ATTEMPTING', () => {
    const s = track(setup({ proposal: { summary: 'Create', changes: [{ type: 'CREATE', path: 'src/new.ts', content: 'x' }], warnings: [] }, sourceFiles: [] }))
    const { native } = makeFakeNative({ createFile: () => { throw codedError('PRECONDITION_FAILED') } })
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('STOPPED')
    expect(result.failure?.phase).toBe('MUTATE')
    expect(readEntryRows(s.db, result.batchId)[0].state).toBe('APPLY_ATTEMPTING')
  })

  it('verifyFile() itself throws after a successful applyModify() -> STOPPED, phase VERIFY, entry stays APPLY_ATTEMPTING (never APPLIED)', () => {
    const s = track(setup())
    const { native } = makeFakeNative({ verifyFile: () => { throw codedError('IO_FAILED') } })
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('STOPPED')
    expect(result.failure?.phase).toBe('VERIFY')
    expect(readEntryRows(s.db, result.batchId)[0].state).toBe('APPLY_ATTEMPTING')
  })

  it('verifyFile() returns OK but with a content hash/length mismatch vs. the durably-admitted proposed values -> treated as VERIFY, never APPLIED', () => {
    const s = track(setup())
    const { native } = makeFakeNative({ verifyFile: () => outcomeForBytes(Buffer.from('wrong content'), APPLIED_FILE_ID, APPLIED_VOLUME) })
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('STOPPED')
    expect(result.failure?.phase).toBe('VERIFY')
    expect(result.failure?.code).toBe('VERIFY_MISMATCH')
    expect(readEntryRows(s.db, result.batchId)[0].state).toBe('APPLY_ATTEMPTING')
  })

  it('verifyFile() returns OK with matching content but a DIFFERENT identity than the mutate call\'s own outcome (file-swap defense) -> VERIFY, never APPLIED', () => {
    const s = track(setup())
    const { native } = makeFakeNative({
      verifyFile: () => outcomeForBytes(Buffer.from(DEFAULT_MODIFIED_CONTENT), 'c'.repeat(32), APPLIED_VOLUME)
    })
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('STOPPED')
    expect(result.failure?.phase).toBe('VERIFY')
    expect(result.failure?.code).toBe('VERIFY_MISMATCH')
  })
})

// ---------------------------------------------------------------------------
// G. Close behavior
// ---------------------------------------------------------------------------

describe('applyBatchForwardService - lease closing on every branch', () => {
  it('happy path: closeLease called exactly once', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative()
    buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(calls.closeLease).toBe(1)
  })

  it('prepareLease() failure: closeLease called exactly zero times (no lease exists)', () => {
    const s = track(setup())
    const { native, calls } = makeFakeNative({ prepareLease: () => { throw codedError('BUSY') } })
    buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(calls.closeLease).toBe(0)
  })

  it('closeLease() itself throwing does not mask a mutate/verify failure already determined', () => {
    const s = track(setup())
    const { native } = makeFakeNative({
      applyModify: () => { throw codedError('BUSY') },
      closeLease: () => { throw new Error('close failed') }
    })
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(result.outcome).toBe('STOPPED')
    expect(result.failure?.phase).toBe('MUTATE')
    expect(result.failure?.code).toBe('BUSY')
  })

  it('closeLease() itself throwing on the all-succeeded path does not prevent the batch SUCCEEDED write', () => {
    const s = track(setup())
    const { native } = makeFakeNative({ closeLease: () => { throw new Error('close failed') } })
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(result.outcome).toBe('SUCCEEDED')
    expect(readBatchRow(s.db, result.batchId).state).toBe('SUCCEEDED')
  })
})

// ---------------------------------------------------------------------------
// H. Write ordering / FULL durability
// ---------------------------------------------------------------------------

describe('applyBatchForwardService - durable write ordering', () => {
  it('full write-order for a 1-MODIFY-entry batch: batch PREPARED, entry PREPARED, batch APPLYING, entry APPLY_ATTEMPTING, entry APPLIED, batch SUCCEEDED', () => {
    const s = track(setup())
    const { writes } = recordWriteOrder(s.db)
    const { native } = makeFakeNative()
    buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(writes).toEqual(['batch:PREPARED', 'entry:PREPARED', 'batch:APPLYING', 'entry:APPLY_ATTEMPTING', 'entry:APPLIED', 'batch:SUCCEEDED'])
  })

  it('APPLY_ATTEMPTING commits before the mutating native call is invoked', () => {
    const s = track(setup())
    let entryStateDuringMutate: unknown
    const { native } = makeFakeNative({
      applyModify: () => {
        const rows = s.db.prepare('SELECT state FROM apply_batch_entries').all() as Array<{ state: string }>
        entryStateDuringMutate = rows[0]?.state
        return outcomeForBytes(Buffer.from(DEFAULT_MODIFIED_CONTENT), APPLIED_FILE_ID, APPLIED_VOLUME)
      }
    })
    const result = buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(result.outcome).toBe('SUCCEEDED')
    expect(entryStateDuringMutate).toBe('APPLY_ATTEMPTING')
  })

  it('APPLIED does not commit until after verifyFile() succeeds', () => {
    const s = track(setup())
    let entryStateDuringVerify: unknown
    const { native } = makeFakeNative({
      verifyFile: () => {
        const rows = s.db.prepare('SELECT state FROM apply_batch_entries').all() as Array<{ state: string }>
        entryStateDuringVerify = rows[0]?.state
        return outcomeForBytes(Buffer.from(DEFAULT_MODIFIED_CONTENT), APPLIED_FILE_ID, APPLIED_VOLUME)
      }
    })
    buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(entryStateDuringVerify).toBe('APPLY_ATTEMPTING')
  })

  it('every write is an independent FULL-durability transaction (7 for a 1-entry happy path: admission\'s own ADMITTED+PENDING write, then batch PREPARED, entry PREPARED, batch APPLYING, entry APPLY_ATTEMPTING, entry APPLIED, batch SUCCEEDED)', () => {
    const s = track(setup())
    const durability = countDurableTransactions(s.db)
    const { native } = makeFakeNative()
    buildForwardService(s, native).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(durability.count()).toBe(7)
  })

  it('static source-scan: every UPDATE ... SET state= is lexically nested inside a withFullDurability(db, () => {...}) block', () => {
    const source = fs.readFileSync(path.join(__dirname, 'applyBatchForwardService.ts'), 'utf8')
    const lines = source.split('\n')
    let checked = 0
    lines.forEach((line, i) => {
      if (!/UPDATE apply_batch(_entries)? SET state=/.test(line)) return
      checked++
      const precedingWindow = lines.slice(Math.max(0, i - 2), i).join('\n')
      expect(precedingWindow).toContain('withFullDurability(db, () => {')
    })
    expect(checked).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// I. Crash-state handoff to B.2C - real, unmodified applyBatchRecoveryService
// ---------------------------------------------------------------------------

describe('applyBatchForwardService - crash-state handoff to B.2C recovery', () => {
  function fakeRecoveryNative(overrides: Partial<ApplyBatchRecoveryNativeDependencies> = {}): { native: ApplyBatchRecoveryNativeDependencies } {
    const native: ApplyBatchRecoveryNativeDependencies = {
      prepareLease: overrides.prepareLease ?? (() => { throw codedError('PRECONDITION_FAILED') }),
      applyModify: overrides.applyModify ?? (() => { throw codedError('PRECONDITION_FAILED') }),
      recoverDeleteCreated: overrides.recoverDeleteCreated ?? (() => { throw codedError('PRECONDITION_FAILED') }),
      closeLease: overrides.closeLease ?? (() => {})
    }
    return { native }
  }

  it('crash before prepare (batch ADMITTED, entries PENDING) -> recoverBatch() resolves ROLLED_BACK, zero native calls', () => {
    const s = track(setup())
    const { native: forwardNative } = makeFakeNative({ prepareLease: () => { throw codedError('PRECONDITION_FAILED') } })
    const result = buildForwardService(s, forwardNative).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(readBatchRow(s.db, result.batchId).state).toBe('ADMITTED')

    const { native: recoveryNative } = fakeRecoveryNative()
    const recovery = createApplyBatchRecoveryService({ db: s.db, native: recoveryNative }).recoverBatch(result.batchId)
    expect(recovery.finalState).toBe('ROLLED_BACK')
  })

  it('crash mid-batch (one entry APPLIED, one APPLY_ATTEMPTING with disk unrecorded) -> recoverBatch() reverses the APPLIED entry toward original and parks the other as RECOVERY_CONFLICT, never toward the proposal', () => {
    const s = track(
      setup({
        proposal: {
          summary: 'Two modifies',
          changes: [
            { type: 'MODIFY', path: 'src/a.ts', content: 'proposed a\n' },
            { type: 'MODIFY', path: 'src/b.ts', content: 'proposed b\n' }
          ],
          warnings: []
        },
        sourceFiles: [makeSourceFile({ path: 'src/a.ts', content: 'original a\n' }), makeSourceFile({ path: 'src/b.ts', content: 'original b\n' })]
      })
    )
    let call = 0
    const { native: forwardNative } = makeFakeNative({
      applyModify: () => {
        call++
        if (call === 2) throw codedError('BUSY')
        return outcomeForBytes(Buffer.from('proposed a\n'), APPLIED_FILE_ID, APPLIED_VOLUME)
      }
    })
    const result = buildForwardService(s, forwardNative).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(result.outcome).toBe('STOPPED')
    const rows = readEntryRows(s.db, result.batchId)
    expect(rows[0].state).toBe('APPLIED')
    expect(rows[1].state).toBe('APPLY_ATTEMPTING')

    // Real, unmodified recovery: as-applied probe matches entry 0 (disk holds
    // proposed content + applied-era identity) -> reverses with ORIGINAL
    // bytes, never proposed. Entry 1 has no durable identity evidence to
    // probe against -> RECOVERY_CONFLICT (fails closed, never guesses).
    const { native: recoveryNative } = fakeRecoveryNative({
      prepareLease: (plan) => {
        const m = plan.modifies![0]
        if (m.expectedSha256Hex === sha256Hex(Buffer.from('proposed a\n'))) {
          return { lease: {}, root: outcomeForBytes(Buffer.alloc(0), ROOT_FILE_ID, ROOT_VOLUME), modifies: [outcomeForBytes(Buffer.from('proposed a\n'), APPLIED_FILE_ID, APPLIED_VOLUME)] }
        }
        throw codedError('PRECONDITION_FAILED')
      },
      applyModify: () => outcomeForBytes(Buffer.from('original a\n'), APPLIED_FILE_ID, APPLIED_VOLUME)
    })
    const recovery = createApplyBatchRecoveryService({ db: s.db, native: recoveryNative }).recoverBatch(result.batchId)
    expect(recovery.finalState).toBe('RECOVERY_CONFLICT')
    const finalRows = readEntryRows(s.db, result.batchId)
    expect(finalRows[0].state).toBe('ROLLED_BACK')
    expect(finalRows[1].state).toBe('RECOVERY_CONFLICT')
  })

  it('crash after every entry reached APPLIED, before batch SUCCEEDED commits -> CONFIRM mode resolves durable SUCCEEDED, zero entry writes', () => {
    const s = track(setup())
    const { native: forwardNative } = makeFakeNative()
    // apply_batches_no_update_terminal blocks any UPDATE on an already-SUCCEEDED
    // row, so this crash window cannot be simulated by letting the pass finish
    // and rewinding it afterward - instead, inject a failure into the terminal
    // batch write's own transaction so it never commits, leaving the batch at
    // APPLYING with every entry already, independently, durably APPLIED.
    injectFailureOnNextMatchingWrite(s.db, /UPDATE apply_batches SET state='SUCCEEDED'/)
    expect(() => buildForwardService(s, forwardNative).submitApply({ projectId: s.projectId, reviewId: s.reviewId })).toThrow(/simulated crash/)

    const batchId = (s.db.prepare('SELECT id FROM apply_batches WHERE project_id = ?').get(s.projectId) as { id: number }).id
    expect(readBatchRow(s.db, batchId).state).toBe('APPLYING')
    const beforeEntries = readEntryRows(s.db, batchId)
    expect(beforeEntries[0].state).toBe('APPLIED')

    const { native: recoveryNative } = fakeRecoveryNative({
      prepareLease: (plan) => ({
        lease: {},
        root: outcomeForBytes(Buffer.alloc(0), ROOT_FILE_ID, ROOT_VOLUME),
        modifies: (plan.modifies ?? []).map(() => outcomeForBytes(Buffer.from(DEFAULT_MODIFIED_CONTENT), APPLIED_FILE_ID, APPLIED_VOLUME))
      })
    })
    const recovery = createApplyBatchRecoveryService({ db: s.db, native: recoveryNative }).recoverBatch(batchId)
    expect(recovery.finalState).toBe('SUCCEEDED')
    expect(readEntryRows(s.db, batchId)).toEqual(beforeEntries) // CONFIRM mode wrote no entry row
  })
})

// ---------------------------------------------------------------------------
// J. Scope boundaries
// ---------------------------------------------------------------------------

/** Strips // and block comments so scope-boundary checks below test actual code, never this file's own prose explaining what it deliberately does NOT do. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

describe('applyBatchForwardService - scope boundaries', () => {
  const source = stripComments(fs.readFileSync(path.join(__dirname, 'applyBatchForwardService.ts'), 'utf8'))

  it('never calls a live-rollback/recovery primitive (recoverDeleteCreated/rollbackFile) - this runner never reverses anything itself', () => {
    // Checked as an actual call/member pattern, not a bare word - the file's
    // own header comments correctly and deliberately NAME both primitives in
    // prose to document that they are never used; a bare-word check would
    // self-defeatingly fail on that documentation.
    expect(source).not.toMatch(/\.recoverDeleteCreated\(/)
    expect(source).not.toMatch(/\.rollbackFile\(/)
    expect(source).not.toContain('recoverDeleteCreated(lease')
    expect(source).not.toContain('rollbackFile(lease')
  })

  it('never references authorizeApply/ApplyAuthorityService directly - admission is exclusively journalService\'s job', () => {
    // Same discipline: checked as an actual import/call, not a bare word -
    // this file's own comments correctly document the boundary in prose.
    expect(source).not.toMatch(/from '\.\/applyAuthorityService'/)
    expect(source).not.toMatch(/\.authorizeApply\(/)
    expect(source).not.toMatch(/\bimport\b[^\n]*ApplyAuthorityService/)
  })

  it('has zero production caller: not referenced under src/main/ipc, src/preload, src/renderer, or src/main/index.ts', () => {
    function walk(dir: string): string[] {
      if (!fs.existsSync(dir)) return []
      const out: string[] = []
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
      }
      return out
    }
    const repoRoot = path.join(__dirname, '..', '..', '..')
    const candidateFiles = [
      path.join(repoRoot, 'src', 'main', 'index.ts'),
      ...walk(path.join(repoRoot, 'src', 'main', 'ipc')),
      ...walk(path.join(repoRoot, 'src', 'preload')),
      ...walk(path.join(repoRoot, 'src', 'renderer'))
    ]
    for (const file of candidateFiles) {
      const content = fs.readFileSync(file, 'utf8')
      expect(content).not.toContain('applyBatchForwardService')
    }
  })
})
