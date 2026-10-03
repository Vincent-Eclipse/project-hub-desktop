import { describe, expect, it } from 'vitest'
import { isNavigationTargetAllowed } from './navigationPolicy'

const DEV_ORIGIN = 'http://localhost:5173'
const FILE_URL = 'file:///C:/Users/Leon/AppData/Local/Programs/EclipseHub/resources/app.asar/out/renderer/index.html'

describe('isNavigationTargetAllowed', () => {
  it('erlaubt exakt denselben Dev-Origin', () => {
    expect(
      isNavigationTargetAllowed('http://localhost:5173/', { allowedDevOrigin: DEV_ORIGIN })
    ).toBe(true)
    expect(
      isNavigationTargetAllowed('http://localhost:5173/irgendein/pfad?x=1', { allowedDevOrigin: DEV_ORIGIN })
    ).toBe(true)
  })

  it('lehnt einen aehnlich beginnenden, aber fremden Host ab (kein Praefix-Vergleich mehr)', () => {
    expect(
      isNavigationTargetAllowed('http://localhost:5173.evil.example/', { allowedDevOrigin: DEV_ORIGIN })
    ).toBe(false)
  })

  it('lehnt einen anderen Port auf demselben Host ab', () => {
    expect(
      isNavigationTargetAllowed('http://localhost:5174/', { allowedDevOrigin: DEV_ORIGIN })
    ).toBe(false)
  })

  it('lehnt eine komplett fremde https-Seite ab', () => {
    expect(
      isNavigationTargetAllowed('https://attacker.example/phishing', { allowedDevOrigin: DEV_ORIGIN })
    ).toBe(false)
  })

  it('lehnt eine ungueltige URL ab, statt sie durchzulassen', () => {
    expect(isNavigationTargetAllowed('nicht:eine:gueltige:url', { allowedDevOrigin: DEV_ORIGIN })).toBe(false)
    expect(isNavigationTargetAllowed('', { allowedDevOrigin: DEV_ORIGIN })).toBe(false)
  })

  it('erlaubt im produktiven Modus exakt die erwartete lokale Renderer-Datei', () => {
    expect(isNavigationTargetAllowed(FILE_URL, { allowedFileUrl: FILE_URL })).toBe(true)
  })

  it('lehnt im produktiven Modus jede fremde http(s)-Navigation ab', () => {
    expect(isNavigationTargetAllowed('https://example.com/', { allowedFileUrl: FILE_URL })).toBe(false)
    expect(isNavigationTargetAllowed('http://localhost:5173/', { allowedFileUrl: FILE_URL })).toBe(false)
  })

  it('lehnt im produktiven Modus eine andere lokale Datei ab', () => {
    expect(
      isNavigationTargetAllowed('file:///C:/Windows/System32/evil.html', { allowedFileUrl: FILE_URL })
    ).toBe(false)
  })

  it('lehnt jede Navigation ab, wenn weder allowedDevOrigin noch allowedFileUrl gesetzt sind', () => {
    expect(isNavigationTargetAllowed('http://localhost:5173/', {})).toBe(false)
    expect(isNavigationTargetAllowed(FILE_URL, {})).toBe(false)
  })
})
