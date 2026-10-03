import React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  error: Error | null
}

/**
 * Einzelne, app-weite Fehlergrenze (Memo Punkt 12.14). Fuer Meilenstein 1
 * bewusst nicht pro Tab/Bereich aufgesplittet - ein Rendering-Fehler
 * irgendwo in der App zeigt einen einfachen Wiederherstellungs-Bildschirm
 * statt eines weissen/leeren Fensters.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Unbehandelter Renderer-Fehler:', error, info.componentStack)
  }

  private reload = (): void => {
    window.location.reload()
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: '#f2f4f7', background: '#0b0d12', fontFamily: 'Segoe UI, system-ui, sans-serif', height: '100%' }}>
          <h2 style={{ marginTop: 0 }}>Etwas ist schiefgelaufen</h2>
          <p style={{ color: '#949ead' }}>Die Anwendung ist auf einen unerwarteten Fehler gestoßen.</p>
          <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>{this.state.error.message}</pre>
          <button
            onClick={this.reload}
            style={{
              marginTop: 16,
              height: 36,
              padding: '0 16px',
              borderRadius: 6,
              border: '1px solid #7c5cff',
              background: '#7c5cff',
              color: '#fff',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Neu laden
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
