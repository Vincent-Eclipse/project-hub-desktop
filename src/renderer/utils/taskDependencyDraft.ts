import type { Task } from '@shared/types'

// Isolierte, reine Zustandsuebergangs-Entscheidung fuer den lokalen
// Abhaengigkeits-Entwurf in TaskDetail (TasksTab.tsx). Kein React-Import,
// daher ohne Rendering testbar.
//
// Hintergrund (ChatGPT-Review Fix 3): TaskDetail synchronisierte den
// lokalen Abhaengigkeits-Entwurf bisher direkt aus der OBJEKT-IDENTITAET der
// gesamten Task (`useEffect(() => { setDependsOn(task.dependsOnTaskIds) },
// [task])`). Der Task-Store ersetzt das Task-Objekt in der Liste bei JEDER
// Mutation (auch bei einer voellig unabhaengigen Status- oder Detail-
// Aenderung), nicht nur bei einer tatsaechlichen Abhaengigkeits-Aenderung -
// dadurch wurden unveroeffentlichte lokale Checkbox-Auswahlen kommentarlos
// verworfen, sobald z. B. der Status geaendert wurde. Diese Funktion
// vergleicht stattdessen den tatsaechlich ZULETZT SYNCHRONISIERTEN
// persistierten Abhaengigkeits-SATZ (nicht die Objektidentitaet) mit dem neu
// empfangenen - nur eine echte Aenderung des persistierten Satzes darf den
// lokalen Entwurf ueberschreiben.
export interface TaskDependencyDraftState {
  taskId: number
  /** Der zuletzt bekannte, tatsaechlich persistierte Abhaengigkeits-Satz. */
  persistedDependsOnTaskIds: number[]
  /** Der aktuell im UI bearbeitete (moeglicherweise noch ungespeicherte) Entwurf. */
  draftDependsOnTaskIds: number[]
}

/** Zwei ID-Listen gelten als gleich, wenn sie - unabhaengig von Reihenfolge und Duplikaten - dieselbe Menge beschreiben. */
export function sameDependencySet(a: readonly number[], b: readonly number[]): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size !== setB.size) return false
  for (const id of setA) {
    if (!setB.has(id)) return false
  }
  return true
}

export function initialTaskDependencyDraftState(task: Pick<Task, 'id' | 'dependsOnTaskIds'>): TaskDependencyDraftState {
  return {
    taskId: task.id,
    persistedDependsOnTaskIds: task.dependsOnTaskIds,
    draftDependsOnTaskIds: task.dependsOnTaskIds
  }
}

/**
 * Berechnet den naechsten Entwurfszustand, wenn eine (moeglicherweise neue)
 * Task-Objektreferenz eintrifft:
 *
 * - Andere Task-ID (Wechsel der ausgewaehlten Aufgabe, oder Erstmontage):
 *   Entwurf wird auf den persistierten Satz DIESER Aufgabe zurueckgesetzt.
 * - Gleiche Task-ID, persistierter Satz UNVERAENDERT gegenueber dem zuletzt
 *   synchronisierten Stand: der lokale Entwurf bleibt UNBERUEHRT (deckt exakt
 *   den gemeldeten Fehlerfall ab - eine unabhaengige Status-/Detail-Aenderung
 *   ersetzt zwar das Task-Objekt, aendert aber nicht dependsOnTaskIds).
 * - Gleiche Task-ID, persistierter Satz TATSAECHLICH veraendert (z. B. nach
 *   einem erfolgreichen Abhaengigkeits-Save oder einer externen Aenderung):
 *   Entwurf wird auf den neuen persistierten Satz resynchronisiert - ein
 *   erfolgreicher Save "gewinnt" also korrekt gegenueber dem alten Entwurf.
 */
export function nextTaskDependencyDraftState(
  previous: TaskDependencyDraftState,
  task: Pick<Task, 'id' | 'dependsOnTaskIds'>
): TaskDependencyDraftState {
  if (previous.taskId !== task.id) {
    return initialTaskDependencyDraftState(task)
  }
  if (sameDependencySet(previous.persistedDependsOnTaskIds, task.dependsOnTaskIds)) {
    return previous
  }
  return initialTaskDependencyDraftState(task)
}
