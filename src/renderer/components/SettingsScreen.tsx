import { useEffect, useState } from 'react'
import type { AppInfo, AppSettings } from '@shared/types'
import { unwrap } from '../api/client'

export function SettingsScreen(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)

  useEffect(() => {
    void load()
  }, [])

  async function load(): Promise<void> {
    setError(null)
    try {
      const [s, info] = await Promise.all([
        unwrap(window.eclipseHub.settings.get()),
        unwrap(window.eclipseHub.system.getAppInfo())
      ])
      setSettings(s)
      setAppInfo(info)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSave(): Promise<void> {
    if (!settings) return
    setIsSaving(true)
    setError(null)
    setSavedNotice(false)
    try {
      const updated = await unwrap(window.eclipseHub.settings.update(settings))
      setSettings(updated)
      setSavedNotice(true)
      setTimeout(() => setSavedNotice(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  if (!settings) return <div style={{ padding: 24 }} className="text-muted">Lädt…</div>

  return (
    <div className="scroll-area" style={{ padding: 24 }}>
      <div style={{ maxWidth: 720 }}>
        <h2 style={{ marginTop: 0 }}>Einstellungen</h2>

        <section className="card" style={{ marginBottom: 20 }}>
          <h4 style={{ marginTop: 0 }}>Browser-Links</h4>
          <label className="field">
            <span className="field-label">ChatGPT-URL</span>
            <input
              value={settings.chatgptUrl}
              onChange={(e) => setSettings({ ...settings, chatgptUrl: e.target.value })}
            />
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="field-label">Claude-URL</span>
            <input
              value={settings.claudeUrl}
              onChange={(e) => setSettings({ ...settings, claudeUrl: e.target.value })}
            />
          </label>
        </section>

        <section className="card" style={{ marginBottom: 20 }}>
          <button
            type="button"
            className="row"
            onClick={() => setShowTemplates(!showTemplates)}
            aria-expanded={showTemplates}
            style={{ width: '100%', justifyContent: 'space-between', background: 'none', border: 'none', color: 'var(--color-text)', padding: 0 }}
          >
            <h4 style={{ margin: 0 }}>Erweiterte Vorlagen: Globale Übergabe-Vorlagen</h4>
            <span aria-hidden="true">{showTemplates ? '▾' : '▸'}</span>
          </button>

          {showTemplates && (
            <div style={{ marginTop: 12 }}>
              <details style={{ marginBottom: 12 }}>
                <summary className="text-xs text-muted" style={{ cursor: 'pointer' }}>
                  Verfügbare Platzhalter anzeigen
                </summary>
                <div className="text-xs text-muted font-mono" style={{ marginTop: 6, lineHeight: 1.7 }}>
                  {'{{projectName}}'} {'{{projectType}}'} {'{{projectDescription}}'} {'{{projectStatus}}'}{' '}
                  {'{{currentStep}}'} {'{{nextAction}}'} {'{{nextActor}}'} {'{{contextVersion}}'}{' '}
                  {'{{contextMarkdown}}'} {'{{concreteTask}}'}
                </div>
                <div className="text-xs text-muted" style={{ marginTop: 6 }}>
                  Es gibt bewusst keinen Platzhalter für den Chat-Verlauf - der Chat fließt nie
                  automatisch in Übergaben ein.
                </div>
              </details>

              <label className="field">
                <span className="field-label">ChatGPT-Vorlage</span>
                <textarea
                  value={settings.chatgptGlobalTemplate}
                  onChange={(e) => setSettings({ ...settings, chatgptGlobalTemplate: e.target.value })}
                  rows={8}
                  className="textarea-code"
                />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span className="field-label">Claude-Vorlage</span>
                <textarea
                  value={settings.claudeGlobalTemplate}
                  onChange={(e) => setSettings({ ...settings, claudeGlobalTemplate: e.target.value })}
                  rows={8}
                  className="textarea-code"
                />
              </label>
            </div>
          )}
        </section>

        <div className="row" style={{ gap: 12 }}>
          <button className="btn btn-primary" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Speichert…' : 'Speichern'}
          </button>
          {savedNotice && <span className="chip chip-success">Gespeichert</span>}
        </div>
        {error && (
          <div className="banner banner-danger" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        {appInfo && (
          <section className="card" style={{ marginTop: 32 }}>
            <h4 style={{ marginTop: 0 }}>App-Informationen</h4>
            <div className="stack text-sm text-muted" style={{ gap: 4 }}>
              <div>Version: {appInfo.appVersion}</div>
              <div>Lokale Speicherung: {appInfo.dbPath}</div>
              <div>Log-Verzeichnis: {appInfo.logPath}</div>
              <div>Keine API-Verbindung, keine Cloud, keine Telemetrie.</div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
