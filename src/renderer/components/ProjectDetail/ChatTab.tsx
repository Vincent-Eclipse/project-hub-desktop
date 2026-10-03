import { useEffect, useState } from 'react'
import { ACTORS, type Actor, type ChatMessage, type Project } from '@shared/types'
import { errorDetail, unwrap } from '../../api/client'
import { ACTOR_LABELS } from '../StatusBadge'

export function ChatTab({ project }: { project: Project }): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [author, setAuthor] = useState<Actor>('LEON')
  const [content, setContent] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedMessageId, setCopiedMessageId] = useState<number | null>(null)
  const readOnly = project.isArchived

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  async function reload(): Promise<void> {
    setIsLoading(true)
    setError(null)
    try {
      setMessages(await unwrap(window.eclipseHub.chat.list(project.id)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }

  async function handleSave(): Promise<void> {
    if (content.trim().length === 0) return
    setIsSaving(true)
    setError(null)
    try {
      await unwrap(window.eclipseHub.chat.addMessage({ projectId: project.id, author, content }))
      setContent('')
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  function handleCancel(): void {
    setContent('')
  }

  async function handleCopy(message: ChatMessage): Promise<void> {
    setError(null)
    try {
      await unwrap(window.eclipseHub.system.copyToClipboard(message.content))
      setCopiedMessageId(message.id)
      setTimeout(() => setCopiedMessageId((current) => (current === message.id ? null : current)), 1500)
    } catch (err) {
      // Kein falscher Erfolg (kein "Kopiert ✓") bei einem tatsaechlichen
      // Fehler, und der eigentliche Nachrichteninhalt taucht nicht im
      // Fehlertext auf.
      setError('Kopieren der Nachricht in die Zwischenablage ist fehlgeschlagen.' + errorDetail(err))
    }
  }

  if (isLoading) return <div className="text-muted">Lädt…</div>

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="stack" style={{ gap: 8, marginBottom: 20 }}>
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true">
              💬
            </div>
            <div className="empty-state-title">Noch keine Verlaufseinträge</div>
            <div className="empty-state-text">
              Hier können Antworten von ChatGPT oder Claude sowie wichtige Entscheidungen manuell
              dokumentiert werden. Der Verlauf fließt nie automatisch in eine Übergabe ein - nur die
              aktuelle Kontext-Version zählt dafür als verbindlich.
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="card" style={{ padding: '10px 14px' }}>
            <div className="row text-xs text-muted" style={{ justifyContent: 'space-between' }}>
              <span>
                {ACTOR_LABELS[m.author]} · {m.createdAt}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => handleCopy(m)}>
                {copiedMessageId === m.id ? 'Kopiert ✓' : 'Kopieren'}
              </button>
            </div>
            <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{m.content}</div>
          </div>
        ))}
      </div>

      {!readOnly && (
        <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 16 }}>
          <h4 style={{ marginTop: 0 }}>Nachricht / Antwort importieren</h4>
          <label className="field">
            <span className="field-label">Autor</span>
            <select value={author} onChange={(e) => setAuthor(e.target.value as Actor)} style={{ width: 200 }}>
              {ACTORS.map((a) => (
                <option key={a} value={a}>
                  {ACTOR_LABELS[a]}
                </option>
              ))}
            </select>
          </label>
          <textarea
            placeholder="Vollständige Antwort hier einfügen (auch mehrzeilig, beliebig lang) …"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
          />

          {content.trim().length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="text-xs text-muted" style={{ marginBottom: 4 }}>
                Vorschau:
              </div>
              <div
                className="card"
                style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto', padding: '10px 14px' }}
              >
                {content}
              </div>
            </div>
          )}

          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn btn-primary" onClick={handleSave} disabled={isSaving || content.trim().length === 0}>
              {isSaving ? 'Speichert…' : 'Als Nachricht speichern'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={handleCancel} disabled={content.length === 0}>
              Abbrechen
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="banner banner-danger" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  )
}
