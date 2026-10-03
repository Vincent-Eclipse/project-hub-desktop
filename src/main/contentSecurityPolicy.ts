// Reine, von Electron unabhaengige Erzeugung der Content-Security-Policy
// (RC4-DevStartFix). Kein 'electron'-Import, dadurch ohne Electron-Laufzeit
// testbar (Vitest/Node) - analog zu navigationPolicy.ts.
//
// Hintergrund: Die strenge Produktions-CSP wurde bislang unveraendert auch
// im Vite-Entwicklungsmodus gesetzt. Vites React-Plugin fuegt im
// Entwicklungsmodus jedoch eine Inline-Preamble fuer React Refresh ein, die
// durch "script-src 'self'" blockiert wird - das Fenster blieb weiss
// (DevTools: "Executing inline script violates ... script-src 'self'",
// danach Folgefehler "@vitejs/plugin-react can't detect preamble").
//
// Diese Datei trennt beide Faelle strikt:
// - Produktion bleibt exakt so streng wie bisher (kein 'unsafe-inline' in
//   script-src, keine Dev-Origins in connect-src).
// - Entwicklung erhaelt ausschliesslich die fuer Vite React Refresh/HMR
//   noetigen, EXAKTEN Freigaben (kein Praefix-/Wildcard-Vergleich, siehe
//   navigationPolicy.ts fuer denselben Grundsatz).

export interface BuildContentSecurityPolicyOptions {
  /** true im Entwicklungsmodus (electron-vite dev), sonst false. */
  development: boolean
  /**
   * Die von electron-vite gesetzte Dev-Renderer-URL
   * (process.env.ELECTRON_RENDERER_URL), z. B. "http://localhost:5173".
   * Nur im Entwicklungsmodus relevant. Fehlt sie oder ist sie ungueltig,
   * wird auf die sichere, produktionsgleiche Fallback-Policy zurueckgefallen.
   */
  rendererUrl?: string
}

// Identisch zur bisherigen Produktions-Policy - bewusst unveraendert.
const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none';"

/**
 * Einzige Quelle der Wahrheit fuer "ist diese Dev-Renderer-URL brauchbar".
 *
 * WICHTIG: new URL() akzeptiert als WHATWG-URL-Parser sehr viel mehr, als
 * hier zulaessig sein darf - u. a. auch Werte wie 'javascript:alert(1)',
 * 'data:text/html,test', 'file:///tmp/index.html', 'ftp://example.com' oder
 * sogar Strings wie 'nicht:eine:gueltige:url' (wird als Opaque-URL mit dem
 * Schema "nicht:" interpretiert und wirft KEINEN Fehler). Ein blosses
 * try/catch um new URL() herum reicht deshalb nicht aus - es muessen
 * zusaetzlich Schema, Origin, Host und Credentials explizit geprueft werden.
 *
 * Zulaessig ist ausschliesslich eine "echte" HTTP(S)-Dev-Adresse:
 * - protocol ist exakt 'http:' oder 'https:' (kein ws:/wss:/file:/data:/
 *   javascript:/ftp: usw. - eine ws:/wss:-URL als PRIMAERE Renderer-URL
 *   waere ohnehin unsinnig, der WebSocket-Origin wird stattdessen erst aus
 *   einer bereits validierten HTTP(S)-URL abgeleitet, siehe
 *   toWebSocketOrigin())
 * - origin ist nicht der Opaque-Wert 'null'
 * - hostname und host sind nicht leer
 * - keine eingebetteten Zugangsdaten (kein username, kein password)
 *
 * buildContentSecurityPolicy() und isUsableDevRendererUrl() verwenden BEIDE
 * ausschliesslich diese eine Funktion, damit die Validierung nicht an zwei
 * Stellen auseinanderlaufen kann.
 */
function parseUsableDevRendererUrl(rendererUrl: string | undefined): URL | null {
  if (!rendererUrl) return null

  let parsed: URL
  try {
    parsed = new URL(rendererUrl)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.origin === 'null') return null
  if (!parsed.hostname || !parsed.host) return null
  if (parsed.username || parsed.password) return null

  return parsed
}

/**
 * Leitet den passenden WebSocket-Origin aus einer bereits validierten
 * HTTP(S)-Dev-URL ab: http: -> ws:, https: -> wss:. Verwendet den bereits
 * geparsten `host` (inkl. Port, inkl. korrekt geklammerter IPv6-Adresse),
 * damit Host und Port exakt uebernommen werden statt per String-Ersetzung.
 */
function toWebSocketOrigin(rendererUrl: URL): string {
  const wsProtocol = rendererUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${rendererUrl.host}`
}

/**
 * Prueft, ob die uebergebene Dev-Renderer-URL fuer eine gezielte
 * Development-Freigabe verwendbar ist (gesetzt, gueltig parsebar UND eine
 * echte HTTP(S)-Adresse ohne Zugangsdaten). Wird separat exportiert, damit
 * der Aufrufer (src/main/index.ts) bei einer ungueltigen/fehlenden URL ein
 * verstaendliches, aber inhaltlich unkritisches Log schreiben kann, ohne die
 * Validierungslogik zu duplizieren.
 */
export function isUsableDevRendererUrl(rendererUrl: string | undefined): boolean {
  return parseUsableDevRendererUrl(rendererUrl) !== null
}

/**
 * Erzeugt die Content-Security-Policy als reinen String.
 *
 * - development=false: liefert immer die unveraenderte, strenge
 *   Produktions-Policy.
 * - development=true mit gueltiger rendererUrl: liefert eine Policy, die
 *   zusaetzlich zur Produktions-Policy NUR 'unsafe-inline' in script-src
 *   (fuer die Vite-React-Refresh-Preamble) sowie den exakten HTTP- und
 *   WebSocket-Origin der Dev-URL in connect-src freigibt. Kein 'unsafe-eval',
 *   keine Protokoll-Wildcards (http:, https:, ws:, wss:).
 * - development=true ohne gueltige rendererUrl (fehlt oder nicht parsebar):
 *   liefert aus Sicherheitsgruenden dieselbe strenge Fallback-Policy wie
 *   Produktion - keine breite Freigabe "ins Blaue".
 */
export function buildContentSecurityPolicy(options: BuildContentSecurityPolicyOptions): string {
  if (!options.development) {
    return PRODUCTION_CSP
  }

  const parsed = parseUsableDevRendererUrl(options.rendererUrl)
  if (parsed === null) {
    return PRODUCTION_CSP
  }

  const httpOrigin = parsed.origin
  const wsOrigin = toWebSocketOrigin(parsed)

  return (
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    'img-src \'self\' data:; ' +
    `connect-src 'self' ${httpOrigin} ${wsOrigin}; ` +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    "frame-src 'none';"
  )
}
