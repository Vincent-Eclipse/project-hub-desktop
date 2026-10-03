// RC2-Korrektur (Abschnitt 7 der RC2-Vorgabe): `new Date().toISOString()`
// liefert ein UTC-Datum - kurz nach Mitternacht in Deutschland (CET/CEST)
// kann das faelschlich noch das Datum des Vortags sein. Diese reine
// Hilfsfunktion liefert stattdessen das LOKALE Kalenderdatum der
// uebergebenen `Date`-Instanz (per getFullYear()/getMonth()/getDate(), also
// in der Zeitzone, in der der Node-/Electron-Prozess laeuft - bei einem
// lokalen Desktop-Programm die Zeitzone des Nutzers). Wird ausschliesslich
// fuer die menschenlesbare Ueberschrift des Import-Updates verwendet
// (responseImportService.ts) - alle Datenbank-Zeitstempel bleiben
// unveraendert im bestehenden UTC-/ISO-Format (strftime in SQLite).
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
