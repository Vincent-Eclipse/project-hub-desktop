import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, RepositoryDiagnostics, RepositoryDiff, RepositoryFile } from '@shared/types'
import { unwrap } from '../../api/client'
import { LatestRequestGuard } from '../../utils/requestGuard'
import { gitDiffLines } from '../../utils/gitDiff'
import { DiffView } from '../DiffView'

const LABELS: Record<RepositoryFile['kind'], string> = {
  added: 'Hinzugefuegt', modified: 'Geaendert', deleted: 'Geloescht',
  renamed: 'Umbenannt', untracked: 'Unversioniert', conflicted: 'Konflikt'
}

function Patch({ title, text, stat }: { title: string; text: string; stat: string }): JSX.Element {
  const parsed = useMemo(() => gitDiffLines(text), [text])
  return <section className="stack">
    <h3>{title}</h3>
    {stat && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{stat}</pre>}
    {parsed.truncated && <div className="banner banner-warning">Anzeige auf 4000 Zeilen gekuerzt.</div>}
    {text ? parsed.format === 'combined' ? <>
      <div className="banner banner-warning">Kombinierter Konflikt-Diff: Nur lesbarer Patch-Text. Normale Zeilenfarben und Zeilennummern sind nicht verfuegbar.</div>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{parsed.raw}</pre>
    </> : <DiffView lines={parsed.lines} /> : <p className="text-muted">Keine Aenderungen.</p>}
  </section>
}

export function RepositoryTab({ project }: { project: Project }): JSX.Element {
  const [diagnostics, setDiagnostics] = useState<RepositoryDiagnostics | null>(null)
  const [diff, setDiff] = useState<RepositoryDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const guard = useRef(new LatestRequestGuard())

  useEffect(() => {
    const ticket = guard.current.start()
    setDiagnostics(null)
    setDiff(null)
    setError(null)
    setBusy(true)
    void (async () => {
      try {
        const result = await unwrap(window.eclipseHub.repository.diagnostics(project.id))
        if (guard.current.isCurrent(ticket)) setDiagnostics(result)
      } catch (err) {
        if (guard.current.isCurrent(ticket)) setError(err instanceof Error ? err.message : 'Repository-Abfrage fehlgeschlagen.')
      } finally {
        if (guard.current.isCurrent(ticket)) setBusy(false)
      }
    })()
    return () => { guard.current.invalidate() }
  }, [project.id, project.folderPath, refresh])

  async function loadDiff(): Promise<void> {
    const ticket = guard.current.start()
    setBusy(true)
    setError(null)
    setDiff(null)
    try {
      const result = await unwrap(window.eclipseHub.repository.diff(project.id))
      if (guard.current.isCurrent(ticket)) setDiff(result)
    } catch (err) {
      if (guard.current.isCurrent(ticket)) setError(err instanceof Error ? err.message : 'Diff-Abfrage fehlgeschlagen.')
    } finally {
      if (guard.current.isCurrent(ticket)) setBusy(false)
    }
  }

  return <div className="stack">
    <div className="row wrap">
      <h3>Repository-Diagnose</h3>
      <button className="btn btn-secondary" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Aktualisieren</button>
    </div>
    <p className="text-muted text-sm">Nur lesender Zugriff. Der Projektordner muss die Repository-Wurzel sein. Verknuepfte Repository-Wurzeln, umgeleitete Git-Metadaten und erweiterte Git-Konfigurationen werden nicht unterstuetzt.</p>
    {busy && <p role="status">Repository wird gelesen…</p>}
    {error && <div className="banner banner-danger" role="alert">{error}</div>}
    {diagnostics && <>
      <div className="card stack" style={{ overflowWrap: 'anywhere' }}>
        <div>Repository erkannt: {diagnostics.detected ? 'Ja' : 'Nein'}</div>
        <div>Repository-Wurzel: {diagnostics.root ?? '–'}</div>
        <div>Aktueller Branch: {diagnostics.detected ? diagnostics.branch ?? 'Detached HEAD' : '–'}</div>
        <div>Arbeitsverzeichnis: {diagnostics.state === 'clean' ? 'Sauber' : diagnostics.state === 'changed' ? 'Aenderungen vorhanden' : '–'}</div>
        <div>Geaenderte Dateien: {diagnostics.files.length}</div>
      </div>
      {diagnostics.files.length > 0 && <ul style={{ overflowWrap: 'anywhere' }}>
        {diagnostics.files.slice(0, 1000).map((file) => <li key={file.path}>
          {LABELS[file.kind]}: {file.previousPath ? file.previousPath + ' → ' : ''}{file.path}
          <span className="text-muted"> (Index: {file.index.trim() || '–'}, Arbeitsverzeichnis: {file.worktree.trim() || '–'})</span>
        </li>)}
      </ul>}
      {diagnostics.files.length > 1000 && <p className="banner banner-warning">Dateiliste auf 1000 Eintraege gekuerzt.</p>}
      {diagnostics.detected && <>
        <p className="text-muted text-sm">Diffs zeigen versionierte Dateien, getrennt nach Index und Arbeitsverzeichnis. Inhalte unversionierter Dateien und Submodule sind nicht Teil des Diffs.</p>
        <button className="btn btn-secondary" disabled={busy} onClick={() => { void loadDiff() }}>Diff anzeigen</button>
      </>}
    </>}
    {diff && <>
      <Patch title="Arbeitsverzeichnis gegen Index" text={diff.unstaged} stat={diff.unstagedStat} />
      <Patch title="Index gegen HEAD" text={diff.staged} stat={diff.stagedStat} />
    </>}
  </div>
}
