import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import {
  ACTORS,
  TASK_BLOCKED_REASON_MAX_LENGTH,
  TASK_MARKDOWN_MAX_LENGTH,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TITLE_MAX_LENGTH,
  type Actor,
  type Project,
  type Task,
  type TaskPriority,
  type TaskStatus
} from '@shared/types'
import { createTaskStore } from '../../state/taskStore'
import { ACTOR_LABELS } from '../StatusBadge'
import {
  initialTaskDependencyDraftState,
  nextTaskDependencyDraftState,
  sameDependencySet
} from '../../utils/taskDependencyDraft'

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  BACKLOG: 'Backlog',
  PLANNED: 'Geplant',
  READY: 'Bereit',
  RUNNING: 'In Arbeit',
  NEEDS_REVIEW: 'Prüfung erforderlich',
  CHANGES_REQUESTED: 'Änderungen angefordert',
  BLOCKED: 'Blockiert',
  DONE: 'Erledigt'
}

const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  LOW: 'Niedrig',
  MEDIUM: 'Mittel',
  HIGH: 'Hoch',
  CRITICAL: 'Kritisch'
}

interface TaskDraft {
  title: string
  priority: TaskPriority
  goalMarkdown: string
  descriptionMarkdown: string
  acceptanceCriteriaMarkdown: string
  verificationRequirementsMarkdown: string
  blockedReason: string
  relevantFilesText: string
}

function draftFromTask(task: Task): TaskDraft {
  return {
    title: task.title,
    priority: task.priority,
    goalMarkdown: task.goalMarkdown,
    descriptionMarkdown: task.descriptionMarkdown,
    acceptanceCriteriaMarkdown: task.acceptanceCriteriaMarkdown,
    verificationRequirementsMarkdown: task.verificationRequirementsMarkdown,
    blockedReason: task.blockedReason,
    relevantFilesText: task.relevantFiles.join('\n')
  }
}

const EMPTY_DRAFT: TaskDraft = {
  title: '',
  priority: 'MEDIUM',
  goalMarkdown: '',
  descriptionMarkdown: '',
  acceptanceCriteriaMarkdown: '',
  verificationRequirementsMarkdown: '',
  blockedReason: '',
  relevantFilesText: ''
}

export function TasksTab({ project }: { project: Project }): JSX.Element {
  return <TasksEditor key={`${project.id}:${project.isArchived}`} project={project} />
}

function TasksEditor({ project }: { project: Project }): JSX.Element {
  const [store] = useState(() => createTaskStore(project.id, project.isArchived))
  const { tasks, loading, saving, error, load, create, updateDetails, updateStatus, updateDependencies, dispose } =
    useStore(store)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [newDraft, setNewDraft] = useState<TaskDraft>(EMPTY_DRAFT)
  const [newCreatedBy, setNewCreatedBy] = useState<Actor>('LEON')

  useEffect(() => {
    void load()
    return dispose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, dispose])

  const selectedTask = tasks.find((t) => t.id === selectedId) ?? null

  async function handleCreate(): Promise<void> {
    const title = newDraft.title.trim()
    if (title.length === 0) return
    const created = await create({
      title,
      priority: newDraft.priority,
      goalMarkdown: newDraft.goalMarkdown,
      descriptionMarkdown: newDraft.descriptionMarkdown,
      acceptanceCriteriaMarkdown: newDraft.acceptanceCriteriaMarkdown,
      verificationRequirementsMarkdown: newDraft.verificationRequirementsMarkdown,
      blockedReason: newDraft.blockedReason,
      relevantFiles: splitRelevantFiles(newDraft.relevantFilesText),
      createdBy: newCreatedBy
    })
    if (created) {
      setCreating(false)
      setNewDraft(EMPTY_DRAFT)
      setSelectedId(created.id)
    }
  }

  if (loading) return <div className="text-muted">Lädt…</div>

  return (
    <div className="two-column">
      <div style={{ flex: 1, minWidth: 260 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h4 style={{ margin: 0 }}>Aufgaben</h4>
          {!project.isArchived && !creating && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                setCreating(true)
                setSelectedId(null)
                setNewDraft(EMPTY_DRAFT)
              }}
            >
              Neue Aufgabe
            </button>
          )}
        </div>
        {project.isArchived && <div className="banner">Archiviertes Projekt: Aufgaben sind schreibgeschützt.</div>}
        {error && <div className="banner banner-danger">{error}</div>}
        <div className="stack" style={{ gap: 6 }}>
          {tasks.map((task) => (
            <button
              key={task.id}
              disabled={saving}
              className={`card card-interactive${selectedId === task.id ? ' card-active' : ''}`}
              onClick={() => {
                setCreating(false)
                setSelectedId(task.id)
              }}
              style={{ padding: 10, textAlign: 'left' }}
            >
              <div className="row" style={{ gap: 6, justifyContent: 'space-between' }}>
                <strong style={{ wordBreak: 'break-word' }}>{task.title}</strong>
              </div>
              <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                {TASK_STATUS_LABELS[task.status]} · {TASK_PRIORITY_LABELS[task.priority]}
              </div>
            </button>
          ))}
          {tasks.length === 0 && !creating && <div className="text-sm text-muted">Noch keine Aufgaben.</div>}
        </div>
      </div>
      <div style={{ flex: 2, minWidth: 0 }}>
        {creating && (
          <TaskForm
            key="new"
            draft={newDraft}
            setDraft={setNewDraft}
            disabled={saving}
            title="Neue Aufgabe"
            onCancel={() => setCreating(false)}
            onSave={() => void handleCreate()}
            saveLabel={saving ? 'Erstellt…' : 'Aufgabe erstellen'}
            extra={
              <label className="text-sm text-muted row" style={{ gap: 6 }}>
                Ersteller
                <select value={newCreatedBy} onChange={(e) => setNewCreatedBy(e.target.value as Actor)} disabled={saving}>
                  {ACTORS.map((actor) => (
                    <option key={actor} value={actor}>
                      {ACTOR_LABELS[actor]}
                    </option>
                  ))}
                </select>
              </label>
            }
          />
        )}
        {!creating && selectedTask && (
          <TaskDetail
            key={selectedTask.id}
            task={selectedTask}
            allTasks={tasks}
            readOnly={project.isArchived}
            saving={saving}
            onSaveDetails={(input) => updateDetails({ id: selectedTask.id, ...input })}
            onChangeStatus={(status) => updateStatus(selectedTask.id, status)}
            onChangeDependencies={(ids) => updateDependencies(selectedTask.id, ids)}
          />
        )}
        {!creating && !selectedTask && (
          <div className="text-sm text-muted">Aufgabe aus der Liste auswählen oder eine neue anlegen.</div>
        )}
      </div>
    </div>
  )
}

function splitRelevantFiles(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function TaskForm({
  draft,
  setDraft,
  disabled,
  title,
  onCancel,
  onSave,
  saveLabel,
  extra
}: {
  draft: TaskDraft
  setDraft: (updater: (prev: TaskDraft) => TaskDraft) => void
  disabled: boolean
  title: string
  onCancel: () => void
  onSave: () => void
  saveLabel: string
  extra?: JSX.Element
}): JSX.Element {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <h4 style={{ margin: 0 }}>{title}</h4>
      <label className="stack" style={{ gap: 4 }}>
        <span className="text-sm text-muted">Titel</span>
        <input
          value={draft.title}
          maxLength={TASK_TITLE_MAX_LENGTH}
          onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
          disabled={disabled}
        />
      </label>
      <label className="stack" style={{ gap: 4 }}>
        <span className="text-sm text-muted">Priorität</span>
        <select
          value={draft.priority}
          onChange={(e) => setDraft((prev) => ({ ...prev, priority: e.target.value as TaskPriority }))}
          disabled={disabled}
        >
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {TASK_PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      {extra}
      <label className="stack" style={{ gap: 4 }}>
        <span className="text-sm text-muted">Ziel</span>
        <textarea
          value={draft.goalMarkdown}
          maxLength={TASK_MARKDOWN_MAX_LENGTH}
          rows={3}
          className="textarea-code"
          onChange={(e) => setDraft((prev) => ({ ...prev, goalMarkdown: e.target.value }))}
          disabled={disabled}
        />
      </label>
      <label className="stack" style={{ gap: 4 }}>
        <span className="text-sm text-muted">Beschreibung</span>
        <textarea
          value={draft.descriptionMarkdown}
          maxLength={TASK_MARKDOWN_MAX_LENGTH}
          rows={5}
          className="textarea-code"
          onChange={(e) => setDraft((prev) => ({ ...prev, descriptionMarkdown: e.target.value }))}
          disabled={disabled}
        />
      </label>
      <label className="stack" style={{ gap: 4 }}>
        <span className="text-sm text-muted">Abnahmekriterien</span>
        <textarea
          value={draft.acceptanceCriteriaMarkdown}
          maxLength={TASK_MARKDOWN_MAX_LENGTH}
          rows={4}
          className="textarea-code"
          onChange={(e) => setDraft((prev) => ({ ...prev, acceptanceCriteriaMarkdown: e.target.value }))}
          disabled={disabled}
        />
      </label>
      <label className="stack" style={{ gap: 4 }}>
        <span className="text-sm text-muted">Verifikationsanforderungen</span>
        <textarea
          value={draft.verificationRequirementsMarkdown}
          maxLength={TASK_MARKDOWN_MAX_LENGTH}
          rows={4}
          className="textarea-code"
          onChange={(e) => setDraft((prev) => ({ ...prev, verificationRequirementsMarkdown: e.target.value }))}
          disabled={disabled}
        />
      </label>
      <label className="stack" style={{ gap: 4 }}>
        <span className="text-sm text-muted">
          Relevante Dateien (eine je Zeile, projektrelativ - reine Metadaten, kein Dateizugriff)
        </span>
        <textarea
          value={draft.relevantFilesText}
          rows={3}
          className="textarea-code"
          placeholder="src/main/services/example.ts"
          onChange={(e) => setDraft((prev) => ({ ...prev, relevantFilesText: e.target.value }))}
          disabled={disabled}
        />
      </label>
      <label className="stack" style={{ gap: 4 }}>
        <span className="text-sm text-muted">Blockiert-Grund (falls zutreffend)</span>
        <textarea
          value={draft.blockedReason}
          maxLength={TASK_BLOCKED_REASON_MAX_LENGTH}
          rows={2}
          className="textarea-code"
          onChange={(e) => setDraft((prev) => ({ ...prev, blockedReason: e.target.value }))}
          disabled={disabled}
        />
      </label>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={disabled || draft.title.trim().length === 0} onClick={onSave}>
          {saveLabel}
        </button>
        <button className="btn btn-secondary btn-sm" disabled={disabled} onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </div>
  )
}

function TaskDetail({
  task,
  allTasks,
  readOnly,
  saving,
  onSaveDetails,
  onChangeStatus,
  onChangeDependencies
}: {
  task: Task
  allTasks: Task[]
  readOnly: boolean
  saving: boolean
  onSaveDetails: (input: Omit<TaskDraft, 'relevantFilesText'> & { relevantFiles: string[] }) => Promise<Task | null>
  onChangeStatus: (status: TaskStatus) => Promise<Task | null>
  onChangeDependencies: (ids: number[]) => Promise<Task | null>
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<TaskDraft>(() => draftFromTask(task))
  // Getrennt vom obigen `draft`/`editing`-Zustand gehalten (siehe
  // taskDependencyDraft.ts): der Abhaengigkeits-Entwurf darf NICHT jedes Mal
  // zurueckgesetzt werden, wenn sich die Task-Objektreferenz aendert - nur
  // wenn sich der tatsaechlich PERSISTIERTE Abhaengigkeits-Satz aendert
  // (ChatGPT-Review Fix 3: eine unabhaengige Status-/Detail-Aenderung darf
  // eine noch ungespeicherte Checkbox-Auswahl nicht verwerfen).
  const [depState, setDepState] = useState(() => initialTaskDependencyDraftState(task))
  const dependsOn = depState.draftDependsOnTaskIds

  const candidateDependencies = useMemo(
    () => allTasks.filter((t) => t.id !== task.id && !wouldCreateCycle(allTasks, task.id, t.id)),
    [allTasks, task.id]
  )

  useEffect(() => {
    setDraft(draftFromTask(task))
    setEditing(false)
  }, [task])

  useEffect(() => {
    setDepState((previous) => nextTaskDependencyDraftState(previous, task))
  }, [task])

  async function handleSave(): Promise<void> {
    const title = draft.title.trim()
    if (title.length === 0) return
    const saved = await onSaveDetails({
      title,
      priority: draft.priority,
      goalMarkdown: draft.goalMarkdown,
      descriptionMarkdown: draft.descriptionMarkdown,
      acceptanceCriteriaMarkdown: draft.acceptanceCriteriaMarkdown,
      verificationRequirementsMarkdown: draft.verificationRequirementsMarkdown,
      blockedReason: draft.blockedReason,
      relevantFiles: splitRelevantFiles(draft.relevantFilesText)
    })
    if (saved) setEditing(false)
  }

  function toggleDependency(id: number): void {
    setDepState((prev) => ({
      ...prev,
      draftDependsOnTaskIds: prev.draftDependsOnTaskIds.includes(id)
        ? prev.draftDependsOnTaskIds.filter((x) => x !== id)
        : [...prev.draftDependsOnTaskIds, id]
    }))
  }

  const dependenciesChanged = !sameDependencySet(depState.draftDependsOnTaskIds, depState.persistedDependsOnTaskIds)

  if (editing && !readOnly) {
    return (
      <TaskForm
        draft={draft}
        setDraft={setDraft}
        disabled={saving}
        title={`Aufgabe bearbeiten: ${task.title}`}
        onCancel={() => {
          setDraft(draftFromTask(task))
          setEditing(false)
        }}
        onSave={() => void handleSave()}
        saveLabel={saving ? 'Speichert…' : 'Speichern'}
      />
    )
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h4 style={{ margin: 0, wordBreak: 'break-word' }}>{task.title}</h4>
        {!readOnly && (
          <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            Bearbeiten
          </button>
        )}
      </div>
      <div className="row wrap" style={{ gap: 12 }}>
        <label className="row text-sm" style={{ gap: 6 }}>
          Status
          <select
            value={task.status}
            disabled={readOnly || saving}
            onChange={(e) => void onChangeStatus(e.target.value as TaskStatus)}
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <span className="chip chip-outline">Priorität: {TASK_PRIORITY_LABELS[task.priority]}</span>
      </div>
      <div className="text-xs text-muted">
        Erstellt von {ACTOR_LABELS[task.createdBy]} am {task.createdAt} · zuletzt geändert am {task.updatedAt}
      </div>

      <Field label="Ziel" value={task.goalMarkdown} />
      <Field label="Beschreibung" value={task.descriptionMarkdown} />
      <Field label="Abnahmekriterien" value={task.acceptanceCriteriaMarkdown} />
      <Field label="Verifikationsanforderungen" value={task.verificationRequirementsMarkdown} />

      <div>
        <div className="text-sm text-muted" style={{ marginBottom: 4 }}>
          Relevante Dateien (Metadaten, kein Dateizugriff)
        </div>
        {task.relevantFiles.length === 0 && <div className="text-sm text-muted">Keine hinterlegt.</div>}
        {task.relevantFiles.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {task.relevantFiles.map((path) => (
              <li key={path} className="text-sm" style={{ fontFamily: 'monospace' }}>
                {path}
              </li>
            ))}
          </ul>
        )}
      </div>

      {task.status === 'BLOCKED' && <Field label="Blockiert-Grund" value={task.blockedReason} />}

      <div>
        <div className="text-sm text-muted" style={{ marginBottom: 4 }}>
          Abhängigkeiten (Planungs-Metadaten, kein Ausführungs-Gate)
        </div>
        {allTasks.length <= 1 && <div className="text-sm text-muted">Keine anderen Aufgaben im Projekt.</div>}
        {allTasks.length > 1 && (
          <div className="stack" style={{ gap: 4 }}>
            {allTasks
              .filter((t) => t.id !== task.id)
              .map((t) => (
                <label key={t.id} className="row text-sm" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={dependsOn.includes(t.id)}
                    disabled={readOnly || saving || (!dependsOn.includes(t.id) && !candidateDependencies.some((c) => c.id === t.id))}
                    onChange={() => toggleDependency(t.id)}
                  />
                  {t.title}
                </label>
              ))}
            {!readOnly && (
              <button
                className="btn btn-secondary btn-sm"
                style={{ alignSelf: 'flex-start' }}
                disabled={saving || !dependenciesChanged}
                onClick={() => void onChangeDependencies(dependsOn)}
              >
                {saving ? 'Speichert…' : 'Abhängigkeiten speichern'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-sm text-muted" style={{ marginBottom: 4 }}>
        {label}
      </div>
      {value.trim().length === 0 ? (
        <div className="text-sm text-muted">–</div>
      ) : (
        <textarea readOnly value={value} rows={Math.min(10, Math.max(2, value.split('\n').length))} className="textarea-code" />
      )}
    </div>
  )
}

/** Rein clientseitige UX-Vorabpruefung (keine Sicherheitsgrenze) - der Service prueft Zyklen serverseitig erneut verbindlich. */
function wouldCreateCycle(allTasks: Task[], taskId: number, candidateId: number): boolean {
  const adjacency = new Map<number, number[]>(allTasks.map((t) => [t.id, t.dependsOnTaskIds]))
  const visited = new Set<number>()
  const stack = [candidateId]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === taskId) return true
    if (visited.has(current)) continue
    visited.add(current)
    for (const next of adjacency.get(current) ?? []) stack.push(next)
  }
  return false
}
