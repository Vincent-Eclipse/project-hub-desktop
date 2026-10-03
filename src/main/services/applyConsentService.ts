import type { Clock } from './codeChangeReviewService'
import { APPLY_CONSENT_PURPOSE_VERSION, type ApplyConsentEvidence, type ApplyConsentQuery, type ApplyConsentSource } from './applyAuthorityService'

// Meilenstein 4.8B.3 Slice 4 - the first real ApplyConsentSource
// implementation. applyAuthorityService.ts has expected this dependency since
// M4.8B.1 and has never received one: "NOT persistent in M4.8B.1 ... a real
// implementation is a future milestone's concern" (applyAuthorityService.ts's
// own ApplyConsentSource doc comment). This file is that implementation -
// nothing more.
//
// FROZEN SCOPE (M4.8B3-Slice4-ConsentCapability-Recon-and-Design.md):
//   - In-memory only. No DB table, no persistence of any kind - an app
//     restart (a new service instance) wipes every record, exactly like
//     codeChangeReviewService.ts's own review registry.
//   - resolveApplyConsent() is PURELY read-only, per its own frozen contract
//     ("MUST NOT mutate ... consent state ... as part of resolving this
//     call") - it never deletes, consumes, or otherwise mutates a record as a
//     side effect of being read. An expired or mismatched record simply
//     reads as absent (null); it is not removed by the read.
//   - Single-use consumption is therefore never the read's job. It is the
//     job of the two NEW, non-ApplyConsentSource methods this file adds:
//     recordApplyConsent() (the explicit-action trigger) and
//     invalidateApplyConsent() (the unconditional, post-attempt consumer,
//     called by a future Slice-6 orchestrator regardless of outcome). Expired
//     entries are swept lazily, opportunistically, ONLY inside
//     recordApplyConsent() - mirroring codeChangeReviewService.ts's own
//     purgeExpired()-called-only-from-a-write discipline.
//   - A short, bounded TTL (APPLY_CONSENT_TTL_MS) is an independent backstop
//     against an orchestrator that records consent and never calls
//     invalidateApplyConsent() (e.g. a crash in between) - it is not the
//     primary enforcement mechanism, which is single-use invalidation itself.

/**
 * Controller-decided (M4.8B3-Slice4-ConsentCapability-Recon-and-Design.md
 * §2.3): short relative to CODE_CHANGE_REVIEW_TTL_MS (2 hours), generous
 * relative to one synchronous record->submitApply->invalidate handler call
 * (milliseconds in practice).
 */
export const APPLY_CONSENT_TTL_MS = 2 * 60 * 1000

interface ApplyConsentRecord {
  fingerprint: string
  expiresAtMs: number
}

export interface ApplyConsentService extends ApplyConsentSource {
  /**
   * Trusted Main-only write. `reviewId`/`fingerprint` MUST already be
   * Main-resolved by the caller (see the design doc §3 - a future Slice-6
   * IPC handler resolves the review fresh and reads its OWN fingerprint;
   * this method never accepts one from a renderer request body, and has no
   * `unknown`/raw-input parameter of any kind). Idempotent: recording again
   * for a reviewId that already has a record (e.g. a legitimate retry after
   * an earlier invalidation) simply replaces it and its TTL.
   */
  recordApplyConsent(reviewId: string, fingerprint: string): void
  /**
   * Trusted Main-only write. Removes the record for `reviewId` ONLY if its
   * stored fingerprint exactly matches `fingerprint` - a mismatched call is a
   * safe no-op, never a partial/wrong deletion. Also a no-op (never throws)
   * if nothing is recorded for `reviewId` at all - a future orchestrator
   * calls this unconditionally after every apply attempt, whether or not a
   * record ever existed to consume.
   */
  invalidateApplyConsent(reviewId: string, fingerprint: string): void
}

const SYSTEM_CLOCK: Clock = { now: () => new Date() }

/**
 * Builds ONE ApplyConsentService bound to an optional injectable clock (for
 * deterministic TTL tests) - mirrors codeChangeReviewService.ts's own
 * createCodeChangeReviewRegistry(clock) shape.
 */
export function createApplyConsentService(clock: Clock = SYSTEM_CLOCK): ApplyConsentService {
  const records = new Map<string, ApplyConsentRecord>()

  function isExpired(record: ApplyConsentRecord): boolean {
    return clock.now().getTime() >= record.expiresAtMs
  }

  /** Removes ONLY expired entries - never a still-valid record. Called exclusively from recordApplyConsent(), never from the read-only resolveApplyConsent(). */
  function purgeExpired(): void {
    for (const [reviewId, record] of records) {
      if (isExpired(record)) records.delete(reviewId)
    }
  }

  return {
    recordApplyConsent(reviewId: string, fingerprint: string): void {
      purgeExpired()
      const now = clock.now().getTime()
      records.set(reviewId, { fingerprint, expiresAtMs: now + APPLY_CONSENT_TTL_MS })
    },

    resolveApplyConsent(query: ApplyConsentQuery): ApplyConsentEvidence | null {
      const record = records.get(query.reviewId)
      if (!record) return null
      if (isExpired(record)) return null
      if (record.fingerprint !== query.fingerprint) return null
      // A fresh, independently-owned object - never the internal record by
      // reference (mirrors applyAuthorityService.ts's own
      // copyCapabilityEvidence() "immediate copy, never the dependency's own
      // object" discipline).
      return { reviewId: query.reviewId, fingerprint: query.fingerprint, purposeVersion: APPLY_CONSENT_PURPOSE_VERSION }
    },

    invalidateApplyConsent(reviewId: string, fingerprint: string): void {
      const record = records.get(reviewId)
      if (!record) return
      if (record.fingerprint !== fingerprint) return
      records.delete(reviewId)
    }
  }
}
