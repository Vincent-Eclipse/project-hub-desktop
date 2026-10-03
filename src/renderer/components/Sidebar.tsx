import { useState } from 'react'
import { useAppStore } from '../state/store'
import { StatusBadge } from './StatusBadge'
import { ProjectForm } from './ProjectForm'

export function Sidebar(): JSX.Element {
  const { projects, showArchived, setShowArchived, activeProjectId, activeView, selectProject, openSettings } =
    useAppStore()
  const [showCreateForm, setShowCreateForm] = useState(false)

  const activeProjects = projects.filter((p) => !p.isArchived)
  const archivedProjects = projects.filter((p) => p.isArchived)

  return (
    <div
      className="stack"
      style={{
        width: 'var(--sidebar-width)',
        flexShrink: 0,
        borderRight: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
        height: '100%'
      }}
    >
      <div style={{ padding: 'var(--space-4) var(--space-4) var(--space-3)', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)' }}>Eclipse Project Hub</div>
      </div>

      <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
        <button className="btn btn-primary btn-block" onClick={() => setShowCreateForm(true)}>
          + Neues Projekt
        </button>
      </div>

      <nav className="scroll-area" aria-label="Projekte" style={{ padding: '0 var(--space-3) var(--space-3)' }}>
        {/* text-muted statt text-faint - faint erreicht auf dieser Flaeche
            nicht genug Kontrast fuer lesbaren Text. */}
        <div
          className="text-xs text-muted"
          style={{ textTransform: 'uppercase', letterSpacing: '0.04em', padding: 'var(--space-2) var(--space-2) var(--space-1)' }}
        >
          Projekte
        </div>

        {activeProjects.length === 0 && (
          <div className="text-sm text-muted" style={{ padding: 'var(--space-2)' }}>
            Noch keine Projekte angelegt.
          </div>
        )}

        <div className="stack" style={{ gap: 4 }}>
          {activeProjects.map((project) => {
            const isActive = activeView === 'project' && activeProjectId === project.id
            return (
              <button
                key={project.id}
                onClick={() => selectProject(project.id)}
                aria-current={isActive ? 'true' : undefined}
                className={`card card-interactive${isActive ? ' card-active' : ''}`}
                style={{ padding: 'var(--space-2) var(--space-3)', border: isActive ? undefined : '1px solid transparent' }}
              >
                <div
                  title={project.name}
                  style={{
                    fontWeight: 600,
                    marginBottom: 4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {project.name}
                </div>
                <div className="row wrap" style={{ gap: 6, marginBottom: project.currentStep ? 4 : 0 }}>
                  <StatusBadge status={project.status} />
                </div>
                {/* Kein "Naechster Akteur" hier - der Projekt-Header traegt
                    das bereits ueber NextActorBadge. */}
                {project.currentStep && (
                  <div
                    className="text-sm text-muted"
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {project.currentStep}
                  </div>
                )}
              </button>
            )
          })}
        </div>

        <div style={{ marginTop: 'var(--space-4)' }}>
          <button
            className="btn btn-ghost btn-sm"
            style={{ width: '100%', justifyContent: 'flex-start' }}
            onClick={() => setShowArchived(!showArchived)}
            aria-expanded={showArchived}
          >
            <span aria-hidden="true">{showArchived ? '▾' : '▸'}</span> Archiviert ({archivedProjects.length})
          </button>
          {showArchived && (
            <div className="stack" style={{ gap: 4, marginTop: 4 }}>
              {archivedProjects.map((project) => {
                const isActive = activeView === 'project' && activeProjectId === project.id
                return (
                  <button
                    key={project.id}
                    onClick={() => selectProject(project.id)}
                    aria-current={isActive ? 'true' : undefined}
                    className={`card card-interactive${isActive ? ' card-active' : ''}`}
                    style={{
                      padding: 'var(--space-2) var(--space-3)',
                      border: isActive ? undefined : '1px solid transparent'
                    }}
                  >
                    <div
                      title={project.name}
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: 'var(--color-text-muted)'
                      }}
                    >
                      {project.name}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </nav>

      <div style={{ padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--color-border)' }}>
        <button
          className="btn btn-secondary btn-block"
          onClick={openSettings}
          aria-current={activeView === 'settings' ? 'true' : undefined}
        >
          ⚙ Einstellungen
        </button>
      </div>

      {showCreateForm && <ProjectForm onClose={() => setShowCreateForm(false)} />}
    </div>
  )
}
