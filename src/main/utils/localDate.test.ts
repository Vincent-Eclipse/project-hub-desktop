import { describe, expect, it } from 'vitest'
import { formatLocalDate } from './localDate'

describe('formatLocalDate', () => {
  it('formatiert ein normales Datum als YYYY-MM-DD', () => {
    expect(formatLocalDate(new Date(2026, 7, 3, 14, 0, 0))).toBe('2026-08-03')
  })

  it('verwendet das LOKALE Kalenderdatum kurz nach Mitternacht, nicht das UTC-Datum', () => {
    // 2026-08-03 00:30 in der lokalen Zeitzone des Konstruktor-Aufrufs -
    // new Date(year, monthIndex, day, hours, ...) interpretiert seine
    // Argumente immer lokal (im Gegensatz zu new Date(isoString), das UTC
    // interpretiert) - genau das entspricht dem in Abschnitt 7 der
    // RC2-Vorgabe beschriebenen Fall.
    const localMidnightThirty = new Date(2026, 7, 3, 0, 30, 0)
    expect(formatLocalDate(localMidnightThirty)).toBe('2026-08-03')
  })

  it('pad(d)et einstellige Monate und Tage mit einer fuehrenden Null', () => {
    expect(formatLocalDate(new Date(2026, 0, 5, 10, 0, 0))).toBe('2026-01-05')
  })

  it('liefert NICHT das UTC-Datum, wenn sich lokales und UTC-Datum unterscheiden wuerden', () => {
    // new Date(2026, 7, 3, 0, 30) ist lokal der 3. August - der UTC-Tag
    // waere je nach positiver Zeitzone (z. B. CEST, UTC+2) noch der 2.
    // August. formatLocalDate() muss auf jeden Fall das LOKALE Datum
    // liefern, unabhaengig davon, in welcher Zeitzone die Testumgebung
    // tatsaechlich laeuft - die Funktion selbst verwendet ausschliesslich
    // die lokalen Getter (getFullYear/getMonth/getDate), niemals
    // toISOString()/getUTC*.
    const local = new Date(2026, 7, 3, 0, 30, 0)
    const viaLocalGetters = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(
      local.getDate()
    ).padStart(2, '0')}`
    expect(formatLocalDate(local)).toBe(viaLocalGetters)
  })
})
