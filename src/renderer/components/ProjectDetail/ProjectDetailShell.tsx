import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { unwrap } from '../../api/client'
import { useAppStore } from '../../state/store'
import { LatestRequestGuard } from '../../utils/requestGuard'
import { StatusBadge, NextActorBadge } from '../StatusBadge'
import { OverviewTab } from './OverviewTab'
import { WorkTab } from './WorkTab'
import { ContextTab } from './ContextTab'
import { TasksTab } from './TasksTab'
import { RulesTab } from './RulesTab'
import { ChatTab } from './ChatTab'
import { SessionsTab } from './SessionsTab'
import { ImportTab } from './ImportTab'
import { HandoffTab } from './HandoffTab'
import { RepositoryTab } from './RepositoryTab'
import { DEFAULT_PROJECT_TAB, PROJECT_TABS, type ProjectTabKey } from './projectTabs'

export function ProjectDetailShell({ projectId }: { projectId: number }): JSX.Element {
  const { projects } = useAppStore()
  const [tab, setTab] = useState<ProjectTabKey>(DEFAULT_PROJECT_TAB)
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Haelt immer die aktuellste projectId bereit (zusaetzliche, einfache
  // Absicherung neben dem Request-Generation-Schutz unten).
  const latestProjectId = useRef(projectId)
  latestProjectId.current = projectId

  // Ein reiner projectId-Vergleich reicht NICHT aus, um den Fall A -> B -> A
  // abzusichern: beide Anfragen fuer A tragen dieselbe ID, ein ID-Vergleich
  // kann die erste (veraltete) A-Antwort nicht von der zweiten (aktuellen)
  // unterscheiden, wenn die erste Antwort zuletzt eintrifft. Der
  // LatestRequestGuard vergibt bei jedem Ladevorgang ein monoton steigendes
  // Ticket - nur die Antwort mit dem zuletzt vergebenen Ticket wird
  // uebernommen, unabhaengig davon, welche projectId sie betrifft oder in
  // welcher Reihenfolge die Antworten eintreffen. Lazy init statt
  // `useRef(new LatestRequestGuard())`, damit nicht bei jedem Render
  // unnoetig eine neue Instanz erzeugt wird.
  const requestGuardRef = useRef<LatestRequestGuard | null>(null)
  if (requestGuardRef.current === null) requestGuardRef.current = new LatestRequestGuard()

  // Beim Wechsel der projectId wird der bisherige Projekt-State SOFORT
  // verworfen (nicht erst nach dem Nachladen) - sonst koennte fuer einen
  // Render-Zyklus noch das alte Projekt unter der neuen projectId
  // angezeigt werden, und Formulare in den Tabs (z. B. OverviewTab) wuerden
  // beim naechsten Blur versehentlich Werte des alten Projekts auf das neue
  // Projekt schreiben. Reset UND Tab-Wechsel laufen bewusst in einem
  // eigenen Effect, der NUR von projectId abhaengt.
  useEffect(() => {
    setTab(DEFAULT_PROJECT_TAB)
    setProject(null)
    setError(null)
  }, [projectId])

  useEffect(() => {
    void reload(projectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projects])

  async function reload(requestedProjectId: number): Promise<void> {
    const ticket = requestGuardRef.current!.start()
    setError(null)
    try {
      const loaded = await unwrap(window.eclipseHub.projects.get(requestedProjectId))
      // Verworfen, wenn zwischenzeitlich ein neuerer Ladevorgang gestartet
      // wurde (auch bei A -> B -> A, wo beide A-Anfragen dieselbe ID
      // haetten) ODER wenn sich projectId inzwischen erneut geaendert hat.
      if (!requestGuardRef.current!.isCurrent(ticket)) return
      if (latestProjectId.current !== requestedProjectId) return
      setProject(loaded)
    } catch (err) {
      if (!requestGuardRef.current!.isCurrent(ticket)) return
      if (latestProjectId.current !== requestedProjectId) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (error) {
    return (
      <div className="banner banner-danger" style={{ margin: 24 }}>
        {error}
      </div>
    )
  }
  if (!project) return <div style={{ padding: 24 }} className="text-muted">Lädt…</div>

  return (
    <div className="stack" style={{ height: '100%' }}>
      <div style={{ padding: '20px 24px 0' }}>
        <div className="row wrap" style={{ gap: 12 }}>
          <h2 style={{ margin: 0, overflowWrap: 'anywhere' }}>{project.name}</h2>
          <span className="chip chip-outline">{project.projectType || 'Kein Projekttyp'}</span>
          <StatusBadge status={project.status} />
          <NextActorBadge nextActor={project.nextActor} />
        </div>
        {(project.currentStep || project.nextAction) && (
          <div className="row wrap text-sm text-muted" style={{ gap: 24, marginTop: 8 }}>
            {project.currentStep && (
              <div style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                <strong style={{ color: 'var(--color-text)' }}>Aktueller Schritt: </strong>
                {project.currentStep}
              </div>
            )}
            {project.nextAction && (
              <div style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                <strong style={{ color: 'var(--color-text)' }}>Nächste Aktion: </strong>
                {project.nextAction}
              </div>
            )}
          </div>
        )}
        <div className="project-tabs" role="tablist" aria-label="Projektbereiche" style={{ marginTop: 16 }}>
          {PROJECT_TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className="project-tab">
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {/* key={project.id} auf jedem Tab: erzwingt einen frischen Mount
          beim Projektwechsel, auch als zusaetzliche Absicherung gegen
          "haengengebliebenen" lokalen Formular-State aus dem vorherigen
          Projekt (siehe Kommentar in OverviewTab). */}
      <div className="scroll-area" style={{ padding: 24 }}>
        {tab === 'work' && project.id === projectId && <WorkTab key={project.id} project={project} />}
        {tab === 'repository' && project.id === projectId && <RepositoryTab key={project.id + ':' + project.folderPath} project={project} />}
        {tab === 'overview' && <OverviewTab key={project.id} project={project} />}
        {tab === 'context' && <ContextTab key={project.id} project={project} />}
        {tab === 'tasks' && project.id === projectId && <TasksTab key={project.id} project={project} />}
        {tab === 'rules' && project.id === projectId && <RulesTab key={project.id} project={project} />}
        {tab === 'chat' && <ChatTab key={project.id} project={project} />}
        {tab === 'sessions' && <SessionsTab key={project.id} project={project} />}
        {tab === 'import' && <ImportTab key={project.id} project={project} />}
        {tab === 'handoff' && <HandoffTab key={project.id} project={project} />}
      </div>
    </div>
  )
}
