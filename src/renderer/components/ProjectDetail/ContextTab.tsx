import { useEffect, useState } from 'react'
import { ACTORS, type Actor, type DiffLine, type Project, type ProjectContextVersion } from '@shared/types'
import { unwrap } from '../../api/client'
import { DiffView } from '../DiffView'
import { ACTOR_LABELS } from '../StatusBadge'
import { DEFAULT_CONTEXT_MARKDOWN } from '@shared/documentTemplates'

export function ContextTab({ project }: { project: Project }): JSX.Element {
  const [versions, setVersions] = useState<ProjectContextVersion[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Anzeige-Modus: entweder wird eine bestimmte (moeglicherweise alte)
  // Version schreibgeschuetzt betrachtet, oder es wird eine neue Version
  // auf Basis eines Entwurfs bearbeitet. Das blosse Anzeigen einer alten
  // Version veraendert NIE, welche Version als "aktuell" gilt.
  const [viewingVersionId, setViewingVersionId] = useState<number | null>(null)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [createdBy, setCreatedBy] = useState<Actor>('LEON')
  const [isSaving, setIsSaving] = useState(false)

  const [diffFromId, setDiffFromId] = useState<number | null>(null)
  const [diffToId, setDiffToId] = useState<number | null>(null)
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null)
  const readOnly = project.isArchived

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  async function reload(): Promise<void> {
    setIsLoading(true)
    setError(null)
    try {
      const list = await unwrap(window.eclipseHub.context.listVersions(project.id))
      setVersions(list)
      setViewingVersionId(list[0]?.id ?? null)
      setMode('view')
      setDiffFromId(list[1]?.id ?? null)
      setDiffToId(list[0]?.id ?? null)
      setDiffLines(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }

  function startEditing(fromVersion: ProjectContextVersion | null): void {
    setDraft(fromVersion?.contentMarkdown ?? DEFAULT_CONTEXT_MARKDOWN)
    setNote('')
    setCreatedBy('LEON')
    setMode('edit')
  }

  async function handleSaveVersion(): Promise<void> {
    setIsSaving(true)
    setError(null)
    try {
      await unwrap(
        window.eclipseHub.context.createVersion({
          projectId: project.id,
          contentMarkdown: draft,
          note: note.trim().length > 0 ? note.trim() : null,
          createdBy
        })
      )
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleShowDiff(): Promise<void> {
    if (diffFromId === null || diffToId === null) return
    setError(null)
    try {
      const lines = await unwrap(window.eclipseHub.context.diff(project.id, diffFromId, diffToId))
      setDiffLines(lines)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (isLoading) return <div className="text-muted">Lädt…</div>

  const latest = versions[0] ?? null
  const viewingVersion = versions.find((v) => v.id === viewingVersionId) ?? null
  const isViewingLatest = latest !== null && viewingVersion?.id === latest.id

  return (
    <div className="two-column">
      <div style={{ flex: 2, minWidth: 0 }}>
        {mode === 'view' && versions.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true">
              📄
            </div>
            <div className="empty-state-title">Noch kein Projekt-Kontext vorhanden</div>
            <div className="empty-state-text">
              Der Projekt-Kontext beschreibt kuratierte Fakten, Entscheidungen und den aktuellen Stand -
              genau dieser Text wird bei einer Übergabe an ChatGPT oder Claude mitgegeben. Erstelle jetzt
              die erste Version. Anforderungen und Verbote gehören in die Projekt-Regeln; Chat bleibt Verlauf.
            </div>
            {!readOnly && (
              <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={() => startEditing(null)}>
                Ersten Kontext anlegen
              </button>
            )}
          </div>
        )}

        {mode === 'view' && versions.length > 0 && (
          <>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <h4 style={{ margin: 0 }}>
                {viewingVersion && (
                  <span className="row" style={{ gap: 8 }}>
                    Version {viewingVersion.versionNumber}
                    {isViewingLatest && <span className="chip chip-success">Aktuell</span>}
                  </span>
                )}
              </h4>
              {!readOnly && (
                <button className="btn btn-primary btn-sm" onClick={() => startEditing(viewingVersion)}>
                  Neue Version auf dieser Basis bearbeiten
                </button>
              )}
            </div>
            {viewingVersion && (
              <div className="text-xs text-muted" style={{ marginBottom: 8 }}>
                Erstellt von {ACTOR_LABELS[viewingVersion.createdBy]} am {viewingVersion.createdAt}
                {viewingVersion.note ? ` – ${viewingVersion.note}` : ''}
              </div>
            )}
            <textarea
              readOnly
              value={viewingVersion?.contentMarkdown ?? ''}
              rows={18}
              className="textarea-code"
              style={{ opacity: 0.9 }}
            />
            {!isViewingLatest && latest && (
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => setViewingVersionId(latest.id)}>
                Zur aktuellen Version zurückkehren
              </button>
            )}
          </>
        )}

        {mode === 'edit' && (
          <>
            <h4 style={{ marginTop: 0 }}>Neue Version bearbeiten</h4>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={18}
              className="textarea-code"
            />
            <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
              <label className="text-sm text-muted row" style={{ gap: 6 }}>
                Ersteller
                <select value={createdBy} onChange={(e) => setCreatedBy(e.target.value as Actor)}>
                  {ACTORS.map((a) => (
                    <option key={a} value={a}>
                      {ACTOR_LABELS[a]}
                    </option>
                  ))}
                </select>
              </label>
              <input
                placeholder="Kurze Notiz zu dieser Version (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                style={{ flex: 1, minWidth: 160 }}
              />
              <button className="btn btn-primary btn-sm" onClick={handleSaveVersion} disabled={isSaving}>
                {isSaving ? 'Speichert…' : 'Als neue Version speichern'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('view')}>
                Abbrechen
              </button>
            </div>
          </>
        )}

        {error && (
          <div className="banner banner-danger" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}

        {diffFromId !== null && diffToId !== null && versions.length > 1 && (
          <div style={{ marginTop: 24 }}>
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <select value={diffFromId} onChange={(e) => setDiffFromId(Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    Version {v.versionNumber}
                  </option>
                ))}
              </select>
              <span aria-hidden="true">→</span>
              <select value={diffToId} onChange={(e) => setDiffToId(Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    Version {v.versionNumber}
                  </option>
                ))}
              </select>
              <button className="btn btn-secondary btn-sm" onClick={handleShowDiff}>
                Diff anzeigen
              </button>
            </div>
            {diffLines && <DiffView lines={diffLines} />}
          </div>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 240 }}>
        <h4 style={{ marginTop: 0 }}>Versionshistorie</h4>
        <div className="stack" style={{ gap: 6 }}>
          {versions.map((v) => (
            <button
              key={v.id}
              onClick={() => {
                setViewingVersionId(v.id)
                setMode('view')
              }}
              className={`card card-interactive${v.id === viewingVersionId ? ' card-active' : ''}`}
              style={{ padding: 10 }}
            >
              <div className="row" style={{ gap: 6, fontWeight: 600 }}>
                Version {v.versionNumber}
                {latest?.id === v.id && <span className="chip chip-success">Aktuell</span>}
              </div>
              <div className="text-xs text-muted" style={{ marginTop: 2 }}>
                {ACTOR_LABELS[v.createdBy]} · {v.createdAt}
              </div>
              {v.note && (
                <div className="text-sm" style={{ marginTop: 4 }}>
                  {v.note}
                </div>
              )}
            </button>
          ))}
          {versions.length === 0 && <div className="text-sm text-muted">Noch keine Versionen.</div>}
        </div>
      </div>
    </div>
  )
}
