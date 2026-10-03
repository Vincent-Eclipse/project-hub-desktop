import { createStore } from 'zustand/vanilla'
import type { CreateRuleVersionInput, DiffLine, ProjectRuleVersion } from '@shared/types'
import { unwrap } from '../api/client'
import { LatestRequestGuard } from '../utils/requestGuard'

interface RulesState {
  versions: ProjectRuleVersion[]
  diffLines: DiffLine[] | null
  loading: boolean
  saving: boolean
  error: string | null
  load: () => Promise<void>
  save: (input: Omit<CreateRuleVersionInput, 'projectId'>) => Promise<boolean>
  showDiff: (fromVersionId: number, toVersionId: number) => Promise<void>
  clearDiff: () => void
  dispose: () => void
}

// Each mounted project owns its state; late IPC responses cannot reach another project.
export function createRulesStore(projectId: number, readOnly: boolean) {
  const requests = new LatestRequestGuard()
  const diffs = new LatestRequestGuard()
  return createStore<RulesState>((set, get) => ({
    versions: [], diffLines: null, loading: true, saving: false, error: null,
    load: async () => {
      const ticket = requests.start()
      set({ loading: true, error: null })
      try {
        const versions = await unwrap(window.eclipseHub.rules.listVersions(projectId))
        if (!requests.isCurrent(ticket)) return
        set({ versions, loading: false })
      } catch (error) {
        if (!requests.isCurrent(ticket)) return
        set({ loading: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
    save: async (input) => {
      if (readOnly || get().saving || get().loading) return false
      const ticket = requests.start()
      set({ saving: true, error: null })
      try {
        const version = await unwrap(window.eclipseHub.rules.createVersion({ ...input, projectId }))
        if (!requests.isCurrent(ticket)) return false
        diffs.invalidate()
        set({ versions: [version, ...get().versions], saving: false, diffLines: null })
        return true
      } catch (error) {
        if (!requests.isCurrent(ticket)) return false
        set({ saving: false, error: error instanceof Error ? error.message : String(error) })
        return false
      }
    },
    showDiff: async (fromVersionId, toVersionId) => {
      const ticket = diffs.start()
      set({ diffLines: null, error: null })
      try {
        const diffLines = await unwrap(window.eclipseHub.rules.diff(projectId, fromVersionId, toVersionId))
        if (!diffs.isCurrent(ticket)) return
        set({ diffLines })
      } catch (error) {
        if (!diffs.isCurrent(ticket)) return
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    },
    clearDiff: () => {
      diffs.invalidate()
      set({ diffLines: null })
    },
    dispose: () => {
      requests.invalidate()
      diffs.invalidate()
    }
  }))
}
