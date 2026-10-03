import { describe, expect, it } from 'vitest'
import {
  canApplySelection,
  createEmptySelection,
  hasAnySelectedAction,
  hasContextCategorySelected,
  isAnalysisResultRelevant,
  isPreviewStale
} from './responseImportGuard'

describe('isPreviewStale', () => {
  it('ist "stale", solange noch nie analysiert wurde', () => {
    expect(isPreviewStale(null, 'irgendein Text')).toBe(true)
  })

  it('ist NICHT stale, wenn der aktuelle Text exakt dem zuletzt analysierten entspricht', () => {
    expect(isPreviewStale('Status: ACTIVE', 'Status: ACTIVE')).toBe(false)
  })

  it('wird stale, sobald der Rohtext nach der Analyse geaendert wird (Projektwechsel-Test aus Abschnitt 31)', () => {
    expect(isPreviewStale('Status: ACTIVE', 'Status: ACTIVE ')).toBe(true)
  })

  it('RC2: wird stale, wenn die Quelle nach der Analyse gewechselt wird, auch bei unveraendertem Rohtext', () => {
    expect(isPreviewStale('Status: ACTIVE', 'Status: ACTIVE', 'CHATGPT', 'CLAUDE')).toBe(true)
  })

  it('RC2: bleibt gueltig, wenn Rohtext UND Quelle unveraendert sind', () => {
    expect(isPreviewStale('Status: ACTIVE', 'Status: ACTIVE', 'CLAUDE', 'CLAUDE')).toBe(false)
  })

  it('RC2: ein Rueckwechsel zur urspruenglichen Quelle macht eine bereits als veraltet erkannte Analyse nicht automatisch wieder gueltig (die Analyse selbst wird beim Quellenwechsel verworfen, nicht nur markiert)', () => {
    // Simuliert: analysiert mit CHATGPT, Quelle auf CLAUDE gewechselt (bereits stale),
    // dann zurueck auf CHATGPT gewechselt - analyzedSource/analyzedRawResponse
    // wurden in der echten Komponente beim ersten Wechsel bereits auf null
    // zurueckgesetzt, sodass hier ohnehin keine "analysierte" Quelle mehr
    // existiert (analyzedRawResponse=null -> immer stale).
    expect(isPreviewStale(null, 'Status: ACTIVE', null, 'CHATGPT')).toBe(true)
  })
})

describe('hasAnySelectedAction / hasContextCategorySelected', () => {
  it('liefert false fuer die konservative leere Standardauswahl', () => {
    expect(hasAnySelectedAction(createEmptySelection())).toBe(false)
    expect(hasContextCategorySelected(createEmptySelection())).toBe(false)
  })

  it('liefert true, sobald irgendeine Top-Level-Aktion ausgewaehlt ist', () => {
    expect(hasAnySelectedAction({ ...createEmptySelection(), saveHistory: true })).toBe(true)
  })

  it('Kontext-Unterkategorien zaehlen NICHT als eigene Top-Level-Aktion', () => {
    const selected = { ...createEmptySelection(), contextIncludeCompletedWork: true }
    expect(hasAnySelectedAction(selected)).toBe(false)
    expect(hasContextCategorySelected(selected)).toBe(true)
  })
})

describe('canApplySelection - keine Uebernahme ohne ausgewaehlte Aktion', () => {
  it('lehnt ab, wenn keine Analyse vorliegt', () => {
    expect(
      canApplySelection({
        hasAnalysis: false,
        isStale: false,
        isProjectArchived: false,
        selected: { ...createEmptySelection(), saveHistory: true }
      })
    ).toBe(false)
  })

  it('lehnt ab, wenn die Vorschau veraltet ist', () => {
    expect(
      canApplySelection({
        hasAnalysis: true,
        isStale: true,
        isProjectArchived: false,
        selected: { ...createEmptySelection(), saveHistory: true }
      })
    ).toBe(false)
  })

  it('lehnt ab, wenn das Projekt archiviert ist', () => {
    expect(
      canApplySelection({
        hasAnalysis: true,
        isStale: false,
        isProjectArchived: true,
        selected: { ...createEmptySelection(), saveHistory: true }
      })
    ).toBe(false)
  })

  it('lehnt ab, wenn keine einzige Aktion ausgewaehlt ist', () => {
    expect(
      canApplySelection({
        hasAnalysis: true,
        isStale: false,
        isProjectArchived: false,
        selected: createEmptySelection()
      })
    ).toBe(false)
  })
})

describe('canApplySelection - Kontextaktionen benoetigen "Neue Kontext-Version"', () => {
  it('lehnt ab, wenn createContextVersion aktiv ist, aber keine Unterkategorie ausgewaehlt wurde', () => {
    expect(
      canApplySelection({
        hasAnalysis: true,
        isStale: false,
        isProjectArchived: false,
        selected: { ...createEmptySelection(), createContextVersion: true }
      })
    ).toBe(false)
  })

  it('erlaubt die Uebernahme, wenn createContextVersion UND mindestens eine Unterkategorie ausgewaehlt sind', () => {
    expect(
      canApplySelection({
        hasAnalysis: true,
        isStale: false,
        isProjectArchived: false,
        selected: { ...createEmptySelection(), createContextVersion: true, contextIncludeCompletedWork: true }
      })
    ).toBe(true)
  })

  it('RC3: lehnt ab, wenn eine contextInclude-Option aktiv ist, waehrend createContextVersion false ist (versteckte Auswahl)', () => {
    expect(
      canApplySelection({
        hasAnalysis: true,
        isStale: false,
        isProjectArchived: false,
        selected: { ...createEmptySelection(), saveHistory: true, contextIncludeCompletedWork: true }
      })
    ).toBe(false)
  })
})

describe('canApplySelection - archivierte Projekte sind schreibgeschuetzt', () => {
  it('erlaubt keine Uebernahme, selbst bei vollstaendig gueltiger Auswahl', () => {
    expect(
      canApplySelection({
        hasAnalysis: true,
        isStale: false,
        isProjectArchived: true,
        selected: { ...createEmptySelection(), createContextVersion: true, contextIncludeCompletedWork: true }
      })
    ).toBe(false)
  })
})

describe('isAnalysisResultRelevant', () => {
  it('ein aktuelles Ergebnis mit unveraenderter Projekt-ID/Quelle/Text wird uebernommen', () => {
    expect(
      isAnalysisResultRelevant({
        isCurrentTicket: true,
        requestedProjectId: 1,
        currentProjectId: 1,
        requestedSource: 'CHATGPT',
        currentSource: 'CHATGPT',
        requestedRawResponse: 'Status: ACTIVE',
        currentRawResponse: 'Status: ACTIVE'
      })
    ).toBe(true)
  })

  it('RC5: eine abweichende Projekt-ID wird verworfen', () => {
    expect(
      isAnalysisResultRelevant({
        isCurrentTicket: true,
        requestedProjectId: 1,
        currentProjectId: 2,
        requestedSource: 'CHATGPT',
        currentSource: 'CHATGPT',
        requestedRawResponse: 'Status: ACTIVE',
        currentRawResponse: 'Status: ACTIVE'
      })
    ).toBe(false)
  })

  it('eine veraltete Analyse nach Quellenwechsel wird verworfen', () => {
    expect(
      isAnalysisResultRelevant({
        isCurrentTicket: true,
        requestedProjectId: 1,
        currentProjectId: 1,
        requestedSource: 'CHATGPT',
        currentSource: 'CLAUDE',
        requestedRawResponse: 'Status: ACTIVE',
        currentRawResponse: 'Status: ACTIVE'
      })
    ).toBe(false)
  })

  it('eine veraltete Analyse nach Rohtextaenderung wird verworfen', () => {
    expect(
      isAnalysisResultRelevant({
        isCurrentTicket: true,
        requestedProjectId: 1,
        currentProjectId: 1,
        requestedSource: 'CHATGPT',
        currentSource: 'CHATGPT',
        requestedRawResponse: 'Status: ACTIVE',
        currentRawResponse: 'Status: ACTIVE geaendert'
      })
    ).toBe(false)
  })

  it('ein durch eine neuere Analyse ueberholtes ODER invalidiertes Ticket wird verworfen, selbst bei unveraenderter Projekt-ID/Quelle/Text', () => {
    expect(
      isAnalysisResultRelevant({
        isCurrentTicket: false,
        requestedProjectId: 1,
        currentProjectId: 1,
        requestedSource: 'CHATGPT',
        currentSource: 'CHATGPT',
        requestedRawResponse: 'Status: ACTIVE',
        currentRawResponse: 'Status: ACTIVE'
      })
    ).toBe(false)
  })
})

describe('canApplySelection - gueltige einfache Auswahl', () => {
  it('erlaubt die Uebernahme bei "nur Verlauf speichern"', () => {
    expect(
      canApplySelection({
        hasAnalysis: true,
        isStale: false,
        isProjectArchived: false,
        selected: { ...createEmptySelection(), saveHistory: true }
      })
    ).toBe(true)
  })
})
