import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { ACTORS, RULES_MARKDOWN_MAX_LENGTH, type Actor, type Project, type ProjectRuleVersion } from '@shared/types'
import { DEFAULT_RULES_MARKDOWN } from '@shared/documentTemplates'
import { createRulesStore } from '../../state/rulesStore'
import { DiffView } from '../DiffView'
import { ACTOR_LABELS } from '../StatusBadge'

export function RulesTab({ project }: { project: Project }): JSX.Element {
  return <RulesEditor key={`${project.id}:${project.isArchived}`} project={project} />
}

function RulesEditor({ project }: { project: Project }): JSX.Element {
  const [store] = useState(() => createRulesStore(project.id, project.isArchived))
  const { versions, loading, saving, error, diffLines, load, save, showDiff, clearDiff, dispose } = useStore(store)
  const [viewingId, setViewingId] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [createdBy, setCreatedBy] = useState<Actor>('LEON')
  const [fromId, setFromId] = useState<number | null>(null)
  const [toId, setToId] = useState<number | null>(null)
  const latest = versions[0] ?? null
  const viewing = versions.find((v) => v.id === viewingId) ?? latest
  const diffFrom = fromId ?? versions[1]?.id
  const diffTo = toId ?? latest?.id

  useEffect(() => {
    void load()
    return dispose
  }, [load, dispose])

  function startEditing(version: ProjectRuleVersion | null): void {
    setDraft(version?.contentMarkdown ?? DEFAULT_RULES_MARKDOWN)
    setNote('')
    setCreatedBy('LEON')
    setEditing(true)
  }

  async function saveVersion(): Promise<void> {
    if (await save({ contentMarkdown: draft, note: note.trim() || null, createdBy })) {
      setViewingId(null)
      setEditing(false)
      setFromId(null)
      setToId(null)
    }
  }

  if (loading) return <div className="text-muted">Laedt…</div>

  return (
    <div className="two-column">
      <div style={{ flex: 2, minWidth: 0 }}>
        <p className="text-sm text-muted">
          Projekt-Regeln beschreiben Anforderungen, Standards und Verbote. Bei Widerspruechen haben sie
          Vorrang vor Aufgaben und Projekt-Kontext. Sie erteilen keine Datei-, Befehls-, Git- oder
          Netzwerkberechtigungen und erweitern keine technischen Faehigkeiten.
        </p>
        {project.isArchived && <div className="banner">Archiviertes Projekt: Regeln sind schreibgeschuetzt.</div>}
        {error && <div className="banner banner-danger">{error}</div>}
        {!editing && (
          <>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <h4>{viewing ? `Version ${viewing.versionNumber}` : 'Noch keine Projekt-Regeln vorhanden'}</h4>
              {viewing?.id === latest?.id && latest && <span className="chip chip-success">Aktuell</span>}
            </div>
            {viewing && <>
              <p className="text-xs text-muted">{ACTOR_LABELS[viewing.createdBy]} · {viewing.createdAt}{viewing.note ? ` – ${viewing.note}` : ''}</p>
              <textarea aria-label="Projekt-Regeln" readOnly value={viewing.contentMarkdown} rows={18} className="textarea-code" />
            </>}
            {!project.isArchived && (
              <button className="btn btn-primary btn-sm" onClick={() => startEditing(viewing)} disabled={!!error && !latest}>
                {viewing ? 'Neue Version auf dieser Basis bearbeiten' : 'Erste Regeln anlegen'}
              </button>
            )}
          </>
        )}
        {editing && !project.isArchived && (
          <>
            <h4>Neue Regel-Version bearbeiten</h4>
            <textarea aria-label="Regel-Markdown bearbeiten" value={draft} onChange={(e) => setDraft(e.target.value)}
              maxLength={RULES_MARKDOWN_MAX_LENGTH} rows={18} className="textarea-code" disabled={saving} />
            <p className="text-xs text-muted">{draft.length} / {RULES_MARKDOWN_MAX_LENGTH} Zeichen</p>
            <div className="row wrap" style={{ gap: 8 }}>
              <label>Ersteller <select value={createdBy} onChange={(e) => setCreatedBy(e.target.value as Actor)} disabled={saving}>
                {ACTORS.map((actor) => <option key={actor} value={actor}>{ACTOR_LABELS[actor]}</option>)}
              </select></label>
              <input aria-label="Versionsnotiz" placeholder="Kurze Notiz (optional)" value={note} maxLength={500}
                onChange={(e) => setNote(e.target.value)} disabled={saving} />
              <button className="btn btn-primary btn-sm" disabled={saving || draft.length > RULES_MARKDOWN_MAX_LENGTH} onClick={() => void saveVersion()}>
                {saving ? 'Speichert…' : 'Als neue Version speichern'}
              </button>
              <button className="btn btn-secondary btn-sm" disabled={saving} onClick={() => setEditing(false)}>Abbrechen</button>
            </div>
          </>
        )}
        {versions.length > 1 && diffFrom !== undefined && diffTo !== undefined && (
          <div style={{ marginTop: 24 }}>
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <select aria-label="Diff von Version" value={diffFrom} onChange={(e) => { setFromId(Number(e.target.value)); clearDiff() }}>
                {versions.map((v) => <option key={v.id} value={v.id}>Version {v.versionNumber}</option>)}
              </select>
              <span aria-hidden="true">→</span>
              <select aria-label="Diff bis Version" value={diffTo} onChange={(e) => { setToId(Number(e.target.value)); clearDiff() }}>
                {versions.map((v) => <option key={v.id} value={v.id}>Version {v.versionNumber}</option>)}
              </select>
              <button className="btn btn-secondary btn-sm" onClick={() => void showDiff(diffFrom, diffTo)}>Diff anzeigen</button>
            </div>
            {diffLines && <DiffView lines={diffLines} />}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 240 }}>
        <h4>Versionshistorie</h4>
        <div className="stack" style={{ gap: 6 }}>
          {versions.map((v) => (
            <button key={v.id} disabled={saving} className={`card card-interactive${viewing?.id === v.id ? ' card-active' : ''}`}
              onClick={() => { setViewingId(v.id); setEditing(false) }} style={{ padding: 10 }}>
              <div>Version {v.versionNumber} {v.id === latest?.id && <span className="chip chip-success">Aktuell</span>}</div>
              <div className="text-xs text-muted">{ACTOR_LABELS[v.createdBy]} · {v.createdAt}</div>
              {v.note && <div className="text-sm">{v.note}</div>}
            </button>
          ))}
          {!latest && <div className="text-sm text-muted">Noch keine Versionen.</div>}
        </div>
      </div>
    </div>
  )
}
