import { create } from 'zustand'
import type {
  ContinuationSnapshot,
  GenerateContinuationPromptInput,
  GenerateContinuationPromptResult,
  Project,
  Session
} from '@shared/types'
import { unwrap } from '../api/client'
import { LatestRequestGuard } from '../utils/requestGuard'

// Je ein Guard pro asynchronem Ladevorgang, analog dem Muster in
// ProjectDetailShell.tsx: ein reiner ID-Vergleich reicht bei A -> B -> A
// nicht aus (beide A-Anfragen tragen dieselbe ID), ein monoton steigendes
// Ticket schon.
const sessionsGuard = new LatestRequestGuard()
const snapshotsGuard = new LatestRequestGuard()
const continuationPromptGuard = new LatestRequestGuard()

interface AppState {
  projects: Project[]
  showArchived: boolean
  activeProjectId: number | null
  activeView: 'project' | 'settings'
  loadError: string | null
  isLoading: boolean

  sessions: Session[]
  selectedSessionId: number | null
  sessionsLoading: boolean
  sessionsError: string | null

  continuationSnapshots: ContinuationSnapshot[]
  selectedSnapshotId: number | null
  snapshotsLoading: boolean
  snapshotsError: string | null

  // Ausschliesslich Laufzeitzustand des offenen Renderer-Prozesses - nie
  // persistiert, siehe Store-Definition unten (kein persist()-Middleware).
  continuationPrompt: GenerateContinuationPromptResult | null
  continuationPromptLoading: boolean
  continuationPromptError: string | null

  loadProjects: () => Promise<void>
  setShowArchived: (show: boolean) => void
  selectProject: (id: number) => void
  openSettings: () => void
  refreshActiveProjectIfNeeded: (id: number) => Promise<void>

  loadSessions: (projectId: number) => Promise<void>
  selectSession: (sessionId: number | null) => void
  loadContinuationSnapshots: (projectId: number, sessionId: number) => Promise<void>
  selectContinuationSnapshot: (snapshotId: number | null) => void
  generateContinuationPrompt: (input: GenerateContinuationPromptInput) => Promise<void>
}

/** Sitzungsabhaengiger Zustand (Snapshots + Prompt) - wird bei jedem Sitzungswechsel vollstaendig geleert. */
const EMPTY_SESSION_DEPENDENT_STATE = {
  continuationSnapshots: [] as ContinuationSnapshot[],
  selectedSnapshotId: null,
  snapshotsLoading: false,
  snapshotsError: null,
  continuationPrompt: null,
  continuationPromptLoading: false,
  continuationPromptError: null
} as const

/** Projektabhaengiger Zustand (Sitzungen + alles Sitzungsabhaengige) - wird bei jedem Projektwechsel vollstaendig geleert. */
const EMPTY_PROJECT_DEPENDENT_STATE = {
  sessions: [] as Session[],
  selectedSessionId: null,
  sessionsLoading: false,
  sessionsError: null,
  ...EMPTY_SESSION_DEPENDENT_STATE
} as const

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  showArchived: false,
  activeProjectId: null,
  activeView: 'project',
  loadError: null,
  isLoading: false,

  sessions: [],
  selectedSessionId: null,
  sessionsLoading: false,
  sessionsError: null,

  continuationSnapshots: [],
  selectedSnapshotId: null,
  snapshotsLoading: false,
  snapshotsError: null,

  continuationPrompt: null,
  continuationPromptLoading: false,
  continuationPromptError: null,

  // Laedt IMMER die vollstaendige Liste (aktiv + archiviert). `showArchived`
  // ist dadurch ein reiner Anzeige-Filter in der Sidebar und beeinflusst
  // nicht mehr, welche Daten vom Main-Prozess geladen werden - so zeigt der
  // Archiv-Zaehler von Anfang an die korrekte Zahl, ohne dass vorher
  // umgeschaltet werden muss, und ohne eine zusaetzliche separate
  // Zaehl-Abfrage einzufuehren.
  loadProjects: async () => {
    set({ isLoading: true, loadError: null })
    try {
      const projects = await unwrap(window.eclipseHub.projects.list(true))
      set({ projects, isLoading: false })

      const currentActive = get().activeProjectId
      if (currentActive === null && projects.length > 0) {
        set({ activeProjectId: projects[0].id, activeView: 'project' })
      } else if (currentActive !== null && !projects.some((project) => project.id === currentActive)) {
        // Das bisher aktive Projekt kommt in der frisch geladenen Liste
        // nicht mehr vor (z. B. geloescht) - jeder darauf aufbauende
        // Sitzungs-/Snapshot-/Prompt-Zustand ist damit ungueltig und wird
        // wie bei einem echten Projektwechsel entwertet.
        sessionsGuard.invalidate()
        snapshotsGuard.invalidate()
        continuationPromptGuard.invalidate()
        set({
          activeProjectId: projects.length > 0 ? projects[0].id : null,
          activeView: 'project',
          ...EMPTY_PROJECT_DEPENDENT_STATE
        })
      }
    } catch (error) {
      set({ isLoading: false, loadError: error instanceof Error ? error.message : String(error) })
    }
  },

  // Reiner Anzeige-Filter - loest bewusst KEIN erneutes Laden aus, da die
  // Sidebar bereits die vollstaendige Liste besitzt und lokal filtert.
  setShowArchived: (show) => set({ showArchived: show }),

  // Ein erneutes Auswaehlen desselben Projekts bleibt ein reiner
  // Ansichtswechsel und darf bereits geladene Sitzungs-/Snapshot-Daten
  // nicht verwerfen. Nur ein tatsaechlicher Projektwechsel entwertet alle
  // laufenden Anfragen und leert den kompletten projektabhaengigen Zustand
  // - sonst koennte die verspaetete Antwort einer Sitzungsliste aus Projekt
  // A im Store von Projekt B landen.
  selectProject: (id) => {
    if (get().activeProjectId === id) {
      set({ activeView: 'project' })
      return
    }
    sessionsGuard.invalidate()
    snapshotsGuard.invalidate()
    continuationPromptGuard.invalidate()
    set({ activeProjectId: id, activeView: 'project', ...EMPTY_PROJECT_DEPENDENT_STATE })
  },

  openSettings: () => set({ activeView: 'settings' }),

  refreshActiveProjectIfNeeded: async (id) => {
    if (get().activeProjectId === id) {
      await get().loadProjects()
    }
  },

  loadSessions: async (projectId) => {
    const ticket = sessionsGuard.start()
    set({ sessionsLoading: true, sessionsError: null })
    try {
      const sessions = await unwrap(window.eclipseHub.sessions.list(projectId))
      if (!sessionsGuard.isCurrent(ticket) || get().activeProjectId !== projectId) return
      set({ sessions, sessionsLoading: false })
    } catch (error) {
      if (!sessionsGuard.isCurrent(ticket) || get().activeProjectId !== projectId) return
      set({ sessionsLoading: false, sessionsError: error instanceof Error ? error.message : String(error) })
    }
  },

  // Kein automatisches Nachladen der Snapshots hier - das bleibt Sache des
  // Aufrufers, analog dazu, dass selectProject() ebenfalls keine Sitzungen
  // nachlaedt.
  selectSession: (sessionId) => {
    if (get().selectedSessionId === sessionId) return
    snapshotsGuard.invalidate()
    continuationPromptGuard.invalidate()
    set({ selectedSessionId: sessionId, ...EMPTY_SESSION_DEPENDENT_STATE })
  },

  loadContinuationSnapshots: async (projectId, sessionId) => {
    const ticket = snapshotsGuard.start()
    set({ snapshotsLoading: true, snapshotsError: null })
    try {
      const continuationSnapshots = await unwrap(window.eclipseHub.snapshots.list(projectId, sessionId))
      if (!snapshotsGuard.isCurrent(ticket) || get().selectedSessionId !== sessionId) return

      const currentSelectedSnapshotId = get().selectedSnapshotId
      const selectionStillValid =
        currentSelectedSnapshotId !== null &&
        continuationSnapshots.some((snapshot) => snapshot.id === currentSelectedSnapshotId)

      if (selectionStillValid) {
        set({ continuationSnapshots, snapshotsLoading: false })
      } else {
        // Die bisherige Auswahl kommt in der frisch geladenen Liste nicht
        // mehr vor - ein daraus erzeugter Prompt waere keinem Snapshot mehr
        // zuordenbar und wird deshalb mit entwertet.
        continuationPromptGuard.invalidate()
        set({
          continuationSnapshots,
          snapshotsLoading: false,
          selectedSnapshotId: null,
          continuationPrompt: null,
          continuationPromptLoading: false,
          continuationPromptError: null
        })
      }
    } catch (error) {
      if (!snapshotsGuard.isCurrent(ticket) || get().selectedSessionId !== sessionId) return
      set({ snapshotsLoading: false, snapshotsError: error instanceof Error ? error.message : String(error) })
    }
  },

  selectContinuationSnapshot: (snapshotId) => {
    if (get().selectedSnapshotId === snapshotId) return
    continuationPromptGuard.invalidate()
    set({
      selectedSnapshotId: snapshotId,
      continuationPrompt: null,
      continuationPromptLoading: false,
      continuationPromptError: null
    })
  },

  generateContinuationPrompt: async (input) => {
    const ticket = continuationPromptGuard.start()
    set({ continuationPromptLoading: true, continuationPromptError: null })
    try {
      const continuationPrompt = await unwrap(window.eclipseHub.prompts.generateContinuation(input))
      if (
        !continuationPromptGuard.isCurrent(ticket) ||
        get().selectedSessionId !== input.sessionId ||
        get().selectedSnapshotId !== input.snapshotId
      ) {
        return
      }
      set({ continuationPrompt, continuationPromptLoading: false })
    } catch (error) {
      if (
        !continuationPromptGuard.isCurrent(ticket) ||
        get().selectedSessionId !== input.sessionId ||
        get().selectedSnapshotId !== input.snapshotId
      ) {
        return
      }
      set({
        continuationPromptLoading: false,
        continuationPromptError: error instanceof Error ? error.message : String(error)
      })
    }
  }
}))
