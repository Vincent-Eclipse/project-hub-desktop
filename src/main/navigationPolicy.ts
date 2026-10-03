// Reine, von Electron unabhaengige Entscheidungsfunktion fuer
// Hauptfenster-Navigation (RC4, Punkt 10). Kein 'electron'-Import, dadurch
// ohne Electron-Laufzeit testbar (Vitest/Node).
//
// Vorheriges Verhalten (RC3) hat eine Ziel-URL per String.startsWith() gegen
// die Dev-URL verglichen - das ist zu grosszuegig: "http://localhost:5173"
// als Praefix erlaubt faelschlich auch "http://localhost:5173.evil.example"
// (ein anderer, fremder Host, dessen Name lediglich mit demselben Text
// beginnt). Diese Funktion parst beide Seiten stattdessen als echte URL und
// vergleicht ausschliesslich exakte Origins (Schema+Host+Port) bzw. - fuer
// den produktiven file://-Fall - exakt denselben Dateipfad. Eine ungueltige
// Ziel-URL wird grundsaetzlich blockiert, niemals stillschweigend erlaubt.

export interface NavigationPolicyOptions {
  /**
   * Origin (Schema+Host+Port) der electron-vite-Dev-Renderer-URL - nur im
   * Entwicklungsmodus gesetzt. Ein `undefined`-Wert bedeutet: Dev-Navigation
   * ist in diesem Modus grundsaetzlich nicht erlaubt.
   */
  allowedDevOrigin?: string
  /**
   * Vollstaendige file://-URL der produktiven Renderer-index.html. Ein
   * `undefined`-Wert bedeutet: es gibt keine erlaubte lokale Datei-URL (z. B.
   * im Entwicklungsmodus, wo ausschliesslich die Dev-URL erlaubt ist).
   */
  allowedFileUrl?: string
}

function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/**
 * Entscheidet, ob eine Navigation des Hauptfensters zu `targetUrl` erlaubt
 * ist. Erlaubt sind ausschliesslich:
 * - im Entwicklungsmodus: derselbe Origin wie `allowedDevOrigin` (exakter
 *   Schema+Host+Port-Vergleich, kein Praefix-/Teilstring-Vergleich)
 * - im produktiven Modus: dieselbe lokale Datei wie `allowedFileUrl`
 *   (`file:`-Protokoll und identischer Pfad)
 *
 * Jede andere Ziel-URL - inklusive fremder http(s)-Seiten, ungueltiger URLs
 * und "aehnlich beginnender" Hosts - wird abgelehnt. Externe Seiten sollen
 * ausschliesslich ueber das validierte system:openExternal-IPC geoeffnet
 * werden, niemals durch eine Navigation des Hauptfensters selbst.
 */
export function isNavigationTargetAllowed(targetUrl: string, options: NavigationPolicyOptions): boolean {
  const target = tryParseUrl(targetUrl)
  if (target === null) return false

  if (options.allowedDevOrigin !== undefined) {
    const devOrigin = tryParseUrl(options.allowedDevOrigin)
    if (devOrigin !== null && target.origin === devOrigin.origin) {
      return true
    }
  }

  if (options.allowedFileUrl !== undefined) {
    const allowedFile = tryParseUrl(options.allowedFileUrl)
    if (
      allowedFile !== null &&
      target.protocol === 'file:' &&
      allowedFile.protocol === 'file:' &&
      target.pathname === allowedFile.pathname
    ) {
      return true
    }
  }

  return false
}
