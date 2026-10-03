import { useEffect, useState } from 'react'
import {
  NEXT_ACTORS,
  PROJECT_STATUSES,
  type FolderStatus,
  type NextActor,
  type Project,
  type ProjectStatus,
  type UpdateProjectInput
} from '@shared/types'
import { unwrap } from '../../api/client'
import { useAppStore } from '../../state/store'
import { NEXT_ACTOR_LABELS, STATUS_LABELS } from '../StatusBadge'

type EditablePatch = Omit<UpdateProjectInput, 'id'>

const FOLDER_STATUS_HINTS: Partial<Record<FolderStatus, string>> = {
  MISSING:
    'Der gespeicherte Ordner wurde nicht gefunden - wurde er verschoben oder gelöscht? Wähle bei Bedarf einen neuen Ordner.',
  INVALID: 'Der gespeicherte Pfad ist kein Ordner mehr (dort liegt inzwischen z. B. eine Datei).',
  INACCESSIBLE: 'Auf den Ordner kann derzeit nicht zugegriffen werden (z. B. fehlende Berechtigung).'
}

// Die Ansicht hat zwei Modi: ein ruhiger, uebersichtlicher Anzeigemodus mit
// den Projektinformationen als Informationsgruppen, und ein Bearbeitungs-
// modus mit dem eigentlichen Formular, der ueber "Projekt bearbeiten"
// geoeffnet wird und mit klaren "Speichern"/"Abbrechen"-Aktionen endet.
// Die zugrunde liegende IPC-Speicherlogik (projects.update) ist unveraendert
// - es aendert sich nur, wie und wann sie aus der Oberflaeche ausgeloest
// wird (gesammelt beim Speichern statt einzeln je Feld beim Verlassen).
export function OverviewTab({ project }: { project: Project }): JSX.Element {
  const { loadProjects } = useAppStore()
  const [mode, setMode] = useState<'view' | 'edit'>('view')

  const [name, setName] = useState(project.name)
  const [projectType, setProjectType] = useState(project.projectType)
  const [description, setDescription] = useState(project.description)
  const [status, setStatus] = useState<ProjectStatus>(project.status)
  const [nextActor, setNextActor] = useState<NextActor>(project.nextActor)
  const [currentStep, setCurrentStep] = useState(project.currentStep)
  const [nextAction, setNextAction] = useState(project.nextAction)

  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isPickingFolder, setIsPickingFolder] = useState(false)
  const [folderPath, setFolderPath] = useState(project.folderPath)
  const [folderStatus, setFolderStatus] = useState<FolderStatus | null>(null)
  const readOnly = project.isArchived

  // Live-Status des Projektordners neu abfragen, sobald das Projekt
  // gewechselt hat ODER sich der gespeicherte Ordner selbst geaendert hat
  // (z. B. nach Auswaehlen/Entfernen). Reine Main-Prozess-Abfrage, kein
  // fs-Zugriff im Renderer, kein permanenter Watcher - siehe
  // projects:getFolderStatus.
  useEffect(() => {
    void loadFolderStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.folderPath])

  async function loadFolderStatus(): Promise<void> {
    try {
      setFolderStatus(await unwrap(window.eclipseHub.projects.getFolderStatus(project.id)))
    } catch {
      // Eine fehlgeschlagene Statusabfrage ist fuer M1 nicht kritisch - die
      // dezente Anzeige wird einfach ausgeblendet, kein harter Fehler fuer
      // eine reine Zusatzinformation.
      setFolderStatus(null)
    }
  }

  // Zusaetzliche Absicherung neben dem key={project.id}-Remount in
  // ProjectDetailShell: synchronisiert den lokalen Formular-State explizit
  // neu, sobald sich die Projekt-ID aendert, und verlaesst einen
  // eventuell offenen Bearbeitungsmodus des vorherigen Projekts.
  useEffect(() => {
    resetDraftFromProject()
    setMode('view')
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  function resetDraftFromProject(): void {
    setName(project.name)
    setProjectType(project.projectType)
    setDescription(project.description)
    setStatus(project.status)
    setNextActor(project.nextActor)
    setCurrentStep(project.currentStep)
    setNextAction(project.nextAction)
    setFolderPath(project.folderPath)
  }

  function startEditing(): void {
    resetDraftFromProject()
    setError(null)
    setMode('edit')
  }

  function cancelEditing(): void {
    resetDraftFromProject()
    setError(null)
    setMode('view')
  }

  async function handleSave(): Promise<void> {
    setError(null)
    setIsSaving(true)
    const patch: EditablePatch = {
      name,
      projectType,
      description,
      status,
      nextActor,
      currentStep,
      nextAction,
      folderPath
    }
    try {
      await unwrap(window.eclipseHub.projects.update({ id: project.id, ...patch }))
      await loadProjects()
      setMode('view')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleArchiveToggle(): Promise<void> {
    setError(null)
    try {
      if (project.isArchived) {
        await unwrap(window.eclipseHub.projects.restore(project.id))
      } else {
        await unwrap(window.eclipseHub.projects.archive(project.id))
      }
      await loadProjects()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handlePickFolder(): Promise<void> {
    setIsPickingFolder(true)
    setError(null)
    try {
      const selected = await unwrap(window.eclipseHub.projects.selectFolder())
      if (selected.folderPath) setFolderPath(selected.folderPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsPickingFolder(false)
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      {readOnly && (
        <div className="banner banner-info" style={{ marginBottom: 20 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Dieses Projekt ist archiviert</div>
            <div className="text-muted">
              Es ist schreibgeschützt{project.archivedAt ? ` (seit ${project.archivedAt})` : ''}. Stelle es
              wieder her, um es zu bearbeiten. Keine Daten gehen dabei verloren.
            </div>
            <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={handleArchiveToggle}>
              Projekt wiederherstellen
            </button>
          </div>
        </div>
      )}

      {mode === 'view' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
            <div className="text-xs text-faint">
              Slug: <code className="font-mono">{project.slug}</code> (ändert sich bei einer Umbenennung nicht)
            </div>
            {!readOnly && (
              <button className="btn btn-secondary btn-sm" onClick={startEditing}>
                Projekt bearbeiten
              </button>
            )}
          </div>

          <div className="card stack" style={{ gap: 16, marginBottom: 16 }}>
            <InfoGroup label="Name" value={project.name} />
            <InfoGroup label="Projekttyp" value={project.projectType || '–'} />
            <InfoGroup label="Beschreibung / Ziel" value={project.description || '–'} multiline />
            <InfoGroup
              label="Projektordner"
              value={project.folderPath ?? 'Kein Ordner ausgewählt'}
              mono={Boolean(project.folderPath)}
            />
            {folderStatus && FOLDER_STATUS_HINTS[folderStatus] && (
              <div className="banner banner-warning">{FOLDER_STATUS_HINTS[folderStatus]}</div>
            )}
          </div>

          <div className="card stack" style={{ gap: 16 }}>
            <div className="field-row">
              <InfoGroup label="Status" value={<StatusChipValue status={project.status} />} />
              <InfoGroup label="Nächster Akteur" value={NEXT_ACTOR_LABELS[project.nextActor]} />
            </div>
            <InfoGroup label="Aktueller Schritt" value={project.currentStep || '–'} />
            <InfoGroup label="Nächste Aktion" value={project.nextAction || '–'} />
          </div>

          <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
            {!readOnly && (
              <button className="btn btn-secondary" onClick={handleArchiveToggle}>
                Projekt archivieren
              </button>
            )}
            <div className="text-xs text-muted" style={{ marginTop: 6 }}>
              Archivieren löscht keine Daten. Chats, Kontext-Versionen und der Projektordner bleiben
              unverändert erhalten.
            </div>
          </div>
        </>
      )}

      {mode === 'edit' && (
        <>
          <div className="text-xs text-faint" style={{ marginBottom: 16 }}>
            Slug: <code className="font-mono">{project.slug}</code> (ändert sich bei einer Umbenennung nicht)
          </div>

          <label className="field">
            <span className="field-label field-required">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="field">
            <span className="field-label">Projekttyp</span>
            <input value={projectType} onChange={(e) => setProjectType(e.target.value)} />
          </label>

          <label className="field">
            <span className="field-label">Beschreibung / Ziel</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
          </label>

          <label className="field">
            <span className="field-label">Projektordner</span>
            <div className="row" style={{ gap: 8 }}>
              <div
                className="text-sm"
                style={{
                  flex: 1,
                  padding: '8px 10px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  color: folderPath ? 'var(--color-text)' : 'var(--color-text-faint)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {folderPath ?? 'Kein Ordner ausgewählt'}
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={handlePickFolder} disabled={isPickingFolder}>
                {folderPath ? 'Ändern' : 'Ordner auswählen'}
              </button>
              {folderPath && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFolderPath(null)}>
                  Entfernen
                </button>
              )}
            </div>
          </label>

          <div className="field-row">
            <label className="field">
              <span className="field-label">Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
                {PROJECT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">Nächster Akteur</span>
              <select value={nextActor} onChange={(e) => setNextActor(e.target.value as NextActor)}>
                {NEXT_ACTORS.map((actor) => (
                  <option key={actor} value={actor}>
                    {NEXT_ACTOR_LABELS[actor]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="field">
            <span className="field-label">Aktueller Schritt</span>
            <input value={currentStep} onChange={(e) => setCurrentStep(e.target.value)} />
          </label>

          <label className="field">
            <span className="field-label">Nächste Aktion</span>
            <input value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
          </label>

          {error && (
            <div className="banner banner-danger" style={{ marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Speichert…' : 'Speichern'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={cancelEditing} disabled={isSaving}>
              Abbrechen
            </button>
          </div>
        </>
      )}

      {mode === 'view' && error && (
        <div className="banner banner-danger" style={{ marginTop: 16 }}>
          {error}
        </div>
      )}
    </div>
  )
}

function InfoGroup({
  label,
  value,
  multiline,
  mono
}: {
  label: string
  value: React.ReactNode
  multiline?: boolean
  mono?: boolean
}): JSX.Element {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="text-xs text-muted" style={{ marginBottom: 4, fontWeight: 600 }}>
        {label}
      </div>
      <div
        className={mono ? 'font-mono text-sm' : undefined}
        style={{
          whiteSpace: multiline ? 'pre-wrap' : 'nowrap',
          overflow: multiline ? 'visible' : 'hidden',
          textOverflow: multiline ? 'clip' : 'ellipsis',
          wordBreak: 'break-word'
        }}
      >
        {value}
      </div>
    </div>
  )
}

function StatusChipValue({ status }: { status: ProjectStatus }): JSX.Element {
  return <span>{STATUS_LABELS[status]}</span>
}
