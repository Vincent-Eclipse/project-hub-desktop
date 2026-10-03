import type Database from 'better-sqlite3'
import type { CapabilityId, CapabilityPolicyMode, CapabilityEvaluation } from '@shared/permissionTypes'
import { validateCapabilityIdList, validateCapabilityPolicyContext, validatePolicyMap, resolveCapabilityRequest } from './capabilityPolicy'
import { getProjectById, ProjectNotFoundError } from './projectsService'
import type { FilesystemWriteCapabilitySource } from './applyAuthorityService'

// Meilenstein 4.8B.3 Slice 4 - the first real FilesystemWriteCapabilitySource
// implementation. applyAuthorityService.ts has expected this dependency since
// M4.8B.1 and the current production composition has never had one: "no
// filesystem.write-capable runtime support ... so there is intentionally no
// production code path that could accidentally produce a positive
// ApplyAuthorization today" (applyAuthorityService.ts's own file header).
// This file is that implementation - nothing more.
//
// FROZEN SCOPE (M4.8B3-Slice4-ConsentCapability-Recon-and-Design.md):
//   - Additive, Apply-scoped ONLY. runService.ts's own
//     RUNTIME_SUPPORTED_CAPABILITIES (['git.read', 'filesystem.read']) is
//     NEVER imported, read, or modified here - this file defines its OWN,
//     textually separate supported-capability list for the Apply operation
//     specifically. Ordinary Run's capability composition is completely
//     untouched.
//   - Reuses capabilityPolicy.ts's existing, generic machinery verbatim
//     (validatePolicyMap, validateCapabilityIdList,
//     validateCapabilityPolicyContext, resolveCapabilityRequest) - no new
//     capability-evaluation logic is written here, only a new composition of
//     already-existing pieces.
//   - Two distinct failure classes, two distinct responses: a malformed
//     trusted policySnapshot (a Main-process wiring bug) throws
//     InvalidCapabilityInputError synchronously at construction time
//     (fail-FAST); a projectId that does not resolve to a live project is
//     live, varying runtime state and is handled per call as a fail-CLOSED
//     DENY, never a throw - evaluateFilesystemWriteCapability()'s own
//     signature promises a return value, and applyAuthorityService.ts calls
//     it with no try/catch at either of its two call sites.

/**
 * Apply-scoped runtime-supported capability list - SEPARATE from
 * runService.ts's RUNTIME_SUPPORTED_CAPABILITIES. filesystem.write is
 * supported for the Apply operation specifically; this never widens what
 * ordinary Run considers supported.
 */
const APPLY_SUPPORTED_CAPABILITIES: readonly CapabilityId[] = ['filesystem.write']

/**
 * Structurally identical to runService.ts's own RunPolicySnapshot, but a
 * DISTINCT, Apply-scoped type - reusing RunPolicySnapshot's exact type
 * identity across two logically separate authority domains (ordinary Run vs.
 * Apply) would let a future caller pass a Run-intended snapshot into an Apply
 * context (or vice versa) without a type error. Built via the SAME
 * underlying validators as RunPolicySnapshot - only the wrapper name
 * differs, never the validation logic.
 *
 * Trusted Main-process input in this slice - its eventual production
 * composition (where a real, current, per-project value comes from) is
 * deliberately deferred, exactly symmetric with RunPolicySnapshot's own
 * still-unresolved production source (see the design doc §4.2).
 */
export interface ApplyCapabilityPolicySnapshot {
  policy: Partial<Record<CapabilityId, CapabilityPolicyMode>>
  ruleDeniedCapabilities: CapabilityId[]
}

export interface ApplyCapabilitySourceDependencies {
  db: Database.Database
  policySnapshot: ApplyCapabilityPolicySnapshot
}

/**
 * Builds ONE FilesystemWriteCapabilitySource bound to the given trusted
 * dependencies. `policySnapshot` is validated ONCE, here, at construction
 * time - a malformed snapshot (unknown capability keys, invalid policy mode
 * values, duplicate ruleDeniedCapabilities entries) throws
 * InvalidCapabilityInputError immediately, before any
 * evaluateFilesystemWriteCapability() call could ever reach it. No
 * dependency has a default - both must be supplied explicitly, mirroring
 * applyAuthorityService.ts's own "no dependency has a default" discipline.
 */
export function createApplyCapabilitySource(deps: ApplyCapabilitySourceDependencies): FilesystemWriteCapabilitySource {
  const { db, policySnapshot } = deps
  const policy = validatePolicyMap(policySnapshot.policy)
  const ruleDeniedCapabilities = validateCapabilityIdList(policySnapshot.ruleDeniedCapabilities, 'ApplyCapabilityPolicySnapshot.ruleDeniedCapabilities')

  return {
    evaluateFilesystemWriteCapability(projectId: number): CapabilityEvaluation {
      let project
      try {
        project = getProjectById(db, projectId)
      } catch (error) {
        if (!(error instanceof ProjectNotFoundError)) throw error
        // Fail-closed DENY, never an uncaught throw. Structurally
        // unreachable given the current schema (no project-deletion
        // operation exists - only archiveProject/restoreProject), but
        // checked explicitly rather than assumed, mirroring
        // applyAuthorityService.ts's own identical defensive catch at its
        // step G (getProjectById -> OWNERSHIP_INVALID).
        return { projectId, capability: 'filesystem.write', decision: 'DENY', reason: 'PROJECT_MISMATCH' }
      }

      // Freshly re-derived on every call - isArchived is live DB state that
      // must never be cached across the two calls authorizeApply() itself
      // makes per attempt (steps C and E).
      const context = validateCapabilityPolicyContext({
        projectId,
        isArchived: project.isArchived,
        supportedCapabilities: [...APPLY_SUPPORTED_CAPABILITIES],
        policy,
        ruleDeniedCapabilities
      })
      const [evaluation] = resolveCapabilityRequest({ projectId, capabilities: ['filesystem.write'] }, context)
      return evaluation
    }
  }
}
