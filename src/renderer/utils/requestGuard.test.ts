import { describe, expect, it } from 'vitest'
import { LatestRequestGuard } from './requestGuard'

describe('LatestRequestGuard', () => {
  it('das erste und einzige Ticket ist aktuell', () => {
    const guard = new LatestRequestGuard()
    const ticket = guard.start()
    expect(guard.isCurrent(ticket)).toBe(true)
  })

  it('ein aelteres Ticket ist NICHT mehr aktuell, sobald ein neueres gestartet wurde', () => {
    const guard = new LatestRequestGuard()
    const first = guard.start()
    const second = guard.start()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })

  it('simuliert A -> B -> A: nur das zuletzt gestartete A-Ticket gilt, obwohl beide A-Anfragen dieselbe fachliche ID (projectId) betreffen', () => {
    const guard = new LatestRequestGuard()

    // Anfrage 1 fuer Projekt A startet.
    const ticketA1 = guard.start()
    // Direkt danach Projekt B.
    const ticketB = guard.start()
    // Direkt danach wieder Projekt A - eine fachlich "gleiche" ID wie
    // ticketA1, aber ein neues, hoeheres Ticket.
    const ticketA2 = guard.start()

    // Die alte Anfrage fuer A (ticketA1) loest sich zuletzt auf - ein reiner
    // ID-Vergleich (beide "A") wuerde das faelschlich als aktuell werten.
    expect(guard.isCurrent(ticketA1)).toBe(false)
    // Die B-Anfrage ist ebenfalls veraltet.
    expect(guard.isCurrent(ticketB)).toBe(false)
    // Nur die zweite, tatsaechlich zuletzt gestartete A-Anfrage gilt.
    expect(guard.isCurrent(ticketA2)).toBe(true)
  })

  it('drei Anfragen in Folge - nur die letzte gewinnt, unabhaengig von Ankunftsreihenfolge', () => {
    const guard = new LatestRequestGuard()
    const tickets = [guard.start(), guard.start(), guard.start()]
    expect(tickets.map((t) => guard.isCurrent(t))).toEqual([false, false, true])
  })

  it('invalidate() macht ein zuvor aktuelles Ticket ungueltig, ohne selbst ein neues Ticket zu vergeben (RC5-Korrektur)', () => {
    const guard = new LatestRequestGuard()
    const ticket = guard.start()
    expect(guard.isCurrent(ticket)).toBe(true)
    guard.invalidate()
    expect(guard.isCurrent(ticket)).toBe(false)
  })

  it('nach invalidate() kann eine neue Anfrage wieder ein aktuelles Ticket erhalten', () => {
    const guard = new LatestRequestGuard()
    const oldTicket = guard.start()
    guard.invalidate()
    const newTicket = guard.start()
    expect(guard.isCurrent(oldTicket)).toBe(false)
    expect(guard.isCurrent(newTicket)).toBe(true)
  })

  it('mehrmaliges Invalidieren bleibt monoton und deterministisch', () => {
    const guard = new LatestRequestGuard()
    const ticket = guard.start()
    guard.invalidate()
    guard.invalidate()
    guard.invalidate()
    expect(guard.isCurrent(ticket)).toBe(false)
    // Nach mehreren invalidate()-Aufrufen liefert eine neue start()-Anfrage
    // weiterhin ein eindeutiges, aktuelles Ticket - kein Ueberlaufen oder
    // Zuruecksetzen der Zaehlung.
    const freshTicket = guard.start()
    expect(guard.isCurrent(freshTicket)).toBe(true)
  })
})
