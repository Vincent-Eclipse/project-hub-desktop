import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import {
  WORK_REQUEST_INTENT_MAX_LENGTH,
  type Project,
  type Task,
  type WorkDecisionStatus,
  type WorkRequestDetail,
  type WorkRequestStatus
} from '@shared/types'
import { unwrap } from '../../api/client'
import { canEditWorkRequestIntent, createWorkRequestStore, decisionsEmptyStateMessage } from '../../state/workRequestStore'
import { formatWorkTimestamp } from '../../utils/timestampFormat'
import { createLinkedTaskLoader, linkedTaskFetchSignature } from './linkedTasks'
import { CodeChangeReviewPanel } from './CodeChangeReview'

const WORK_REQUEST_STATUS_LABELS: Record<WorkRequestStatus, string> = {
  IDEA: 'Idee',
  PLANNING: 'In Planung',
  NEEDS_DECISION: 'Entscheidung erforderlich',
  READY: 'Bereit',
  EXECUTING: 'Wird bearbeitet',
  REVIEWING: 'Wird geprüft',
  CHANGES_REQUIRED: 'Änderungen erforderlich',
  READY_FOR_APPROVAL: 'Bereit zur Freigabe',
  DONE: 'Erledigt',
  BLOCKED: 'Blockiert',
  PAUSED: 'Pausiert',
  CANCELLED: 'Abgebrochen'
}

const DECISION_STATUS_LABELS: Record<WorkDecisionStatus, string> = {
  OPEN: 'Offen',
  RESOLVED: 'Entschieden',
  CANCELLED: 'Abgebrochen'
}

function WorkTimestamp({ iso, className }: { iso: string; className?: string }): JSX.Element {
  return (
    <time dateTime={iso} title={iso} className={className}>
      {formatWorkTimestamp(iso)}
    </time>
  )
}

export function WorkTab({ project }: { project: Project }): JSX.Element {
  return <WorkEditor key={`${project.id}:${project.isArchived}`} project={project} />
}

function WorkEditor({ project }: { project: Project }): JSX.Element {
  const [store] = useState(() => createWorkRequestStore(project.id, project.isArchived))
  const {
    workRequests,
    selected,
    selectedId,
    loadingList,
    loadingSelected,
    saving,
    error,
    loadList,
    select,
    create,
    updateIntent,
    resolveDecision,
    dispose
  } = useStore(store)
  const [composerText, setComposerText] = useState('')
  // `saving` im Store gilt fuer JEDE Work-Mutation (create/updateIntent/
  // resolveDecision), nicht nur fuer diese Erstellung - der Button-Text
  // soll aber stabil bleiben, waehrend eine unverwandte Mutation laeuft,
  // statt faelschlich "Erstellt…" zu zeigen.
  const [isCreating, setIsCreating] = useState(false)
  const [linkedTasksById, setLinkedTasksById] = useState<Record<number, Task>>({})
  const [linkedTaskLoader] = useState(() =>
    createLinkedTaskLoader((projectId, taskId) => unwrap(window.eclipseHub.tasks.get(projectId, taskId)))
  )

  useEffect(() => {
    void loadList()
    return () => {
      linkedTaskLoader.dispose()
      dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadList, dispose, linkedTaskLoader])

  // ChatGPT-Re-Review Fix 2 (v4): interne Aufgaben sind reine Metadaten am
  // Work Request (taskIds) - statt des kompletten Task-Backlogs (tasks:list)
  // wird gezielt tasks:get (bereits bestehende M4.2-IPC) fuer genau die
  // verknuepften IDs aufgerufen. Die Abhaengigkeit ist eine kleine stabile
  // Signatur aus projectId + geordneten taskIds statt des gesamten
  // `selected`-Objekts, damit ein erneutes Aufloesen NICHT bei jeder
  // Plan-/Status-/Entscheidungsaenderung wiederholt wird, sondern nur, wenn
  // sich die verknuepfte Menge/Reihenfolge tatsaechlich aendert.
  const linkedTaskIds = selected?.taskIds ?? []
  const linkedTaskSignature = linkedTaskFetchSignature(project.id, linkedTaskIds)
  useEffect(() => {
    if (linkedTaskIds.length === 0) {
      setLinkedTasksById({})
      return
    }
    void linkedTaskLoader.load(project.id, linkedTaskIds, setLinkedTasksById)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedTaskSignature, linkedTaskLoader])

  async function handleCreate(): Promise<void> {
    const text = composerText.trim()
    if (text.length === 0) return
    setIsCreating(true)
    try {
      const created = await create(composerText)
      if (created) setComposerText('')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="work-layout">
      <div className="work-list-pane">
        {!project.isArchived && (
          <div className="stack" style={{ gap: 8, marginBottom: 20 }}>
            <label className="stack" style={{ gap: 4 }}>
              <strong>Was möchtest du machen?</strong>
              <span className="text-sm text-muted">
                {/* M4.4 automatisiert die Planungs-Rueckfrage noch nicht - Copy darf das nicht implizieren. */}
                Beschreibe, was gebaut oder geändert werden soll.
              </span>
              <textarea
                className="work-field"
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                maxLength={WORK_REQUEST_INTENT_MAX_LENGTH}
                rows={4}
                placeholder="z. B. „Ich möchte, dass Nutzer ihr Profilbild hochladen können.“"
                disabled={saving || loadingList}
              />
            </label>
            <button
              className="btn btn-primary"
              style={{ alignSelf: 'flex-start' }}
              // ChatGPT-Re-Review Fix 1: waehrend die Liste noch laedt (u. a.
              // direkt nach dem Mounten) darf keine Erstellung gestartet
              // werden - der Store lehnt das serverseitig ohnehin ab, das
              // deaktivierte Steuerelement macht es zusaetzlich sichtbar.
              // ChatGPT-Re-Review Fix 4 (v4): dasselbe gilt, waehrend eine
              // bestehende Auswahl noch laedt (`loadingSelected`) - nur das
              // ABSENDEN wird blockiert, das Tippen im Textfeld bleibt
              // erlaubt (siehe textarea oben, unveraendert).
              disabled={saving || loadingList || loadingSelected || composerText.trim().length === 0}
              onClick={() => void handleCreate()}
            >
              {isCreating ? 'Erstellt…' : 'Auftrag erstellen'}
            </button>
          </div>
        )}
        {project.isArchived && <div className="banner">Archiviertes Projekt: Aufträge sind schreibgeschützt.</div>}
        {error && <div className="banner banner-danger">{error}</div>}

        <h4 style={{ marginBottom: 8 }}>Aufträge</h4>
        {loadingList && <div className="text-muted">Lädt…</div>}
        {!loadingList && (
          <div className="stack" style={{ gap: 6 }}>
            {workRequests.map((workRequest) => (
              <button
                key={workRequest.id}
                className={`card card-interactive${selectedId === workRequest.id ? ' card-active' : ''}`}
                onClick={() => void select(workRequest.id)}
                style={{ padding: 10, textAlign: 'left' }}
              >
                <strong className="work-list-title" title={workRequest.title}>
                  {workRequest.title}
                </strong>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  {WORK_REQUEST_STATUS_LABELS[workRequest.status]} ·{' '}
                  <WorkTimestamp iso={workRequest.updatedAt} className="work-timestamp" />
                </div>
              </button>
            ))}
            {workRequests.length === 0 && <div className="text-sm text-muted">Noch keine Aufträge.</div>}
          </div>
        )}
      </div>
      <div className="work-detail-pane">
        {loadingSelected && <div className="text-muted">Lädt…</div>}
        {!loadingSelected && selected && (
          <WorkDetail
            key={selected.id}
            request={selected}
            projectId={project.id}
            linkedTasksById={linkedTasksById}
            readOnly={project.isArchived}
            saving={saving}
            onUpdateIntent={updateIntent}
            onResolveDecision={resolveDecision}
          />
        )}
        {!loadingSelected && !selected && (
          <div className="text-sm text-muted">Wähle einen Auftrag aus der Liste oder erstelle einen neuen.</div>
        )}
      </div>
    </div>
  )
}

function WorkDetail({
  request,
  projectId,
  linkedTasksById,
  readOnly,
  saving,
  onUpdateIntent,
  onResolveDecision
}: {
  request: WorkRequestDetail
  projectId: number
  linkedTasksById: Record<number, Task>
  readOnly: boolean
  saving: boolean
  onUpdateIntent: (intentMarkdown: string) => Promise<unknown>
  onResolveDecision: (decisionId: number, optionKey: string) => Promise<unknown>
}): JSX.Element {
  const [editingIntent, setEditingIntent] = useState(false)
  const [intentDraft, setIntentDraft] = useState(request.intentMarkdown)
  const canEditIntent = canEditWorkRequestIntent(request, readOnly)

  useEffect(() => {
    setIntentDraft(request.intentMarkdown)
    setEditingIntent(false)
  }, [request.id, request.intentMarkdown])

  async function handleSaveIntent(): Promise<void> {
    const text = intentDraft.trim()
    if (text.length === 0) return
    const result = await onUpdateIntent(intentDraft)
    if (result) setEditingIntent(false)
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
        <h3 className="work-detail-title">{request.title}</h3>
        <span className="chip chip-outline">{WORK_REQUEST_STATUS_LABELS[request.status]}</span>
      </div>
      <div className="text-muted">
        Zuletzt geändert am <WorkTimestamp iso={request.updatedAt} className="work-timestamp" />
      </div>

      <section className="stack" style={{ gap: 8 }}>
        <h4 style={{ margin: 0 }}>Deine Anforderung</h4>
        {!editingIntent && (
          <>
            <textarea readOnly value={request.intentMarkdown} rows={4} className="work-field work-readonly-text" />
            {canEditIntent && (
              <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setEditingIntent(true)}>
                Bearbeiten
              </button>
            )}
          </>
        )}
        {editingIntent && canEditIntent && (
          <>
            <textarea
              className="work-field"
              value={intentDraft}
              onChange={(e) => setIntentDraft(e.target.value)}
              maxLength={WORK_REQUEST_INTENT_MAX_LENGTH}
              rows={4}
              disabled={saving}
            />
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn btn-primary btn-sm"
                disabled={saving || intentDraft.trim().length === 0}
                onClick={() => void handleSaveIntent()}
              >
                {saving ? 'Speichert…' : 'Speichern'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={saving}
                onClick={() => {
                  setIntentDraft(request.intentMarkdown)
                  setEditingIntent(false)
                }}
              >
                Abbrechen
              </button>
            </div>
          </>
        )}
      </section>

      <section className="stack" style={{ gap: 8 }}>
        <h4 style={{ margin: 0 }}>Plan</h4>
        {!request.planMarkdown && <div className="text-sm text-muted">Plan wurde noch nicht erstellt.</div>}
        {request.planMarkdown && (
          <textarea readOnly value={request.planMarkdown} rows={6} className="work-field work-readonly-text" />
        )}
      </section>

      <section className="stack" style={{ gap: 8 }}>
        <h4 style={{ margin: 0 }}>Entscheidungen</h4>
        {/* ChatGPT-Re-Review Fix 5 (v4): vor der ersten Planung ist NICHT
            bekannt, ob Entscheidungen noetig sein werden - "Keine
            Entscheidungen erforderlich." waere eine unbegruendete Behauptung.
            Erst nach einer Planung ohne Entscheidungen (planMarkdown gesetzt,
            decisions leer) ist diese Aussage tatsaechlich bekannt. */}
        {decisionsEmptyStateMessage(request) && (
          <div className="text-sm text-muted">{decisionsEmptyStateMessage(request)}</div>
        )}
        {request.decisions.map((decision) => (
          <div key={decision.id} className="card" style={{ padding: 12 }}>
            <div className="row wrap" style={{ justifyContent: 'space-between', gap: 8 }}>
              <strong style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{decision.questionMarkdown}</strong>
              <span className="chip chip-outline">{DECISION_STATUS_LABELS[decision.status]}</span>
            </div>
            {decision.recommendationMarkdown && (
              <p className="text-sm text-muted" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
                Empfehlung: {decision.recommendationMarkdown}
              </p>
            )}
            <div className="stack" style={{ gap: 8, marginTop: 8 }}>
              {decision.options.map((option) => {
                const isResolvedChoice = decision.resolvedOptionKey === option.key
                const isRecommended = decision.recommendedOptionKey === option.key
                return (
                  <div key={option.key} className="stack" style={{ gap: 4 }}>
                    {/* .decision-option-resolved-choice haelt die persistierte
                        gewaehlte Option bei voller Opazitaet lesbar, auch
                        wenn der Button disabled ist. */}
                    <button
                      className={`btn decision-option ${isResolvedChoice ? 'btn-primary decision-option-resolved-choice' : 'btn-secondary'}`}
                      disabled={readOnly || saving || decision.status !== 'OPEN'}
                      onClick={() => void onResolveDecision(decision.id, option.key)}
                    >
                      {option.label}
                      {isRecommended ? ' (empfohlen)' : ''}
                      {isResolvedChoice ? ' ✓' : ''}
                    </button>
                    {option.descriptionMarkdown && (
                      <div className="text-sm text-muted" style={{ paddingLeft: 4, overflowWrap: 'anywhere' }}>
                        {option.descriptionMarkdown}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </section>

      {/* Ausgeblendet statt leerem Platzhalter, solange keine Tasks verknuepft sind. */}
      {request.taskIds.length > 0 && (
        <section className="stack" style={{ gap: 8 }}>
          <h4 style={{ margin: 0 }}>Interne Arbeit</h4>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {request.taskIds.map((taskId) => (
              <li key={taskId} className="text-sm">
                {linkedTasksById[taskId]?.title ?? `Aufgabe #${taskId}`}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Meilenstein 4.8A - zeigt AUSSCHLIESSLICH bereits ueber einen Main-internen/Test-Pfad
          erstellte Reviews fuer diesen Work Request an (siehe CodeChangeReview.tsx's
          Datei-Kommentar) - es gibt bewusst KEINEN Button, der eine Review erzeugt. Rendert
          selbst nichts (gibt null zurueck), solange keine Review fuer diesen Work Request
          existiert - kein leerer Platzhalter-Abschnitt. */}
      <CodeChangeReviewPanel projectId={projectId} workRequestId={request.id} readOnly={readOnly} />
    </div>
  )
}
