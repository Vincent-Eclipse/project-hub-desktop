import { describe, expect, it } from 'vitest'
import { buildSuccessMessage } from './responseImportMessages'
import { createEmptySelection } from './responseImportGuard'

describe('buildSuccessMessage', () => {
  it('nur Verlauf gespeichert', () => {
    const selected = { ...createEmptySelection(), saveHistory: true }
    expect(buildSuccessMessage(selected, false)).toBe('Originalantwort wurde im Verlauf gespeichert.')
  })

  it('nur neue Kontext-Version erstellt', () => {
    const selected = { ...createEmptySelection(), createContextVersion: true, contextIncludeCompletedWork: true }
    expect(buildSuccessMessage(selected, true)).toBe('Import übernommen und neue Kontext-Version erstellt.')
  })

  it('nur Projektmetadaten geändert (Status)', () => {
    const selected = { ...createEmptySelection(), changeStatus: true }
    expect(buildSuccessMessage(selected, false)).toBe('Import übernommen und Projektinformationen aktualisiert.')
  })

  it('nur Projektmetadaten geändert (mehrere Metadatenfelder gleichzeitig zählen weiterhin als "nur Metadaten")', () => {
    const selected = {
      ...createEmptySelection(),
      changeStatus: true,
      changeCurrentStep: true,
      changeNextAction: true,
      changeNextActor: true
    }
    expect(buildSuccessMessage(selected, false)).toBe('Import übernommen und Projektinformationen aktualisiert.')
  })

  it('Verlauf plus Kontext', () => {
    const selected = { ...createEmptySelection(), saveHistory: true, createContextVersion: true, contextIncludeCompletedWork: true }
    expect(buildSuccessMessage(selected, true)).toBe('Originalantwort gespeichert und neue Kontext-Version erstellt.')
  })

  it('gemischte Aktionstypen (Verlauf plus Metadaten) liefert die allgemeine Erfolgsmeldung', () => {
    const selected = { ...createEmptySelection(), saveHistory: true, changeStatus: true }
    expect(buildSuccessMessage(selected, false)).toBe('Import wurde erfolgreich übernommen.')
  })

  it('gemischte Aktionstypen (Kontext plus Metadaten) liefert die allgemeine Erfolgsmeldung', () => {
    const selected = { ...createEmptySelection(), changeStatus: true, createContextVersion: true, contextIncludeCompletedWork: true }
    expect(buildSuccessMessage(selected, true)).toBe('Import wurde erfolgreich übernommen.')
  })

  it('alle drei Aktionstypen gleichzeitig liefert die allgemeine Erfolgsmeldung', () => {
    const selected = {
      ...createEmptySelection(),
      saveHistory: true,
      changeStatus: true,
      createContextVersion: true,
      contextIncludeCompletedWork: true
    }
    expect(buildSuccessMessage(selected, true)).toBe('Import wurde erfolgreich übernommen.')
  })
})
