import { describe, expect, it } from 'vitest'
import { buildContentSecurityPolicy, isUsableDevRendererUrl } from './contentSecurityPolicy'

/**
 * Extrahiert eine einzelne Direktive (z. B. "script-src") als vollstaendige
 * Teilzeichenfolge (inkl. Direktivenname, ohne das abschliessende ";") aus
 * einer CSP-Zeichenfolge. Wird in den Tests benoetigt, um GEZIELT z. B.
 * script-src zu pruefen, statt versehentlich pauschal ueber die gesamte
 * CSP-Zeichenfolge zu suchen - die Fallback-/Production-Policy enthaelt
 * absichtlich 'unsafe-inline' in style-src (fuer Inline-Styles), verboten
 * ist 'unsafe-inline' ausschliesslich in script-src. Ein Test, der die
 * gesamte CSP-Zeichenfolge auf 'unsafe-inline' prueft, wuerde deshalb
 * faelschlich auch gegen das erlaubte style-src-'unsafe-inline' schlagen.
 */
function getDirective(csp: string, directiveName: string): string {
  return (
    csp
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith(`${directiveName} `) || directive === directiveName) ?? ''
  )
}

describe('buildContentSecurityPolicy - Produktion', () => {
  it('script-src enthaelt ausschliesslich self', () => {
    const csp = buildContentSecurityPolicy({ development: false })
    expect(csp).toMatch(/script-src 'self';/)
  })

  it('enthaelt kein unsafe-inline in script-src', () => {
    const csp = buildContentSecurityPolicy({ development: false })
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
  })

  it('connect-src enthaelt keine Dev-URL, selbst wenn eine uebergeben wird', () => {
    const csp = buildContentSecurityPolicy({ development: false, rendererUrl: 'http://localhost:5173' })
    expect(csp).toMatch(/connect-src 'self';/)
    expect(csp).not.toContain('localhost:5173')
  })

  it('enthaelt keinen WebSocket-Origin', () => {
    const csp = buildContentSecurityPolicy({ development: false, rendererUrl: 'http://localhost:5173' })
    expect(csp).not.toContain('ws:')
    expect(csp).not.toContain('wss:')
  })

  it('enthaelt keine breiten Protokoll-Wildcards', () => {
    const csp = buildContentSecurityPolicy({ development: false })
    expect(csp).not.toMatch(/\bhttp:/)
    expect(csp).not.toMatch(/\bhttps:/)
    expect(csp).not.toMatch(/\bws:/)
    expect(csp).not.toMatch(/\bwss:/)
  })

  it('bleibt insgesamt so streng wie zuvor (object-src, base-uri, frame-src none)', () => {
    const csp = buildContentSecurityPolicy({ development: false })
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-src 'none'")
  })
})

describe('buildContentSecurityPolicy - Development mit gueltiger HTTP-Dev-URL', () => {
  const DEV_URL = 'http://localhost:5173'

  it('script-src enthaelt unsafe-inline fuer die Vite-React-Refresh-Preamble', () => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: DEV_URL })
    expect(csp).toContain("script-src 'self' 'unsafe-inline'")
  })

  it('connect-src enthaelt exakt den HTTP-Dev-Origin', () => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: DEV_URL })
    expect(csp).toContain('connect-src \'self\' http://localhost:5173 ws://localhost:5173;')
  })

  it('connect-src enthaelt exakt den passenden WebSocket-Origin', () => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: DEV_URL })
    expect(csp).toContain('ws://localhost:5173')
  })

  it('verwendet ausschliesslich den tatsaechlich uebergebenen exakten Origin und leitet keinen kuerzeren Praefix-Origin ab', () => {
    // Hinweis zur Wahl dieses Testwerts: "http://localhost:5173.evil.example"
    // (wie im urspruenglichen Test) ist tatsaechlich GAR KEINE gueltige URL -
    // new URL() versucht ".evil.example" nach dem Doppelpunkt als Portzahl zu
    // parsen und wirft "Invalid URL". Dieser Wert landet also ohnehin im
    // Fallback-Fall und pruefte faelschlich nicht, was er sollte. Stattdessen
    // wird hier "http://localhost.evil.example:5173" verwendet: eine
    // GUELTIGE, aber echte fremde Origin, deren Hostname lediglich mit dem
    // Text "localhost" beginnt. Wenn dieser Wert tatsaechlich als
    // ELECTRON_RENDERER_URL uebergeben wird, wird er korrekt als GENAU
    // DIESER Origin freigegeben. Der sicherheitsrelevante Punkt ist NICHT,
    // dass dieser Wert abgelehnt werden muesste, sondern dass niemals
    // zusaetzlich der kuerzere Praefix "http://localhost:5173" (ein echter,
    // anderer Origin) aus ihm abgeleitet oder per startsWith()/Teilstring-
    // Vergleich mit ihm verwechselt wird.
    const csp = buildContentSecurityPolicy({
      development: true,
      rendererUrl: 'http://localhost.evil.example:5173'
    })
    expect(csp).toContain('http://localhost.evil.example:5173')
    expect(csp).not.toMatch(/connect-src[^;]*\shttp:\/\/localhost:5173\s/)
  })

  it('enthaelt kein unsafe-eval', () => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: DEV_URL })
    expect(csp).not.toContain('unsafe-eval')
  })

  it('enthaelt keine pauschalen Protokoll-Wildcards', () => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: DEV_URL })
    expect(csp).not.toMatch(/connect-src[^;]* http:[ ;]/)
    expect(csp).not.toMatch(/connect-src[^;]* ws:[ ;]/)
  })
})

describe('buildContentSecurityPolicy - Development mit HTTPS-Dev-URL', () => {
  const DEV_URL = 'https://localhost:5173'

  it('uebernimmt den HTTPS-Origin exakt', () => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: DEV_URL })
    expect(csp).toContain('https://localhost:5173')
  })

  it('leitet daraus den passenden WSS-Origin ab', () => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: DEV_URL })
    expect(csp).toContain('wss://localhost:5173')
    expect(csp).not.toContain('ws://localhost:5173')
  })
})

describe('buildContentSecurityPolicy / isUsableDevRendererUrl - abgelehnte Werte', () => {
  // new URL() ist als WHATWG-Parser sehr grosszuegig und akzeptiert weit
  // mehr als eine brauchbare HTTP(S)-Dev-Adresse (u. a. auch Werte wie
  // 'nicht:eine:gueltige:url', die als Opaque-URL mit eigenem Schema
  // geparst werden und deshalb KEINEN Fehler werfen). Diese Faelle muessen
  // trotzdem sicher abgelehnt werden - kein blosses try/catch um new URL().
  const REJECTED_VALUES: Array<[string, string | undefined]> = [
    ['undefined', undefined],
    ['leerer String', ''],
    ['kein gueltiges URL-Schema (Opaque-URL, wirft keinen Fehler)', 'nicht:eine:gueltige:url'],
    ['javascript-Schema', 'javascript:alert(1)'],
    ['data-Schema', 'data:text/html,test'],
    ['file-Schema', 'file:///tmp/index.html'],
    ['ftp-Schema', 'ftp://example.com'],
    ['ws-Schema als primaere Renderer-URL', 'ws://localhost:5173'],
    ['wss-Schema als primaere Renderer-URL', 'wss://localhost:5173'],
    ['URL mit eingebetteten Zugangsdaten', 'http://user:password@localhost:5173']
  ]

  it.each(REJECTED_VALUES)('isUsableDevRendererUrl liefert false fuer: %s', (_label, value) => {
    expect(isUsableDevRendererUrl(value)).toBe(false)
  })

  it.each(REJECTED_VALUES)('buildContentSecurityPolicy faellt zurueck auf die Production-Policy fuer: %s', (_label, value) => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: value })
    expect(csp).toBe(buildContentSecurityPolicy({ development: false }))
  })

  it.each(REJECTED_VALUES)('wirft keine Exception fuer: %s', (_label, value) => {
    expect(() => isUsableDevRendererUrl(value)).not.toThrow()
    expect(() => buildContentSecurityPolicy({ development: true, rendererUrl: value })).not.toThrow()
  })

  it.each(REJECTED_VALUES)('script-src enthaelt kein unsafe-inline fuer: %s (style-src darf es weiterhin enthalten)', (_label, value) => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: value })
    const scriptSrc = getDirective(csp, 'script-src')
    expect(scriptSrc).toBe("script-src 'self'")
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    // Gegenprobe: style-src enthaelt weiterhin absichtlich 'unsafe-inline'
    // (unveraendert seit RC1-RC4, fuer Inline-Styles) - das ist KEIN Fehler.
    expect(getDirective(csp, 'style-src')).toContain("'unsafe-inline'")
  })

  it.each(REJECTED_VALUES)('enthaelt keine Dev-Origin-Freigabe fuer: %s', (_label, value) => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: value })
    expect(csp).toMatch(/connect-src 'self';/)
  })

  it.each(REJECTED_VALUES)('enthaelt keine WebSocket-Freigabe fuer: %s', (_label, value) => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: value })
    expect(csp).not.toContain('ws:')
    expect(csp).not.toContain('wss:')
  })
})

describe('buildContentSecurityPolicy / isUsableDevRendererUrl - zulaessige echte HTTP(S)-Dev-Adressen', () => {
  const ACCEPTED_VALUES = [
    'http://localhost:5173',
    'https://localhost:5173',
    'http://127.0.0.1:5173',
    'http://[::1]:5173'
  ]

  it.each(ACCEPTED_VALUES)('isUsableDevRendererUrl liefert true fuer: %s', (value) => {
    expect(isUsableDevRendererUrl(value)).toBe(true)
  })

  it.each(ACCEPTED_VALUES)('buildContentSecurityPolicy gibt eine Development-Freigabe fuer: %s', (value) => {
    const csp = buildContentSecurityPolicy({ development: true, rendererUrl: value })
    expect(csp).toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).not.toBe(buildContentSecurityPolicy({ development: false }))
  })
})
