import { useEffect } from 'react'
import type { Project, SessionProvider, SessionStatus } from '@shared/types'
import { useAppStore } from '../../state/store'

const PROVIDER_LABELS: Record<SessionProvider, string> = {
  CHATGPT: 'ChatGPT',
  CLAUDE: 'Claude'
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  ACTIVE: 'Aktiv',
  PAUSED: 'Pausiert',
  LIMIT_REACHED: 'Limit erreicht',
  RESPONSE_INCOMPLETE: 'Antwort unvollständig',
  WAITING_ON_HUMAN: 'Wartet auf Mensch',
  COMPLETED: 'Abgeschlossen',
  ABANDONED: 'Verworfen'
}

interface SessionsTabProps {
  project: Project
}

function valueOrFallback(value: string): string {
  return value.trim().length > 0 ? value : 'Keine Angabe'
}

function DetailRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-xs text-muted" style={{ marginBottom: 2, fontWeight: 600 }}>
        {label}
      </div>
      <div className="text-sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {value}
      </div>
    </div>
  )
}

export function SessionsTab({ project }: SessionsTabProps): JSX.Element {
  const { sessions, selectedSessionId, sessionsLoading, sessionsError, loadSessions, selectSession } = useAppStore()

  useEffect(() => {
    void loadSessions(project.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null

  return (
    <div className="two-column">
      <div style={{ flex: 1, minWidth: 240 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <h4 style={{ margin: 0 }}>Sitzungen</h4>
          <span className="chip chip-outline">{sessions.length}</span>
        </div>

        {sessionsLoading && <div className="text-muted">Lädt…</div>}

        {!sessionsLoading && sessionsError && <div className="banner banner-danger">{sessionsError}</div>}

        {!sessionsLoading && !sessionsError && sessions.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true">
              🧭
            </div>
            <div className="empty-state-title">Noch keine Sitzungen</div>
            <div className="empty-state-text">
              Für dieses Projekt wurden noch keine Arbeitssitzungen angelegt.
            </div>
          </div>
        )}

        {!sessionsLoading && !sessionsError && sessions.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            {sessions.map((session) => {
              const isSelected = session.id === selectedSessionId
              return (
                <button
                  key={session.id}
                  type="button"
                  aria-pressed={isSelected}
                  className={`card card-interactive${isSelected ? ' card-active' : ''}`}
                  style={{ padding: 10 }}
                  onClick={() => selectSession(session.id)}
                >
                  <div style={{ fontWeight: 600 }}>
                    {session.title.trim().length > 0 ? session.title : `Sitzung #${session.id}`}
                  </div>
                  <div className="text-xs text-muted" style={{ marginTop: 2 }}>
                    {PROVIDER_LABELS[session.provider]} · {STATUS_LABELS[session.status]}
                  </div>
                  {session.currentTask.trim().length > 0 && (
                    <div className="text-sm" style={{ marginTop: 4 }}>
                      {session.currentTask}
                    </div>
                  )}
                  <div className="text-xs text-faint" style={{ marginTop: 4 }}>
                    Aktualisiert: {session.updatedAt}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 240 }}>
        {selectedSession === null && (
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true">
              🧭
            </div>
            <div className="empty-state-title">Sitzung auswählen</div>
            <div className="empty-state-text">Wähle links eine Sitzung aus, um ihre Details zu sehen.</div>
          </div>
        )}

        {selectedSession !== null && (
          <div className="card stack" style={{ gap: 12, padding: 16 }}>
            <h4 style={{ margin: 0 }}>
              {selectedSession.title.trim().length > 0 ? selectedSession.title : `Sitzung #${selectedSession.id}`}
            </h4>
            <DetailRow label="ID" value={String(selectedSession.id)} />
            <DetailRow label="Provider" value={PROVIDER_LABELS[selectedSession.provider]} />
            <DetailRow label="Status" value={STATUS_LABELS[selectedSession.status]} />
            <DetailRow label="Aktuelle Aufgabe" value={valueOrFallback(selectedSession.currentTask)} />
            <DetailRow label="Notizen" value={valueOrFallback(selectedSession.notes)} />
            <DetailRow label="Erstellt am" value={selectedSession.createdAt} />
            <DetailRow label="Zuletzt aktualisiert" value={selectedSession.updatedAt} />
            {selectedSession.completedAt !== null && (
              <DetailRow label="Abgeschlossen am" value={selectedSession.completedAt} />
            )}
            {selectedSession.predecessorSessionId !== null && (
              <DetailRow label="Vorgängersitzung" value={`#${selectedSession.predecessorSessionId}`} />
            )}
            {selectedSession.basedOnSnapshotId !== null && (
              <DetailRow label="Basiert auf Snapshot" value={`#${selectedSession.basedOnSnapshotId}`} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
