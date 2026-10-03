import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../testUtils/testDb'
import { createProject, archiveProject, updateProject, getProjectById } from './projectsService'
import { createTask, updateTaskDetails } from './taskService'
import {
  createWorkRequest,
  replaceTaskLinks,
  applyPlanningResult,
  resolveDecision,
  setWorkRequestStatus,
  getWorkRequestForProject
} from './workRequestService'
import { createRuleVersion, getCurrentProjectRules } from './rulesService'
import { createCodeChangeReviewRegistry, computeCodeChangeReviewFingerprint, type CodeChangeReviewRegistry } from './codeChangeReviewService'
import type { CodeChangeGenerationProvenance, ValidatedCodeChangePackage } from './claudeCodeChangeService'
import type { ProjectTextFileFormat, ProjectTextFileIdentityEvidence, ProjectTextFileResult } from '@shared/projectTextReadTypes'
import type { CodeChangeProposal } from '@shared/codeChangeTypes'
import type { CapabilityEvaluation } from '@shared/permissionTypes'
import {
  createApplyAuthorityService,
  ApplyAuthorityError,
  APPLY_CONSENT_PURPOSE_VERSION,
  type ApplyAuthorityErrorCode,
  type ApplyConsentSource,
  type ApplyConsentEvidence,
  type FilesystemWriteCapabilitySource,
  type ApplyAuthorization
} from './applyAuthorityService'

/**
 * Error MESSAGES on classified errors in this codebase are localized German
 * prose (see e.g. CodeChangeReviewError) - never expected to contain the
 * machine-readable code. Tests assert on `.code` directly, exactly like
 * codeChangeReviewService.test.ts does for CodeChangeReviewError.
 */
function expectAuthorityErrorCode(fn: () => unknown, code: ApplyAuthorityErrorCode): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ApplyAuthorityError)
    expect((error as ApplyAuthorityError).code).toBe(code)
    return
  }
  throw new Error(`expected authorizeApply to throw ApplyAuthorityError(${code}), but it did not throw`)
}

// ---------------------------------------------------------------------------
// Fixtures - mirrors codeChangeReviewService.test.ts's fixture style
// (makeSourceFile/makeProposal/makePackage), but the provenance built here is
// additionally kept CONSISTENT with real DB rows (project/task/workRequest/
// rules) created via the actual service functions - this module's authority
// checks compare against live DB reads, so a meaningful "authorized"
// baseline requires the two to actually agree, and a meaningful "stale" test
// requires deliberately diverging exactly one of them afterward.
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

// ---------------------------------------------------------------------------
// Trusted fixture dependencies - hand-built, exactly as the M4.8B.1 task
// brief anticipates ("Focused tests may construct the authority service with
// trusted consent fixtures" / "Tests may inject trusted policy/support
// fixtures").
// ---------------------------------------------------------------------------

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

/**
 * Returns a FIXED, non-null evidence object regardless of the query it was
 * asked - used to exercise authorizeApply's OWN validation of the returned
 * evidence's reviewId/fingerprint/purposeVersion fields (M4.8B.1 V2, task
 * brief section 6.A) - as opposed to exactConsentSource, which returns null
 * for a mismatched query and therefore only ever exercises the "consent is
 * null" branch, not the "consent is non-null but wrong" branch.
 */
function wrongEvidenceConsentSource(evidence: ApplyConsentEvidence): ApplyConsentSource {
  return { resolveApplyConsent: () => evidence }
}

function fixedCapabilitySource(
  projectId: number,
  decision: CapabilityEvaluation['decision'],
  overrides: Partial<CapabilityEvaluation> = {}
): FilesystemWriteCapabilitySource {
  return {
    evaluateFilesystemWriteCapability: () => ({
      projectId,
      capability: 'filesystem.write',
      decision,
      reason: decision === 'ALLOW' ? 'POLICY_ALLOWED' : decision === 'REQUIRES_APPROVAL' ? 'APPROVAL_REQUIRED' : 'POLICY_DENIED',
      ...overrides
    })
  }
}

/** A capability source whose EVERY call returns the SAME mutable object reference - used to prove a later mutation of that old object cannot retroactively influence an already-copied evidence value (M4.8B.1 V2, blocker F3, reentrancy test 4). */
function sharedMutableCapabilitySource(initial: CapabilityEvaluation): { source: FilesystemWriteCapabilitySource; shared: CapabilityEvaluation } {
  const shared: CapabilityEvaluation = { ...initial }
  return { source: { evaluateFilesystemWriteCapability: () => shared }, shared }
}

/** A capability source that returns a DIFFERENT decision on each successive call - used to test the two-call (before/after consent) re-evaluation (M4.8B.1 V2, blocker F3). */
function sequencedCapabilitySource(projectId: number, results: ReadonlyArray<Partial<CapabilityEvaluation> & { decision: CapabilityEvaluation['decision'] }>): FilesystemWriteCapabilitySource {
  let index = 0
  return {
    evaluateFilesystemWriteCapability: () => {
      const step = results[Math.min(index, results.length - 1)]
      index++
      return {
        projectId,
        capability: 'filesystem.write',
        reason: step.decision === 'ALLOW' ? 'POLICY_ALLOWED' : step.decision === 'REQUIRES_APPROVAL' ? 'APPROVAL_REQUIRED' : 'POLICY_DENIED',
        ...step
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Full end-to-end setup: real DB rows (project with a REAL temp-directory
// folder, task, work request linked to it, optionally rules/a resolved
// decision), a provenance snapshot that genuinely matches that DB state at
// the moment it is taken, a review created+approved through the real
// registry, and the resulting live fingerprint - the same shape a
// successful authorizeApply() call needs to see.
// ---------------------------------------------------------------------------

interface Setup {
  db: Database.Database
  registry: CodeChangeReviewRegistry
  projectId: number
  taskId: number
  workRequestId: number
  tmpDir: string
  reviewId: string
  fingerprint: string
  provenance: CodeChangeGenerationProvenance
  proposal: CodeChangeProposal
}

function setup(options: { withRules?: boolean; withResolvedDecision?: boolean; proposal?: CodeChangeProposal } = {}): Setup {
  const db = createTestDb()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-apply-authority-test-'))

  const project = createProject(db, { name: 'Demo', projectType: 'App', description: 'Fixture project', folderPath: tmpDir })
  const workRequest = createWorkRequest(db, { projectId: project.id, intentMarkdown: 'Do X', createdBy: 'LEON' })
  const task = createTask(db, { projectId: project.id, title: 'Fixture task', createdBy: 'LEON' })
  replaceTaskLinks(db, { projectId: project.id, workRequestId: workRequest.id, taskIds: [task.id] })

  if (options.withRules) {
    createRuleVersion(db, { projectId: project.id, contentMarkdown: '# Rules v1', createdBy: 'LEON' })
  }

  if (options.withResolvedDecision) {
    // applyPlanningResult can only ever be called ONCE per work request
    // (no replanning in this architecture - see workRequestService.ts) -
    // so any test that needs to later diverge the decision set must NOT
    // resolve it here; it resolves it itself after the review is created
    // (see test 25).
    applyPlanningResult(db, {
      projectId: project.id,
      id: workRequest.id,
      planningResult: {
        planMarkdown: 'Plan',
        decisionRequests: [{ questionMarkdown: 'Approach A or B?', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }]
      }
    })
  }

  const freshProject = getProjectById(db, project.id)
  const freshWorkRequest = getWorkRequestForProject(db, project.id, workRequest.id)
  const freshRules = getCurrentProjectRules(db, project.id)

  const sourceFile = makeSourceFile()
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
    rules: freshRules ? { versionNumber: freshRules.versionNumber, contentMarkdown: freshRules.contentMarkdown } : null,
    context: null,
    decisions: freshWorkRequest.decisions.map((decision) => ({
      questionMarkdown: decision.questionMarkdown,
      status: decision.status,
      resolvedOptionKey: decision.resolvedOptionKey,
      resolutionNote: decision.resolutionNote
    })),
    sourcePaths: ['src/math.ts'],
    modifyPaths: ['src/math.ts'],
    createPaths: [],
    disclosedRelativePaths: ['src/math.ts'],
    sourceFiles: [sourceFile],
    createPreconditions: []
  }

  const proposal = options.proposal ?? makeProposal()
  const pkg = makePackage(provenance, proposal)

  const registry = createCodeChangeReviewRegistry()
  const created = registry.createReview(pkg)
  registry.approveReview(project.id, created.reviewId)
  const fingerprint = computeCodeChangeReviewFingerprint(pkg)

  return {
    db,
    registry,
    projectId: project.id,
    taskId: task.id,
    workRequestId: workRequest.id,
    tmpDir,
    reviewId: created.reviewId,
    fingerprint,
    provenance,
    proposal
  }
}

function authorizedService(s: Setup, overrides: { consent?: ApplyConsentSource; capability?: FilesystemWriteCapabilitySource } = {}) {
  return createApplyAuthorityService({
    db: s.db,
    reviewRegistry: s.registry,
    applyConsentSource: overrides.consent ?? exactConsentSource(s.reviewId, s.fingerprint),
    capabilitySource: overrides.capability ?? fixedCapabilitySource(s.projectId, 'ALLOW')
  })
}

const tmpDirs: string[] = []
beforeEach(() => {
  tmpDirs.length = 0
})
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function track(s: Setup): Setup {
  tmpDirs.push(s.tmpDir)
  return s
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyAuthorityService - review state gates', () => {
  it('1. PENDING review cannot authorize', () => {
    const s = track(setup())
    // Build a SEPARATE, still-PENDING review on the same project/task/workRequest.
    const pkg = makePackage(s.provenance, s.proposal)
    const pending = s.registry.createReview(pkg)
    const service = createApplyAuthorityService({
      db: s.db,
      reviewRegistry: s.registry,
      applyConsentSource: exactConsentSource(pending.reviewId, computeCodeChangeReviewFingerprint(pkg)),
      capabilitySource: fixedCapabilitySource(s.projectId, 'ALLOW')
    })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: pending.reviewId }), 'REVIEW_NOT_ELIGIBLE')
  })

  it('2. APPROVED review WITHOUT explicit apply consent cannot authorize', () => {
    const s = track(setup())
    const service = authorizedService(s, { consent: noConsentSource() })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'APPLY_CONSENT_MISSING')
  })

  it('3. APPROVED + exact consent reaches the remaining gates and succeeds in a trusted fixture', () => {
    const s = track(setup())
    const service = authorizedService(s)
    const result = service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(result.reviewId).toBe(s.reviewId)
    expect(result.fingerprint).toBe(s.fingerprint)
    expect(result.mutations).toHaveLength(1)
  })

  it('4. Consent evidence for another reviewId (non-null, wrong) fails - exercises authorizeApply\'s own evidence validation, not just "consent is null"', () => {
    const s = track(setup())
    // wrongEvidenceConsentSource returns this evidence UNCONDITIONALLY, regardless of the query -
    // exactConsentSource would instead have returned null here, which only proves the "no
    // consent" branch, not that authorizeApply itself checks the returned reviewId.
    const service = authorizedService(s, {
      consent: wrongEvidenceConsentSource({ reviewId: 'some-other-review-id', fingerprint: s.fingerprint, purposeVersion: APPLY_CONSENT_PURPOSE_VERSION })
    })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'APPLY_CONSENT_MISSING')
  })

  it('5. Consent evidence for the same reviewId but the wrong fingerprint (non-null) fails', () => {
    const s = track(setup())
    const service = authorizedService(s, {
      consent: wrongEvidenceConsentSource({ reviewId: s.reviewId, fingerprint: 'deadbeef'.repeat(8), purposeVersion: APPLY_CONSENT_PURPOSE_VERSION })
    })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'APPLY_CONSENT_MISSING')
  })

  it('5b. Consent evidence for the exact right reviewId+fingerprint but the wrong purposeVersion (non-null) fails', () => {
    const s = track(setup())
    const service = authorizedService(s, {
      consent: wrongEvidenceConsentSource({ reviewId: s.reviewId, fingerprint: s.fingerprint, purposeVersion: 'some-other-purpose-v0' })
    })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'APPLY_CONSENT_MISSING')
  })

  it('6. Existing review approval alone is never treated as filesystem mutation permission (ALLOW capability + no consent still fails)', () => {
    const s = track(setup())
    const service = authorizedService(s, { consent: noConsentSource(), capability: fixedCapabilitySource(s.projectId, 'ALLOW') })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'APPLY_CONSENT_MISSING')
  })
})

describe('applyAuthorityService - trusted capability source', () => {
  it('7. DENY blocks, even with valid consent present', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'DENY') })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('8. POLICY_UNSET (a DENY-decision reason) blocks', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'DENY', { reason: 'POLICY_UNSET' }) })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('9. UNSUPPORTED (a DENY-decision reason) blocks', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'DENY', { reason: 'UNSUPPORTED' }) })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('10. ALLOW still requires exact review acceptance + exact apply consent', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'ALLOW'), consent: noConsentSource() })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'APPLY_CONSENT_MISSING')
  })

  it('11. REQUIRES_APPROVAL requires exact consent and does not mutate policy state into ALLOW', () => {
    const s = track(setup())
    const withoutConsent = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'REQUIRES_APPROVAL'), consent: noConsentSource() })
    expectAuthorityErrorCode(() => withoutConsent.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'APPLY_CONSENT_MISSING')

    const withConsent = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'REQUIRES_APPROVAL') })
    const result = withConsent.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    // The returned envelope carries the ORIGINAL decision, never silently upgraded to ALLOW.
    expect(result.capabilityEvaluation.decision).toBe('REQUIRES_APPROVAL')
  })
})

describe('applyAuthorityService - selection input cannot carry authority', () => {
  it('12. Caller cannot supply policy/paths/hashes/root/approval/provenance as authority - extra fields reject the whole request', () => {
    const s = track(setup())
    const service = authorizedService(s)
    const poisoned = {
      projectId: s.projectId,
      reviewId: s.reviewId,
      approved: true,
      fingerprint: 'x',
      capabilityEvaluation: { decision: 'ALLOW' },
      rootIdentity: { realPath: '/evil', dev: '1', ino: '1' }
    }
    expectAuthorityErrorCode(() => service.authorizeApply(poisoned), 'INVALID_SELECTION')
  })

  it('12b. A non-object, null, or missing-field selection is rejected', () => {
    const s = track(setup())
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply(null), 'INVALID_SELECTION')
    expectAuthorityErrorCode(() => service.authorizeApply('reviewId'), 'INVALID_SELECTION')
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId }), 'INVALID_SELECTION')
    expectAuthorityErrorCode(() => service.authorizeApply({ reviewId: s.reviewId }), 'INVALID_SELECTION')
  })
})

describe('applyAuthorityService - live review checks', () => {
  it('13. Cross-project review selection fails', () => {
    const s = track(setup())
    const otherProject = createProject(s.db, { name: 'Other', projectType: 'App', description: 'x' })
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: otherProject.id, reviewId: s.reviewId }), 'REVIEW_NOT_ELIGIBLE')
  })

  it('14. requestChanges after prior approval prevents fresh authorization', () => {
    const s = track(setup())
    s.registry.requestChanges(s.projectId, s.reviewId, 'please redo')
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'REVIEW_NOT_ELIGIBLE')
  })

  it('15. expired review prevents authorization', () => {
    let now = new Date('2026-01-01T00:00:00.000Z').getTime()
    const clock = { now: () => new Date(now) }
    const db = createTestDb()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-apply-authority-test-'))
    tmpDirs.push(tmpDir)
    const project = createProject(db, { name: 'Demo', projectType: 'App', description: 'd', folderPath: tmpDir })
    const workRequest = createWorkRequest(db, { projectId: project.id, intentMarkdown: 'Do X', createdBy: 'LEON' })
    const task = createTask(db, { projectId: project.id, title: 'T', createdBy: 'LEON' })
    replaceTaskLinks(db, { projectId: project.id, workRequestId: workRequest.id, taskIds: [task.id] })
    const freshProject = getProjectById(db, project.id)
    const provenance: CodeChangeGenerationProvenance = {
      projectId: project.id,
      taskId: task.id,
      workRequestId: workRequest.id,
      project: { name: freshProject.name, projectType: freshProject.projectType, description: freshProject.description },
      projectFolderPath: freshProject.folderPath,
      projectFolderComparisonKey: freshProject.folderComparisonKey,
      rootIdentity: { realPath: tmpDir, dev: '1', ino: '2' },
      workRequest: { intentMarkdown: 'Do X', planMarkdown: null, status: 'IDEA' },
      task: {
        title: 'T',
        goalMarkdown: '',
        descriptionMarkdown: '',
        priority: 'MEDIUM',
        status: 'BACKLOG',
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
      createPreconditions: []
    }
    const pkg = makePackage(provenance, makeProposal())
    const registry = createCodeChangeReviewRegistry(clock)
    const created = registry.createReview(pkg)
    registry.approveReview(project.id, created.reviewId)
    const fingerprint = computeCodeChangeReviewFingerprint(pkg)

    const service = createApplyAuthorityService({
      db,
      reviewRegistry: registry,
      applyConsentSource: exactConsentSource(created.reviewId, fingerprint),
      capabilitySource: fixedCapabilitySource(project.id, 'ALLOW')
    })
    expect(() => service.authorizeApply({ projectId: project.id, reviewId: created.reviewId })).not.toThrow()
    now += 3 * 60 * 60 * 1000 // past the 2h TTL
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: project.id, reviewId: created.reviewId }), 'REVIEW_NOT_ELIGIBLE')
  })
})

describe('applyAuthorityService - project rules outrank approval', () => {
  it('16. a changed current rule version prevents authorization', () => {
    const s = track(setup({ withRules: true }))
    createRuleVersion(s.db, { projectId: s.projectId, contentMarkdown: '# Rules v2', createdBy: 'LEON' })
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'STALE_PROJECT_RULES')
  })

  it('17a. null -> rules prevents authorization', () => {
    const s = track(setup({ withRules: false }))
    createRuleVersion(s.db, { projectId: s.projectId, contentMarkdown: '# New rules', createdBy: 'LEON' })
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'STALE_PROJECT_RULES')
  })

  it('17b. rules -> null prevents authorization (reviewed rules were present, current rules are now absent)', () => {
    // Rule versions are append-only (no delete API), so a real project's CURRENT rules can never
    // actually regress from present to absent - this direction is exercised by holding a
    // provenance snapshot that recorded NON-NULL rules (as if they existed at review time)
    // against a project whose CURRENT rules are genuinely null (setup({withRules: false}) never
    // creates any rule_version row at all) - the opposite starting point from test 17a (which
    // starts with current rules null too, but then adds a REAL current rule version afterward).
    const s = track(setup({ withRules: false }))
    expect(getCurrentProjectRules(s.db, s.projectId)).toBeNull()
    const provenanceWithReviewedRules: CodeChangeGenerationProvenance = {
      ...s.provenance,
      rules: { versionNumber: 1, contentMarkdown: '# Rules that existed when this was reviewed' }
    }
    const pkg = makePackage(provenanceWithReviewedRules, s.proposal)
    const created = s.registry.createReview(pkg)
    s.registry.approveReview(s.projectId, created.reviewId)
    const fingerprint = computeCodeChangeReviewFingerprint(pkg)
    const service = createApplyAuthorityService({
      db: s.db,
      reviewRegistry: s.registry,
      applyConsentSource: exactConsentSource(created.reviewId, fingerprint),
      capabilitySource: fixedCapabilitySource(s.projectId, 'ALLOW')
    })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: created.reviewId }), 'STALE_PROJECT_RULES')
  })

  it('18. the SAME Markdown content under a newer rule version still prevents authorization', () => {
    const s = track(setup({ withRules: true }))
    const current = getCurrentProjectRules(s.db, s.projectId)
    // Re-create a new version carrying the EXACT SAME markdown text.
    createRuleVersion(s.db, { projectId: s.projectId, contentMarkdown: current!.contentMarkdown, createdBy: 'LEON' })
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'STALE_PROJECT_RULES')
  })
})

describe('applyAuthorityService - project/target/root-identity binding', () => {
  it('19. an archived project prevents authorization', () => {
    const s = track(setup())
    archiveProject(s.db, s.projectId)
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'OWNERSHIP_INVALID')
  })

  it('20. project folder reassignment prevents authorization', () => {
    const s = track(setup())
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-apply-authority-test-other-'))
    tmpDirs.push(otherDir)
    updateProject(s.db, { id: s.projectId, folderPath: otherDir })
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'STALE_PROJECT_TARGET')
  })

  it('21. missing historical root identity prevents authorization', () => {
    const s = track(setup())
    const provenanceMissingRoot: CodeChangeGenerationProvenance = { ...s.provenance, rootIdentity: null }
    const pkg = makePackage(provenanceMissingRoot, s.proposal)
    const created = s.registry.createReview(pkg)
    s.registry.approveReview(s.projectId, created.reviewId)
    const fingerprint = computeCodeChangeReviewFingerprint(pkg)
    const service = createApplyAuthorityService({
      db: s.db,
      reviewRegistry: s.registry,
      applyConsentSource: exactConsentSource(created.reviewId, fingerprint),
      capabilitySource: fixedCapabilitySource(s.projectId, 'ALLOW')
    })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: created.reviewId }), 'INSUFFICIENT_ROOT_IDENTITY')
  })

  it('21b. an incomplete (dev/ino null) historical root identity prevents authorization', () => {
    const s = track(setup())
    const provenanceIncompleteRoot: CodeChangeGenerationProvenance = {
      ...s.provenance,
      rootIdentity: { realPath: s.tmpDir, dev: null, ino: null }
    }
    const pkg = makePackage(provenanceIncompleteRoot, s.proposal)
    const created = s.registry.createReview(pkg)
    s.registry.approveReview(s.projectId, created.reviewId)
    const fingerprint = computeCodeChangeReviewFingerprint(pkg)
    const service = createApplyAuthorityService({
      db: s.db,
      reviewRegistry: s.registry,
      applyConsentSource: exactConsentSource(created.reviewId, fingerprint),
      capabilitySource: fixedCapabilitySource(s.projectId, 'ALLOW')
    })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: created.reviewId }), 'INSUFFICIENT_ROOT_IDENTITY')
  })
})

describe('applyAuthorityService - ownership, membership, workflow lifecycle', () => {
  it('22. task/work-request ownership mismatch prevents authorization', () => {
    const s = track(setup())
    const otherWorkRequest = createWorkRequest(s.db, { projectId: s.projectId, intentMarkdown: 'Other', createdBy: 'LEON' })
    const provenanceWrongWr: CodeChangeGenerationProvenance = { ...s.provenance, workRequestId: otherWorkRequest.id }
    const pkg = makePackage(provenanceWrongWr, s.proposal)
    const created = s.registry.createReview(pkg)
    s.registry.approveReview(s.projectId, created.reviewId)
    const fingerprint = computeCodeChangeReviewFingerprint(pkg)
    const service = createApplyAuthorityService({
      db: s.db,
      reviewRegistry: s.registry,
      applyConsentSource: exactConsentSource(created.reviewId, fingerprint),
      capabilitySource: fixedCapabilitySource(s.projectId, 'ALLOW')
    })
    // The task is not linked to `otherWorkRequest` - membership must fail.
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: created.reviewId }), 'OWNERSHIP_INVALID')
  })

  it('23. task unlink/detachment prevents authorization where membership is required', () => {
    const s = track(setup())
    replaceTaskLinks(s.db, { projectId: s.projectId, workRequestId: s.workRequestId, taskIds: [] })
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'OWNERSHIP_INVALID')
  })

  it('24. explicit work-request cancellation prevents authorization', () => {
    const s = track(setup())
    setWorkRequestStatus(s.db, { projectId: s.projectId, id: s.workRequestId, status: 'CANCELLED' })
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'WORKFLOW_INELIGIBLE')
  })

  it('25. changed current explicit user decisions prevent authorization', () => {
    // The review is created while the decision is still OPEN (status: 'OPEN', resolvedOptionKey:
    // null) - provenance.decisions captures exactly that. Resolving it AFTER the review exists
    // changes the CURRENT decision set relative to what was reviewed.
    const s = track(setup({ withResolvedDecision: true }))
    const wr = getWorkRequestForProject(s.db, s.projectId, s.workRequestId)
    expect(wr.decisions[0].status).toBe('OPEN')
    resolveDecision(s.db, {
      projectId: s.projectId,
      workRequestId: s.workRequestId,
      decisionId: wr.decisions[0].id,
      optionKey: 'a',
      resolutionNote: 'Chose A after the review was created'
    })
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'STALE_USER_DECISIONS')
  })

  it('26. an ordinary lower-authority task-text change does NOT prevent authorization', () => {
    const s = track(setup())
    // Actually mutate an ordinary lower-authority field (task descriptive
    // text) AFTER the review was created - task title/description are lower
    // authority than approval/consent (task brief: "Do not invert the
    // frozen authority precedence"), and the provenance snapshot's
    // task/workRequest text fields are never compared against current DB
    // content at all, so this alone must not invalidate an otherwise
    // authorized exact review/consent.
    updateTaskDetails(s.db, {
      projectId: s.projectId,
      id: s.taskId,
      descriptionMarkdown: 'This description was completely rewritten after the review was created.'
    })
    const service = authorizedService(s)
    const result = service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(result.reviewId).toBe(s.reviewId)
  })
})

describe('applyAuthorityService - mutation set / envelope shape', () => {
  it('27. duplicate/colliding reviewed target paths reject using existing validators', () => {
    const s = track(
      setup({
        proposal: {
          summary: 'Two changes to the same target',
          changes: [
            { type: 'MODIFY', path: 'src/math.ts', content: DEFAULT_MODIFIED_CONTENT },
            { type: 'CREATE', path: 'SRC/MATH.TS', content: 'x' }
          ],
          warnings: []
        }
      })
    )
    const service = authorizedService(s)
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'INVALID_MUTATION_SET')
  })

  it('28. the MODIFY envelope entry contains exact reviewed old/new SHA-256 + lengths', () => {
    const s = track(setup())
    const service = authorizedService(s)
    const result = service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    const [mutation] = result.mutations
    expect(mutation.type).toBe('MODIFY')
    if (mutation.type !== 'MODIFY') throw new Error('unreachable')
    expect(mutation.originalSha256).toBe(sha256Of(DEFAULT_SOURCE_CONTENT, DEFAULT_FORMAT))
    expect(mutation.originalByteLength).toBe(bytesFor(DEFAULT_SOURCE_CONTENT, DEFAULT_FORMAT).length)
    expect(mutation.proposedSha256).toBe(sha256Of(DEFAULT_MODIFIED_CONTENT, DEFAULT_FORMAT))
    expect(mutation.proposedByteLength).toBe(bytesFor(DEFAULT_MODIFIED_CONTENT, DEFAULT_FORMAT).length)
  })

  it('29. the CREATE envelope entry contains expectedAbsence=true plus exact proposed SHA-256 + length', () => {
    const createContent = 'export const x = 1\n'
    const s = track(
      setup({
        proposal: { summary: 'Create a new file', changes: [{ type: 'CREATE', path: 'src/new.ts', content: createContent }], warnings: [] }
      })
    )
    const service = authorizedService(s)
    const result = service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    const [mutation] = result.mutations
    expect(mutation.type).toBe('CREATE')
    if (mutation.type !== 'CREATE') throw new Error('unreachable')
    expect(mutation.expectedAbsence).toBe(true)
    expect(mutation.proposedSha256).toBe(createHash('sha256').update(Buffer.from(createContent, 'utf8')).digest('hex'))
    expect(mutation.proposedByteLength).toBe(Buffer.byteLength(createContent, 'utf8'))
  })

  it('30. mutation order remains the reviewed order', () => {
    const s = track(
      setup({
        proposal: {
          summary: 'Two independent changes',
          changes: [
            { type: 'CREATE', path: 'src/z-new.ts', content: 'z' },
            { type: 'MODIFY', path: 'src/math.ts', content: DEFAULT_MODIFIED_CONTENT }
          ],
          warnings: []
        }
      })
    )
    const service = authorizedService(s)
    const result = service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(result.mutations.map((m) => m.path)).toEqual(['src/z-new.ts', 'src/math.ts'])
  })

  it('31. no raw Buffer/proposedBytes exist anywhere in the returned envelope', () => {
    const s = track(setup())
    const service = authorizedService(s)
    const result = service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(DEFAULT_MODIFIED_CONTENT)
    expect(serialized).not.toContain(DEFAULT_SOURCE_CONTENT)
    for (const mutation of result.mutations) {
      expect(Buffer.isBuffer((mutation as unknown as { proposedBytes?: unknown }).proposedBytes)).toBe(false)
      expect('proposedBytes' in mutation).toBe(false)
      expect('content' in mutation).toBe(false)
    }
  })
})

describe('applyAuthorityService - authority cannot be reached through mutation', () => {
  it('32. mutating the caller-visible original request/objects after the call cannot change the returned/stored authority', () => {
    const s = track(setup())
    const service = authorizedService(s)
    const request = { projectId: s.projectId, reviewId: s.reviewId }
    const result = service.authorizeApply(request)
    request.projectId = 999999
    ;(request as unknown as { reviewId: string }).reviewId = 'tampered'
    expect(result.projectId).toBe(s.projectId)
    expect(result.reviewId).toBe(s.reviewId)
    // The returned envelope itself is frozen - a caller mutating it cannot
    // succeed either. This file is an ES module, which always runs in
    // strict mode, so assigning to a frozen object's property throws
    // (rather than silently no-op-ing, as it would in sloppy mode) - the
    // authority-relevant guarantee under test is simply that the attempt
    // never actually changes the value.
    expect(() => {
      ;(result as ApplyAuthorization).projectId = 1
    }).toThrow(TypeError)
    expect(result.projectId).toBe(s.projectId)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.mutations)).toBe(true)
    expect(Object.isFrozen(result.target)).toBe(true)
  })

  it('32b. complete runtime immutability of the returned authorization (M4.8B.1 V2, blocker F1)', () => {
    // Two mutations (not one) - Array.prototype.reverse() on a length-1
    // frozen array has no element pair to swap and is therefore a no-op
    // that does NOT throw, even though the array is genuinely frozen; with
    // two elements it must actually attempt to write both indices, which
    // does throw.
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
    const service = authorizedService(s)
    const result = service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    const originalRootIdentity = { ...result.target.rootIdentity }
    const originalTargetPath = result.target.projectFolderPath
    const originalDecision = result.capabilityEvaluation.decision
    const originalMutationsLength = result.mutations.length
    const [firstMutation] = result.mutations
    const originalFirstPath = firstMutation.path
    const originalFirstProposedSha256 = firstMutation.proposedSha256

    // Every attempted mutation below either throws (strict-mode ES module -
    // assigning to/extending a frozen object throws TypeError) or is a
    // silent no-op for methods that check extensibility/frozenness
    // themselves (Array.prototype.push/reverse on a frozen array throw too,
    // in strict mode) - either way, none of them may change the observed
    // value, which is what every assertion below actually checks.
    const attempts: Array<() => void> = [
      () => {
        ;(result.target.rootIdentity as { realPath: string }).realPath = '/tampered'
      },
      () => {
        ;(result.target.rootIdentity as { dev: string | null }).dev = 'tampered'
      },
      () => {
        ;(result.target.rootIdentity as { ino: string | null }).ino = 'tampered'
      },
      () => {
        ;(result.target as { projectFolderPath: string }).projectFolderPath = '/tampered'
      },
      () => {
        ;(result.capabilityEvaluation as { decision: string }).decision = 'DENY'
      },
      () => {
        ;(result.mutations[0] as { path: string }).path = 'tampered/path.ts'
      },
      () => {
        ;(result.mutations[0] as { proposedSha256: string }).proposedSha256 = 'f'.repeat(64)
      },
      () => {
        result.mutations.push({ type: 'CREATE', path: 'injected.ts', expectedAbsence: true, proposedSha256: 'a'.repeat(64), proposedByteLength: 0 })
      },
      () => {
        result.mutations.reverse()
      }
    ]
    for (const attempt of attempts) {
      expect(attempt).toThrow(TypeError)
    }

    expect(result.target.rootIdentity).toEqual(originalRootIdentity)
    expect(result.target.projectFolderPath).toBe(originalTargetPath)
    expect(result.capabilityEvaluation.decision).toBe(originalDecision)
    expect(result.mutations).toHaveLength(originalMutationsLength)
    expect(result.mutations[0].path).toBe(originalFirstPath)
    expect((result.mutations[0] as { proposedSha256: string }).proposedSha256).toBe(originalFirstProposedSha256)

    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.target)).toBe(true)
    expect(Object.isFrozen(result.target.rootIdentity)).toBe(true)
    expect(Object.isFrozen(result.capabilityEvaluation)).toBe(true)
    expect(Object.isFrozen(result.mutations)).toBe(true)
    for (const mutation of result.mutations) expect(Object.isFrozen(mutation)).toBe(true)
  })

  it('33. repeated authorizeApply derivation performs no filesystem mutation, native call, or durable state change', () => {
    const s = track(setup())
    const service = authorizedService(s)
    const before = fs.readdirSync(s.tmpDir)
    service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    const after = fs.readdirSync(s.tmpDir)
    expect(after).toEqual(before)
    // The review's own state is untouched by repeated authorization derivation.
    const stillApproved = s.registry.getReview(s.projectId, s.reviewId)
    expect(stillApproved.state).toBe('APPROVED')
  })

  it('34. this module never imports/loads the native windows-safe-apply addon or wrapper', () => {
    // A bare substring check would false-positive on this module's OWN
    // header comment, which explicitly documents that it does NOT do this
    // (naming the module by name to say so) - checking for an actual
    // import/require statement is the real, behavioral property under test.
    const source = fs.readFileSync(path.join(__dirname, 'applyAuthorityService.ts'), 'utf8')
    // Matches an actual ES import/require MODULE SPECIFIER string containing
    // the addon's name - not just the English word "import"/"imports"
    // appearing near the name in prose (this file's own header comment
    // documents the absence by naming the module, which a bare substring
    // check would false-positive on).
    expect(source).not.toMatch(/(?:from\s+|require\()\s*['"][^'"]*windows-?[Ss]afe[Aa]pply[^'"]*['"]/)
  })

  it('35. no production IPC/UI/Run write operation is introduced by this module', () => {
    const registerIpcSource = fs.readFileSync(path.join(__dirname, '..', 'ipc', 'registerIpc.ts'), 'utf8')
    expect(registerIpcSource).not.toMatch(/applyAuthorityService/)
    expect(registerIpcSource).not.toMatch(/authorizeApply/)
    const runServiceSource = fs.readFileSync(path.join(__dirname, 'runService.ts'), 'utf8')
    expect(runServiceSource).not.toMatch(/filesystem\.write/)
  })
})

function rawCapabilitySource(raw: unknown): FilesystemWriteCapabilitySource {
  return { evaluateFilesystemWriteCapability: () => raw as CapabilityEvaluation }
}

describe('applyAuthorityService - capability evidence fail-closed (M4.8B.1 V2, blocker F2)', () => {
  it('foreign projectId in the capability evidence fails closed', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId + 999, 'ALLOW') })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('wrong capability name in the evidence fails closed', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'ALLOW', { capability: 'git.write' }) })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('a missing decision field fails closed', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: rawCapabilitySource({ projectId: s.projectId, capability: 'filesystem.write', reason: 'POLICY_ALLOWED' }) })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('a missing reason field fails closed', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: rawCapabilitySource({ projectId: s.projectId, capability: 'filesystem.write', decision: 'ALLOW' }) })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('an unknown decision string fails closed', () => {
    const s = track(setup())
    const service = authorizedService(s, {
      capability: rawCapabilitySource({ projectId: s.projectId, capability: 'filesystem.write', decision: 'MAYBE', reason: 'POLICY_ALLOWED' })
    })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('an unknown reason string fails closed', () => {
    const s = track(setup())
    const service = authorizedService(s, {
      capability: rawCapabilitySource({ projectId: s.projectId, capability: 'filesystem.write', decision: 'ALLOW', reason: 'BECAUSE_I_SAID_SO' })
    })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('ALLOW + UNSUPPORTED (contradictory pair) fails closed', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'ALLOW', { reason: 'UNSUPPORTED' }) })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('ALLOW + POLICY_UNSET (contradictory pair) fails closed', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'ALLOW', { reason: 'POLICY_UNSET' }) })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('ALLOW + APPROVAL_REQUIRED (contradictory pair) fails closed', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'ALLOW', { reason: 'APPROVAL_REQUIRED' }) })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('REQUIRES_APPROVAL + POLICY_ALLOWED (contradictory pair) fails closed', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'REQUIRES_APPROVAL', { reason: 'POLICY_ALLOWED' }) })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('a malformed, mostly-empty partial object fails closed rather than throwing an uncaught type-confusion error', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: rawCapabilitySource({}) })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('a null capability evidence value fails closed rather than throwing an uncaught type-confusion error', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: rawCapabilitySource(null) })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('positive control: the accepted ALLOW+POLICY_ALLOWED pair still succeeds', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'ALLOW') })
    expect(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })).not.toThrow()
  })

  it('positive control: the accepted REQUIRES_APPROVAL+APPROVAL_REQUIRED pair still succeeds', () => {
    const s = track(setup())
    const service = authorizedService(s, { capability: fixedCapabilitySource(s.projectId, 'REQUIRES_APPROVAL') })
    expect(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })).not.toThrow()
  })
})

describe('applyAuthorityService - reentrancy / final-currentness regression tests (M4.8B.1 V2, blocker F3)', () => {
  it('1. capability resolver reentrantly changes the review from APPROVED to CHANGES_REQUESTED - authorization fails after final review re-resolution', () => {
    const s = track(setup())
    const capability: FilesystemWriteCapabilitySource = {
      evaluateFilesystemWriteCapability: () => {
        // Side effect a trusted Main dependency must not have in practice
        // (see the interface contract) - exercised here anyway to prove
        // this module survives the accidental-composition-bug case by
        // re-checking afterward, not by trusting this earlier read.
        try {
          s.registry.requestChanges(s.projectId, s.reviewId, 'reentrant change')
        } catch {
          // Already CHANGES_REQUESTED by the second capability call - fine for this test.
        }
        return { projectId: s.projectId, capability: 'filesystem.write', decision: 'ALLOW', reason: 'POLICY_ALLOWED' }
      }
    }
    const service = authorizedService(s, { capability })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'REVIEW_NOT_ELIGIBLE')
  })

  it('2. consent resolver reentrantly changes the review to CHANGES_REQUESTED - authorization fails', () => {
    const s = track(setup())
    const consent: ApplyConsentSource = {
      resolveApplyConsent: (query) => {
        s.registry.requestChanges(s.projectId, s.reviewId, 'reentrant change from consent')
        if (query.reviewId !== s.reviewId || query.fingerprint !== s.fingerprint) return null
        return { reviewId: query.reviewId, fingerprint: query.fingerprint, purposeVersion: APPLY_CONSENT_PURPOSE_VERSION }
      }
    }
    const service = authorizedService(s, { consent })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'REVIEW_NOT_ELIGIBLE')
  })

  it('3. consent resolver flips the capability source from allowed to denied before the final (post-consent) capability re-evaluation - authorization fails', () => {
    const s = track(setup())
    let capabilityDecision: CapabilityEvaluation['decision'] = 'ALLOW'
    const capability: FilesystemWriteCapabilitySource = {
      evaluateFilesystemWriteCapability: () => ({
        projectId: s.projectId,
        capability: 'filesystem.write',
        decision: capabilityDecision,
        reason: capabilityDecision === 'ALLOW' ? 'POLICY_ALLOWED' : 'POLICY_DENIED'
      })
    }
    const consent: ApplyConsentSource = {
      resolveApplyConsent: (query) => {
        capabilityDecision = 'DENY' // flips it before the SECOND (post-consent) capability call
        if (query.reviewId !== s.reviewId || query.fingerprint !== s.fingerprint) return null
        return { reviewId: query.reviewId, fingerprint: query.fingerprint, purposeVersion: APPLY_CONSENT_PURPOSE_VERSION }
      }
    }
    const service = authorizedService(s, { consent, capability })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it('4. mutating the FIRST capability call\'s reusable shared object during consent resolution takes effect only through a later fresh read, never retroactively', () => {
    const s = track(setup())
    const { source: capability, shared } = sharedMutableCapabilitySource({
      projectId: s.projectId,
      capability: 'filesystem.write',
      decision: 'ALLOW',
      reason: 'POLICY_ALLOWED'
    })
    const consent: ApplyConsentSource = {
      resolveApplyConsent: (query) => {
        // Mutate the SAME shared object the capability source keeps returning.
        shared.decision = 'DENY'
        shared.reason = 'POLICY_DENIED'
        if (query.reviewId !== s.reviewId || query.fingerprint !== s.fingerprint) return null
        return { reviewId: query.reviewId, fingerprint: query.fingerprint, purposeVersion: APPLY_CONSENT_PURPOSE_VERSION }
      }
    }
    const service = createApplyAuthorityService({ db: s.db, reviewRegistry: s.registry, applyConsentSource: consent, capabilitySource: capability })
    // The FINAL (post-consent) capability call legitimately reads the
    // now-mutated shared object fresh (this is a real, current read, not a
    // stale one) and correctly sees DENY - proving the mutation only ever
    // takes effect through the dependency's own normal contract. Test 4b
    // proves the complementary half: an old, already-copied evaluation
    // cannot be corrupted after the fact.
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
  })

  it("4b. mutating the FIRST call's already-returned evidence object AFTER a successful authorization cannot retroactively change the already-built result", () => {
    const s = track(setup())
    let firstEvidenceReturned: CapabilityEvaluation | null = null
    let calls = 0
    const capability: FilesystemWriteCapabilitySource = {
      evaluateFilesystemWriteCapability: () => {
        calls++
        // A FRESH object every call (unlike sharedMutableCapabilitySource) -
        // the two calls are independent, exactly as a well-behaved
        // dependency implementation would be.
        const evaluation: CapabilityEvaluation = { projectId: s.projectId, capability: 'filesystem.write', decision: 'ALLOW', reason: 'POLICY_ALLOWED' }
        if (calls === 1) firstEvidenceReturned = evaluation
        return evaluation
      }
    }
    const service = authorizedService(s, { capability })
    const result = service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(calls).toBe(2)
    // Mutate the FIRST call's already-returned object AFTER authorization succeeded.
    ;(firstEvidenceReturned as unknown as { decision: string }).decision = 'DENY'
    expect(result.capabilityEvaluation.decision).toBe('ALLOW')
  })

  it('5. a positive first capability evaluation followed by a DENY/POLICY_UNSET/UNSUPPORTED final evaluation fails', () => {
    const s = track(setup())
    for (const secondReason of ['POLICY_DENIED', 'POLICY_UNSET', 'UNSUPPORTED'] as const) {
      const capability = sequencedCapabilitySource(s.projectId, [
        { decision: 'ALLOW', reason: 'POLICY_ALLOWED' },
        { decision: 'DENY', reason: secondReason }
      ])
      const service = authorizedService(s, { capability })
      expectAuthorityErrorCode(() => service.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId }), 'CAPABILITY_DENIED')
    }
  })

  it('6. the review expiring between the initial and final resolution fails closed (deterministic clock, no wall-clock sleep)', () => {
    let now = new Date('2026-01-01T00:00:00.000Z').getTime()
    const clock = { now: () => new Date(now) }
    const db = createTestDb()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-apply-authority-test-'))
    tmpDirs.push(tmpDir)
    const project = createProject(db, { name: 'Demo', projectType: 'App', description: 'd', folderPath: tmpDir })
    const workRequest = createWorkRequest(db, { projectId: project.id, intentMarkdown: 'Do X', createdBy: 'LEON' })
    const task = createTask(db, { projectId: project.id, title: 'T', createdBy: 'LEON' })
    replaceTaskLinks(db, { projectId: project.id, workRequestId: workRequest.id, taskIds: [task.id] })
    const freshProject = getProjectById(db, project.id)
    const provenance: CodeChangeGenerationProvenance = {
      projectId: project.id,
      taskId: task.id,
      workRequestId: workRequest.id,
      project: { name: freshProject.name, projectType: freshProject.projectType, description: freshProject.description },
      projectFolderPath: freshProject.folderPath,
      projectFolderComparisonKey: freshProject.folderComparisonKey,
      rootIdentity: { realPath: tmpDir, dev: '1', ino: '2' },
      workRequest: { intentMarkdown: 'Do X', planMarkdown: null, status: 'IDEA' },
      task: {
        title: 'T',
        goalMarkdown: '',
        descriptionMarkdown: '',
        priority: 'MEDIUM',
        status: 'BACKLOG',
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
      createPreconditions: []
    }
    const pkg = makePackage(provenance, makeProposal())
    const registry = createCodeChangeReviewRegistry(clock)
    const created = registry.createReview(pkg)
    registry.approveReview(project.id, created.reviewId)
    const fingerprint = computeCodeChangeReviewFingerprint(pkg)

    // The capability dependency's own call is where the clock advances past
    // the review's TTL - deterministic, no real sleep - simulating "time
    // passed between the initial review resolution (already done before
    // this dependency is first called) and the final re-resolution (which
    // happens after both dependency calls return)".
    const capability: FilesystemWriteCapabilitySource = {
      evaluateFilesystemWriteCapability: (projectId) => {
        now += 3 * 60 * 60 * 1000 // past the 2h TTL
        return { projectId, capability: 'filesystem.write', decision: 'ALLOW', reason: 'POLICY_ALLOWED' }
      }
    }
    const service = createApplyAuthorityService({
      db,
      reviewRegistry: registry,
      applyConsentSource: exactConsentSource(created.reviewId, fingerprint),
      capabilitySource: capability
    })
    expectAuthorityErrorCode(() => service.authorizeApply({ projectId: project.id, reviewId: created.reviewId }), 'REVIEW_NOT_ELIGIBLE')
  })
})
