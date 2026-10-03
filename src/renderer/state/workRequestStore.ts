import { createStore } from 'zustand/vanilla'
import type { WorkRequestDetail, WorkRequestStatus, WorkRequestSummary } from '@shared/types'
import { unwrap } from '../api/client'
import { LatestRequestGuard } from '../utils/requestGuard'

interface WorkRequestState {
  workRequests: WorkRequestSummary[]
  selectedId: number | null
  selected: WorkRequestDetail | null
  loadingList: boolean
  loadingSelected: boolean
  saving: boolean
  error: string | null
  loadList: () => Promise<void>
  select: (id: number | null) => Promise<void>
  create: (intentMarkdown: string) => Promise<WorkRequestDetail | null>
  updateIntent: (intentMarkdown: string) => Promise<WorkRequestDetail | null>
  resolveDecision: (decisionId: number, optionKey: string) => Promise<WorkRequestDetail | null>
  dispose: () => void
}

// ChatGPT-Re-Review Fix 3: die Liste transportiert bewusst nur die schlanke
// WorkRequestSummary (siehe shared/types.ts) - create/updateIntent/
// resolveDecision liefern weiterhin die vollstaendige WorkRequestDetail
// zurueck (fuer `selected`), werden aber ueber diesen einen kleinen Helfer
// auf eine Summary projiziert, bevor sie in `workRequests` geschrieben
// werden. Kein generisches DTO-Mapping-Framework - eine Funktion, ein Zweck.
function toSummary(detail: WorkRequestDetail): WorkRequestSummary {
  return {
    id: detail.id,
    projectId: detail.projectId,
    title: detail.title,
    status: detail.status,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt
  }
}

// ChatGPT-Re-Review Fix 1 (v4): mirrors workRequestService.assertIntentEditable
// exactly - status alone is not the rule, because Main-internal
// setWorkRequestStatus() can force a status back to IDEA after planning. The
// service remains the sole authority (this only controls whether the UI
// OFFERS the "Bearbeiten" control; the server independently re-checks and
// rejects on updateIntent regardless of what the client sends).
export function canEditWorkRequestIntent(request: WorkRequestDetail, readOnly: boolean): boolean {
  return request.status === 'IDEA' && request.planMarkdown === null && request.decisions.length === 0 && !readOnly
}

// ChatGPT-Re-Review Fix 5 (v4): before the first planning pass, whether
// decisions will even be needed is genuinely unknown - "Keine Entscheidungen
// erforderlich." would be an unsupported claim at that point. Only once a
// plan exists with zero decisions is that statement actually true. Returns
// null once decisions exist (the populated-decision rendering already
// handles that case and shows no empty-state text).
export function decisionsEmptyStateMessage(
  request: Pick<WorkRequestDetail, 'planMarkdown' | 'decisions'>
): string | null {
  if (request.decisions.length > 0) return null
  return request.planMarkdown === null ? 'Noch keine Entscheidungen vorhanden.' : 'Keine Entscheidungen erforderlich.'
}

// ChatGPT-Re-Review Fix 3 (v4): mirrors listWorkRequestsForProject()'s SQL
// ordering exactly ("(status IN ('DONE','CANCELLED')) ASC, updated_at DESC")
// plus a deterministic id tie-breaker for equal timestamps, which SQLite's
// ORDER BY does not otherwise guarantee. applyMutationResult() previously
// replaced an entry in place WITHOUT re-sorting, so a mutation that changed
// updated_at (e.g. resolving a decision, editing the intent) left the local
// list order stale until the next full loadList(). This is a small local
// helper, not a generic sort/priority framework.
const TERMINAL_STATUSES: ReadonlySet<WorkRequestStatus> = new Set(['DONE', 'CANCELLED'])

export function sortWorkRequestSummaries(list: readonly WorkRequestSummary[]): WorkRequestSummary[] {
  return [...list].sort((a, b) => {
    const aTerminal = TERMINAL_STATUSES.has(a.status) ? 1 : 0
    const bTerminal = TERMINAL_STATUSES.has(b.status) ? 1 : 0
    if (aTerminal !== bTerminal) return aTerminal - bTerminal
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    return a.id - b.id
  })
}

// Jedes gemountete Projekt besitzt seinen eigenen Store - eine veraltete
// IPC-Antwort kann daher nie ein anderes Projekt erreichen (analog
// taskStore.ts/rulesStore.ts). `projectId` wird NIE aus einem
// Aufruferparameter uebernommen - jede Mutation sendet ausschliesslich das
// fest an diesen Store gebundene `projectId` (Main verifiziert die
// Work-Request-Zugehoerigkeit zusaetzlich serverseitig).
//
// Drei getrennte Generation-Zaehler (list/select/mutation), nach denselben
// in Meilenstein 4.2 gehaerteten Regeln: eine Mutation invalidiert IMMER
// sowohl einen noch ausstehenden Listen- als auch Auswahl-Ladevorgang und
// haelt `loadingSelected` konsistent - ohne das koennte ein AELTERER, noch
// laufender select()/loadList() nach einer bereits abgeschlossenen NEUEREN
// Mutation aufloesen und deren frischeren Zustand mit veralteten Daten
// ueberschreiben. Waehrend eine Mutation laeuft (`saving`), starten
// loadList()/select() ausserdem gar nicht erst neu.
//
// ChatGPT-Re-Review Fix 1: umgekehrt gilt das Gleiche - eine Mutation darf
// NICHT beginnen, waehrend `loadingList` noch aussteht (z. B. der allererste
// Ladevorgang direkt nach dem Mounten). beginMutation() invalidiert zwar
// einen ausstehenden Listen-Ticket, setzt aber `loadingList` nie selbst
// zurueck - ein create() waehrend des ersten Ladevorgangs wuerde sonst mit
// einem noch leeren/unvollstaendigen `workRequests`-Array arbeiten, `create`
// wuerde erfolgreich sein, aber die (korrekt verworfene) veraltete
// Listenantwort haette die bereits existierenden Auftraege geliefert - die
// gehen dann unwiderruflich verloren, UND `loadingList` bliebe dauerhaft
// `true`. create()/updateIntent()/resolveDecision() lehnen deshalb jede
// Mutation ab, solange `loadingList` wahr ist.
export function createWorkRequestStore(projectId: number, readOnly: boolean) {
  const listGuard = new LatestRequestGuard()
  const selectGuard = new LatestRequestGuard()
  const mutationGuard = new LatestRequestGuard()

  return createStore<WorkRequestState>((set, get) => {
    function beginMutation(): number {
      listGuard.invalidate()
      selectGuard.invalidate()
      const ticket = mutationGuard.start()
      set({ saving: true, error: null, loadingSelected: false })
      return ticket
    }

    function applyMutationResult(updated: WorkRequestDetail): void {
      const summary = toSummary(updated)
      set({
        selected: updated,
        workRequests: sortWorkRequestSummaries(
          get().workRequests.map((workRequest) => (workRequest.id === summary.id ? summary : workRequest))
        ),
        saving: false
      })
    }

    return {
      workRequests: [],
      selectedId: null,
      selected: null,
      loadingList: true,
      loadingSelected: false,
      saving: false,
      error: null,
      loadList: async () => {
        if (get().saving) return
        const ticket = listGuard.start()
        set({ loadingList: true, error: null })
        try {
          const workRequests = await unwrap(window.eclipseHub.workRequests.list(projectId))
          if (!listGuard.isCurrent(ticket)) return
          set({ workRequests, loadingList: false })
        } catch (error) {
          if (!listGuard.isCurrent(ticket)) return
          set({ loadingList: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
      select: async (id) => {
        if (id === null) {
          selectGuard.invalidate()
          set({ selectedId: null, selected: null, loadingSelected: false })
          return
        }
        if (get().saving) return
        const ticket = selectGuard.start()
        set({ selectedId: id, selected: null, loadingSelected: true, error: null })
        try {
          const selected = await unwrap(window.eclipseHub.workRequests.get(projectId, id))
          if (!selectGuard.isCurrent(ticket)) return
          set({ selected, loadingSelected: false })
        } catch (error) {
          if (!selectGuard.isCurrent(ticket)) return
          set({ loadingSelected: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
      create: async (intentMarkdown) => {
        // ChatGPT re-review Fix 1: a mutation must not begin while the
        // initial/any list load is still pending. beginMutation() invalidates
        // a pending list ticket but never resolves `loadingList` itself - a
        // create() that raced ahead of the FIRST loadList() would succeed
        // using an empty/incomplete `workRequests` array, and the invalidated
        // stale response would then be correctly ignored, permanently
        // stranding `loadingList: true` AND silently losing whichever
        // already-existing Work Requests that first load would have
        // delivered. Refusing to mutate while `loadingList` is true removes
        // the race entirely instead of trying to reconcile two in-flight
        // sources of truth for the same array.
        //
        // ChatGPT-Re-Review Fix 4 (v4): create() must ALSO refuse to start
        // while `loadingSelected` is true. beginMutation() sets
        // `loadingSelected: false` unconditionally (it invalidates the
        // pending select ticket) - if create() were allowed to run
        // concurrently with a still-resolving select(id) and create()
        // subsequently FAILED, beginMutation() would already have discarded
        // the in-flight select ticket, so the eventual (now-stale, ignored)
        // select response could never restore `selected`. The store would be
        // left incoherent: `selectedId` still pointing at the original
        // request while `selected` stays null and `loadingSelected` false
        // forever, with no retry path. Refusing to start create() while a
        // selection is pending removes this race entirely instead of adding
        // retry machinery for M4.3.
        if (readOnly || get().saving || get().loadingList || get().loadingSelected) return null
        const ticket = beginMutation()
        try {
          const created = await unwrap(window.eclipseHub.workRequests.create({ projectId, intentMarkdown }))
          if (!mutationGuard.isCurrent(ticket)) return null
          set({
            workRequests: sortWorkRequestSummaries([toSummary(created), ...get().workRequests]),
            selectedId: created.id,
            selected: created,
            saving: false
          })
          return created
        } catch (error) {
          if (!mutationGuard.isCurrent(ticket)) return null
          set({ saving: false, error: error instanceof Error ? error.message : String(error) })
          return null
        }
      },
      updateIntent: async (intentMarkdown) => {
        if (readOnly || get().saving || get().loadingList) return null
        const current = get().selected
        if (!current) return null
        const ticket = beginMutation()
        try {
          const updated = await unwrap(
            window.eclipseHub.workRequests.updateIntent({ projectId, id: current.id, intentMarkdown })
          )
          if (!mutationGuard.isCurrent(ticket)) return null
          applyMutationResult(updated)
          return updated
        } catch (error) {
          if (!mutationGuard.isCurrent(ticket)) return null
          set({ saving: false, error: error instanceof Error ? error.message : String(error) })
          return null
        }
      },
      resolveDecision: async (decisionId, optionKey) => {
        if (readOnly || get().saving || get().loadingList) return null
        const current = get().selected
        if (!current) return null
        const ticket = beginMutation()
        try {
          const updated = await unwrap(
            window.eclipseHub.workRequests.resolveDecision({
              projectId,
              workRequestId: current.id,
              decisionId,
              optionKey
            })
          )
          if (!mutationGuard.isCurrent(ticket)) return null
          applyMutationResult(updated)
          return updated
        } catch (error) {
          if (!mutationGuard.isCurrent(ticket)) return null
          set({ saving: false, error: error instanceof Error ? error.message : String(error) })
          return null
        }
      },
      dispose: () => {
        listGuard.invalidate()
        selectGuard.invalidate()
        mutationGuard.invalidate()
      }
    }
  })
}
