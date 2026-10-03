import { createStore } from 'zustand/vanilla'
import type { CodeChangeReviewProjection, CodeChangeReviewSummary } from '@shared/codeChangeReviewTypes'
import { unwrap } from '../api/client'
import { LatestRequestGuard } from '../utils/requestGuard'

// M4.8A V2: the list only ever holds lightweight CodeChangeReviewSummary entries (no
// diff/source content - see codeChangeReviewService.ts's listReviewsForProject()). A decision
// (approve/requestChanges) returns the FULL CodeChangeReviewProjection though (for `selected`) -
// toSummaryShape() projects it down to the same summary shape used by the list, mirroring
// workRequestStore.ts's own toSummary() precedent for exactly this list/detail shape split.
function toSummaryShape(projection: CodeChangeReviewProjection): CodeChangeReviewSummary {
  return {
    reviewId: projection.reviewId,
    projectId: projection.projectId,
    taskId: projection.taskId,
    workRequestId: projection.workRequestId,
    state: projection.state,
    summary: projection.summary,
    warnings: projection.warnings,
    fileCount: projection.files.length,
    feedback: projection.feedback,
    createdAt: projection.createdAt,
    expiresAt: projection.expiresAt
  }
}

// Meilenstein 4.8A - Review-Zustand fuer die Work-Ansicht. Analog
// workRequestStore.ts (jedes gemountete Projekt besitzt seinen eigenen
// Store, drei getrennte Generation-Zaehler fuer list/select/decision) -
// KEIN generisches ReviewManager-/WorkflowEngine-/Query-Framework. `readOnly`
// (archiviertes Projekt) deaktiviert Approve/Request-Changes vollstaendig,
// genau wie bei Work Requests.
//
// WICHTIG: dieser Store kann NIEMALS eine Review ERSTELLEN - es gibt bewusst
// keinen IPC-Kanal dafuer (siehe codeChangeReviewService.ts's Datei-
// Kommentar: Review-Erstellung ist Main-internal only). Dieser Store zeigt
// ausschliesslich bereits ueber einen Main-internen/Test-Pfad erstellte
// Reviews an.

interface CodeChangeReviewState {
  reviews: CodeChangeReviewSummary[]
  selectedId: string | null
  selected: CodeChangeReviewProjection | null
  loadingList: boolean
  loadingSelected: boolean
  deciding: boolean
  error: string | null
  loadList: () => Promise<void>
  select: (reviewId: string | null) => Promise<void>
  approve: () => Promise<CodeChangeReviewProjection | null>
  requestChanges: (feedback: string) => Promise<CodeChangeReviewProjection | null>
  dispose: () => void
}

export type { CodeChangeReviewState }

export function createCodeChangeReviewStore(projectId: number, readOnly: boolean) {
  const listGuard = new LatestRequestGuard()
  const selectGuard = new LatestRequestGuard()
  const decisionGuard = new LatestRequestGuard()

  return createStore<CodeChangeReviewState>((set, get) => {
    // Mirrors workRequestStore.ts's beginMutation(): a decision (approve/requestChanges)
    // invalidates any still-pending list/select ticket so a stale response can never
    // overwrite the freshly-decided state, without resolving loadingList/loadingSelected
    // itself (see workRequestStore.ts's own extensive rationale for why that split matters).
    function beginDecision(): number {
      listGuard.invalidate()
      selectGuard.invalidate()
      const ticket = decisionGuard.start()
      set({ deciding: true, error: null, loadingSelected: false })
      return ticket
    }

    function applyDecisionResult(updated: CodeChangeReviewProjection): void {
      const updatedSummary = toSummaryShape(updated)
      set({
        selected: updated,
        reviews: get().reviews.map((review) => (review.reviewId === updatedSummary.reviewId ? updatedSummary : review)),
        deciding: false
      })
    }

    return {
      reviews: [],
      selectedId: null,
      selected: null,
      loadingList: true,
      loadingSelected: false,
      deciding: false,
      error: null,
      loadList: async () => {
        if (get().deciding) return
        const ticket = listGuard.start()
        set({ loadingList: true, error: null })
        try {
          const reviews = await unwrap(window.eclipseHub.codeChangeReviews.list(projectId))
          if (!listGuard.isCurrent(ticket)) return
          set({ reviews, loadingList: false })
        } catch (error) {
          if (!listGuard.isCurrent(ticket)) return
          set({ loadingList: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
      select: async (reviewId) => {
        if (reviewId === null) {
          selectGuard.invalidate()
          set({ selectedId: null, selected: null, loadingSelected: false })
          return
        }
        if (get().deciding) return
        const ticket = selectGuard.start()
        set({ selectedId: reviewId, selected: null, loadingSelected: true, error: null })
        try {
          const selected = await unwrap(window.eclipseHub.codeChangeReviews.get(projectId, reviewId))
          if (!selectGuard.isCurrent(ticket)) return
          set({ selected, loadingSelected: false })
        } catch (error) {
          if (!selectGuard.isCurrent(ticket)) return
          set({ loadingSelected: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
      approve: async () => {
        if (readOnly || get().deciding || get().loadingList) return null
        const current = get().selected
        if (!current) return null
        const ticket = beginDecision()
        try {
          const updated = await unwrap(window.eclipseHub.codeChangeReviews.approve(projectId, current.reviewId))
          if (!decisionGuard.isCurrent(ticket)) return null
          applyDecisionResult(updated)
          return updated
        } catch (error) {
          if (!decisionGuard.isCurrent(ticket)) return null
          set({ deciding: false, error: error instanceof Error ? error.message : String(error) })
          return null
        }
      },
      requestChanges: async (feedback) => {
        if (readOnly || get().deciding || get().loadingList) return null
        const current = get().selected
        if (!current) return null
        const ticket = beginDecision()
        try {
          const updated = await unwrap(window.eclipseHub.codeChangeReviews.requestChanges(projectId, current.reviewId, feedback))
          if (!decisionGuard.isCurrent(ticket)) return null
          applyDecisionResult(updated)
          return updated
        } catch (error) {
          if (!decisionGuard.isCurrent(ticket)) return null
          set({ deciding: false, error: error instanceof Error ? error.message : String(error) })
          return null
        }
      },
      dispose: () => {
        listGuard.invalidate()
        selectGuard.invalidate()
        decisionGuard.invalidate()
      }
    }
  })
}

/** Whether the Approve action should currently be offered - PENDING only, never read-only/archived. */
export function canApproveReview(review: Pick<CodeChangeReviewProjection, 'state'> | null, readOnly: boolean): boolean {
  return review !== null && review.state === 'PENDING' && !readOnly
}

/** Whether the Request Changes action should currently be offered - PENDING or APPROVED (revokes approval), never CHANGES_REQUESTED (already decided) or read-only/archived. */
export function canRequestChanges(review: Pick<CodeChangeReviewProjection, 'state'> | null, readOnly: boolean): boolean {
  return review !== null && (review.state === 'PENDING' || review.state === 'APPROVED') && !readOnly
}
