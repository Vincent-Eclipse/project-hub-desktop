import { describe, it, expect } from 'vitest'
import type { Clock } from './codeChangeReviewService'
import { APPLY_CONSENT_PURPOSE_VERSION } from './applyAuthorityService'
import { APPLY_CONSENT_TTL_MS, createApplyConsentService } from './applyConsentService'

// Meilenstein 4.8B.3 Slice 4 - applyConsentService.ts's test matrix, exactly
// mirroring M4.8B3-Slice4-ConsentCapability-Recon-and-Design.md §6.1.

/** A mutable, injectable Clock - lets tests advance "now" deterministically past APPLY_CONSENT_TTL_MS without a real sleep. */
function makeMutableClock(startMs: number): { clock: Clock; advanceMs: (deltaMs: number) => void } {
  let current = startMs
  return {
    clock: { now: () => new Date(current) },
    advanceMs: (deltaMs: number) => {
      current += deltaMs
    }
  }
}

describe('applyConsentService - recording and resolving', () => {
  it('1. record, then resolve with the exact {reviewId, fingerprint} -> returns matching evidence', () => {
    const service = createApplyConsentService()
    service.recordApplyConsent('review-1', 'fp-1')
    expect(service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })).toEqual({
      reviewId: 'review-1',
      fingerprint: 'fp-1',
      purposeVersion: APPLY_CONSENT_PURPOSE_VERSION
    })
  })

  it('2. resolve with no prior record for that reviewId -> null', () => {
    const service = createApplyConsentService()
    expect(service.resolveApplyConsent({ reviewId: 'never-recorded', fingerprint: 'fp-1' })).toBeNull()
  })

  it('3. resolve with the correct reviewId but a wrong fingerprint -> null', () => {
    const service = createApplyConsentService()
    service.recordApplyConsent('review-1', 'fp-1')
    expect(service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'wrong-fp' })).toBeNull()
  })

  it('4. resolve for an unrecorded reviewId while a DIFFERENT reviewId IS recorded -> null for the unrecorded one, unaffected for the other', () => {
    const service = createApplyConsentService()
    service.recordApplyConsent('review-A', 'fp-A')
    expect(service.resolveApplyConsent({ reviewId: 'review-B', fingerprint: 'fp-B' })).toBeNull()
    expect(service.resolveApplyConsent({ reviewId: 'review-A', fingerprint: 'fp-A' })).toEqual({
      reviewId: 'review-A',
      fingerprint: 'fp-A',
      purposeVersion: APPLY_CONSENT_PURPOSE_VERSION
    })
  })

  it('5. expiry: record, advance an injected clock past APPLY_CONSENT_TTL_MS, resolve -> null', () => {
    const { clock, advanceMs } = makeMutableClock(0)
    const service = createApplyConsentService(clock)
    service.recordApplyConsent('review-1', 'fp-1')
    advanceMs(APPLY_CONSENT_TTL_MS)
    expect(service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })).toBeNull()
  })

  it('expiry boundary: one millisecond before the TTL elapses, the record is still valid', () => {
    const { clock, advanceMs } = makeMutableClock(0)
    const service = createApplyConsentService(clock)
    service.recordApplyConsent('review-1', 'fp-1')
    advanceMs(APPLY_CONSENT_TTL_MS - 1)
    expect(service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })).not.toBeNull()
  })

  it('6. project isolation / no single-slot collision: two different reviewIds recorded concurrently are both independently resolvable', () => {
    const service = createApplyConsentService()
    service.recordApplyConsent('review-A', 'fp-A')
    service.recordApplyConsent('review-B', 'fp-B')
    expect(service.resolveApplyConsent({ reviewId: 'review-A', fingerprint: 'fp-A' })).not.toBeNull()
    expect(service.resolveApplyConsent({ reviewId: 'review-B', fingerprint: 'fp-B' })).not.toBeNull()
  })

  it('7. repeated record (legitimate retry): record, invalidate, record again for the same reviewId/fingerprint -> resolves again', () => {
    const service = createApplyConsentService()
    service.recordApplyConsent('review-1', 'fp-1')
    service.invalidateApplyConsent('review-1', 'fp-1')
    expect(service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })).toBeNull()
    service.recordApplyConsent('review-1', 'fp-1')
    expect(service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })).toEqual({
      reviewId: 'review-1',
      fingerprint: 'fp-1',
      purposeVersion: APPLY_CONSENT_PURPOSE_VERSION
    })
  })
})

describe('applyConsentService - invalidation (single-use enforcement)', () => {
  it('8. invalidate then resolve -> null (the single-use guarantee itself)', () => {
    const service = createApplyConsentService()
    service.recordApplyConsent('review-1', 'fp-1')
    service.invalidateApplyConsent('review-1', 'fp-1')
    expect(service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })).toBeNull()
  })

  it('9. invalidate with no prior record -> no-op, does not throw', () => {
    const service = createApplyConsentService()
    expect(() => service.invalidateApplyConsent('never-recorded', 'fp-1')).not.toThrow()
    expect(service.resolveApplyConsent({ reviewId: 'never-recorded', fingerprint: 'fp-1' })).toBeNull()
  })

  it('10. invalidate with a mismatched fingerprint -> the existing record (for the correct fingerprint) is untouched', () => {
    const service = createApplyConsentService()
    service.recordApplyConsent('review-1', 'fp-1')
    service.invalidateApplyConsent('review-1', 'wrong-fp')
    expect(service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })).toEqual({
      reviewId: 'review-1',
      fingerprint: 'fp-1',
      purposeVersion: APPLY_CONSENT_PURPOSE_VERSION
    })
  })
})

describe('applyConsentService - read-only discipline', () => {
  it('11. dual-read compatibility: two immediate reads for the same query return equal, unaffected-by-each-other evidence', () => {
    const service = createApplyConsentService()
    service.recordApplyConsent('review-1', 'fp-1')
    const first = service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })
    const second = service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })
    expect(first).toEqual(second)
    expect(second).not.toBeNull()
  })

  it('12. defensive copy: mutating the returned evidence object does not affect a later resolve() for the same query', () => {
    const service = createApplyConsentService()
    service.recordApplyConsent('review-1', 'fp-1')
    const evidence = service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })
    expect(evidence).not.toBeNull()
    ;(evidence as { fingerprint: string }).fingerprint = 'tampered'
    const again = service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })
    expect(again).toEqual({ reviewId: 'review-1', fingerprint: 'fp-1', purposeVersion: APPLY_CONSENT_PURPOSE_VERSION })
  })

  it('resolveApplyConsent() never removes an expired record itself - a later, non-expiring re-check still reads it as absent, never re-appears', () => {
    const { clock, advanceMs } = makeMutableClock(0)
    const service = createApplyConsentService(clock)
    service.recordApplyConsent('review-1', 'fp-1')
    advanceMs(APPLY_CONSENT_TTL_MS)
    expect(service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })).toBeNull()
    // A second read (still expired, clock unchanged) must be equally null - not
    // "resurrected" by the prior read, and not affected by resolve() having run.
    expect(service.resolveApplyConsent({ reviewId: 'review-1', fingerprint: 'fp-1' })).toBeNull()
  })
})

describe('applyConsentService - purge-on-record', () => {
  it('13. record A, expire it, record B -> B is resolvable, A (expired) is not', () => {
    const { clock, advanceMs } = makeMutableClock(0)
    const service = createApplyConsentService(clock)
    service.recordApplyConsent('review-A', 'fp-A')
    advanceMs(APPLY_CONSENT_TTL_MS)
    service.recordApplyConsent('review-B', 'fp-B')
    expect(service.resolveApplyConsent({ reviewId: 'review-A', fingerprint: 'fp-A' })).toBeNull()
    expect(service.resolveApplyConsent({ reviewId: 'review-B', fingerprint: 'fp-B' })).toEqual({
      reviewId: 'review-B',
      fingerprint: 'fp-B',
      purposeVersion: APPLY_CONSENT_PURPOSE_VERSION
    })
  })
})

describe('applyConsentService - restart symmetry', () => {
  it('14. a fresh service instance has no records', () => {
    const service = createApplyConsentService()
    expect(service.resolveApplyConsent({ reviewId: 'anything', fingerprint: 'anything' })).toBeNull()
  })
})
