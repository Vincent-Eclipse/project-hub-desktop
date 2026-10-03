import { createStore } from 'zustand/vanilla'
import type { CreateTaskInput, Task, TaskStatus, UpdateTaskInput } from '@shared/types'
import { unwrap } from '../api/client'
import { LatestRequestGuard } from '../utils/requestGuard'

interface TaskState {
  tasks: Task[]
  loading: boolean
  saving: boolean
  error: string | null
  load: () => Promise<void>
  create: (input: Omit<CreateTaskInput, 'projectId'>) => Promise<Task | null>
  updateDetails: (input: Omit<UpdateTaskInput, 'id' | 'projectId'> & { id: number }) => Promise<Task | null>
  updateStatus: (id: number, status: TaskStatus) => Promise<Task | null>
  updateDependencies: (id: number, dependsOnTaskIds: number[]) => Promise<Task | null>
  dispose: () => void
}

// Jedes gemountete Projekt besitzt seinen eigenen Store - eine veraltete
// IPC-Antwort kann daher nie ein anderes Projekt erreichen (analog
// rulesStore.ts). `projectId` wird NIE aus einem Aufruferparameter
// uebernommen - jede Mutation sendet ausschliesslich das fest an diesen
// Store gebundene `projectId` (siehe Fix 1: Main verifiziert Task-Zugehoerigkeit
// zusaetzlich serverseitig, aber der Renderer soll erst gar keine
// abweichende ID anbieten koennen).
//
// `loads` schuetzt Listenladevorgaenge, `mutations` schuetzt Erstellen/Aendern.
// Eine Mutation invalidiert dabei IMMER einen zu diesem Zeitpunkt noch
// ausstehenden Ladevorgang (siehe Fix 2): ohne das koennte ein AELTERER,
// noch laufender load() nach einer bereits abgeschlossenen, NEUEREN Mutation
// aufloesen und deren frischeren Task-Zustand mit veralteten Daten
// ueberschreiben - die beiden Generation-Zaehler waren zuvor faelschlich als
// bereits ausreichend dokumentiert, obwohl sie komplett unabhaengig liefen.
// Waehrend eine Mutation laeuft (`saving`), startet load() ausserdem gar
// nicht erst neu - der zuletzt bestaetigte Mutations-Zustand bleibt dadurch
// immer die alleinige Quelle der Wahrheit.
export function createTaskStore(projectId: number, readOnly: boolean) {
  const loads = new LatestRequestGuard()
  const mutations = new LatestRequestGuard()

  function replaceTask(tasks: Task[], updated: Task): Task[] {
    return tasks.map((task) => (task.id === updated.id ? updated : task))
  }

  return createStore<TaskState>((set, get) => {
    /** Vor jeder Mutation aufrufen: verwirft einen noch ausstehenden load() und haelt `loading` konsistent. */
    function beginMutation(): number {
      loads.invalidate()
      const ticket = mutations.start()
      set({ saving: true, error: null, loading: false })
      return ticket
    }

    return {
      tasks: [],
      loading: true,
      saving: false,
      error: null,
      load: async () => {
        if (get().saving) return
        const ticket = loads.start()
        set({ loading: true, error: null })
        try {
          const tasks = await unwrap(window.eclipseHub.tasks.list(projectId))
          if (!loads.isCurrent(ticket)) return
          set({ tasks, loading: false })
        } catch (error) {
          if (!loads.isCurrent(ticket)) return
          set({ loading: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
      create: async (input) => {
        if (readOnly || get().saving) return null
        const ticket = beginMutation()
        try {
          const task = await unwrap(window.eclipseHub.tasks.create({ ...input, projectId }))
          if (!mutations.isCurrent(ticket)) return null
          set({ tasks: [...get().tasks, task], saving: false })
          return task
        } catch (error) {
          if (!mutations.isCurrent(ticket)) return null
          set({ saving: false, error: error instanceof Error ? error.message : String(error) })
          return null
        }
      },
      updateDetails: async (input) => {
        if (readOnly || get().saving) return null
        const ticket = beginMutation()
        try {
          const task = await unwrap(window.eclipseHub.tasks.update({ ...input, projectId }))
          if (!mutations.isCurrent(ticket)) return null
          set({ tasks: replaceTask(get().tasks, task), saving: false })
          return task
        } catch (error) {
          if (!mutations.isCurrent(ticket)) return null
          set({ saving: false, error: error instanceof Error ? error.message : String(error) })
          return null
        }
      },
      updateStatus: async (id, status) => {
        if (readOnly || get().saving) return null
        const ticket = beginMutation()
        try {
          const task = await unwrap(window.eclipseHub.tasks.updateStatus({ id, status, projectId }))
          if (!mutations.isCurrent(ticket)) return null
          set({ tasks: replaceTask(get().tasks, task), saving: false })
          return task
        } catch (error) {
          if (!mutations.isCurrent(ticket)) return null
          set({ saving: false, error: error instanceof Error ? error.message : String(error) })
          return null
        }
      },
      updateDependencies: async (id, dependsOnTaskIds) => {
        if (readOnly || get().saving) return null
        const ticket = beginMutation()
        try {
          const task = await unwrap(window.eclipseHub.tasks.updateDependencies({ id, dependsOnTaskIds, projectId }))
          if (!mutations.isCurrent(ticket)) return null
          set({ tasks: replaceTask(get().tasks, task), saving: false })
          return task
        } catch (error) {
          if (!mutations.isCurrent(ticket)) return null
          set({ saving: false, error: error instanceof Error ? error.message : String(error) })
          return null
        }
      },
      dispose: () => {
        loads.invalidate()
        mutations.invalidate()
      }
    }
  })
}
