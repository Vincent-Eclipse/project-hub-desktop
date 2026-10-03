import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { CapabilityEvaluation } from '@shared/permissionTypes'
import { getProjectById } from './projectsService'
import { getTaskForProject } from './taskService'
import { getWorkRequestForProject } from './workRequestService'
import { getCurrentProjectRules } from './rulesService'
import {
  CodeChangeReviewError,
  reconstructOriginalBytes,
  reconstructProposedBytes,
  type CodeChangeAuthoritativeReview,
  type CodeChangeReviewRegistry
} from './codeChangeReviewService'
import type { CodeChangeRootIdentityEvidence } from './claudeCodeChangeService'
import { assertNoCaseInsensitiveDuplicatePaths, InvalidSourceAccessPathError, validateSourceAccessPath } from './sourceAccessPath'

// Meilenstein 4.8B.1 - Provenance + Apply Authority.
//
// FROZEN PURPOSE (see the M4.8B.1 task brief): this module answers EXACTLY
// one question - "is this exact already-reviewed change set currently
// authorized to become a FUTURE mutation attempt?" It does NOT perform the
// mutation, does NOT open a native lease, does NOT persist anything, and is
// NOT a bearer capability - a returned ApplyAuthorization is a snapshot
// derived synchronously from live state, valid only for the instant it was
// built. A caller must call authorizeApply() again immediately before any
// future mutation attempt; this module makes no freshness promise beyond
// that single call.
//
// Later milestones own what this one deliberately does not:
//   M4.8B.2 - durable apply attempt / journal / admission / idempotency /
//             replay protection / crash recovery.
//   M4.8B.3 - the production Apply workflow, its (minimal) UI, and the
//             actual execution/native adapter that consumes this envelope.
//
// M4.8A's CodeChangeReviewRegistry ("the user accepted this exact
// unchangeable, Main-owned review record") is NOT reinterpreted here as
// permission to write files - approveReview() has never meant that (see
// codeChangeReviewTypes.ts's file header). This module adds the SECOND,
// independent condition M4.8A explicitly deferred: explicit consent for this
// exact review/fingerprint to become a future Apply attempt, evaluated
// together with every other live authority gate below. Capability policy
// (capabilityPolicy.ts) and this operation-level authorization remain
// different concepts - an ALLOW capability decision is still not "this
// specific reviewed change set may be applied now."
//
// This module is Main-only. It is NEVER imported by registerIpc.ts, never
// reaches the renderer, and never imports/loads/calls windowsSafeApply.ts or
// any native addon - see the M4.8B.1 review report for the repo-wide grep
// proof. There is deliberately no IPC channel, no Apply button, and no
// automatic apply-after-approval anywhere in this milestone.

// ---------------------------------------------------------------------------
// Trusted, Main-owned dependencies. Neither has a permissive default or a
// production wiring in M4.8B.1 - the current production composition has no
// positive apply-consent issuer and no filesystem.write-capable runtime
// support (see runService.ts's RUNTIME_SUPPORTED_CAPABILITIES, unchanged by
// this milestone), so there is intentionally no production code path that
// could accidentally produce a positive ApplyAuthorization today. Tests
// construct these from trusted, hand-built fixtures.
// ---------------------------------------------------------------------------

/** Fixed purpose/version tag for the ONE thing consent under this milestone can mean - never a generic "approved" boolean. */
export const APPLY_CONSENT_PURPOSE_VERSION = 'eclipse-apply-intent-v1'

/**
 * Exact selection key for a piece of apply-consent evidence - reviewId AND
 * the review's OWN freshly-resolved fingerprint (never a caller-supplied
 * one - see ApplyAuthorityRequest below, which carries no fingerprint at
 * all). A consent record for one fingerprint must never satisfy a
 * differently-fingerprinted review, even under the same reviewId (a review
 * is immutable once created, but this binding is checked explicitly rather
 * than assumed - see resolveApplyConsent's caller below).
 */
export interface ApplyConsentQuery {
  readonly reviewId: string
  readonly fingerprint: string
}

/** What a trusted consent source returns for a query that IS explicitly consented - never inferred from silence. */
export interface ApplyConsentEvidence {
  readonly reviewId: string
  readonly fingerprint: string
  readonly purposeVersion: string
}

/**
 * Main-only dependency: resolves whether explicit apply consent currently
 * exists for an exact reviewId+fingerprint. Returns null for "no consent" -
 * there is no other falsy/absent representation. NOT persistent in
 * M4.8B.1 (no DB table here - see the module header); a real implementation
 * is a future milestone's concern (M4.8B.3 captures the actual user action,
 * M4.8B.2 may durably bind it). Queried freshly on every authorizeApply()
 * call - never cached across calls, so a later revocation (this source
 * starting to return null for a query it previously answered) takes effect
 * immediately on the next call.
 *
 * CONTRACT (M4.8B.1 V2, blocker F3): this is a trusted Main-owned, READ-ONLY
 * authority resolver. An implementation MUST NOT mutate review state,
 * consent state, capability policy, or project/rules/workflow state; MUST
 * NOT perform any filesystem mutation; and MUST NOT reenter any
 * authority-changing API (e.g. the review registry's approveReview/
 * requestChanges) as part of resolving this call. This module does not (and
 * cannot) defend against a dependency that deliberately violates this
 * contract - that is not this module's threat model (its dependencies are
 * trusted Main code, not untrusted input). What this module DOES defend
 * against is an ACCIDENTAL composition bug - e.g. two dependencies sharing
 * mutable state such that resolving one has a side effect on the other's
 * next result - by re-checking the current-authority-relevant state again
 * after both dependency calls have run, immediately before building the
 * envelope (see authorizeApply's phased flow below). Being synchronous/
 * no-`await` prevents unrelated Main-process code from interleaving here;
 * it does NOT by itself prove nothing changed as a side effect of these two
 * specific calls, which is exactly what that re-check is for.
 */
export interface ApplyConsentSource {
  resolveApplyConsent(query: ApplyConsentQuery): ApplyConsentEvidence | null
}

/**
 * Main-only dependency: resolves the CURRENT, trusted filesystem.write
 * CapabilityEvaluation for a project - never derived from a caller-supplied
 * CapabilityEvaluation, a historical RunPolicySnapshot, or any
 * proposal/provenance field (see resolveCapabilityRequest in
 * capabilityPolicy.ts, whose CapabilityEvaluation type is reused verbatim
 * here - this module does not reinvent that vocabulary, it only consumes
 * one evaluation of it for one fixed capability). There is no default
 * implementation - a caller MUST supply one, and the current production
 * composition has none that could return anything but DENY (filesystem.write
 * is not in RUNTIME_SUPPORTED_CAPABILITIES).
 *
 * CONTRACT (M4.8B.1 V2, blocker F3): same read-only, non-reentrant contract
 * as ApplyConsentSource above - see that interface's doc comment. This
 * module additionally never trusts a bare `decision !== 'DENY'` reading of
 * this dependency's return value as positive authority - see
 * isAcceptablePositiveCapabilityEvidence below for the exact, narrow,
 * internally-coherent decision/reason pairs it accepts, and note that this
 * dependency is called TWICE per authorizeApply() (once before, once after
 * the apply-consent call) precisely because it is a synchronous call into
 * separate trusted code whose result this module cannot assume is stable
 * across that other call.
 */
export interface FilesystemWriteCapabilitySource {
  evaluateFilesystemWriteCapability(projectId: number): CapabilityEvaluation
}

export interface ApplyAuthorityDependencies {
  db: Database.Database
  reviewRegistry: CodeChangeReviewRegistry
  applyConsentSource: ApplyConsentSource
  capabilitySource: FilesystemWriteCapabilitySource
}

// ---------------------------------------------------------------------------
// Untrusted, caller-facing selection input - deliberately minimal (see the
// M4.8B.1 task brief, "SELECTION-ONLY AUTHORITY REQUEST"). Carries NO
// authoritative field of any kind - no approved boolean, no fingerprint, no
// paths/hashes/proposed bytes, no operation type, no project root/identity,
// no rules, no capability decision, no consent boolean, no provenance
// object. reviewId only SELECTS which private Main record to resolve;
// EVERY relationship and piece of evidence below is independently resolved
// Main-side from that selection, never trusted from the caller.
// ---------------------------------------------------------------------------

export interface ApplyAuthorityRequest {
  projectId: number
  reviewId: string
}

const APPLY_AUTHORITY_REQUEST_ALLOWED_KEYS = ['projectId', 'reviewId'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * Fail-closed, exact-keys validation (mirrors capabilityPolicy.ts's
 * assertExactKeys) - an extra field (e.g. a caller trying to smuggle in
 * `approved`, `fingerprint`, `rootIdentity`, `capabilityEvaluation`, ...)
 * makes the WHOLE request invalid rather than being silently ignored. This
 * is the only place in this module that reads untrusted input.
 */
function validateApplyAuthorityRequest(raw: unknown): ApplyAuthorityRequest {
  if (!isPlainObject(raw)) throw new ApplyAuthorityError('INVALID_SELECTION')
  const keys = Object.keys(raw)
  const allowed = new Set<string>(APPLY_AUTHORITY_REQUEST_ALLOWED_KEYS)
  if (keys.some((key) => !allowed.has(key)) || keys.length !== APPLY_AUTHORITY_REQUEST_ALLOWED_KEYS.length) {
    throw new ApplyAuthorityError('INVALID_SELECTION')
  }
  if (!Number.isInteger(raw.projectId) || (raw.projectId as number) <= 0) {
    throw new ApplyAuthorityError('INVALID_SELECTION')
  }
  if (typeof raw.reviewId !== 'string' || raw.reviewId.length === 0) {
    throw new ApplyAuthorityError('INVALID_SELECTION')
  }
  return { projectId: raw.projectId as number, reviewId: raw.reviewId }
}

// ---------------------------------------------------------------------------
// Error model - the smallest set of classified failures covering every
// authority gate below. Never leaks WHY within a category (e.g. review
// missing vs. expired vs. wrong project vs. not yet approved all collapse to
// REVIEW_NOT_ELIGIBLE) - a caller must not be able to use this as an oracle
// to learn about a review it doesn't already know is theirs.
// ---------------------------------------------------------------------------

export const APPLY_AUTHORITY_ERROR_CODES = [
  'INVALID_SELECTION',
  'REVIEW_NOT_ELIGIBLE',
  'APPLY_CONSENT_MISSING',
  'CAPABILITY_DENIED',
  'STALE_PROJECT_RULES',
  'STALE_PROJECT_TARGET',
  'INSUFFICIENT_ROOT_IDENTITY',
  'STALE_USER_DECISIONS',
  'OWNERSHIP_INVALID',
  'WORKFLOW_INELIGIBLE',
  'INVALID_MUTATION_SET'
] as const
export type ApplyAuthorityErrorCode = (typeof APPLY_AUTHORITY_ERROR_CODES)[number]

const ERROR_MESSAGES: Record<ApplyAuthorityErrorCode, string> = {
  INVALID_SELECTION: 'Die Apply-Auswahl ist ungueltig.',
  REVIEW_NOT_ELIGIBLE: 'Diese Review ist derzeit nicht fuer eine Autorisierung berechtigt.',
  APPLY_CONSENT_MISSING: 'Es liegt keine explizite Apply-Freigabe fuer genau diese Review/Fingerprint vor.',
  CAPABILITY_DENIED: 'Die filesystem.write-Capability ist derzeit nicht zulaessig.',
  STALE_PROJECT_RULES: 'Die aktuellen Projekt-Regeln weichen von der geprueften Review ab.',
  STALE_PROJECT_TARGET: 'Die aktuelle Projekt-Ordner-Zuordnung weicht von der geprueften Review ab.',
  INSUFFICIENT_ROOT_IDENTITY: 'Die in der Review erfasste Root-Identitaets-Evidenz ist unvollstaendig.',
  STALE_USER_DECISIONS: 'Die aktuellen expliziten Nutzer-Entscheidungen weichen von der geprueften Review ab.',
  OWNERSHIP_INVALID: 'Die Projekt-/Task-/Work-Request-Zugehoerigkeit der Review ist nicht mehr gueltig.',
  WORKFLOW_INELIGIBLE: 'Der zugehoerige Workflow ist storniert/widerrufen und nicht mehr autorisierbar.',
  INVALID_MUTATION_SET: 'Die geprueften Mutationen sind nicht mehr intern konsistent.'
}

export class ApplyAuthorityError extends Error {
  constructor(public readonly code: ApplyAuthorityErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'ApplyAuthorityError'
  }
}

// ---------------------------------------------------------------------------
// The authorization envelope (see the M4.8B.1 task brief, "MUTATION
// ENVELOPE"). Small, immutable, logical - not a bearer credential, not
// persisted, not itself a digest. Only MODIFY and CREATE - CodeFileChange
// (@shared/codeChangeTypes) has no DELETE/RENAME/MOVE variant at all, so
// this restriction is already a fact about the type system, not something
// this module additionally enforces at runtime.
// ---------------------------------------------------------------------------

export const APPLY_AUTHORIZATION_SCHEMA_VERSION = 'eclipse-apply-authorization-v1'

export interface AuthorizedMutationModify {
  type: 'MODIFY'
  path: string
  originalSha256: string
  originalByteLength: number
  proposedSha256: string
  proposedByteLength: number
}

export interface AuthorizedMutationCreate {
  type: 'CREATE'
  path: string
  expectedAbsence: true
  proposedSha256: string
  proposedByteLength: number
}

export type AuthorizedMutation = AuthorizedMutationModify | AuthorizedMutationCreate

/**
 * Materializes the reviewed target binding explicitly, even though it is
 * ALSO transitively protected by `fingerprint` - a future execution
 * consumer (M4.8B.2/B.3) needs these values operationally to prove that the
 * root actually pinned by a future B.0 Prepare() corresponds to the
 * historically reviewed root (see the M4.8B.1 task brief, "FUTURE
 * HISTORICAL ROOT -> PINNED ROOT INVARIANT"). `rootIdentity` here is
 * Node's own dev/ino evidence (CodeChangeRootIdentityEvidence) - NOT
 * automatically equivalent to Win32's FILE_ID_INFO/nativeFileId128Hex/
 * nativeVolumeSerial that a future B.0 Prepare() call reports. A verified
 * mapping/comparison contract between the two belongs to that future
 * execution integration, not to this module - this module carries only the
 * historical evidence, and never opens a native lease itself.
 */
export interface AuthorizedApplyTarget {
  projectFolderPath: string
  projectFolderComparisonKey: string
  rootIdentity: CodeChangeRootIdentityEvidence
}

export interface ApplyAuthorization {
  schemaVersion: string
  projectId: number
  reviewId: string
  fingerprint: string
  applyConsentPurposeVersion: string
  capabilityEvaluation: CapabilityEvaluation
  target: AuthorizedApplyTarget
  mutations: AuthorizedMutation[]
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * M4.8B.1 V2 fix (blocker F1): the V1 version froze every part of the
 * envelope EXCEPT `target.rootIdentity`, leaving one nested object
 * genuinely mutable after return. Deliberately NOT a generic recursive
 * deepFreeze - `rootIdentity` is frozen explicitly, by name, as the one
 * remaining nested object this envelope carries.
 */
function freezeAuthorization(authorization: ApplyAuthorization): ApplyAuthorization {
  Object.freeze(authorization.target.rootIdentity)
  for (const mutation of authorization.mutations) Object.freeze(mutation)
  Object.freeze(authorization.mutations)
  Object.freeze(authorization.target)
  Object.freeze(authorization.capabilityEvaluation)
  return Object.freeze(authorization)
}

// ---------------------------------------------------------------------------
// M4.8B.1 V2 fix (blocker F2): the V1 version treated any
// `decision !== 'DENY'` as positive authority - fail-OPEN for a malformed or
// internally-contradictory positive-looking result (e.g. `ALLOW` paired
// with a DENY-only reason like `UNSUPPORTED`/`POLICY_UNSET`, or an unknown
// decision/reason string entirely). This module now accepts ONLY the two
// exact, internally-coherent positive pairs the capability vocabulary
// (permissionTypes.ts) actually defines as meaningful positive outcomes.
// ---------------------------------------------------------------------------

interface CapabilityEvidenceCopy {
  projectId: number
  capability: string
  decision: string
  reason: string
}

/**
 * Copies ONLY the four scalar fields the moment they are received, and
 * never reads the dependency's own returned object again afterward (M4.8B.1
 * V2, blocker F3: a dependency-owned object mutated later - e.g. by that
 * same dependency, or by another dependency call made in between - must
 * never be able to retroactively change an already-copied evidence value).
 * Reads defensively (not trusting the static `CapabilityEvaluation` type at
 * runtime) so a missing/wrong-typed field reads as an empty/NaN sentinel
 * rather than throwing a type-confusion exception - that sentinel then
 * simply fails the exact-pair check below, which is the correct classified
 * fail-closed outcome for a malformed dependency result.
 */
function copyCapabilityEvidence(raw: CapabilityEvaluation): CapabilityEvidenceCopy {
  const source = raw as unknown as { projectId?: unknown; capability?: unknown; decision?: unknown; reason?: unknown } | null | undefined
  return {
    projectId: typeof source?.projectId === 'number' ? source.projectId : Number.NaN,
    capability: typeof source?.capability === 'string' ? source.capability : '',
    decision: typeof source?.decision === 'string' ? source.decision : '',
    reason: typeof source?.reason === 'string' ? source.reason : ''
  }
}

/**
 * The exact allow-list (blocker F2): every other combination - foreign
 * projectId, wrong capability, DENY, POLICY_UNSET, UNSUPPORTED, a missing/
 * unknown decision or reason, or any contradictory pairing (e.g.
 * ALLOW+APPROVAL_REQUIRED, REQUIRES_APPROVAL+POLICY_ALLOWED,
 * ALLOW+UNSUPPORTED) - is REJECTED, never silently coerced or upgraded.
 */
function isAcceptablePositiveCapabilityEvidence(evidence: CapabilityEvidenceCopy, expectedProjectId: number): boolean {
  if (evidence.projectId !== expectedProjectId) return false
  if (evidence.capability !== 'filesystem.write') return false
  if (evidence.decision === 'ALLOW' && evidence.reason === 'POLICY_ALLOWED') return true
  if (evidence.decision === 'REQUIRES_APPROVAL' && evidence.reason === 'APPROVAL_REQUIRED') return true
  return false
}

// ---------------------------------------------------------------------------
// Explicit decisions comparison (M4.8B.1 task brief, "EXPLICIT USER
// DECISIONS") - reuses the EXACT authority-relevant projection
// claudeCodeChangeService.ts's buildInternalSnapshot() already captured into
// provenance.decisions (questionMarkdown/status/resolvedOptionKey/
// resolutionNote, in work_request_decisions' `id ASC` order) - never a
// second decision model, never comparing the full WorkRequestDecision row
// (id/workRequestId/options/recommendedOptionKey/recommendationMarkdown/
// createdAt/resolvedAt are lower-authority/structural, not part of what was
// reviewed).
// ---------------------------------------------------------------------------

interface ReviewedDecisionProjection {
  questionMarkdown: string
  status: string
  resolvedOptionKey: string | null
  resolutionNote: string
}

function sameDecisions(a: readonly ReviewedDecisionProjection[], b: readonly ReviewedDecisionProjection[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (entry, index) =>
      entry.questionMarkdown === b[index].questionMarkdown &&
      entry.status === b[index].status &&
      entry.resolvedOptionKey === b[index].resolvedOptionKey &&
      entry.resolutionNote === b[index].resolutionNote
  )
}

/**
 * Resolves the review fresh from the registry and requires it to exist, be
 * bound to the requested project, not be expired, and be exactly APPROVED
 * right now. Used TWICE per authorizeApply() call (M4.8B.1 V2, blocker F3) -
 * once to establish the initial identity before the two dependency calls,
 * once more immediately before the envelope is built - so that anything
 * that happened during those two calls (intentional or an accidental
 * composition bug) is caught rather than silently trusted from a
 * now-possibly-stale earlier read.
 */
function resolveApprovedLiveReview(
  reviewRegistry: CodeChangeReviewRegistry,
  projectId: number,
  reviewId: string
): CodeChangeAuthoritativeReview {
  let record: CodeChangeAuthoritativeReview
  try {
    record = reviewRegistry.resolveAuthoritative(projectId, reviewId)
  } catch (error) {
    if (error instanceof CodeChangeReviewError) throw new ApplyAuthorityError('REVIEW_NOT_ELIGIBLE')
    throw error
  }
  if (record.state !== 'APPROVED') throw new ApplyAuthorityError('REVIEW_NOT_ELIGIBLE')
  return record
}

/**
 * Builds ONE ApplyAuthorityService bound to the given trusted dependencies.
 * Mirrors codeChangeReviewService.ts's createCodeChangeReviewRegistry(...)
 * factory shape. No dependency has a default - every one must be supplied
 * explicitly (see the interfaces above for why a permissive default would
 * be unsafe).
 */
export function createApplyAuthorityService(deps: ApplyAuthorityDependencies) {
  const { db, reviewRegistry, applyConsentSource, capabilitySource } = deps

  /**
   * Resolves and validates ONE filesystem.write CapabilityEvaluation for
   * `projectId` - see isAcceptablePositiveCapabilityEvidence/
   * copyCapabilityEvidence above (blocker F2) for the exact acceptance
   * rule and the immediate-copy discipline (blocker F3). Called twice per
   * authorizeApply() - see resolveApprovedLiveReview's doc comment for why.
   */
  function resolveAcceptableCapability(projectId: number): CapabilityEvaluation {
    const raw = capabilitySource.evaluateFilesystemWriteCapability(projectId)
    const evidence = copyCapabilityEvidence(raw)
    if (!isAcceptablePositiveCapabilityEvidence(evidence, projectId)) {
      throw new ApplyAuthorityError('CAPABILITY_DENIED')
    }
    // Reconstructed from the validated, independently-owned copy - never
    // the dependency's own returned object reference.
    return {
      projectId: evidence.projectId,
      capability: 'filesystem.write',
      decision: evidence.decision as CapabilityEvaluation['decision'],
      reason: evidence.reason as CapabilityEvaluation['reason']
    }
  }

  /**
   * Synchronous by design (task brief, "SYNCHRONOUS FINAL AUTHORITY
   * DECISION"): every dependency this function reads (the in-memory review
   * registry, better-sqlite3 via `db`, and the two injected trusted
   * dependencies) is synchronous, so this entire function contains no
   * `await` at all - unrelated Main-process code can never interleave here.
   *
   * That said (M4.8B.1 V2, blocker F3): being synchronous does NOT by
   * itself make this an atomic snapshot of authority - the two injected
   * dependency calls (capability, consent) are calls into separate trusted
   * Main code that this function does not control, and per their documented
   * contract (see ApplyConsentSource/FilesystemWriteCapabilitySource above)
   * must not mutate authority state as a side effect - but this function
   * does not simply assume that held. Instead it follows a phased flow that
   * re-establishes current authority immediately before building the
   * envelope, so that if anything DID change across those two calls (an
   * accidental composition bug, not adversarial code - see the interface
   * contracts for that distinction), it is caught rather than silently used:
   *
   *   A. validate the untrusted selection request
   *   B. resolve the INITIAL live review (must be APPROVED) - establishes
   *      projectId/reviewId/fingerprint for the two dependency calls below
   *   C. resolve+validate capability (1st call - fail-fast gate)
   *   D. resolve+validate exact apply consent (reviewId+fingerprint from B)
   *   E. resolve+validate capability AGAIN (2nd call) - THIS is the
   *      evaluation placed in the envelope, never the first one
   *   F. re-resolve the live review ONE MORE TIME - must still exist, still
   *      be the SAME project/reviewId/fingerprint, and still be APPROVED
   *   G. only now perform the remaining fresh reads/checks (project/
   *      archive/folder/root-identity/rules/ownership/membership/
   *      cancellation/decisions/mutation-set), all against `db` and the
   *      registry - not the two injected dependencies, so they carry no
   *      equivalent reentrancy concern
   *   H. build and freeze the envelope, with no await/yield anywhere above
   */
  function authorizeApply(rawRequest: unknown): ApplyAuthorization {
    const request = validateApplyAuthorityRequest(rawRequest)

    // B
    const initialRecord = resolveApprovedLiveReview(reviewRegistry, request.projectId, request.reviewId)

    // C
    resolveAcceptableCapability(initialRecord.projectId)

    // D - queried by the INITIAL review's own reviewId+fingerprint - never a
    // caller-supplied one (ApplyAuthorityRequest carries no fingerprint field
    // at all).
    const consent = applyConsentSource.resolveApplyConsent({
      reviewId: initialRecord.reviewId,
      fingerprint: initialRecord.fingerprint
    })
    if (
      consent === null ||
      consent.reviewId !== initialRecord.reviewId ||
      consent.fingerprint !== initialRecord.fingerprint ||
      consent.purposeVersion !== APPLY_CONSENT_PURPOSE_VERSION
    ) {
      throw new ApplyAuthorityError('APPLY_CONSENT_MISSING')
    }

    // E - the evaluation that ends up in the envelope.
    const capabilityEvaluation = resolveAcceptableCapability(initialRecord.projectId)

    // F - re-resolve fully fresh; a review is otherwise immutable once
    // created (only `state`/`feedback` can ever change - see
    // codeChangeReviewService.ts), so projectId/reviewId/fingerprint
    // mismatching here should be structurally unreachable today, but this
    // is checked explicitly rather than assumed, exactly like every other
    // freshness check in this module.
    const record = resolveApprovedLiveReview(reviewRegistry, request.projectId, request.reviewId)
    if (
      record.projectId !== initialRecord.projectId ||
      record.reviewId !== initialRecord.reviewId ||
      record.fingerprint !== initialRecord.fingerprint
    ) {
      throw new ApplyAuthorityError('REVIEW_NOT_ELIGIBLE')
    }

    const { provenance, proposal } = record.package

    // --- G: remaining fresh reads/checks. Current project + archival +
    // folder/target binding (task brief,
    // "PROJECT / TARGET BINDING", "DO NOT OVER-INVALIDATE" - ownership/
    // lifecycle facts, never task/work-request/project CONTENT text). ---
    let project
    try {
      project = getProjectById(db, record.projectId)
    } catch {
      throw new ApplyAuthorityError('OWNERSHIP_INVALID')
    }
    if (project.isArchived) throw new ApplyAuthorityError('OWNERSHIP_INVALID')
    if (project.folderPath !== provenance.projectFolderPath || project.folderComparisonKey !== provenance.projectFolderComparisonKey) {
      throw new ApplyAuthorityError('STALE_PROJECT_TARGET')
    }

    // --- Historical root identity completeness (task brief, "FUTURE
    // HISTORICAL ROOT -> PINNED ROOT INVARIANT"). This is a completeness
    // check on the STORED provenance value, not a comparison against
    // current state - B.0/native APIs are never called from here. ---
    const rootIdentity: CodeChangeRootIdentityEvidence | null = provenance.rootIdentity
    if (
      rootIdentity === null ||
      rootIdentity.realPath.length === 0 ||
      rootIdentity.dev === null ||
      rootIdentity.ino === null ||
      // A real target requires a real folder - checked explicitly here
      // rather than relying on captureRootIdentityEvidence() in
      // claudeCodeChangeService.ts always returning null for a null
      // projectFolderPath as an indirect guarantee of this.
      provenance.projectFolderPath === null ||
      provenance.projectFolderComparisonKey === null
    ) {
      throw new ApplyAuthorityError('INSUFFICIENT_ROOT_IDENTITY')
    }

    // --- Project Rules - higher authority than user approval (task brief,
    // "PROJECT RULES - HIGHER AUTHORITY"). null must stay null; any version
    // or content change invalidates, including the same Markdown under a
    // newer version number. ---
    const currentRules = getCurrentProjectRules(db, record.projectId)
    const reviewedRules = provenance.rules
    const rulesMatch =
      (currentRules === null && reviewedRules === null) ||
      (currentRules !== null &&
        reviewedRules !== null &&
        currentRules.versionNumber === reviewedRules.versionNumber &&
        currentRules.contentMarkdown === reviewedRules.contentMarkdown)
    if (!rulesMatch) throw new ApplyAuthorityError('STALE_PROJECT_RULES')

    // --- Task / Work Request ownership + membership + explicit cancellation
    // (task brief, "DO NOT OVER-INVALIDATE LOWER-AUTHORITY CONTEXT" -
    // revalidate ownership/lifecycle only, never task/work-request text). ---
    let task
    let workRequest
    try {
      task = getTaskForProject(db, record.projectId, record.taskId)
      workRequest = getWorkRequestForProject(db, record.projectId, record.workRequestId)
    } catch {
      throw new ApplyAuthorityError('OWNERSHIP_INVALID')
    }
    if (!workRequest.taskIds.includes(task.id)) throw new ApplyAuthorityError('OWNERSHIP_INVALID')
    // CANCELLED is the one WorkRequestStatus value that is an explicit,
    // unambiguous revocation signal in the existing status vocabulary (see
    // @shared/types.ts's WORK_REQUEST_STATUSES) - PAUSED/BLOCKED/DONE/etc.
    // are deliberately NOT treated as revoking authorization here, since the
    // existing architecture gives none of them explicit revocation
    // semantics (task brief: "Do not invent broad lifecycle rules ...
    // unless existing architecture gives those states explicit authority/
    // revocation semantics").
    if (workRequest.status === 'CANCELLED') throw new ApplyAuthorityError('WORKFLOW_INELIGIBLE')

    // --- Explicit user decisions (task brief, "EXPLICIT USER DECISIONS"). ---
    const currentDecisions: ReviewedDecisionProjection[] = workRequest.decisions.map((decision) => ({
      questionMarkdown: decision.questionMarkdown,
      status: decision.status,
      resolvedOptionKey: decision.resolvedOptionKey,
      resolutionNote: decision.resolutionNote
    }))
    if (!sameDecisions(currentDecisions, provenance.decisions)) throw new ApplyAuthorityError('STALE_USER_DECISIONS')

    // --- Path / collision consistency (task brief, "PATH / COLLISION
    // CHECKS") - reuses the EXACT validators already applied to
    // modifyPaths/createPaths at proposal-generation time
    // (claudeCodeChangeService.ts), as a cheap final consistency check -
    // never a second canonicalization subsystem, and never claimed to be
    // exhaustive NTFS Unicode/8.3 alias protection (that remains native
    // execution's own responsibility). ---
    const allTargetPaths = proposal.changes.map((change) => change.path)
    try {
      for (const path of allTargetPaths) validateSourceAccessPath(path)
      assertNoCaseInsensitiveDuplicatePaths(allTargetPaths, 'reviewed mutation targets')
    } catch (error) {
      if (error instanceof InvalidSourceAccessPathError) throw new ApplyAuthorityError('INVALID_MUTATION_SET')
      throw error
    }

    // --- Build the mutation envelope, in REVIEWED ORDER (proposal.changes
    // is never sorted/reordered/rewritten here) - task brief, "MUTATION
    // ENVELOPE" + "NO RAW BYTES IN AUTHORIZATION". Byte reconstruction
    // reuses codeChangeReviewService.ts's own rules verbatim. ---
    const sourceByPath = new Map(provenance.sourceFiles.map((file) => [file.path, file]))
    const mutations: AuthorizedMutation[] = proposal.changes.map((change) => {
      // Explicit if/else-if/fail-closed (M4.8B.1 V2, see task brief section
      // 8) rather than treating "not MODIFY" as "must be CREATE" - currently
      // equivalent in behavior (CodeFileChange has only these two variants),
      // but this reads correctly on its own and fails closed instead of
      // silently mis-typing a mutation if that ever changes.
      if (change.type === 'MODIFY') {
        const base = sourceByPath.get(change.path)
        // Cannot happen given claudeCodeChangeService.ts's own MODIFY-scope
        // guarantee (see codeChangeReviewService.ts's identical defensive
        // check) - fails closed rather than silently treating an unknown
        // MODIFY as something else.
        if (!base) throw new ApplyAuthorityError('INVALID_MUTATION_SET')
        const originalBytes = reconstructOriginalBytes(base.content, base.format)
        const proposedBytes = reconstructProposedBytes(change, base.format)
        const modifyMutation: AuthorizedMutationModify = {
          type: 'MODIFY',
          path: change.path,
          originalSha256: sha256Hex(originalBytes),
          originalByteLength: originalBytes.length,
          proposedSha256: sha256Hex(proposedBytes),
          proposedByteLength: proposedBytes.length
        }
        return modifyMutation
      }
      if (change.type === 'CREATE') {
        const proposedBytes = reconstructProposedBytes(change, null)
        const createMutation: AuthorizedMutationCreate = {
          type: 'CREATE',
          path: change.path,
          expectedAbsence: true,
          proposedSha256: sha256Hex(proposedBytes),
          proposedByteLength: proposedBytes.length
        }
        return createMutation
      }
      throw new ApplyAuthorityError('INVALID_MUTATION_SET')
    })

    const authorization: ApplyAuthorization = {
      schemaVersion: APPLY_AUTHORIZATION_SCHEMA_VERSION,
      projectId: record.projectId,
      reviewId: record.reviewId,
      fingerprint: record.fingerprint,
      applyConsentPurposeVersion: APPLY_CONSENT_PURPOSE_VERSION,
      // Already a freshly-constructed object from resolveAcceptableCapability
      // (never the dependency's own returned reference) - safe to freeze
      // directly.
      capabilityEvaluation,
      target: {
        projectFolderPath: provenance.projectFolderPath as string,
        projectFolderComparisonKey: provenance.projectFolderComparisonKey as string,
        // M4.8B.1 V2 fix (blocker F1): a FRESH object containing only the
        // three evidence fields - never the `rootIdentity` reference read
        // out of `provenance` above, which is not (and must not need to be)
        // itself frozen or owned by this function.
        rootIdentity: { realPath: rootIdentity.realPath, dev: rootIdentity.dev, ino: rootIdentity.ino }
      },
      mutations
    }
    return freezeAuthorization(authorization)
  }

  return { authorizeApply }
}

export type ApplyAuthorityService = ReturnType<typeof createApplyAuthorityService>
