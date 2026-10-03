import { describe, expect, it } from 'vitest'
import { PARSER_VERSION, normalizeActor, normalizeStatus, parseResponse } from './responseImportParser'

describe('parseResponse - deutsche Markdown-Ueberschriften', () => {
  it('erkennt "## Erledigt" als completedWork', () => {
    const result = parseResponse('## Erledigt\n- Login implementiert\n- Tests geschrieben')
    expect(result.completedWork).toEqual(['Login implementiert', 'Tests geschrieben'])
  })

  it('erkennt "### Tests" (Ebene 3) als testResults', () => {
    const result = parseResponse('### Tests\n- 12 von 12 bestanden')
    expect(result.testResults).toEqual(['12 von 12 bestanden'])
  })

  it('erkennt "## Offene Punkte" und "## Nächster Schritt"', () => {
    const result = parseResponse('## Offene Punkte\n- Review ausstehend\n\n## Nächster Schritt\n- Deploy vorbereiten')
    expect(result.openItems).toEqual(['Review ausstehend'])
    expect(result.nextStep).toEqual(['Deploy vorbereiten'])
  })
})

describe('parseResponse - englische Markdown-Ueberschriften', () => {
  it('erkennt "## Completed" / "## Done"', () => {
    expect(parseResponse('## Completed\n- Shipped feature X').completedWork).toEqual(['Shipped feature X'])
    expect(parseResponse('## Done\n- Shipped feature Y').completedWork).toEqual(['Shipped feature Y'])
  })

  it('erkennt "## Changed Files" / "## Files Changed"', () => {
    expect(parseResponse('## Changed Files\n- a.ts').changedFiles).toEqual(['a.ts'])
    expect(parseResponse('## Files Changed\n- b.ts').changedFiles).toEqual(['b.ts'])
  })

  it('erkennt "## Open Items" und "## Next Step"', () => {
    const result = parseResponse('## Open Items\n- Follow up needed\n\n## Next Step\n- Ship it')
    expect(result.openItems).toEqual(['Follow up needed'])
    expect(result.nextStep).toEqual(['Ship it'])
  })
})

describe('parseResponse - einfache deutsche Labels', () => {
  it('erkennt "Status:" als suggestedStatus', () => {
    const result = parseResponse('Status: ACTIVE')
    expect(result.suggestedStatus).toBe('ACTIVE')
    expect(result.suggestedStatusRaw).toBe('ACTIVE')
  })

  it('erkennt "Aktueller Schritt:" und "Nächste Aktion:" getrennt', () => {
    const result = parseResponse('Aktueller Schritt: Schritt 7\nNächste Aktion: Review anfragen')
    expect(result.suggestedCurrentStep).toBe('Schritt 7')
    expect(result.suggestedNextAction).toBe('Review anfragen')
  })

  it('erkennt "Nächster Akteur:"', () => {
    const result = parseResponse('Nächster Akteur: Leon')
    expect(result.suggestedNextActor).toBe('LEON')
  })

  it('erkennt einzeilige Inhalts-Labels wie "Geänderte Dateien:" und "Blocker:"', () => {
    const result = parseResponse('Geänderte Dateien: src/main.ts\nBlocker: Wartet auf Zugangsdaten')
    expect(result.changedFiles).toEqual(['src/main.ts'])
    expect(result.blockers).toEqual(['Wartet auf Zugangsdaten'])
  })
})

describe('parseResponse - einfache englische Labels', () => {
  it('erkennt "Next Actor:" und "Current Step:"', () => {
    const result = parseResponse('Next Actor: Claude\nCurrent Step: Step 3')
    expect(result.suggestedNextActor).toBe('CLAUDE')
    expect(result.suggestedCurrentStep).toBe('Step 3')
  })
})

describe('parseResponse - mehrere Kategorien und Listen unter Ueberschriften', () => {
  it('parst eine vollstaendige, gemischte Antwort korrekt', () => {
    const response = [
      '## Zusammenfassung',
      'Schritt 7 wurde umgesetzt.',
      '',
      '## Erledigt',
      '- ManagerCardSystem Basis',
      '- Unit-Tests',
      '',
      '## Geänderte Dateien',
      '- src/ManagerCardSystem.lua',
      '- src/tests/ManagerCardSystem.test.lua',
      '',
      '## Tests',
      '- 8 von 8 bestanden',
      '',
      '## Offene Punkte',
      '- Balancing pruefen',
      '',
      'Status: TESTING',
      'Nächster Akteur: Leon'
    ].join('\n')

    const result = parseResponse(response)
    expect(result.summary).toEqual(['Schritt 7 wurde umgesetzt.'])
    expect(result.completedWork).toEqual(['ManagerCardSystem Basis', 'Unit-Tests'])
    expect(result.changedFiles).toEqual(['src/ManagerCardSystem.lua', 'src/tests/ManagerCardSystem.test.lua'])
    expect(result.testResults).toEqual(['8 von 8 bestanden'])
    expect(result.openItems).toEqual(['Balancing pruefen'])
    expect(result.suggestedStatus).toBe('TESTING')
    expect(result.suggestedNextActor).toBe('LEON')
  })
})

describe('parseResponse - normaler Absatztext und nicht zugeordneter Inhalt', () => {
  it('legt Fliesstext ohne vorherige Ueberschrift/Label unter unassigned ab', () => {
    const result = parseResponse('Das ist nur ein normaler Satz ohne Struktur.')
    expect(result.unassigned).toEqual(['Das ist nur ein normaler Satz ohne Struktur.'])
    expect(result.completedWork).toEqual([])
  })

  it('erkennt keine zufaelligen Woerter mitten in einem Absatz als Struktur', () => {
    const result = parseResponse('Wir sind aktiv dabei, den Status der Blocker zu klaeren.')
    expect(result.unassigned).toEqual(['Wir sind aktiv dabei, den Status der Blocker zu klaeren.'])
    expect(result.suggestedStatus).toBeNull()
    expect(result.blockers).toEqual([])
  })
})

describe('parseResponse - Codeblöcke werden ignoriert', () => {
  it('interpretiert Ueberschriften/Labels innerhalb eines Codeblocks nicht als Struktur', () => {
    const response = ['## Erledigt', '```', '## Status: FAKE', 'Status: ERROR', '```', '- echtes Element'].join('\n')
    const result = parseResponse(response)
    expect(result.completedWork).toEqual(['echtes Element'])
    expect(result.suggestedStatus).toBeNull()
  })

  it('nimmt Codeblock-Inhalte nicht in unassigned auf', () => {
    const response = ['```', 'const x = 1', 'irgendein Codekommentar', '```'].join('\n')
    const result = parseResponse(response)
    expect(result.unassigned).toEqual([])
  })
})

describe('parseResponse - aehnlich klingende Begriffe werden nicht faelschlich erkannt', () => {
  it('"Statusbericht:" wird nicht als "Status:" erkannt', () => {
    const result = parseResponse('Statusbericht: alles im Plan')
    expect(result.suggestedStatus).toBeNull()
    expect(result.unassigned).toEqual(['Statusbericht: alles im Plan'])
  })

  it('"## Erledigte Punkte diese Woche" wird nicht als "Erledigt"-Ueberschrift erkannt', () => {
    // RC5-Korrektur: dieser Test erwartete bislang faelschlich, dass die
    // unbekannte Ueberschrift selbst verschwindet (nur "Punkt A" blieb
    // unter unassigned uebrig). Das widersprach der seit RC3 verbindlichen
    // Regel, dass eine NICHT erkannte Ueberschrift selbst (in ihrer
    // sichtbaren Schreibweise inkl. "#"-Zeichen) unter unassigned
    // erhalten bleibt, gefolgt vom nachfolgenden Inhalt in derselben
    // Reihenfolge (siehe die "unbekannte Markdown-Ueberschriften bleiben
    // sichtbar"-Tests weiter unten). Die Produktionslogik war bereits
    // korrekt - nur diese Testerwartung war veraltet und wurde jetzt an
    // die bereits verbindliche Regel angepasst, kein neuer Sonderfall im
    // Parser noetig.
    const result = parseResponse('## Erledigte Punkte diese Woche\n- Punkt A')
    // "Erledigte Punkte diese Woche" ist NICHT identisch mit dem bekannten
    // Synonym "Erledigt" - die Ueberschrift wird deshalb korrekt nicht als
    // bekannte Erledigt-Kategorie erkannt, completedWork bleibt leer.
    expect(result.completedWork).toEqual([])
    // Die unbekannte Ueberschrift selbst bleibt sichtbar erhalten,
    // gefolgt vom Listeneintrag in der Ursprungsreihenfolge.
    expect(result.unassigned).toEqual(['## Erledigte Punkte diese Woche', 'Punkt A'])
  })
})

describe('parseResponse - Status-Normalisierung', () => {
  it('lehnt unbekannten Status ab, zeigt ihn aber als Rohtext', () => {
    const result = parseResponse('Status: shipped-and-done')
    expect(result.suggestedStatus).toBeNull()
    expect(result.suggestedStatusRaw).toBe('shipped-and-done')
  })

  it('"blocked" wird NICHT automatisch zu ERROR', () => {
    const result = parseResponse('Status: blocked')
    expect(result.suggestedStatus).toBeNull()
    expect(result.suggestedStatusRaw).toBe('blocked')
  })

  it('normalisiert gueltige Statuswerte case-insensitive', () => {
    expect(normalizeStatus('active')).toBe('ACTIVE')
    expect(normalizeStatus('Testing')).toBe('TESTING')
    expect(normalizeStatus('DONE')).toBe('COMPLETED')
    expect(normalizeStatus('waiting on human')).toBe('WAITING_ON_HUMAN')
    expect(normalizeStatus('waiting_on_human')).toBe('WAITING_ON_HUMAN')
  })
})

describe('parseResponse - Akteurs-Normalisierung', () => {
  it('lehnt unbekannten Akteur ab, zeigt ihn aber als Rohtext', () => {
    const result = parseResponse('Nächster Akteur: Bob')
    expect(result.suggestedNextActor).toBeNull()
    expect(result.suggestedNextActorRaw).toBe('Bob')
  })

  it('normalisiert gueltige Akteurswerte case-insensitive', () => {
    expect(normalizeActor('chatgpt')).toBe('CHATGPT')
    expect(normalizeActor('Claude')).toBe('CLAUDE')
    expect(normalizeActor('LEON')).toBe('LEON')
    expect(normalizeActor('none')).toBe('NONE')
  })
})

describe('parseResponse - Reihenfolge, Deduplizierung und Originaltext', () => {
  it('behaelt die urspruengliche Reihenfolge innerhalb einer Kategorie', () => {
    const result = parseResponse('## Erledigt\n- Erstens\n- Zweitens\n- Drittens')
    expect(result.completedWork).toEqual(['Erstens', 'Zweitens', 'Drittens'])
  })

  it('dedupliziert identische Eintraege ohne unterschiedliche Inhalte zu verlieren', () => {
    const result = parseResponse('## Erledigt\n- Login implementiert\n- Login implementiert\n- Tests geschrieben')
    expect(result.completedWork).toEqual(['Login implementiert', 'Tests geschrieben'])
  })

  it('veraendert den Originaltext an keiner Stelle - der Aufrufer erhaelt weiterhin den rohen String separat', () => {
    const raw = '## Erledigt\n- Login implementiert'
    parseResponse(raw)
    // parseResponse mutiert die Eingabe nicht (kein In-Place-Trim etc.)
    expect(raw).toBe('## Erledigt\n- Login implementiert')
  })
})

describe('parseResponse - leere Eingabe und Groessenlimit', () => {
  it('liefert ein vollstaendig leeres Ergebnis fuer eine leere Eingabe', () => {
    const result = parseResponse('')
    expect(result.completedWork).toEqual([])
    expect(result.unassigned).toEqual([])
    expect(result.suggestedStatus).toBeNull()
    expect(result.contextAddition).toBe('')
  })

  it('parst auch eine 200.000 Zeichen lange Antwort ohne Fehler (Groessenlimit wird von der aufrufenden Service-/IPC-Ebene durchgesetzt, nicht vom Parser selbst)', () => {
    const longLine = 'x'.repeat(200_000)
    expect(() => parseResponse(`## Erledigt\n- ${longLine}`)).not.toThrow()
  })
})

describe('parseResponse - contextAddition', () => {
  it('baut nur aus tatsaechlich vorhandenen, nicht-leeren Kategorien auf (keine leeren Ueberschriften)', () => {
    const result = parseResponse('## Erledigt\n- Sache A')
    expect(result.contextAddition).toContain('### Erledigte Arbeiten')
    expect(result.contextAddition).toContain('- Sache A')
    expect(result.contextAddition).not.toContain('### Geänderte Dateien')
    expect(result.contextAddition).not.toContain('### Blocker')
  })
})

describe('PARSER_VERSION', () => {
  it('ist eine feste, positive Ganzzahl', () => {
    expect(Number.isInteger(PARSER_VERSION)).toBe(true)
    expect(PARSER_VERSION).toBeGreaterThan(0)
  })
})

describe('parseResponse - mehrdeutige Metadaten werden nicht geraten (RC2-Korrektur)', () => {
  it('identische Statuswiederholung (nur Gross-/Kleinschreibung unterschiedlich) bleibt eindeutig', () => {
    const result = parseResponse('Status: ACTIVE\nStatus: active')
    expect(result.suggestedStatus).toBe('ACTIVE')
    expect(result.suggestedStatusAmbiguous).toBe(false)
    expect(result.suggestedStatusCandidates).toEqual(['ACTIVE'])
  })

  it('widersprüchliche Statuswerte liefern KEINEN Status (kein Last-value-wins)', () => {
    const result = parseResponse('Status: ACTIVE\nStatus: PAUSED')
    expect(result.suggestedStatus).toBeNull()
    expect(result.suggestedStatusAmbiguous).toBe(true)
    expect(result.suggestedStatusCandidates).toEqual(['ACTIVE', 'PAUSED'])
  })

  it('identische Akteurswiederholung bleibt eindeutig', () => {
    const result = parseResponse('Nächster Akteur: Leon\nNächster Akteur: LEON')
    expect(result.suggestedNextActor).toBe('LEON')
    expect(result.suggestedNextActorAmbiguous).toBe(false)
  })

  it('widersprüchliche Akteure liefern KEINE Änderung', () => {
    const result = parseResponse('Nächster Akteur: Leon\nNächster Akteur: Claude')
    expect(result.suggestedNextActor).toBeNull()
    expect(result.suggestedNextActorAmbiguous).toBe(true)
    expect(result.suggestedNextActorCandidates).toEqual(['Leon', 'Claude'])
  })

  it('widersprüchliche "Aktueller Schritt"-Werte liefern KEINE Änderung', () => {
    const result = parseResponse('Aktueller Schritt: Schritt 2\nAktueller Schritt: Schritt 3')
    expect(result.suggestedCurrentStep).toBeNull()
    expect(result.suggestedCurrentStepAmbiguous).toBe(true)
    expect(result.suggestedCurrentStepCandidates).toEqual(['Schritt 2', 'Schritt 3'])
  })

  it('widersprüchliche "Nächste Aktion"-Werte liefern KEINE Änderung', () => {
    const result = parseResponse('Nächste Aktion: Tests starten\nNächste Aktion: Release erstellen')
    expect(result.suggestedNextAction).toBeNull()
    expect(result.suggestedNextActionAmbiguous).toBe(true)
    expect(result.suggestedNextActionCandidates).toEqual(['Tests starten', 'Release erstellen'])
  })

  it('bei Mehrdeutigkeit bleibt der Rohtext ueber die Kandidatenliste sichtbar, auch wenn kein Wert uebernommen wird', () => {
    const result = parseResponse('Status: ACTIVE\nStatus: PAUSED')
    expect(result.suggestedStatusRaw).toBeNull() // kein EINZELNER Rohtext, da mehrdeutig
    expect(result.suggestedStatusCandidates.length).toBe(2) // aber die Kandidaten bleiben sichtbar
  })
})

describe('parseResponse - Tilden-Codeblöcke (RC2-Korrektur)', () => {
  it('ignoriert Inhalte innerhalb eines Tilden-Fence genauso wie bei Backticks', () => {
    const response = ['## Erledigt', '~~~', 'Status: ACTIVE', '~~~', '- echtes Element'].join('\n')
    const result = parseResponse(response)
    expect(result.completedWork).toEqual(['echtes Element'])
    expect(result.suggestedStatus).toBeNull()
  })

  it('unterstuetzt eine Sprachangabe nach dem Tilden-Fence', () => {
    const response = ['~~~text', 'Status: ACTIVE', '~~~'].join('\n')
    const result = parseResponse(response)
    expect(result.suggestedStatus).toBeNull()
  })

  it('unterstuetzt eine Sprachangabe nach dem Backtick-Fence', () => {
    const response = ['```lua', 'Status: ACTIVE', '```'].join('\n')
    const result = parseResponse(response)
    expect(result.suggestedStatus).toBeNull()
  })

  it('normaler Text nach einem geschlossenen Tilden-Fence wird wieder normal erkannt', () => {
    const response = ['~~~', 'ignoriert', '~~~', 'Status: TESTING'].join('\n')
    const result = parseResponse(response)
    expect(result.suggestedStatus).toBe('TESTING')
  })

  it('ein Backtick-Fence innerhalb eines offenen Tilden-Fence schliesst diesen NICHT', () => {
    const response = ['~~~', '```', 'Status: ACTIVE', '~~~', 'Status: TESTING'].join('\n')
    const result = parseResponse(response)
    // Der Tilden-Block bleibt bis zur ZWEITEN Tilden-Zeile offen; danach
    // wird "Status: TESTING" wieder normal erkannt.
    expect(result.suggestedStatus).toBe('TESTING')
  })
})

describe('parseResponse - Fence-Laenge korrekt verfolgt (RC3-Korrektur)', () => {
  it('drei Backticks oeffnen, drei schliessen', () => {
    const r = parseResponse(['```', 'Status: ACTIVE', '```', 'Status: TESTING'].join('\n'))
    expect(r.suggestedStatus).toBe('TESTING')
  })

  it('vier Backticks werden NICHT durch drei geschlossen', () => {
    const r = parseResponse(['````', 'Status: ACTIVE', '```', 'Status: TESTING'].join('\n'))
    // Der Block bleibt bis zum Textende offen (keine gueltige Schliessung
    // vorhanden) - beide Status-Zeilen sind Codeblock-Inhalt.
    expect(r.suggestedStatus).toBeNull()
  })

  it('vier Backticks werden durch vier geschlossen', () => {
    const r = parseResponse(['````', 'Status: ACTIVE', '````', 'Status: TESTING'].join('\n'))
    expect(r.suggestedStatus).toBe('TESTING')
  })

  it('vier Backticks werden durch fuenf oder mehr geschlossen', () => {
    const r = parseResponse(['````', 'Status: ACTIVE', '`````', 'Status: TESTING'].join('\n'))
    expect(r.suggestedStatus).toBe('TESTING')
  })

  it('drei Tilden oeffnen und drei schliessen', () => {
    const r = parseResponse(['~~~', 'Status: ACTIVE', '~~~', 'Status: TESTING'].join('\n'))
    expect(r.suggestedStatus).toBe('TESTING')
  })

  it('vier Tilden werden NICHT durch drei geschlossen', () => {
    const r = parseResponse(['~~~~', 'Status: ACTIVE', '~~~', 'Status: TESTING'].join('\n'))
    expect(r.suggestedStatus).toBeNull()
  })

  it('vier Tilden werden durch vier oder mehr geschlossen', () => {
    const r = parseResponse(['~~~~', 'Status: ACTIVE', '~~~~~', 'Status: TESTING'].join('\n'))
    expect(r.suggestedStatus).toBe('TESTING')
  })

  it('Backtick-Fence wird nicht durch Tilde geschlossen', () => {
    const r = parseResponse(['```', 'Status: ACTIVE', '~~~', 'Status: TESTING'].join('\n'))
    expect(r.suggestedStatus).toBeNull()
  })

  it('Tilde-Fence wird nicht durch Backtick geschlossen', () => {
    const r = parseResponse(['~~~', 'Status: ACTIVE', '```', 'Status: TESTING'].join('\n'))
    expect(r.suggestedStatus).toBeNull()
  })

  it('ein schliessender Fence mit zusaetzlichem Text schliesst NICHT', () => {
    const r = parseResponse(['```', 'Status: ACTIVE', '```not-a-closing-fence', 'Status: TESTING'].join('\n'))
    expect(r.suggestedStatus).toBeNull()
  })

  it('Whitespace nach einem gueltigen schliessenden Fence ist erlaubt', () => {
    const r = parseResponse(['```', 'Status: ACTIVE', '```   ', 'Status: TESTING'].join('\n'))
    expect(r.suggestedStatus).toBe('TESTING')
  })

  it('Sprachangabe beim Oeffnen wird akzeptiert und landet nicht als Inhalt', () => {
    const r = parseResponse(['```typescript', 'Status: ACTIVE', '```', 'Status: TESTING'].join('\n'))
    expect(r.suggestedStatus).toBe('TESTING')
    expect(r.unassigned).not.toContain('```typescript')
  })

  it('Status-Label innerhalb eines offenen Fences wird nicht erkannt', () => {
    const r = parseResponse(['````', 'Status: ACTIVE', '```', 'Status: PAUSED', '````'].join('\n'))
    expect(r.suggestedStatus).toBeNull()
  })

  it('Akteur-Label innerhalb eines offenen Fences wird nicht erkannt', () => {
    const r = parseResponse(['````', 'Nächster Akteur: Leon', '```', '````'].join('\n'))
    expect(r.suggestedNextActor).toBeNull()
  })

  it('normaler Text nach einer gueltigen Schliessung wird wieder erkannt', () => {
    const r = parseResponse(['````', 'ignoriert', '````', '## Erledigt', '- Sache A'].join('\n'))
    expect(r.completedWork).toEqual(['Sache A'])
  })

  it('ein nicht geschlossener Block haelt den gesamten restlichen Text zurueck', () => {
    const r = parseResponse(['````', 'Status: ACTIVE', '## Erledigt', '- Sache A', 'Nächster Akteur: Leon'].join('\n'))
    expect(r.suggestedStatus).toBeNull()
    expect(r.completedWork).toEqual([])
    expect(r.suggestedNextActor).toBeNull()
    expect(r.unassigned).toEqual([])
  })
})

describe('parseResponse - unbekannte Markdown-Ueberschriften bleiben sichtbar (RC3-Korrektur)', () => {
  it('unbekannte Ebene-2-Ueberschrift bleibt selbst in unassigned erhalten', () => {
    const r = parseResponse('## Deployment Notes\n- Release vorbereiten')
    expect(r.unassigned).toEqual(['## Deployment Notes', 'Release vorbereiten'])
  })

  it('unbekannte Ebene-6-Ueberschrift bleibt selbst in unassigned erhalten', () => {
    const r = parseResponse('###### Sonstiges\nEin Hinweis')
    expect(r.unassigned).toEqual(['###### Sonstiges', 'Ein Hinweis'])
  })

  it('unbekannte Ueberschrift mit Absatztext', () => {
    const r = parseResponse('## Deployment Notes\nBitte vor dem naechsten Release pruefen.')
    expect(r.unassigned).toEqual(['## Deployment Notes', 'Bitte vor dem naechsten Release pruefen.'])
  })

  it('unbekannte Ueberschrift mit Liste - korrekte Reihenfolge', () => {
    const r = parseResponse('## Deployment Notes\n- Erstens\n- Zweitens')
    expect(r.unassigned).toEqual(['## Deployment Notes', 'Erstens', 'Zweitens'])
  })

  it('bekannte Ueberschriften erscheinen NICHT zusaetzlich in unassigned', () => {
    const r = parseResponse('## Erledigt\n- Sache A\n## Deployment Notes\n- Sache B')
    expect(r.completedWork).toEqual(['Sache A'])
    expect(r.unassigned).toEqual(['## Deployment Notes', 'Sache B'])
    expect(r.unassigned).not.toContain('## Erledigt')
  })

  it('eine unbekannte Ueberschrift innerhalb eines Codeblocks wird ignoriert', () => {
    const r = parseResponse(['```', '## Deployment Notes', '```', '- danach'].join('\n'))
    expect(r.unassigned).not.toContain('## Deployment Notes')
    expect(r.unassigned).toEqual(['danach'])
  })
})

describe('parseResponse - Laengenlimits fuer aktuellen Schritt/naechste Aktion (RC3-Korrektur)', () => {
  it('genau 500 Zeichen bei "Aktueller Schritt" bleibt gueltig', () => {
    const value = 'x'.repeat(500)
    const r = parseResponse(`Aktueller Schritt: ${value}`)
    expect(r.suggestedCurrentStep).toBe(value)
    expect(r.suggestedCurrentStepTooLong).toBe(false)
  })

  it('501 Zeichen bei "Aktueller Schritt" wird abgelehnt, bleibt aber als Kandidat sichtbar', () => {
    const value = 'x'.repeat(501)
    const r = parseResponse(`Aktueller Schritt: ${value}`)
    expect(r.suggestedCurrentStep).toBeNull()
    expect(r.suggestedCurrentStepTooLong).toBe(true)
    expect(r.suggestedCurrentStepCandidates).toEqual([value])
  })

  it('genau 500 Zeichen bei "Nächste Aktion" bleibt gueltig', () => {
    const value = 'y'.repeat(500)
    const r = parseResponse(`Nächste Aktion: ${value}`)
    expect(r.suggestedNextAction).toBe(value)
    expect(r.suggestedNextActionTooLong).toBe(false)
  })

  it('501 Zeichen bei "Nächste Aktion" wird abgelehnt, bleibt aber als Kandidat sichtbar', () => {
    const value = 'y'.repeat(501)
    const r = parseResponse(`Nächste Aktion: ${value}`)
    expect(r.suggestedNextAction).toBeNull()
    expect(r.suggestedNextActionTooLong).toBe(true)
    expect(r.suggestedNextActionCandidates).toEqual([value])
  })
})
