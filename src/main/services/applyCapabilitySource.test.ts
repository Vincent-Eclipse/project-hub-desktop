import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../testUtils/testDb'
import { createProject, getProjectById, archiveProject } from './projectsService'
import { createTask } from './taskService'
import { createWorkRequest, getWorkRequestForProject, replaceTaskLinks } from './workRequestService'
import { createCodeChangeReviewRegistry, computeCodeChangeReviewFingerprint, type CodeChangeReviewRegistry } from './codeChangeReviewService'
import type { CodeChangeGenerationProvenance, ValidatedCodeChangePackage } from './claudeCodeChangeService'
import type { ProjectTextFileFormat, ProjectTextFileIdentityEvidence, ProjectTextFileResult } from '@shared/projectTextReadTypes'
import type { CodeChangeProposal } from '@shared/codeChangeTypes'
import { InvalidCapabilityInputError } from './capabilityPolicy'
import { createApplyAuthorityService, ApplyAuthorityError, type ApplyConsentSource, type FilesystemWriteCapabilitySource } from './applyAuthorityService'
import { createApplyConsentService } from './applyConsentService'
import { createApplyCapabilitySource, type ApplyCapabilityPolicySnapshot } from './applyCapabilitySource'

// Meilenstein 4.8B.3 Slice 4 - applyCapabilitySource.ts's test matrix,
// exactly mirroring M4.8B3-Slice4-ConsentCapability-Recon-and-Design.md
// §6.2.

// ---------------------------------------------------------------------------
// Part A - narrow unit tests against a bare project (no review/authority
// chain needed) - covers §6.2 cases 1-14.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
  tmpDirs.length = 0
})

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-apply-cap-test-'))
  tmpDirs.push(dir)
  return dir
}

function insertProject(db: Database.Database): number {
  return createProject(db, { name: 'Demo', projectType: 'App', description: 'Fixture project', folderPath: makeTmpDir() }).id
}

function snapshot(overrides: Partial<ApplyCapabilityPolicySnapshot> = {}): ApplyCapabilityPolicySnapshot {
  return { policy: {}, ruleDeniedCapabilities: [], ...overrides }
}

describe('applyCapabilitySource - policy modes', () => {
  it('1. ALLOW policy, project exists, not archived, no rule denial -> ALLOW/POLICY_ALLOWED', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const source = createApplyCapabilitySource({ db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'ALLOW' } }) })
    expect(source.evaluateFilesystemWriteCapability(projectId)).toEqual({ projectId, capability: 'filesystem.write', decision: 'ALLOW', reason: 'POLICY_ALLOWED' })
  })

  it('2. DENY policy -> DENY/POLICY_DENIED', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const source = createApplyCapabilitySource({ db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'DENY' } }) })
    expect(source.evaluateFilesystemWriteCapability(projectId)).toEqual({ projectId, capability: 'filesystem.write', decision: 'DENY', reason: 'POLICY_DENIED' })
  })

  it('3. REQUIRES_APPROVAL policy -> REQUIRES_APPROVAL/APPROVAL_REQUIRED', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const source = createApplyCapabilitySource({ db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'REQUIRES_APPROVAL' } }) })
    expect(source.evaluateFilesystemWriteCapability(projectId)).toEqual({ projectId, capability: 'filesystem.write', decision: 'REQUIRES_APPROVAL', reason: 'APPROVAL_REQUIRED' })
  })

  it('4. no entry for filesystem.write in policy at all -> DENY/POLICY_UNSET', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const source = createApplyCapabilitySource({ db, policySnapshot: snapshot() })
    expect(source.evaluateFilesystemWriteCapability(projectId)).toEqual({ projectId, capability: 'filesystem.write', decision: 'DENY', reason: 'POLICY_UNSET' })
  })

  it('5. POLICY_UNSET vs. explicit DENY are distinguished (different reason, same DENY decision)', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const explicitDeny = createApplyCapabilitySource({ db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'DENY' } }) }).evaluateFilesystemWriteCapability(projectId)
    const unset = createApplyCapabilitySource({ db, policySnapshot: snapshot() }).evaluateFilesystemWriteCapability(projectId)
    expect(explicitDeny.decision).toBe('DENY')
    expect(unset.decision).toBe('DENY')
    expect(explicitDeny.reason).toBe('POLICY_DENIED')
    expect(unset.reason).toBe('POLICY_UNSET')
    expect(explicitDeny.reason).not.toBe(unset.reason)
  })

  it('6. project archived, policy ALLOW -> DENY/PROJECT_ARCHIVED (archive overrides an otherwise-positive policy)', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    archiveProject(db, projectId)
    const source = createApplyCapabilitySource({ db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'ALLOW' } }) })
    expect(source.evaluateFilesystemWriteCapability(projectId)).toEqual({ projectId, capability: 'filesystem.write', decision: 'DENY', reason: 'PROJECT_ARCHIVED' })
  })

  it('7. ruleDeniedCapabilities includes filesystem.write, policy ALLOW -> DENY/RULE_RESTRICTION (rule denial overrides an otherwise-positive policy)', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const source = createApplyCapabilitySource({ db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'ALLOW' }, ruleDeniedCapabilities: ['filesystem.write'] }) })
    expect(source.evaluateFilesystemWriteCapability(projectId)).toEqual({ projectId, capability: 'filesystem.write', decision: 'DENY', reason: 'RULE_RESTRICTION' })
  })
})

describe('applyCapabilitySource - fail-closed vs. fail-fast', () => {
  it('8. nonexistent projectId fails closed to DENY/PROJECT_MISMATCH, never throws', () => {
    const db = createTestDb()
    const source = createApplyCapabilitySource({ db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'ALLOW' } }) })
    let result: ReturnType<FilesystemWriteCapabilitySource['evaluateFilesystemWriteCapability']> | undefined
    expect(() => {
      result = source.evaluateFilesystemWriteCapability(999999)
    }).not.toThrow()
    expect(result).toEqual({ projectId: 999999, capability: 'filesystem.write', decision: 'DENY', reason: 'PROJECT_MISMATCH' })
  })

  it('9. fail-fast construction: an unknown capability key in policy throws InvalidCapabilityInputError synchronously, at construction', () => {
    const db = createTestDb()
    expect(() =>
      createApplyCapabilitySource({
        db,
        policySnapshot: { policy: { 'not.a.capability': 'ALLOW' } as unknown as ApplyCapabilityPolicySnapshot['policy'], ruleDeniedCapabilities: [] }
      })
    ).toThrow(InvalidCapabilityInputError)
  })

  it('10. fail-fast construction: a duplicate entry in ruleDeniedCapabilities throws InvalidCapabilityInputError synchronously, at construction', () => {
    const db = createTestDb()
    expect(() =>
      createApplyCapabilitySource({
        db,
        policySnapshot: { policy: {}, ruleDeniedCapabilities: ['filesystem.write', 'filesystem.write'] }
      })
    ).toThrow(InvalidCapabilityInputError)
  })

  it('malformed policy mode value throws at construction', () => {
    const db = createTestDb()
    expect(() =>
      createApplyCapabilitySource({
        db,
        policySnapshot: { policy: { 'filesystem.write': 'MAYBE' as unknown as ApplyCapabilityPolicySnapshot['policy']['filesystem.write'] }, ruleDeniedCapabilities: [] }
      })
    ).toThrow(InvalidCapabilityInputError)
  })
})

describe('applyCapabilitySource - freshness and isolation', () => {
  it('11. freshness across two calls on one instance: archiving the project between calls is reflected on the SECOND call, not retroactively on the first', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const source = createApplyCapabilitySource({ db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'ALLOW' } }) })

    const first = source.evaluateFilesystemWriteCapability(projectId)
    expect(first).toEqual({ projectId, capability: 'filesystem.write', decision: 'ALLOW', reason: 'POLICY_ALLOWED' })

    archiveProject(db, projectId)

    const second = source.evaluateFilesystemWriteCapability(projectId)
    expect(second).toEqual({ projectId, capability: 'filesystem.write', decision: 'DENY', reason: 'PROJECT_ARCHIVED' })
    // The first, already-returned evaluation is unaffected retroactively.
    expect(first).toEqual({ projectId, capability: 'filesystem.write', decision: 'ALLOW', reason: 'POLICY_ALLOWED' })
  })

  it('12. project isolation on one shared instance: two projects, one archived, evaluated independently through the SAME source', () => {
    const db = createTestDb()
    const activeProjectId = insertProject(db)
    const archivedProjectId = insertProject(db)
    archiveProject(db, archivedProjectId)

    const source = createApplyCapabilitySource({ db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'ALLOW' } }) })

    expect(source.evaluateFilesystemWriteCapability(activeProjectId)).toEqual({
      projectId: activeProjectId,
      capability: 'filesystem.write',
      decision: 'ALLOW',
      reason: 'POLICY_ALLOWED'
    })
    expect(source.evaluateFilesystemWriteCapability(archivedProjectId)).toEqual({
      projectId: archivedProjectId,
      capability: 'filesystem.write',
      decision: 'DENY',
      reason: 'PROJECT_ARCHIVED'
    })
  })

  it('13. PROJECT_MISMATCH never fires for a live, matching project (negative control across every positive-path case)', () => {
    const db = createTestDb()
    const projectId = insertProject(db)
    const cases: Array<Partial<ApplyCapabilityPolicySnapshot>> = [
      { policy: { 'filesystem.write': 'ALLOW' } },
      { policy: { 'filesystem.write': 'DENY' } },
      { policy: { 'filesystem.write': 'REQUIRES_APPROVAL' } },
      { policy: {} }
    ]
    for (const overrides of cases) {
      const source = createApplyCapabilitySource({ db, policySnapshot: snapshot(overrides) })
      const evaluation = source.evaluateFilesystemWriteCapability(projectId)
      expect(evaluation.projectId).toBe(projectId)
      expect(evaluation.reason).not.toBe('PROJECT_MISMATCH')
    }
  })
})

describe('applyCapabilitySource - scope-boundary regression guard', () => {
  it('14. runService.ts RUNTIME_SUPPORTED_CAPABILITIES remains exactly [git.read, filesystem.read] - never widened to include filesystem.write', () => {
    const source = fs.readFileSync(path.join(__dirname, 'runService.ts'), 'utf8')
    const match = source.match(/const RUNTIME_SUPPORTED_CAPABILITIES:[^=]*=\s*(\[[^\]]*\])/)
    expect(match).not.toBeNull()
    const arrayLiteral = (match as RegExpMatchArray)[1]
    expect(arrayLiteral).toContain("'git.read'")
    expect(arrayLiteral).toContain("'filesystem.read'")
    expect(arrayLiteral).not.toContain('filesystem.write')
    // Belt-and-suspenders: the whole file must not reference filesystem.write anywhere.
    expect(source).not.toContain('filesystem.write')
  })
})

// ---------------------------------------------------------------------------
// Part B - real end-to-end applyAuthorityService coverage, combining BOTH new
// Slice-4 implementations (no fixtures for either) - covers §6.2 cases 15-17.
// Mirrors applyBatchForwardService.test.ts's own setup() fixture style
// exactly.
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

interface Setup {
  db: Database.Database
  registry: CodeChangeReviewRegistry
  projectId: number
  reviewId: string
  fingerprint: string
}

function setup(): Setup {
  const db = createTestDb()
  const tmpDir = makeTmpDir()

  const project = createProject(db, { name: 'Demo', projectType: 'App', description: 'Fixture project', folderPath: tmpDir })
  const workRequest = createWorkRequest(db, { projectId: project.id, intentMarkdown: 'Do X', createdBy: 'LEON' })
  const task = createTask(db, { projectId: project.id, title: 'Fixture task', createdBy: 'LEON' })
  replaceTaskLinks(db, { projectId: project.id, workRequestId: workRequest.id, taskIds: [task.id] })

  const freshProject = getProjectById(db, project.id)
  const freshWorkRequest = getWorkRequestForProject(db, project.id, workRequest.id)

  const proposal = makeProposal()
  const modifyPaths = proposal.changes.filter((c) => c.type === 'MODIFY').map((c) => c.path)
  const createPaths = proposal.changes.filter((c) => c.type === 'CREATE').map((c) => c.path)
  const sourceFiles = modifyPaths.map((p) => makeSourceFile({ path: p }))

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

  return { db, registry, projectId: project.id, reviewId: created.reviewId, fingerprint }
}

function fixedConsentSource(evidence: { reviewId: string; fingerprint: string } | null): ApplyConsentSource {
  return {
    resolveApplyConsent: () => evidence && { reviewId: evidence.reviewId, fingerprint: evidence.fingerprint, purposeVersion: 'eclipse-apply-intent-v1' }
  }
}

describe('applyCapabilitySource + applyConsentService - real end-to-end authorizeApply()', () => {
  it('15. capability ALLOW + matching real consent record -> authorizeApply() succeeds end-to-end, returns a frozen ApplyAuthorization', () => {
    const s = setup()
    const capabilitySource = createApplyCapabilitySource({ db: s.db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'ALLOW' } }) })
    const consentService = createApplyConsentService()
    consentService.recordApplyConsent(s.reviewId, s.fingerprint)

    const authorityService = createApplyAuthorityService({ db: s.db, reviewRegistry: s.registry, applyConsentSource: consentService, capabilitySource })
    const authorization = authorityService.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(authorization.reviewId).toBe(s.reviewId)
    expect(authorization.fingerprint).toBe(s.fingerprint)
    expect(authorization.capabilityEvaluation).toEqual({ projectId: s.projectId, capability: 'filesystem.write', decision: 'ALLOW', reason: 'POLICY_ALLOWED' })
    expect(Object.isFrozen(authorization)).toBe(true)
  })

  it('16. capability REQUIRES_APPROVAL + matching real consent record -> authorizeApply() also succeeds end-to-end', () => {
    const s = setup()
    const capabilitySource = createApplyCapabilitySource({ db: s.db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'REQUIRES_APPROVAL' } }) })
    const consentService = createApplyConsentService()
    consentService.recordApplyConsent(s.reviewId, s.fingerprint)

    const authorityService = createApplyAuthorityService({ db: s.db, reviewRegistry: s.registry, applyConsentSource: consentService, capabilitySource })
    const authorization = authorityService.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(authorization.capabilityEvaluation).toEqual({ projectId: s.projectId, capability: 'filesystem.write', decision: 'REQUIRES_APPROVAL', reason: 'APPROVAL_REQUIRED' })
  })

  it('17. capability ALLOW but consent never recorded -> authorizeApply() throws ApplyAuthorityError(APPLY_CONSENT_MISSING)', () => {
    const s = setup()
    const capabilitySource = createApplyCapabilitySource({ db: s.db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'ALLOW' } }) })
    const consentService = createApplyConsentService() // nothing ever recorded

    const authorityService = createApplyAuthorityService({ db: s.db, reviewRegistry: s.registry, applyConsentSource: consentService, capabilitySource })
    expect(() => authorityService.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })).toThrow(ApplyAuthorityError)
    try {
      authorityService.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })
    } catch (error) {
      expect((error as ApplyAuthorityError).code).toBe('APPLY_CONSENT_MISSING')
    }
  })

  it('a decoy consent (wrong fingerprint) via a hand-built ApplyConsentSource still fails APPLY_CONSENT_MISSING, proving the fingerprint binding is enforced end-to-end', () => {
    const s = setup()
    const capabilitySource = createApplyCapabilitySource({ db: s.db, policySnapshot: snapshot({ policy: { 'filesystem.write': 'ALLOW' } }) })
    const decoyConsent = fixedConsentSource({ reviewId: s.reviewId, fingerprint: 'wrong-fingerprint' })

    const authorityService = createApplyAuthorityService({ db: s.db, reviewRegistry: s.registry, applyConsentSource: decoyConsent, capabilitySource })
    expect(() => authorityService.authorizeApply({ projectId: s.projectId, reviewId: s.reviewId })).toThrow(ApplyAuthorityError)
  })
})
