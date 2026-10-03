import type { Task } from '@shared/types'
import { LatestRequestGuard } from '../../utils/requestGuard'

// ChatGPT-Re-Review Fix 2 (v4): WorkTab durfte fuer die Anzeige der wenigen
// mit einem Work Request verknuepften internen Aufgaben-Titel bisher NICHT
// den kompletten Task-Backlog des Projekts laden (tasks:list ueberträgt
// jeden Task und loest fuer jeden Task Abhaengigkeiten auf, wiederholt bei
// JEDER Aenderung des vollstaendigen WorkRequestDetail-Objekts, auch wenn
// nur eine Entscheidung aufgeloest wurde und taskIds unveraendert blieb).
// Stattdessen wird die bereits bestehende M4.2-IPC tasks:get gezielt fuer
// genau die verknuepften IDs aufgerufen - keine neue IPC, keine generische
// Cache-Schicht, kein geteilter taskStore.

/**
 * Kleine stabile Signatur aus projectId + geordneten taskIds - als
 * useEffect-Abhaengigkeit in WorkTab.tsx verwendet, damit ein Refetch NUR
 * ausgeloest wird, wenn sich die verknuepfte Menge/Reihenfolge tatsaechlich
 * aendert, nicht bei jeder Aenderung von Plan/Status/Entscheidungen.
 */
export function linkedTaskFetchSignature(projectId: number, taskIds: readonly number[]): string {
  return `${projectId}:${taskIds.join(',')}`
}

export type GetTask = (projectId: number, taskId: number) => Promise<Task>

/**
 * Loest genau die uebergebenen Task-IDs auf (nie den Backlog). Ein einzelner
 * fehlschlagender Task (z. B. zwischenzeitlich geloescht) darf weder das
 * Laden der uebrigen verknuepften Tasks verhindern noch den Aufrufer werfen
 * lassen - er fehlt einfach im Ergebnis, sodass WorkTab.tsx's bestehendes
 * "Aufgabe #ID"-Fallback greift. Ein fehlschlagender Task loescht nie einen
 * bereits erfolgreich geladenen anderen Task aus dem Ergebnis.
 */
export async function fetchLinkedTasksById(
  projectId: number,
  taskIds: readonly number[],
  getTask: GetTask
): Promise<Record<number, Task>> {
  const entries = await Promise.all(
    taskIds.map(async (taskId): Promise<readonly [number, Task | null]> => {
      try {
        return [taskId, await getTask(projectId, taskId)]
      } catch {
        return [taskId, null]
      }
    })
  )
  const byId: Record<number, Task> = {}
  for (const [taskId, task] of entries) {
    if (task) byId[taskId] = task
  }
  return byId
}

/**
 * Schuetzt vor veralteten Ergebnissen, wenn die Auswahl schneller wechselt
 * als eine laufende Aufloesung antwortet (analog LatestRequestGuard in
 * workRequestStore.ts/taskStore.ts) - lokal fuer WorkTab's Anzeige
 * verknuepfter Tasks statt eines geteilten taskStore-Caches.
 */
export function createLinkedTaskLoader(getTask: GetTask) {
  const guard = new LatestRequestGuard()
  return {
    load: async (
      projectId: number,
      taskIds: readonly number[],
      onResult: (byId: Record<number, Task>) => void
    ): Promise<void> => {
      const ticket = guard.start()
      const byId = await fetchLinkedTasksById(projectId, taskIds, getTask)
      if (!guard.isCurrent(ticket)) return
      onResult(byId)
    },
    dispose: (): void => {
      guard.invalidate()
    }
  }
}
