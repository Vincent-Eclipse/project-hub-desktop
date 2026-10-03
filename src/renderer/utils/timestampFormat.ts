// Formatiert in der lokalen Zeitzone des Nutzers im deutschen Datumsformat
// (konsistent zur uebrigen fest-deutschsprachigen Oberflaeche). Der exakte
// ISO-Wert bleibt unveraendert gespeichert - der Aufrufer transportiert ihn
// weiterhin separat ueber <time datetime="...">.
const FORMATTER = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

export function formatWorkTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return FORMATTER.format(date)
}
