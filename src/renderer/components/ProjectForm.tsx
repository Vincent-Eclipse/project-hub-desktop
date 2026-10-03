import { useState } from 'react'
import { NEXT_ACTORS, PROJECT_STATUSES, type NextActor, type ProjectStatus } from '@shared/types'
import { unwrap } from '../api/client'
import { useAppStore } from '../state/store'
import { NEXT_ACTOR_LABELS, STATUS_LABELS } from './StatusBadge'

export function ProjectForm({ onClose }: { onClose: () => void }): JSX.Element {
  const { loadProjects, selectProject } = useAppStore()
  const [name, setName] = useState('')
  const [projectType, setProjectType] = useState('')
  const [description, setDescription] = useState('')
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [status, setStatus] = useState<ProjectStatus>('PLANNING')
  const [currentStep, setCurrentStep] = useState('')
  const [nextActor, setNextActor] = useState<NextActor>('LEON')
  const [nextAction, setNextAction] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isPickingFolder, setIsPickingFolder] = useState(false)

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

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    if (name.trim().length === 0) {
      setError('Bitte einen Projektnamen angeben.')
      return
    }
    if (projectType.trim().length === 0) {
      setError('Bitte einen Projekttyp angeben.')
      return
    }
    setIsSaving(true)
    try {
      const project = await unwrap(
        window.eclipseHub.projects.create({
          name,
          projectType,
          description,
          folderPath,
          status,
          currentStep,
          nextActor,
          nextAction
        })
      )
      await loadProjects()
      selectProject(project.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(4, 5, 8, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 24
      }}
      onClick={onClose}
    >
      <form
        className="card-raised"
        style={{
          background: 'var(--color-surface-raised)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          width: 480,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0
        }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div style={{ padding: '20px 24px 4px', borderBottom: '1px solid var(--color-border)' }}>
          <h3 style={{ margin: 0 }}>Neues Projekt</h3>
          <p className="text-sm" style={{ margin: '4px 0 16px' }}>
            Lege die Eckdaten fest - alles kann später jederzeit angepasst werden.
          </p>
        </div>

        <div className="scroll-area" style={{ padding: '16px 24px' }}>
          <label className="field">
            <span className="field-label field-required">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>

          <label className="field">
            <span className="field-label field-required">Projekttyp</span>
            <input value={projectType} onChange={(e) => setProjectType(e.target.value)} placeholder="z. B. Roblox" />
          </label>

          <label className="field">
            <span className="field-label">Beschreibung / Ziel</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </label>

          <label className="field">
            <span className="field-label">Projektordner (optional)</span>
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
                Ordner auswählen
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
            <input
              value={currentStep}
              onChange={(e) => setCurrentStep(e.target.value)}
              placeholder="z. B. Schritt 7 - ManagerCardSystem Basis"
            />
          </label>

          <label className="field" style={{ marginBottom: 4 }}>
            <span className="field-label">Nächste Aktion</span>
            <input
              value={nextAction}
              onChange={(e) => setNextAction(e.target.value)}
              placeholder="z. B. Warten auf Wiederaufnahme"
            />
          </label>

          {error && (
            <div className="banner banner-danger" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
        </div>

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', padding: '14px 24px', borderTop: '1px solid var(--color-border)' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="btn btn-primary" disabled={isSaving}>
            {isSaving ? 'Wird angelegt…' : 'Projekt anlegen'}
          </button>
        </div>
      </form>
    </div>
  )
}
