import { useEffect, useState } from 'react'
import type { AiRole, GeneratedPrompt, Project, RoleTemplateInfo } from '@shared/types'
import { errorDetail, unwrap } from '../../api/client'

const ROLE_LABELS: Record<AiRole, string> = { CHATGPT: 'ChatGPT', CLAUDE: 'Claude' }

export function HandoffTab({ project }: { project: Project }): JSX.Element {
  const [role, setRole] = useState<AiRole>('CHATGPT')
  const [roleInfo, setRoleInfo] = useState<RoleTemplateInfo | null>(null)
  const [concreteTask, setConcreteTask] = useState('')
  const [generated, setGenerated] = useState<GeneratedPrompt | null>(null)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle')
  const [showOverrideEditor, setShowOverrideEditor] = useState(false)
  const [overrideDraft, setOverrideDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [appUrl, setAppUrl] = useState<string>('')
  const readOnly = project.isArchived

  useEffect(() => {
    void loadRoleInfo()
    void loadUrl()
    setGenerated(null)
    setCopyStatus('idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, role])

  async function loadRoleInfo(): Promise<void> {
    setError(null)
    try {
      const info = await unwrap(window.eclipseHub.prompts.getRoleInfo(project.id, role))
      setRoleInfo(info)
      setOverrideDraft(info.overrideTemplate ?? info.globalTemplate)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function loadUrl(): Promise<void> {
    try {
      const settings = await unwrap(window.eclipseHub.settings.get())
      setAppUrl(role === 'CHATGPT' ? settings.chatgptUrl : settings.claudeUrl)
    } catch {
      // Nicht kritisch fuer die Kernfunktion des Tabs.
    }
  }

  async function handleGenerate(): Promise<void> {
    setError(null)
    if (concreteTask.trim().length === 0) {
      setError('Bitte eine konkrete Aufgabe angeben, bevor der Prompt erzeugt wird.')
      return
    }
    try {
      const prompt = await unwrap(window.eclipseHub.prompts.generate(project.id, role, concreteTask))
      setGenerated(prompt)
      setCopyStatus('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCopy(): Promise<void> {
    if (!generated) return
    setError(null)
    try {
      // Kopiert exakt den bereits erzeugten und angezeigten Text -
      // keine erneute Generierung, damit Vorschau und Zwischenablage
      // garantiert identisch sind.
      await unwrap(window.eclipseHub.system.copyToClipboard(generated.promptText))
      setCopyStatus('copied')
    } catch (err) {
      // Bei einem Fehler wird kein falscher Erfolg gemeldet (copyStatus
      // bleibt 'idle') und der eigentliche Prompt-Inhalt landet nicht im
      // Fehlertext - nur eine allgemeine, sichere Meldung.
      setCopyStatus('idle')
      setError('Kopieren in die Zwischenablage ist fehlgeschlagen.' + errorDetail(err))
    }
  }

  async function handleOpenBrowser(): Promise<void> {
    if (!appUrl) return
    setError(null)
    try {
      await unwrap(window.eclipseHub.system.openExternal(appUrl))
    } catch (err) {
      setError(`${ROLE_LABELS[role]} konnte nicht im Browser geöffnet werden.` + errorDetail(err))
    }
  }

  async function handleSaveOverride(): Promise<void> {
    setError(null)
    try {
      const info = await unwrap(
        window.eclipseHub.prompts.setOverride({ projectId: project.id, role, template: overrideDraft })
      )
      setRoleInfo(info)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleResetOverride(): Promise<void> {
    setError(null)
    try {
      const info = await unwrap(
        window.eclipseHub.prompts.setOverride({ projectId: project.id, role, template: null })
      )
      setRoleInfo(info)
      setOverrideDraft(info.globalTemplate)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="text-xs text-faint" style={{ textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
        1. Ziel auswählen
      </div>
      <div
        role="radiogroup"
        aria-label="Übergabeziel"
        className="row"
        style={{ gap: 8, marginBottom: 16, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 4, width: 'fit-content' }}
      >
        {(['CHATGPT', 'CLAUDE'] as AiRole[]).map((r) => (
          <button
            key={r}
            role="radio"
            aria-checked={role === r}
            onClick={() => setRole(r)}
            className="btn"
            style={{
              border: 'none',
              background: role === r ? 'var(--color-accent)' : 'transparent',
              color: role === r ? '#fff' : 'var(--color-text-muted)'
            }}
          >
            {ROLE_LABELS[r]}
          </button>
        ))}
      </div>

      {roleInfo?.isOverridden && (
        <div className="text-xs text-muted" style={{ marginBottom: 12 }}>
          Projektspezifische Vorlage aktiv (weicht von der globalen Vorlage ab).
        </div>
      )}

      <div className="text-xs text-faint" style={{ textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
        2. Konkrete Aufgabe
      </div>
      <label className="field">
        <textarea
          value={concreteTask}
          onChange={(e) => setConcreteTask(e.target.value)}
          placeholder="z. B. Plane jetzt Schritt 7 des Projekts. Erstelle noch keinen Code."
          rows={4}
        />
      </label>

      <div className="text-xs text-faint" style={{ textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
        3.–5. Erzeugen, prüfen, übergeben
      </div>
      <div className="row wrap" style={{ gap: 8, marginBottom: 16 }}>
        <button className="btn btn-primary" onClick={handleGenerate}>
          Prompt generieren
        </button>
        <button className="btn btn-secondary" onClick={handleCopy} disabled={!generated}>
          {copyStatus === 'copied' ? 'In Zwischenablage kopiert ✓' : 'In Zwischenablage kopieren'}
        </button>
        <button className="btn btn-ghost" onClick={handleOpenBrowser} disabled={!appUrl}>
          {ROLE_LABELS[role]} im Browser öffnen
        </button>
      </div>

      {generated && (
        <label className="field">
          <span className="field-label">Promptvorschau</span>
          <textarea readOnly value={generated.promptText} rows={16} className="textarea-code" />
        </label>
      )}
      {!generated && (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            📤
          </div>
          <div className="empty-state-title">Noch kein Prompt erzeugt</div>
          <div className="empty-state-text">
            Klicke auf „Prompt generieren“, um eine Vorschau zu sehen - genau dieser Text wird beim
            Kopieren in die Zwischenablage übertragen. Der Chat-Verlauf fließt nicht automatisch ein,
            sondern die aktuelle Kontext-Version und die oben eingegebene konkrete Aufgabe.
            Vorhandene Projekt-Regeln werden unabhängig von der Vorlage immer vorangestellt.
          </div>
        </div>
      )}

      {error && (
        <div className="banner banner-danger" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowOverrideEditor(!showOverrideEditor)}>
          {showOverrideEditor ? 'Erweiterte Vorlage ausblenden' : 'Erweitert: Projektspezifische Vorlage bearbeiten'}
        </button>
        {showOverrideEditor && !readOnly && (
          <div style={{ marginTop: 12 }}>
            <textarea
              value={overrideDraft}
              onChange={(e) => setOverrideDraft(e.target.value)}
              rows={10}
              className="textarea-code"
            />
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={handleSaveOverride}>
                Override speichern
              </button>
              <button className="btn btn-ghost btn-sm" onClick={handleResetOverride}>
                Auf globale Vorlage zurücksetzen
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
