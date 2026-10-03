import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ContinuationSnapshot,
  GenerateContinuationPromptInput,
  GenerateContinuationPromptResult,
  IpcResult,
  Project,
  Session
} from '@shared/types'
import { useAppStore } from './store'

// Vitest laeuft fuer diese Datei in der Node-Umgebung (siehe
// vitest.config.ts, kein jsdom) - `window` existiert dort nicht von sich
// aus. Ein einfaches Objekt auf globalThis reicht als Ersatz, da store.ts
// ausschliesslich window.eclipseHub.<methode>(...) aufruft - kein Zugriff
// auf weitere Browser-APIs.
function installEclipseHubMock() {
  const projectsList = vi.fn()
  const sessionsList = vi.fn()
  const snapshotsList = vi.fn()
  const generateContinuation = vi.fn()
  ;(globalThis as unknown as { window: unknown }).window = {
    eclipseHub: {
      projects: { list: projectsList },
      sessions: { list: sessionsList },
      snapshots: { list: snapshotsList },
      prompts: { generateContinuation }
    }
  }
  return { projectsList, sessionsList, snapshotsList, generateContinuation }
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fail(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } }
}

/** Liefert ein Promise plus dessen resolve/reject, um den Abschlusszeitpunkt in Race-Tests gezielt zu steuern. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'Projekt',
    slug: 'projekt',
    projectType: 'Typ',
    description: '',
    folderPath: null,
    folderComparisonKey: null,
    status: 'ACTIVE',
    nextActor: 'NONE',
    currentStep: '',
    nextAction: '',
    isArchived: false,
    archivedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    currentContextVersionId: null,
    currentContextVersionNumber: null,
    ...overrides
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    projectId: 1,
    provider: 'CHATGPT',
    title: '',
    status: 'ACTIVE',
    currentTask: '',
    masterContextVersionId: null,
    predecessorSessionId: null,
    basedOnSnapshotId: null,
    notes: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    completedAt: null,
    ...overrides
  }
}

function makeSnapshot(overrides: Partial<ContinuationSnapshot> = {}): ContinuationSnapshot {
  return {
    id: 1,
    projectId: 1,
    sessionId: 1,
    versionNumber: 1,
    provider: 'CHATGPT',
    masterContextVersionId: null,
    currentTask: '',
    confirmedDone: [],
    confirmedOpen: [],
    blockers: [],
    lastCompleteSection: '',
    missingSections: [],
    nextExactStep: '',
    additionalHumanAction: '',
    reasonCode: 'OTHER',
    confirmationState: 'CONFIRMED',
    derivedFromSnapshotId: null,
    createdBy: 'LEON',
    createdAt: '2024-01-01T00:00:00.000Z',
    requiredFiles: [],
    ...overrides
  }
}

function makePromptResult(overrides: Partial<GenerateContinuationPromptResult> = {}): GenerateContinuationPromptResult {
  return {
    provider: 'CHATGPT',
    promptText: '## 1. Projekt und Provider\nProjekt: X\nProvider: CHATGPT',
    generatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('loadSessions', () => {
  it('laedt Sitzungen erfolgreich und beendet sessionsLoading', async () => {
    const { sessionsList } = installEclipseHubMock()
    sessionsList.mockResolvedValue(ok([makeSession({ id: 1 })]))
    useAppStore.setState({ activeProjectId: 1 })

    await useAppStore.getState().loadSessions(1)

    expect(sessionsList).toHaveBeenCalledWith(1)
    const state = useAppStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual([1])
    expect(state.sessionsLoading).toBe(false)
    expect(state.sessionsError).toBeNull()
  })

  it('speichert einen Sitzungsfehler sicher und beendet sessionsLoading', async () => {
    const { sessionsList } = installEclipseHubMock()
    sessionsList.mockResolvedValue(fail('INTERNAL_ERROR', 'Ein interner Fehler ist aufgetreten.'))
    useAppStore.setState({ activeProjectId: 1 })

    await useAppStore.getState().loadSessions(1)

    const state = useAppStore.getState()
    expect(state.sessions).toEqual([])
    expect(state.sessionsLoading).toBe(false)
    expect(state.sessionsError).toBe('Ein interner Fehler ist aufgetreten.')
  })

  it('ignoriert eine verspaetete Sitzungsantwort, nachdem zwischenzeitlich ein anderes Projekt aktiv wurde', async () => {
    const { sessionsList } = installEclipseHubMock()
    const first = deferred<IpcResult<Session[]>>()
    sessionsList.mockReturnValueOnce(first.promise)
    useAppStore.setState({ activeProjectId: 1 })

    const pending = useAppStore.getState().loadSessions(1)
    useAppStore.getState().selectProject(2)
    first.resolve(ok([makeSession({ id: 99, projectId: 1 })]))
    await pending

    const state = useAppStore.getState()
    expect(state.activeProjectId).toBe(2)
    expect(state.sessions).toEqual([])
    expect(state.sessionsLoading).toBe(false)
  })

  it('setzt bei A -> B -> A ausschliesslich das Ergebnis der zuletzt gestarteten Anfrage durch', async () => {
    const { sessionsList } = installEclipseHubMock()
    const firstCall = deferred<IpcResult<Session[]>>()
    const secondCall = deferred<IpcResult<Session[]>>()
    sessionsList.mockReturnValueOnce(firstCall.promise).mockReturnValueOnce(secondCall.promise)
    useAppStore.setState({ activeProjectId: 1 })

    const pendingFirst = useAppStore.getState().loadSessions(1)
    const pendingSecond = useAppStore.getState().loadSessions(1)
    firstCall.resolve(ok([makeSession({ id: 1 })]))
    secondCall.resolve(ok([makeSession({ id: 2 })]))
    await Promise.all([pendingFirst, pendingSecond])

    expect(useAppStore.getState().sessions.map((s) => s.id)).toEqual([2])
  })
})

describe('loadProjects - Reset bei nicht mehr vorhandenem aktivem Projekt', () => {
  it('entfernt saemtlichen projektabhaengigen Zustand, wenn das aktive Projekt nach dem Laden fehlt, und waehlt ein Ersatzprojekt', async () => {
    const { projectsList } = installEclipseHubMock()
    projectsList.mockResolvedValue(ok([makeProject({ id: 2 })]))
    useAppStore.setState({
      activeProjectId: 1,
      sessions: [makeSession({ id: 1 })],
      selectedSessionId: 1,
      sessionsLoading: true,
      sessionsError: 'alter Fehler',
      continuationSnapshots: [makeSnapshot({ id: 1 })],
      selectedSnapshotId: 1,
      snapshotsLoading: true,
      snapshotsError: 'alter Snapshotfehler',
      continuationPrompt: makePromptResult(),
      continuationPromptLoading: true,
      continuationPromptError: 'alter Promptfehler'
    })

    await useAppStore.getState().loadProjects()

    const state = useAppStore.getState()
    expect(state.activeProjectId).toBe(2)
    expect(state.activeView).toBe('project')
    expect(state.sessions).toEqual([])
    expect(state.selectedSessionId).toBeNull()
    expect(state.sessionsLoading).toBe(false)
    expect(state.sessionsError).toBeNull()
    expect(state.continuationSnapshots).toEqual([])
    expect(state.selectedSnapshotId).toBeNull()
    expect(state.snapshotsLoading).toBe(false)
    expect(state.snapshotsError).toBeNull()
    expect(state.continuationPrompt).toBeNull()
    expect(state.continuationPromptLoading).toBe(false)
    expect(state.continuationPromptError).toBeNull()
  })

  it('setzt activeProjectId auf null, wenn das aktive Projekt fehlt und die Projektliste leer ist', async () => {
    const { projectsList } = installEclipseHubMock()
    projectsList.mockResolvedValue(ok([]))
    useAppStore.setState({
      activeProjectId: 1,
      sessions: [makeSession({ id: 1 })],
      selectedSessionId: 1,
      continuationSnapshots: [makeSnapshot({ id: 1 })],
      selectedSnapshotId: 1,
      continuationPrompt: makePromptResult()
    })

    await useAppStore.getState().loadProjects()

    const state = useAppStore.getState()
    expect(state.activeProjectId).toBeNull()
    expect(state.sessions).toEqual([])
    expect(state.selectedSessionId).toBeNull()
    expect(state.continuationSnapshots).toEqual([])
    expect(state.selectedSnapshotId).toBeNull()
    expect(state.continuationPrompt).toBeNull()
  })

  it('behaelt Session-, Snapshot- und Promptdaten, wenn das aktive Projekt weiterhin vorhanden ist', async () => {
    const { projectsList } = installEclipseHubMock()
    projectsList.mockResolvedValue(ok([makeProject({ id: 1 }), makeProject({ id: 2 })]))
    const prompt = makePromptResult()
    useAppStore.setState({
      activeProjectId: 1,
      sessions: [makeSession({ id: 5 })],
      selectedSessionId: 5,
      continuationSnapshots: [makeSnapshot({ id: 7 })],
      selectedSnapshotId: 7,
      continuationPrompt: prompt
    })

    await useAppStore.getState().loadProjects()

    const state = useAppStore.getState()
    expect(state.activeProjectId).toBe(1)
    expect(state.sessions.map((s) => s.id)).toEqual([5])
    expect(state.selectedSessionId).toBe(5)
    expect(state.continuationSnapshots.map((s) => s.id)).toEqual([7])
    expect(state.selectedSnapshotId).toBe(7)
    expect(state.continuationPrompt).toEqual(prompt)
  })

  it('eine vor dem Projektreset gestartete verspaetete Sessionantwort ueberschreibt den neu zugeordneten Projektzustand nicht', async () => {
    const { projectsList, sessionsList } = installEclipseHubMock()
    const deferredSessions = deferred<IpcResult<Session[]>>()
    sessionsList.mockReturnValueOnce(deferredSessions.promise)
    useAppStore.setState({ activeProjectId: 1 })

    const pendingSessions = useAppStore.getState().loadSessions(1)

    projectsList.mockResolvedValue(ok([makeProject({ id: 2 })]))
    await useAppStore.getState().loadProjects()

    deferredSessions.resolve(ok([makeSession({ id: 99, projectId: 1 })]))
    await pendingSessions

    const state = useAppStore.getState()
    expect(state.activeProjectId).toBe(2)
    expect(state.sessions).toEqual([])
    expect(state.sessionsLoading).toBe(false)
  })
})

describe('selectProject', () => {
  it('behaelt geladene Sitzungsdaten, wenn dasselbe Projekt erneut ausgewaehlt wird', () => {
    useAppStore.setState({ activeProjectId: 1, sessions: [makeSession({ id: 1 })], selectedSessionId: 1 })

    useAppStore.getState().selectProject(1)

    const state = useAppStore.getState()
    expect(state.sessions).toHaveLength(1)
    expect(state.selectedSessionId).toBe(1)
  })

  it('entfernt bei einem tatsaechlichen Projektwechsel saemtliche Session-, Snapshot- und Promptdaten', () => {
    useAppStore.setState({
      activeProjectId: 1,
      sessions: [makeSession({ id: 1 })],
      selectedSessionId: 1,
      sessionsLoading: true,
      sessionsError: 'alter Fehler',
      continuationSnapshots: [makeSnapshot({ id: 1 })],
      selectedSnapshotId: 1,
      snapshotsLoading: true,
      snapshotsError: 'alter Snapshotfehler',
      continuationPrompt: makePromptResult(),
      continuationPromptLoading: true,
      continuationPromptError: 'alter Promptfehler'
    })

    useAppStore.getState().selectProject(2)

    const state = useAppStore.getState()
    expect(state.activeProjectId).toBe(2)
    expect(state.sessions).toEqual([])
    expect(state.selectedSessionId).toBeNull()
    expect(state.sessionsLoading).toBe(false)
    expect(state.sessionsError).toBeNull()
    expect(state.continuationSnapshots).toEqual([])
    expect(state.selectedSnapshotId).toBeNull()
    expect(state.snapshotsLoading).toBe(false)
    expect(state.snapshotsError).toBeNull()
    expect(state.continuationPrompt).toBeNull()
    expect(state.continuationPromptLoading).toBe(false)
    expect(state.continuationPromptError).toBeNull()
  })
})

describe('selectSession', () => {
  it('leert Snapshot- und Promptzustand bei einem Sitzungswechsel', () => {
    useAppStore.setState({
      selectedSessionId: 1,
      continuationSnapshots: [makeSnapshot({ id: 5 })],
      selectedSnapshotId: 5,
      snapshotsLoading: true,
      snapshotsError: 'alter Fehler',
      continuationPrompt: makePromptResult(),
      continuationPromptLoading: true,
      continuationPromptError: 'alter Promptfehler'
    })

    useAppStore.getState().selectSession(2)

    const state = useAppStore.getState()
    expect(state.selectedSessionId).toBe(2)
    expect(state.continuationSnapshots).toEqual([])
    expect(state.selectedSnapshotId).toBeNull()
    expect(state.snapshotsLoading).toBe(false)
    expect(state.snapshotsError).toBeNull()
    expect(state.continuationPrompt).toBeNull()
    expect(state.continuationPromptLoading).toBe(false)
    expect(state.continuationPromptError).toBeNull()
  })

  it('leert bei Auswahl von null den sitzungsabhaengigen Zustand vollstaendig', () => {
    useAppStore.setState({
      selectedSessionId: 1,
      continuationSnapshots: [makeSnapshot()],
      selectedSnapshotId: 1,
      snapshotsLoading: true,
      continuationPrompt: makePromptResult(),
      continuationPromptLoading: true
    })

    useAppStore.getState().selectSession(null)

    const state = useAppStore.getState()
    expect(state.selectedSessionId).toBeNull()
    expect(state.continuationSnapshots).toEqual([])
    expect(state.selectedSnapshotId).toBeNull()
    expect(state.snapshotsLoading).toBe(false)
    expect(state.continuationPrompt).toBeNull()
    expect(state.continuationPromptLoading).toBe(false)
  })
})

describe('loadContinuationSnapshots', () => {
  it('laedt Snapshots fuer die angegebene Sitzung', async () => {
    const { snapshotsList } = installEclipseHubMock()
    snapshotsList.mockResolvedValue(ok([makeSnapshot({ id: 1 })]))
    useAppStore.setState({ activeProjectId: 7, selectedSessionId: 3 })

    await useAppStore.getState().loadContinuationSnapshots(7, 3)

    expect(snapshotsList).toHaveBeenCalledWith(7, 3)
    const state = useAppStore.getState()
    expect(state.continuationSnapshots.map((s) => s.id)).toEqual([1])
    expect(state.snapshotsLoading).toBe(false)
    expect(state.snapshotsError).toBeNull()
  })

  it('ignoriert eine verspaetete Snapshotantwort einer vorher ausgewaehlten Sitzung', async () => {
    const { snapshotsList } = installEclipseHubMock()
    const first = deferred<IpcResult<ContinuationSnapshot[]>>()
    snapshotsList.mockReturnValueOnce(first.promise)
    useAppStore.setState({ activeProjectId: 1, selectedSessionId: 1 })

    const pending = useAppStore.getState().loadContinuationSnapshots(1, 1)
    useAppStore.getState().selectSession(2)
    first.resolve(ok([makeSnapshot({ id: 1, sessionId: 1 })]))
    await pending

    const state = useAppStore.getState()
    expect(state.selectedSessionId).toBe(2)
    expect(state.continuationSnapshots).toEqual([])
    expect(state.snapshotsLoading).toBe(false)
  })

  it('setzt eine nicht mehr vorhandene selectedSnapshotId nach erfolgreichem Laden auf null und leert den Prompt', async () => {
    const { snapshotsList } = installEclipseHubMock()
    snapshotsList.mockResolvedValue(ok([makeSnapshot({ id: 2 })]))
    useAppStore.setState({
      activeProjectId: 1,
      selectedSessionId: 1,
      selectedSnapshotId: 1,
      continuationPrompt: makePromptResult()
    })

    await useAppStore.getState().loadContinuationSnapshots(1, 1)

    const state = useAppStore.getState()
    expect(state.continuationSnapshots.map((s) => s.id)).toEqual([2])
    expect(state.selectedSnapshotId).toBeNull()
    expect(state.continuationPrompt).toBeNull()
  })

  it('behaelt eine weiterhin vorhandene selectedSnapshotId nach erfolgreichem Laden', async () => {
    const { snapshotsList } = installEclipseHubMock()
    snapshotsList.mockResolvedValue(ok([makeSnapshot({ id: 1 }), makeSnapshot({ id: 2 })]))
    useAppStore.setState({ activeProjectId: 1, selectedSessionId: 1, selectedSnapshotId: 2 })

    await useAppStore.getState().loadContinuationSnapshots(1, 1)

    expect(useAppStore.getState().selectedSnapshotId).toBe(2)
  })
})

describe('selectContinuationSnapshot', () => {
  it('leert den bisherigen Prompt bei einem Snapshotwechsel', () => {
    useAppStore.setState({
      selectedSnapshotId: 1,
      continuationPrompt: makePromptResult(),
      continuationPromptLoading: true,
      continuationPromptError: 'alter Fehler'
    })

    useAppStore.getState().selectContinuationSnapshot(2)

    const state = useAppStore.getState()
    expect(state.selectedSnapshotId).toBe(2)
    expect(state.continuationPrompt).toBeNull()
    expect(state.continuationPromptLoading).toBe(false)
    expect(state.continuationPromptError).toBeNull()
  })
})

describe('generateContinuationPrompt', () => {
  it('erzeugt einen Prompt erfolgreich, reicht den Input unveraendert weiter und speichert das Ergebnis unveraendert', async () => {
    const { generateContinuation } = installEclipseHubMock()
    const result = makePromptResult({ promptText: 'Exakter Prompttext ohne Veraenderung' })
    generateContinuation.mockResolvedValue(ok(result))
    useAppStore.setState({ selectedSessionId: 1, selectedSnapshotId: 2 })
    const input: GenerateContinuationPromptInput = { sessionId: 1, snapshotId: 2, provider: 'CHATGPT' }

    await useAppStore.getState().generateContinuationPrompt(input)

    // toBe (nicht nur toEqual) auf dem Eingabeobjekt: belegt, dass keine
    // Kopie/Transformation stattfindet, sondern exakt dieselbe Referenz an
    // die Preload-Bruecke weitergereicht wird.
    expect(generateContinuation).toHaveBeenCalledTimes(1)
    expect(generateContinuation.mock.calls[0][0]).toBe(input)

    const state = useAppStore.getState()
    expect(state.continuationPrompt).toEqual(result)
    expect(state.continuationPrompt?.promptText).toBe(result.promptText)
    expect(state.continuationPromptLoading).toBe(false)
    expect(state.continuationPromptError).toBeNull()
  })

  it('setzt bei einem Promptfehler eine sichere Fehlermeldung und beendet Loading', async () => {
    const { generateContinuation } = installEclipseHubMock()
    generateContinuation.mockResolvedValue(
      fail('PROMPT_TOO_LARGE', 'Der erzeugte Prompt ueberschreitet die maximale Laenge.')
    )
    useAppStore.setState({ selectedSessionId: 1, selectedSnapshotId: 2 })

    await useAppStore.getState().generateContinuationPrompt({ sessionId: 1, snapshotId: 2, provider: 'CHATGPT' })

    const state = useAppStore.getState()
    expect(state.continuationPromptLoading).toBe(false)
    expect(state.continuationPromptError).toBe('Der erzeugte Prompt ueberschreitet die maximale Laenge.')
    expect(state.continuationPrompt).toBeNull()
  })

  it('ignoriert einen verspaeteten Prompt eines inzwischen abgewaehlten Snapshots', async () => {
    const { generateContinuation } = installEclipseHubMock()
    const first = deferred<IpcResult<GenerateContinuationPromptResult>>()
    generateContinuation.mockReturnValueOnce(first.promise)
    useAppStore.setState({ selectedSessionId: 1, selectedSnapshotId: 1 })

    const pending = useAppStore.getState().generateContinuationPrompt({ sessionId: 1, snapshotId: 1, provider: 'CHATGPT' })
    useAppStore.getState().selectContinuationSnapshot(2)
    first.resolve(ok(makePromptResult({ promptText: 'veraltet' })))
    await pending

    const state = useAppStore.getState()
    expect(state.selectedSnapshotId).toBe(2)
    expect(state.continuationPrompt).toBeNull()
    expect(state.continuationPromptLoading).toBe(false)
  })
})
