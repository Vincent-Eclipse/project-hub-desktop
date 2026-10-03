import { describe, expect, it } from 'vitest'
import { APPLY_BATCH_STATES, APPLY_BATCH_ENTRY_STATES } from '@shared/applyBatchTypes'
import { assertValidBatchTransition, assertValidEntryTransition, ApplyBatchTransitionError } from './applyBatchTransitionGuard'

// Meilenstein 4.8B.2C - pure, no DB, no native module. Mirrors the
// Implementation Spec v4 S13.A test matrix exactly.
//
// M4.8B.3 Slice 1 additions (forward-path rows) are appended at the end of
// each describe block below, clearly separated - every test above that
// boundary is the original B.2C recovery-path regression suite, unchanged.

const BATCH_TABLE: Array<{ from: (typeof APPLY_BATCH_STATES)[number]; to: (typeof APPLY_BATCH_STATES)[number]; preRecoveryState: 'ADMITTED' | 'PREPARED' | 'APPLYING' | 'ROLLING_BACK' | null }> = [
  { from: 'ADMITTED', to: 'RECOVERY_REQUIRED', preRecoveryState: null },
  { from: 'PREPARED', to: 'RECOVERY_REQUIRED', preRecoveryState: null },
  { from: 'APPLYING', to: 'RECOVERY_REQUIRED', preRecoveryState: null },
  { from: 'ROLLING_BACK', to: 'RECOVERY_REQUIRED', preRecoveryState: null },
  { from: 'RECOVERY_REQUIRED', to: 'RECOVERY_REQUIRED', preRecoveryState: 'ADMITTED' },
  { from: 'RECOVERY_REQUIRED', to: 'SUCCEEDED', preRecoveryState: 'APPLYING' },
  { from: 'RECOVERY_REQUIRED', to: 'ROLLED_BACK', preRecoveryState: 'APPLYING' },
  { from: 'RECOVERY_REQUIRED', to: 'RECOVERY_CONFLICT', preRecoveryState: 'APPLYING' }
]

const ENTRY_TABLE: Array<{ from: (typeof APPLY_BATCH_ENTRY_STATES)[number]; to: (typeof APPLY_BATCH_ENTRY_STATES)[number] }> = [
  { from: 'PENDING', to: 'ROLLED_BACK' },
  { from: 'PREPARED', to: 'ROLLED_BACK' },
  { from: 'APPLIED', to: 'ROLLBACK_ATTEMPTING' },
  { from: 'APPLY_ATTEMPTING', to: 'ROLLBACK_ATTEMPTING' },
  { from: 'ROLLBACK_ATTEMPTING', to: 'ROLLBACK_ATTEMPTING' },
  { from: 'APPLIED', to: 'ROLLED_BACK' },
  { from: 'APPLY_ATTEMPTING', to: 'ROLLED_BACK' },
  { from: 'ROLLBACK_ATTEMPTING', to: 'ROLLED_BACK' },
  { from: 'APPLY_ATTEMPTING', to: 'RECOVERY_CONFLICT' },
  { from: 'ROLLBACK_ATTEMPTING', to: 'RECOVERY_CONFLICT' }
]

// M4.8B.3 Slice 1 - the exact six new forward-path rows this slice adds.
const FORWARD_BATCH_TABLE: Array<{ from: (typeof APPLY_BATCH_STATES)[number]; to: (typeof APPLY_BATCH_STATES)[number]; preRecoveryState: null }> = [
  { from: 'ADMITTED', to: 'PREPARED', preRecoveryState: null },
  { from: 'PREPARED', to: 'APPLYING', preRecoveryState: null },
  { from: 'APPLYING', to: 'SUCCEEDED', preRecoveryState: null }
]

const FORWARD_ENTRY_TABLE: Array<{ from: (typeof APPLY_BATCH_ENTRY_STATES)[number]; to: (typeof APPLY_BATCH_ENTRY_STATES)[number] }> = [
  { from: 'PENDING', to: 'PREPARED' },
  { from: 'PREPARED', to: 'APPLY_ATTEMPTING' },
  { from: 'APPLY_ATTEMPTING', to: 'APPLIED' }
]

describe('applyBatchTransitionGuard - batch transitions (S4.1)', () => {
  it('1. every row of the batch table succeeds', () => {
    for (const row of BATCH_TABLE) {
      expect(() => assertValidBatchTransition({ state: row.from, preRecoveryState: row.preRecoveryState }, row.to)).not.toThrow()
    }
  })

  it('RECOVERY_REQUIRED->SUCCEEDED with preRecoveryState PREPARED or ROLLING_BACK both throw (the one rule the schema itself cannot express)', () => {
    expect(() => assertValidBatchTransition({ state: 'RECOVERY_REQUIRED', preRecoveryState: 'PREPARED' }, 'SUCCEEDED')).toThrow(ApplyBatchTransitionError)
    expect(() => assertValidBatchTransition({ state: 'RECOVERY_REQUIRED', preRecoveryState: 'ROLLING_BACK' }, 'SUCCEEDED')).toThrow(ApplyBatchTransitionError)
  })

  it('RECOVERY_CONFLICT -> anything throws (the O2 enforcement point: never automatically retried or altered)', () => {
    for (const to of APPLY_BATCH_STATES) {
      expect(() => assertValidBatchTransition({ state: 'RECOVERY_CONFLICT', preRecoveryState: 'APPLYING' }, to)).toThrow(ApplyBatchTransitionError)
    }
  })

  it('SUCCEEDED/ROLLED_BACK -> anything throws', () => {
    for (const from of ['SUCCEEDED', 'ROLLED_BACK'] as const) {
      for (const to of APPLY_BATCH_STATES) {
        expect(() => assertValidBatchTransition({ state: from, preRecoveryState: 'APPLYING' }, to)).toThrow(ApplyBatchTransitionError)
      }
    }
  })

  it('every rejected pair throws INVALID_BATCH_TRANSITION with the correct code', () => {
    try {
      assertValidBatchTransition({ state: 'ADMITTED', preRecoveryState: null }, 'SUCCEEDED')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ApplyBatchTransitionError)
      expect((error as ApplyBatchTransitionError).code).toBe('INVALID_BATCH_TRANSITION')
    }
  })

  // ---------------------------------------------------------------------
  // M4.8B.3 Slice 1 - forward-path rows (new)
  // ---------------------------------------------------------------------

  it('7. every row of the new forward batch table succeeds (ADMITTED->PREPARED->APPLYING->SUCCEEDED)', () => {
    for (const row of FORWARD_BATCH_TABLE) {
      expect(() => assertValidBatchTransition({ state: row.from, preRecoveryState: row.preRecoveryState }, row.to)).not.toThrow()
    }
  })

  it('8. forward batch transitions cannot skip a required intermediate state', () => {
    expect(() => assertValidBatchTransition({ state: 'ADMITTED', preRecoveryState: null }, 'APPLYING')).toThrow(ApplyBatchTransitionError)
    expect(() => assertValidBatchTransition({ state: 'ADMITTED', preRecoveryState: null }, 'SUCCEEDED')).toThrow(ApplyBatchTransitionError)
    expect(() => assertValidBatchTransition({ state: 'PREPARED', preRecoveryState: null }, 'SUCCEEDED')).toThrow(ApplyBatchTransitionError)
  })

  it('9. APPLYING->SUCCEEDED is a live, non-recovery row distinct from RECOVERY_REQUIRED->SUCCEEDED - it never becomes reachable via a recovery-shaped preRecoveryState, and a fabricated non-null preRecoveryState is rejected even from the correct source state', () => {
    // The recovery row's own source state (RECOVERY_REQUIRED) still requires RECOVERY_REQUIRED, never APPLYING directly with a preRecoveryState guard substituting for it.
    expect(() => assertValidBatchTransition({ state: 'APPLYING', preRecoveryState: 'APPLYING' }, 'SUCCEEDED')).toThrow(ApplyBatchTransitionError)
    // The live row's own defensive guard: a batch actually at APPLYING is schema-guaranteed to carry a NULL pre_recovery_state - a caller passing a fabricated non-null value must still be rejected, not silently accepted.
    expect(() => assertValidBatchTransition({ state: 'APPLYING', preRecoveryState: 'ADMITTED' }, 'SUCCEEDED')).toThrow(ApplyBatchTransitionError)
  })

  it('10. every existing recovery-path batch row is unaffected by the new forward rows (full regression re-run)', () => {
    for (const row of BATCH_TABLE) {
      expect(() => assertValidBatchTransition({ state: row.from, preRecoveryState: row.preRecoveryState }, row.to)).not.toThrow()
    }
  })
})

describe('applyBatchTransitionGuard - entry transitions (S4.2)', () => {
  it('2. every row of the corrected entry table succeeds, including APPLIED->ROLLED_BACK still succeeding', () => {
    for (const row of ENTRY_TABLE) {
      expect(() => assertValidEntryTransition({ state: row.from }, row.to)).not.toThrow()
    }
    // Explicit regression proof this edge was preserved, not accidentally dropped alongside APPLIED->RECOVERY_CONFLICT.
    expect(() => assertValidEntryTransition({ state: 'APPLIED' }, 'ROLLED_BACK')).not.toThrow()
  })

  it('3. APPLIED -> RECOVERY_CONFLICT throws INVALID_ENTRY_TRANSITION (the direct fix this table exists to enforce)', () => {
    try {
      assertValidEntryTransition({ state: 'APPLIED' }, 'RECOVERY_CONFLICT')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ApplyBatchTransitionError)
      expect((error as ApplyBatchTransitionError).code).toBe('INVALID_ENTRY_TRANSITION')
    }
  })

  it('4. PENDING->RECOVERY_CONFLICT / PREPARED->RECOVERY_CONFLICT both throw', () => {
    expect(() => assertValidEntryTransition({ state: 'PENDING' }, 'RECOVERY_CONFLICT')).toThrow(ApplyBatchTransitionError)
    expect(() => assertValidEntryTransition({ state: 'PREPARED' }, 'RECOVERY_CONFLICT')).toThrow(ApplyBatchTransitionError)
  })

  it('5. ROLLED_BACK / RECOVERY_CONFLICT -> anything throws', () => {
    for (const from of ['ROLLED_BACK', 'RECOVERY_CONFLICT'] as const) {
      for (const to of APPLY_BATCH_ENTRY_STATES) {
        expect(() => assertValidEntryTransition({ state: from }, to)).toThrow(ApplyBatchTransitionError)
      }
    }
  })

  it('6. APPLY_ATTEMPTING and ROLLBACK_ATTEMPTING are EXHAUSTIVELY the only two legal direct sources of RECOVERY_CONFLICT', () => {
    const actualLegalSources = APPLY_BATCH_ENTRY_STATES.filter((from) => {
      try {
        assertValidEntryTransition({ state: from }, 'RECOVERY_CONFLICT')
        return true
      } catch {
        return false
      }
    })
    expect(new Set(actualLegalSources)).toEqual(new Set(['APPLY_ATTEMPTING', 'ROLLBACK_ATTEMPTING']))
  })

  it('PENDING -> APPLIED/APPLY_ATTEMPTING still throws (M4.8B.3 Slice 1 note: PENDING must still pass through PREPARED first - only PREPARED->APPLY_ATTEMPTING and APPLY_ATTEMPTING->APPLIED became legal, never a direct skip from PENDING)', () => {
    expect(() => assertValidEntryTransition({ state: 'PENDING' }, 'APPLIED')).toThrow(ApplyBatchTransitionError)
    expect(() => assertValidEntryTransition({ state: 'PENDING' }, 'APPLY_ATTEMPTING')).toThrow(ApplyBatchTransitionError)
  })

  it('PREPARED -> APPLIED still throws even after M4.8B.3 Slice 1 (the write-ahead APPLY_ATTEMPTING marker may never be bypassed - only PREPARED->APPLY_ATTEMPTING is legal, not PREPARED->APPLIED directly)', () => {
    expect(() => assertValidEntryTransition({ state: 'PREPARED' }, 'APPLIED')).toThrow(ApplyBatchTransitionError)
  })

  // ---------------------------------------------------------------------
  // M4.8B.3 Slice 1 - forward-path rows (new)
  // ---------------------------------------------------------------------

  it('7. every row of the new forward entry table succeeds (PENDING->PREPARED->APPLY_ATTEMPTING->APPLIED)', () => {
    for (const row of FORWARD_ENTRY_TABLE) {
      expect(() => assertValidEntryTransition({ state: row.from }, row.to)).not.toThrow()
    }
  })

  it('8. forward entry transitions cannot skip a required intermediate state, in either direction of the chain', () => {
    // Cannot skip PREPARED.
    expect(() => assertValidEntryTransition({ state: 'PENDING' }, 'APPLY_ATTEMPTING')).toThrow(ApplyBatchTransitionError)
    expect(() => assertValidEntryTransition({ state: 'PENDING' }, 'APPLIED')).toThrow(ApplyBatchTransitionError)
    // Cannot skip the write-ahead APPLY_ATTEMPTING marker.
    expect(() => assertValidEntryTransition({ state: 'PREPARED' }, 'APPLIED')).toThrow(ApplyBatchTransitionError)
    // No reverse transition anywhere in the forward chain.
    expect(() => assertValidEntryTransition({ state: 'PREPARED' }, 'PENDING')).toThrow(ApplyBatchTransitionError)
    expect(() => assertValidEntryTransition({ state: 'APPLY_ATTEMPTING' }, 'PREPARED')).toThrow(ApplyBatchTransitionError)
    expect(() => assertValidEntryTransition({ state: 'APPLIED' }, 'APPLY_ATTEMPTING')).toThrow(ApplyBatchTransitionError)
  })

  it('9. the new forward rows add no new source of RECOVERY_CONFLICT (regression re-run of test 6 against the extended table)', () => {
    const actualLegalSources = APPLY_BATCH_ENTRY_STATES.filter((from) => {
      try {
        assertValidEntryTransition({ state: from }, 'RECOVERY_CONFLICT')
        return true
      } catch {
        return false
      }
    })
    expect(new Set(actualLegalSources)).toEqual(new Set(['APPLY_ATTEMPTING', 'ROLLBACK_ATTEMPTING']))
  })

  it('10. every existing recovery-path entry row is unaffected by the new forward rows (full regression re-run)', () => {
    for (const row of ENTRY_TABLE) {
      expect(() => assertValidEntryTransition({ state: row.from }, row.to)).not.toThrow()
    }
    expect(() => assertValidEntryTransition({ state: 'APPLIED' }, 'ROLLED_BACK')).not.toThrow()
    expect(() => assertValidEntryTransition({ state: 'APPLIED' }, 'RECOVERY_CONFLICT')).toThrow(ApplyBatchTransitionError)
  })
})
