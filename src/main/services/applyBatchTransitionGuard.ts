// Meilenstein 4.8B.2C (Recovery Core) + 4.8B.3 Slice 1 (forward-path rows) -
// pure, DB-free, in-memory transition validation for the frozen
// apply_batches/apply_batch_entries vocabularies (@shared/applyBatchTypes.ts).
// Takes an already-read row snapshot and a desired target state; either
// returns normally or throws. No DB I/O, no native call, ever, in this file.
//
// Recovery-path rows (B.2C) are scoped exactly to the transitions
// applyBatchRecoveryService.ts actually calls, unchanged since B.2C.
// Forward-path rows (B.3 Slice 1, added below) are scoped exactly to the
// single live (non-crash) admission->success sequence the future forward-
// execution service (B.3 Slice 2+, not part of this slice) will drive:
//   batch:  ADMITTED -> PREPARED -> APPLYING -> SUCCEEDED
//   entry:  PENDING  -> PREPARED -> APPLY_ATTEMPTING -> APPLIED
// This slice adds ONLY those six table rows (three per table) - no service,
// no IPC, no wiring, no DB I/O, no native call exists yet to request them.
// The live APPLIED->ROLLBACK_ATTEMPTING->ROLLED_BACK path some future
// mission might add for a NON-crash, in-process rollback is deliberately
// still absent: per the approved B.3 design, a live forward-execution
// failure never rolls itself back - it aborts and leaves the batch in a
// scan-discoverable non-terminal state, which the EXISTING recovery rows
// (APPLYING -> RECOVERY_REQUIRED, already present) already resolve, whether
// invoked at next app startup or by an immediate in-process recoverBatch()
// call. No new row is needed for that path, now or later.
import type { ApplyBatchState, ApplyBatchEntryState, ApplyBatchRecoveryOriginState } from '@shared/applyBatchTypes'
import type { ApplyBatchTransitionErrorCode } from '@shared/applyBatchRecoveryTypes'

export class ApplyBatchTransitionError extends Error {
  constructor(
    public readonly code: ApplyBatchTransitionErrorCode,
    public readonly detail: string
  ) {
    super(`${code}: ${detail}`)
    this.name = 'ApplyBatchTransitionError'
  }
}

interface BatchTransitionInput {
  state: ApplyBatchState
  preRecoveryState: ApplyBatchRecoveryOriginState | null
}

interface BatchTransitionRule {
  from: ApplyBatchState
  to: ApplyBatchState
  guard?: (ctx: BatchTransitionInput) => boolean
}

// Table 4.1 (batch). Recovery-path rows (B.2C) first, forward-path rows
// (B.3 Slice 1) appended after - every recovery-path row below is
// byte-for-byte unchanged from B.2C.
const ALLOWED_BATCH_TRANSITIONS: readonly BatchTransitionRule[] = [
  { from: 'ADMITTED', to: 'RECOVERY_REQUIRED' },
  { from: 'PREPARED', to: 'RECOVERY_REQUIRED' },
  { from: 'APPLYING', to: 'RECOVERY_REQUIRED' },
  { from: 'ROLLING_BACK', to: 'RECOVERY_REQUIRED' },
  { from: 'RECOVERY_REQUIRED', to: 'RECOVERY_REQUIRED' },
  { from: 'RECOVERY_REQUIRED', to: 'SUCCEEDED', guard: (ctx) => ctx.preRecoveryState === 'APPLYING' },
  { from: 'RECOVERY_REQUIRED', to: 'ROLLED_BACK' },
  { from: 'RECOVERY_REQUIRED', to: 'RECOVERY_CONFLICT' },

  // --- B.3 Slice 1: forward-path rows (new) -------------------------------
  // ADMITTED -> PREPARED: the batch's single Prepare() call captures root
  // native identity (root_native_file_id_128_hex/volume_serial, NULL until
  // exactly this transition - 007_apply_batches.ts:41-43) and every entry's
  // per-entry outcome in one native call, before any mutating call is ever
  // issued for any entry.
  { from: 'ADMITTED', to: 'PREPARED' },
  // PREPARED -> APPLYING: forward execution begins issuing mutating native
  // calls (createFile()/applyModify()) for individual entries.
  { from: 'PREPARED', to: 'APPLYING' },
  // APPLYING -> SUCCEEDED: the live, non-crash success path - deliberately
  // a DIFFERENT `from` state than the existing RECOVERY_REQUIRED->SUCCEEDED
  // row above, so this row never needs and never shares that row's
  // preRecoveryState=='APPLYING' guard (which checks a stored recovery-
  // origin marker, an unrelated concept). guard here instead asserts the
  // schema's own invariant explicitly rather than assuming it: a batch at
  // state='APPLYING' has never been marked RECOVERY_REQUIRED, so its
  // pre_recovery_state column is schema-guaranteed NULL
  // (007_apply_batches.ts's "state NOT IN (RECOVERY_REQUIRED,RECOVERY_CONFLICT,
  // SUCCEEDED,ROLLED_BACK) OR pre_recovery_state IS NULL" CHECK) - checked
  // here anyway, redundantly, so a caller passing a fabricated/incorrect
  // preRecoveryState can never reach live SUCCEEDED through this row.
  { from: 'APPLYING', to: 'SUCCEEDED', guard: (ctx) => ctx.preRecoveryState === null }
]

export function assertValidBatchTransition(current: BatchTransitionInput, to: ApplyBatchState): void {
  const rule = ALLOWED_BATCH_TRANSITIONS.find((r) => r.from === current.state && r.to === to)
  if (!rule || (rule.guard && !rule.guard(current))) {
    throw new ApplyBatchTransitionError(
      'INVALID_BATCH_TRANSITION',
      `${current.state} -> ${to} (preRecoveryState=${String(current.preRecoveryState)})`
    )
  }
}

interface EntryTransitionRule {
  from: ApplyBatchEntryState
  to: ApplyBatchEntryState
}

// Table 4.2 (entry). Recovery-path rows (B.2C) first, forward-path rows
// (B.3 Slice 1) appended after - every recovery-path row below is
// byte-for-byte unchanged from B.2C. RECOVERY_CONFLICT is reachable ONLY
// from APPLY_ATTEMPTING or ROLLBACK_ATTEMPTING, exactly per the frozen
// vocabulary - {from:'APPLIED', to:'RECOVERY_CONFLICT'} is deliberately
// ABSENT. Every code path in applyBatchRecoveryService.ts that could
// otherwise request this transition for an APPLIED-origin entry first
// durably transitions it to ROLLBACK_ATTEMPTING (ensureNotDirectlyApplied,
// used by resolveEntryConflict) - so this guard never needs to, and must
// never, permit the direct edge. APPLIED->ROLLED_BACK is retained: that path
// (the as-original-probe-matched case) can never reach RECOVERY_CONFLICT, so
// no pre-marker is required or performed for it. The three new forward-path
// rows below add NO new source of RECOVERY_CONFLICT and do not touch this
// set at all - APPLY_ATTEMPTING/ROLLBACK_ATTEMPTING remain exhaustively the
// only two legal direct sources (see this file's own test suite).
const ALLOWED_ENTRY_TRANSITIONS: readonly EntryTransitionRule[] = [
  { from: 'PENDING', to: 'ROLLED_BACK' },
  { from: 'PREPARED', to: 'ROLLED_BACK' },
  { from: 'APPLIED', to: 'ROLLBACK_ATTEMPTING' },
  { from: 'APPLY_ATTEMPTING', to: 'ROLLBACK_ATTEMPTING' },
  { from: 'ROLLBACK_ATTEMPTING', to: 'ROLLBACK_ATTEMPTING' },
  { from: 'APPLIED', to: 'ROLLED_BACK' },
  { from: 'APPLY_ATTEMPTING', to: 'ROLLED_BACK' },
  { from: 'ROLLBACK_ATTEMPTING', to: 'ROLLED_BACK' },
  { from: 'APPLY_ATTEMPTING', to: 'RECOVERY_CONFLICT' },
  { from: 'ROLLBACK_ATTEMPTING', to: 'RECOVERY_CONFLICT' },
  // NOTE: {from:'APPLIED', to:'RECOVERY_CONFLICT'} is deliberately ABSENT - see comment above.

  // --- B.3 Slice 1: forward-path rows (new) -------------------------------
  // PENDING -> PREPARED: this entry's own outcome from the batch's single
  // Prepare() call (prepared_native_file_id_128_hex/volume_serial captured
  // here for MODIFY; CREATE entries pass through with both left NULL -
  // 007_apply_batches.ts:145-149). No native mutating call has happened yet.
  { from: 'PENDING', to: 'PREPARED' },
  // PREPARED -> APPLY_ATTEMPTING: write-ahead marker, committed BEFORE the
  // entry's own mutating native call (createFile()/applyModify()) is
  // issued - mirrors B.2C's own markBeforeMutatingCall write-ahead
  // discipline exactly, applied here to the forward direction.
  { from: 'PREPARED', to: 'APPLY_ATTEMPTING' },
  // APPLY_ATTEMPTING -> APPLIED: the mutating native call succeeded AND
  // verifyFile() confirmed exact post-write bytes/identity - never written
  // before verification, mirroring the schema's own mandatory-once-APPLIED
  // evidence CHECK (007_apply_batches.ts:204-208).
  { from: 'APPLY_ATTEMPTING', to: 'APPLIED' }
]

export function assertValidEntryTransition(current: { state: ApplyBatchEntryState }, to: ApplyBatchEntryState): void {
  const allowed = ALLOWED_ENTRY_TRANSITIONS.some((r) => r.from === current.state && r.to === to)
  if (!allowed) {
    throw new ApplyBatchTransitionError('INVALID_ENTRY_TRANSITION', `${current.state} -> ${to}`)
  }
}
