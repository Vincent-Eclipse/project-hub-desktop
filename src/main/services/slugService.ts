import type Database from 'better-sqlite3'

const UMLAUT_MAP: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  Ä: 'Ae',
  Ö: 'Oe',
  Ü: 'Ue',
  ß: 'ss'
}

// Unicode-Bereich der kombinierenden diakritischen Zeichen (U+0300-U+036F),
// die nach einer NFKD-Zerlegung uebrig bleiben (z. B. fuer Akzente ausserhalb
// der deutschen Umlaute). Als Escape-Sequenz geschrieben statt als
// woertliches Zeichen im Quelltext, um Encoding-Mehrdeutigkeiten zu vermeiden.
const COMBINING_DIACRITICS = /[\u0300-\u036f]/g

/**
 * Wandelt einen Projektnamen in eine URL-/dateifreundliche Kleinbuchstaben-
 * Form um. Deutsche Umlaute werden sinnvoll transliteriert (nicht einfach
 * entfernt), Leerzeichen werden zu Bindestrichen, alles andere Nicht-
 * alphanumerische wird ebenfalls zu Bindestrichen, doppelte Bindestriche
 * werden zusammengefasst, fuehrende/abschliessende Bindestriche entfernt.
 */
export function slugify(input: string): string {
  const withUmlauts = input.replace(/[äöüÄÖÜß]/g, (ch) => UMLAUT_MAP[ch] ?? ch)
  return withUmlauts
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Erzeugt einen fuer die projects-Tabelle eindeutigen Slug aus einem
 * Projektnamen. Bei Kollision wird "-2", "-3", ... angehaengt
 * (z. B. airport-career, airport-career-2). Wird ausschliesslich beim
 * Anlegen aufgerufen - eine spaetere Umbenennung veraendert den Slug NICHT
 * mehr (updateProject fasst die slug-Spalte bewusst nie an).
 */
export function generateUniqueSlug(db: Database.Database, name: string): string {
  const base = slugify(name) || 'projekt'
  const existing = new Set(
    (db.prepare('SELECT slug FROM projects').all() as Array<{ slug: string }>).map((r) => r.slug)
  )

  if (!existing.has(base)) return base

  let counter = 2
  while (existing.has(`${base}-${counter}`)) {
    counter += 1
  }
  return `${base}-${counter}`
}
