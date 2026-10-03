import { useEffect } from 'react'
import { useAppStore } from './state/store'
import { Sidebar } from './components/Sidebar'
import { ProjectDetailShell } from './components/ProjectDetail/ProjectDetailShell'
import { SettingsScreen } from './components/SettingsScreen'

export default function App(): JSX.Element {
  const { activeProjectId, activeView, loadProjects, loadError } = useAppStore()

  useEffect(() => {
    void loadProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        {loadError && (
          <div className="banner banner-danger" style={{ margin: 24 }}>
            {loadError}
          </div>
        )}
        {!loadError && activeView === 'settings' && <SettingsScreen />}
        {!loadError && activeView === 'project' && activeProjectId !== null && (
          <ProjectDetailShell projectId={activeProjectId} />
        )}
        {!loadError && activeView === 'project' && activeProjectId === null && (
          <div className="empty-state" style={{ margin: 24 }}>
            <div className="empty-state-icon" aria-hidden="true">
              ＋
            </div>
            <div className="empty-state-title">Noch kein Projekt vorhanden</div>
            <div className="empty-state-text">
              Lege links über „Neues Projekt“ dein erstes Projekt an und beschreibe anschließend in
              Work, was gebaut oder geändert werden soll.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
