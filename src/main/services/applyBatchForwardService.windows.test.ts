// Meilenstein 4.8B.3 Slice 3 - Windows-only, real native addon, real
// filesystem fixtures, real B.1/B.2B admission chain throughout.
// submitApply() has NO batch-ID entry point (Slice 2 v2's deliberate design),
// so every test here performs a full, real admission (a real
// project/task/workRequest, a real CodeChangeReviewRegistry, a real approved
// review) exactly as applyBatchForwardService.test.ts's own setup() does -
// the only difference from that fake-native suite is that `native` here is
// ALWAYS realWindowsSafeApplyForwardNativeDependencies, unmodified, and every
// fixture file is a real file on a real temp directory. Mirrors
// applyBatchRecoveryService.windows.test.ts's / windowsSafeApply.core.windows.test.ts's
// existing harness conventions. See
// C:\Eclipse Projekte\Claude Reports\M4.8B3-Slice3-WindowsTests-Implementation-Spec.md
// for the full design rationale, including exactly which properties are
// deliberately left to the fake-native suites (§8 "Boundaries").
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestDb } from '../testUtils/testDb'
import { createProject, getProjectById } from './projectsService'
import { createTask } from './taskService'
import { createWorkRequest, getWorkRequestForProject, replaceTaskLinks } from './workRequestService'
import { createCodeChangeReviewRegistry, computeCodeChangeReviewFingerprint, type CodeChangeReviewRegistry } from './codeChangeReviewService'
import type { CodeChangeGenerationProvenance, ValidatedCodeChangePackage } from './claudeCodeChangeService'
import type { ProjectTextFileFormat, ProjectTextFileIdentityEvidence, ProjectTextFileResult } from '@shared/projectTextReadTypes'
import type { CodeChangeProposal } from '@shared/codeChangeTypes'
import { createApplyAuthorityService, APPLY_CONSENT_PURPOSE_VERSION, type ApplyConsentSource, type FilesystemWriteCapabilitySource } from './applyAuthorityService'
import { createApplyBatchJournalService } from './applyBatchJournalService'
import { prepareLease, closeLease, type WindowsSafeApplyPlan } from './windowsSafeApply'
import { createApplyBatchForwardService, realWindowsSafeApplyForwardNativeDependencies } from './applyBatchForwardService'

const IS_WINDOWS = process.platform === 'win32'

// ---------------------------------------------------------------------------
// Fixture root lifecycle - one fresh mkdtempSync() root per test. On a
// passing test it is deleted; on a failing test it is preserved and its path
// logged for diagnosis.
//
// This reads ctx.task.result?.state directly in afterEach rather than using
// onTestFailed() - vitest's own runner (@vitest/runner's runTest(), see
// node_modules/@vitest/runner/dist/chunk-artifact.js) records a failed test
// callback's outcome onto task.result.state BEFORE afterEach hooks run, and
// only invokes onTestFailed handlers AFTER afterEach and fixture cleanup have
// already completed. An earlier revision of this file registered its
// preserve-on-failure logic via onTestFailed() inside beforeEach, which is
// exactly backwards for this purpose: afterEach would already have deleted
// the fixture directory by the time onTestFailed ran, so a failed test would
// log a path that no longer existed. Reading ctx.task.result?.state inside
// afterEach itself is therefore the correct place to decide cleanup - the
// state is already final by the time afterEach observes it.
// ---------------------------------------------------------------------------

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-forward-'))
})

afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') {
    // eslint-disable-next-line no-console
    console.error(`[applyBatchForwardService.windows.test.ts] test failed - fixture root preserved for diagnosis: ${root}`)
    return
  }
  fs.rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fixtures - mirrors applyBatchForwardService.test.ts's fixture style, with
// flat, root-level paths only (never nested - see spec §1.3) and plain,
// no-BOM content only (BOM reconstruction fidelity is already directly,
// positively covered by the fake-native suite - see spec §1.2).
// ---------------------------------------------------------------------------

const NO_BOM: ProjectTextFileFormat = { utf8Bom: false, lineEnding: 'LF', finalNewline: true }

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function bytesFor(content: string): Buffer {
  return Buffer.from(content, 'utf8')
}

function makeIdentity(overrides: Partial<ProjectTextFileIdentityEvidence> = {}): ProjectTextFileIdentityEvidence {
  return { dev: '111', ino: '222', ...overrides }
}

function makeSourceFile(overrides: Partial<ProjectTextFileResult> & { path: string; content: string }): ProjectTextFileResult {
  const format = overrides.format ?? NO_BOM
  const sha256 = overrides.sha256 ?? sha256Hex(bytesFor(overrides.content))
  const identity = overrides.identity ?? makeIdentity()
  return { path: overrides.path, content: overrides.content, sha256, format, identity }
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

function fixedCapabilitySource(projectId: number): FilesystemWriteCapabilitySource {
  return {
    evaluateFilesystemWriteCapability: () => ({ projectId, capability: 'filesystem.write', decision: 'ALLOW', reason: 'POLICY_ALLOWED' })
  }
}

interface Setup {
  db: Database.Database
  registry: CodeChangeReviewRegistry
  projectId: number
  reviewId: string
  fingerprint: string
}

/** Real admission-chain fixture - a real project/task/workRequest and a real approved review, bound to the given real temp directory as the project folder. Mirrors applyBatchForwardService.test.ts's own setup() exactly, minus the fake-native/tmpDir-creation concerns (root is created by beforeEach here, once per test, and is also the real native root). */
function setup(forRoot: string, options: { proposal: CodeChangeProposal; sourceFiles: ProjectTextFileResult[] }): Setup {
  const db = createTestDb()
  const project = createProject(db, { name: 'Demo', projectType: 'App', description: 'Fixture project', folderPath: forRoot })
  const workRequest = createWorkRequest(db, { projectId: project.id, intentMarkdown: 'Do X', createdBy: 'LEON' })
  const task = createTask(db, { projectId: project.id, title: 'Fixture task', createdBy: 'LEON' })
  replaceTaskLinks(db, { projectId: project.id, workRequestId: workRequest.id, taskIds: [task.id] })

  const freshProject = getProjectById(db, project.id)
  const freshWorkRequest = getWorkRequestForProject(db, project.id, workRequest.id)

  const { proposal, sourceFiles } = options
  const modifyPaths = proposal.changes.filter((c) => c.type === 'MODIFY').map((c) => c.path)
  const createPaths = proposal.changes.filter((c) => c.type === 'CREATE').map((c) => c.path)

  const provenance: CodeChangeGenerationProvenance = {
    projectId: project.id,
    taskId: task.id,
    workRequestId: workRequest.id,
    project: { name: freshProject.name, projectType: freshProject.projectType, description: freshProject.description },
    projectFolderPath: freshProject.folderPath,
    projectFolderComparisonKey: freshProject.folderComparisonKey,
    rootIdentity: { realPath: forRoot, dev: '10', ino: '20' },
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

/** Builds ONE real forward service: real authority service, real journal service, real registry, and the REAL, unmodified native binding - no fake anywhere. */
function buildRealForwardService(s: Setup) {
  const applyAuthorityService = createApplyAuthorityService({
    db: s.db,
    reviewRegistry: s.registry,
    applyConsentSource: exactConsentSource(s.reviewId, s.fingerprint),
    capabilitySource: fixedCapabilitySource(s.projectId)
  })
  const journalService = createApplyBatchJournalService({ db: s.db, applyAuthorityService, reviewRegistry: s.registry })
  return createApplyBatchForwardService({
    db: s.db,
    native: realWindowsSafeApplyForwardNativeDependencies,
    reviewRegistry: s.registry,
    journalService
  })
}

function readBatchRow(db: Database.Database, id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM apply_batches WHERE id = ?').get(id) as Record<string, unknown>
}

function readEntryRows(db: Database.Database, batchId: number): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM apply_batch_entries WHERE batch_id = ? ORDER BY ordinal').all(batchId) as Array<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// 1. Real MODIFY forward apply
// ---------------------------------------------------------------------------

describe.skipIf(!IS_WINDOWS)('applyBatchForwardService - real MODIFY forward apply (real native, real fixtures)', () => {
  it('original file on disk -> submitApply -> exact proposed bytes on disk, durable SUCCEEDED with independently re-derived evidence and an independent identity re-probe', () => {
    const original = 'original content line\n'
    const proposed = 'proposed content line\n'
    fs.writeFileSync(path.join(root, 'a.txt'), bytesFor(original))

    const s = setup(root, {
      proposal: { summary: 'Modify a', changes: [{ type: 'MODIFY', path: 'a.txt', content: proposed }], warnings: [] },
      sourceFiles: [makeSourceFile({ path: 'a.txt', content: original })]
    })

    const result = buildRealForwardService(s).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('SUCCEEDED')
    expect(result.entriesApplied).toBe(1)
    expect(result.totalEntries).toBe(1)
    expect(result.failure).toBeNull()

    const onDisk = fs.readFileSync(path.join(root, 'a.txt'))
    expect(onDisk.equals(bytesFor(proposed))).toBe(true)

    const batchRow = readBatchRow(s.db, result.batchId)
    expect(batchRow.state).toBe('SUCCEEDED')
    expect(batchRow.completed_at).not.toBeNull()

    const entryRow = readEntryRows(s.db, result.batchId)[0]
    expect(entryRow.state).toBe('APPLIED')
    expect(entryRow.failure_note).toBeNull()

    // Independently re-derived, never trusting the production code's own
    // self-report of what it wrote.
    const recomputedSha = sha256Hex(onDisk)
    expect(entryRow.written_sha256).toBe(recomputedSha)
    expect(entryRow.written_byte_length).toBe(onDisk.length)

    // A second, fully independent, read-only native probe cross-verifies the
    // DB's recorded native identity against a FRESH native read of the live
    // file - not merely a re-read of the production code's own return value.
    const probePlan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: recomputedSha, expectedLength: onDisk.length, proposedBytes: Buffer.alloc(0) }]
    }
    const probe = prepareLease(probePlan)
    try {
      expect(probe.modifies[0].code).toBe('OK')
      expect(probe.modifies[0].nativeFileId128Hex).toBe(entryRow.native_file_id_128_hex)
      expect(probe.modifies[0].nativeVolumeSerial).toBe(entryRow.native_volume_serial)
    } finally {
      closeLease(probe.lease)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Real CREATE forward apply
// ---------------------------------------------------------------------------

describe.skipIf(!IS_WINDOWS)('applyBatchForwardService - real CREATE forward apply (real native, real fixtures)', () => {
  it('absent file -> submitApply -> exact proposed bytes on disk, durable SUCCEEDED with independently re-derived evidence and an independent identity re-probe', () => {
    const proposed = 'created content line\n'

    const s = setup(root, {
      proposal: { summary: 'Create new', changes: [{ type: 'CREATE', path: 'new.txt', content: proposed }], warnings: [] },
      sourceFiles: []
    })

    expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false)

    const result = buildRealForwardService(s).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('SUCCEEDED')
    expect(result.entriesApplied).toBe(1)
    expect(result.failure).toBeNull()

    const onDisk = fs.readFileSync(path.join(root, 'new.txt'))
    expect(onDisk.equals(bytesFor(proposed))).toBe(true)

    const batchRow = readBatchRow(s.db, result.batchId)
    expect(batchRow.state).toBe('SUCCEEDED')

    const entryRow = readEntryRows(s.db, result.batchId)[0]
    expect(entryRow.state).toBe('APPLIED')
    expect(entryRow.failure_note).toBeNull()

    const recomputedSha = sha256Hex(onDisk)
    expect(entryRow.written_sha256).toBe(recomputedSha)
    expect(entryRow.written_byte_length).toBe(onDisk.length)

    // For the identity re-probe against a CREATE target, prepareLease() must
    // be issued as a MODIFY probe (the file now genuinely exists) - this
    // still proves the DB's recorded identity is true of the live file,
    // independently of the production code's own createFile() call.
    const probePlan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'new.txt', expectedSha256Hex: recomputedSha, expectedLength: onDisk.length, proposedBytes: Buffer.alloc(0) }]
    }
    const probe = prepareLease(probePlan)
    try {
      expect(probe.modifies[0].code).toBe('OK')
      expect(probe.modifies[0].nativeFileId128Hex).toBe(entryRow.native_file_id_128_hex)
      expect(probe.modifies[0].nativeVolumeSerial).toBe(entryRow.native_volume_serial)
    } finally {
      closeLease(probe.lease)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Mixed MODIFY/CREATE/MODIFY batch - separate native index maps proven by
//    exact final bytes of all three files (per controller decision, no
//    additional identity re-probe here - see spec §Open decisions).
// ---------------------------------------------------------------------------

describe.skipIf(!IS_WINDOWS)('applyBatchForwardService - mixed MODIFY/CREATE/MODIFY batch (real native, real fixtures)', () => {
  it('interleaved reviewed order -> each of the three real files ends up with exactly its own proposed bytes, proving correct, independent per-kind index mapping', () => {
    const originalA = 'original a\n'
    const proposedA = 'proposed a\n'
    const proposedC = 'created c\n'
    const originalB = 'original b\n'
    const proposedB = 'proposed b\n'

    fs.writeFileSync(path.join(root, 'a.txt'), bytesFor(originalA))
    fs.writeFileSync(path.join(root, 'b.txt'), bytesFor(originalB))
    expect(fs.existsSync(path.join(root, 'c.txt'))).toBe(false)

    const s = setup(root, {
      proposal: {
        summary: 'Mixed',
        changes: [
          { type: 'MODIFY', path: 'a.txt', content: proposedA },
          { type: 'CREATE', path: 'c.txt', content: proposedC },
          { type: 'MODIFY', path: 'b.txt', content: proposedB }
        ],
        warnings: []
      },
      sourceFiles: [makeSourceFile({ path: 'a.txt', content: originalA }), makeSourceFile({ path: 'b.txt', content: originalB })]
    })

    const result = buildRealForwardService(s).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('SUCCEEDED')
    expect(result.entriesApplied).toBe(3)

    expect(fs.readFileSync(path.join(root, 'a.txt')).equals(bytesFor(proposedA))).toBe(true)
    expect(fs.readFileSync(path.join(root, 'c.txt')).equals(bytesFor(proposedC))).toBe(true)
    expect(fs.readFileSync(path.join(root, 'b.txt')).equals(bytesFor(proposedB))).toBe(true)

    const entryRows = readEntryRows(s.db, result.batchId)
    expect(entryRows).toHaveLength(3)
    for (const row of entryRows) {
      expect(row.state).toBe('APPLIED')
      expect(row.failure_note).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Real prepare/precondition failure - target altered before submitApply()
//    is ever called. admitBatch() is provably filesystem-independent (it
//    only cross-checks two in-memory representations of the same review), so
//    this produces the identical observable state as an alteration strictly
//    between admission and forward execution - see spec §5 for the full
//    rationale.
// ---------------------------------------------------------------------------

describe.skipIf(!IS_WINDOWS)('applyBatchForwardService - real PRECONDITION_FAILED during prepare (real native, real fixtures)', () => {
  it('target altered before submitApply -> STOPPED/PREPARE/PRECONDITION_FAILED, no mutation, batch stays ADMITTED, entry stays PENDING', () => {
    const original = 'expected original\n'
    const altered = 'externally altered before apply\n'
    fs.writeFileSync(path.join(root, 'a.txt'), bytesFor(original))

    const s = setup(root, {
      proposal: { summary: 'Modify a', changes: [{ type: 'MODIFY', path: 'a.txt', content: 'proposed content\n' }], warnings: [] },
      sourceFiles: [makeSourceFile({ path: 'a.txt', content: original })]
    })

    // Alter the real file before submitApply() is ever invoked.
    fs.writeFileSync(path.join(root, 'a.txt'), bytesFor(altered))

    const result = buildRealForwardService(s).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('STOPPED')
    expect(result.failure?.phase).toBe('PREPARE')
    expect(result.failure?.code).toBe('PRECONDITION_FAILED')

    // No mutation occurred - the file still holds the externally-altered bytes.
    expect(fs.readFileSync(path.join(root, 'a.txt')).equals(bytesFor(altered))).toBe(true)

    // Recovery-discoverable: batch/entry left exactly where admission put
    // them - prepareLease() failed before any state write beyond admission's own.
    expect(readBatchRow(s.db, result.batchId).state).toBe('ADMITTED')
    expect(readEntryRows(s.db, result.batchId)[0].state).toBe('PENDING')
  })
})

// ---------------------------------------------------------------------------
// 5. Real native CREATE collision - a genuinely LATER failure point than #4:
//    prepareLease() succeeds (CREATE only resolves the parent chain), so the
//    batch already reached PREPARED/APPLYING and the entry already reached
//    APPLY_ATTEMPTING (write-ahead) before the native createFile() call
//    itself fails closed on the pre-existing target.
// ---------------------------------------------------------------------------

describe.skipIf(!IS_WINDOWS)('applyBatchForwardService - real CREATE collision during mutate (real native, real fixtures)', () => {
  it('target created externally before submitApply -> STOPPED/MUTATE/PRECONDITION_FAILED, external file preserved untouched, batch left APPLYING, entry left APPLY_ATTEMPTING', () => {
    const s = setup(root, {
      proposal: { summary: 'Create new', changes: [{ type: 'CREATE', path: 'new.txt', content: 'proposed create content\n' }], warnings: [] },
      sourceFiles: []
    })

    const external = Buffer.from('externally created before apply\n', 'utf8')
    fs.writeFileSync(path.join(root, 'new.txt'), external)

    const result = buildRealForwardService(s).submitApply({ projectId: s.projectId, reviewId: s.reviewId })

    expect(result.outcome).toBe('STOPPED')
    expect(result.failure?.phase).toBe('MUTATE')
    expect(result.failure?.code).toBe('PRECONDITION_FAILED')

    // CREATE_NEW semantics: the native layer never opens/writes an existing target.
    expect(fs.readFileSync(path.join(root, 'new.txt')).equals(external)).toBe(true)

    // A structurally LATER, distinct recovery-discoverable state than #4:
    // the write-ahead marker already committed before the mutate call failed.
    expect(readBatchRow(s.db, result.batchId).state).toBe('APPLYING')
    expect(readEntryRows(s.db, result.batchId)[0].state).toBe('APPLY_ATTEMPTING')
  })
})

// ---------------------------------------------------------------------------
// 6. Native lease/resource discipline
// ---------------------------------------------------------------------------

describe.skipIf(!IS_WINDOWS)('applyBatchForwardService - native lease/resource discipline (real native, real fixtures)', () => {
  it('a successful pass releases its lease sufficiently for expected follow-up filesystem access: ordinary read succeeds, and an independent prepareLease/closeLease round trip against the same file also succeeds', () => {
    const original = 'lease discipline original\n'
    const proposed = 'lease discipline proposed\n'
    fs.writeFileSync(path.join(root, 'a.txt'), bytesFor(original))

    const s = setup(root, {
      proposal: { summary: 'Modify a', changes: [{ type: 'MODIFY', path: 'a.txt', content: proposed }], warnings: [] },
      sourceFiles: [makeSourceFile({ path: 'a.txt', content: original })]
    })

    const result = buildRealForwardService(s).submitApply({ projectId: s.projectId, reviewId: s.reviewId })
    expect(result.outcome).toBe('SUCCEEDED')

    // Ordinary, non-exclusive access succeeds immediately - no lingering
    // exclusive handle from the forward pass's own lease.
    let onDisk: Buffer = Buffer.alloc(0)
    expect(() => {
      onDisk = fs.readFileSync(path.join(root, 'a.txt'))
    }).not.toThrow()
    expect(onDisk.equals(bytesFor(proposed))).toBe(true)

    // A second, fully independent prepareLease/closeLease round trip against
    // the same file also succeeds without BUSY - a stronger proof than a
    // mere read, since prepareLease() itself opens the target with an
    // exclusive share mode.
    const probePlan: WindowsSafeApplyPlan = {
      root,
      modifies: [{ path: 'a.txt', expectedSha256Hex: sha256Hex(onDisk), expectedLength: onDisk.length, proposedBytes: Buffer.alloc(0) }]
    }
    const probe = prepareLease(probePlan)
    expect(probe.modifies[0].code).toBe('OK')
    closeLease(probe.lease)
  })
})
