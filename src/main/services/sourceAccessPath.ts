// Meilenstein 4.7B.1 - EINZIGER, wiederverwendbarer STRICT-Validator fuer
// tatsaechlichen Dateisystem-Quellzugriff (Lesen jetzt, spaeter auch
// CREATE-Kandidatenpfade). Bewusst NICHT taskRelevantFiles.ts - jene Datei
// validiert reine Planungs-Metadaten (siehe dortiger Kommentar), niemals
// eine tatsaechliche Dateisystem-Zugriffs-Autoritaet.
//
// Kanonische Form: vorwaerts-schraegstrich-getrennter, projekt-relativer
// Pfad (Beispiel: "src/main/example.ts"). Unsicherer Input wird ABGELEHNT,
// NIEMALS "bereinigt" - kein Trimmen, kein Normalisieren, kein Aufloesen von
// Traversal. Ein abgelehnter Pfad bleibt abgelehnt.
//
// Zwei Ebenen in EINEM Validator:
//   1. SYNTAX (Teil C der Vorgabe): reine Zeichen-/Segment-Form.
//   2. AUSSCHLUSS (Teil D der Vorgabe): Verteidigung-in-der-Tiefe gegen
//      offensichtliche Geheimnis-/Kontroll-/generierte Pfade (.git, .claude,
//      .env*, offensichtliche Schluessel-/Credential-Dateien, node_modules/
//      dist/build/out/coverage). Das ist KEINE Provider-Freigabe-Autorisierung
//      - nur eine zusaetzliche, absichtlich KLEINE Sperrliste (siehe
//      Datei-Kommentar der Vorgabe: "Do NOT create an enormous filename
//      blacklist").

export class InvalidSourceAccessPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSourceAccessPathError'
  }
}

// Grosszuegig genug fuer jeden realistischen Quelldateipfad, aber begrenzt -
// dieselbe Groessenordnung wie TASK_RELEVANT_FILE_PATH_MAX_LENGTH.
const MAX_PATH_LENGTH = 1024

// \x00-\x1f deckt NUL (\x00) und alle ASCII-Steuerzeichen ab.
const CONTROL_CHAR_RE = /[\x00-\x1f]/
// < > : " | ? * sind unter Windows in Dateinamen ungueltig; ':' deckt auch
// Colon-/ADS-Syntax (z. B. "file.txt:secret") ab, '?'/'*' sind zugleich die
// Wildcard-Zeichen.
const INVALID_SEGMENT_CHAR_RE = /[<>:"|?*]/
const DRIVE_PREFIX_RE = /^[A-Za-z]:/
const TRAILING_DOT_OR_SPACE_RE = /[ .]$/

// Windows reservierte Geraetenamen (case-insensitiv, unabhaengig von einer
// Dateiendung - "con.txt" ist ebenso reserviert wie "CON").
const RESERVED_WINDOWS_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
])

// Verzeichnis-Segmente, die AN JEDER Stelle im Pfad kategorisch abgelehnt
// werden - bewusst KLEIN (siehe Datei-Kommentar oben). Ordinaere
// Entwicklungsdateien (package.json, tsconfig, Migrationen, Skripte, Tests,
// Dokumentation) bleiben ausdruecklich zulaessig.
const EXCLUDED_DIRECTORY_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  '.claude',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage'
])

// .env/.env.* muss als kategorischer SEGMENT-Ausschluss gelten, nicht nur
// als Dateiname-Muster - sonst koennten Pfade wie ".env/secrets.ts" oder
// "config/.env.production/token.ts" den Ausschluss umgehen, obwohl das
// eingefrorene Design Pfade INNERHALB von .env/.env.* kategorisch ablehnt.
// Geprueft gegen JEDES Segment (case-insensitiv), nicht nur den Dateinamen.
const EXCLUDED_SEGMENT_PATTERNS: readonly RegExp[] = [/^\.env$/i, /^\.env\..+$/i]

// Offensichtliche Geheimnis-/Credential-Dateinamen-Muster - keine riesige
// Blacklist, nur die in der Vorgabe explizit genannten Kategorien (private
// Schluessel/Zertifikate, bekannte Credential-Stores, offensichtliche
// Auth-Token-Stores). Bewusst primaer dateiname-orientiert (nicht pro
// Segment) - anders als .env/.env.* oben stellen diese Muster keine
// plausible Verzeichnis-Form dar; eine Segment-weite Anwendung wuerde hier
// keinen zusaetzlichen Schutz bieten, nur unnoetige false positives
// riskieren (siehe Vorgabe: "Do NOT create an enormous filename blacklist").
const EXCLUDED_FILENAME_PATTERNS: readonly RegExp[] = [
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /^id_rsa$/i,
  /^id_dsa$/i,
  /^id_ecdsa$/i,
  /^id_ed25519$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^credentials(\.json)?$/i
]

function assertSyntax(raw: string): void {
  if (raw.length === 0) throw new InvalidSourceAccessPathError('Der Pfad darf nicht leer sein.')
  if (raw.length > MAX_PATH_LENGTH) {
    throw new InvalidSourceAccessPathError(`Der Pfad ist zu lang (max. ${MAX_PATH_LENGTH} Zeichen).`)
  }
  if (CONTROL_CHAR_RE.test(raw)) {
    throw new InvalidSourceAccessPathError('Der Pfad enthaelt ein NUL- oder ASCII-Steuerzeichen.')
  }
  // Kanonische Form ist ausschliesslich Vorwaertsschraegstrich-getrennt - ein
  // Backslash wird niemals interpretiert/normalisiert, sondern lehnt den
  // gesamten Pfad ab. Das deckt zugleich Windows-Geraete-/Extended-Pfade
  // (\\?\..., \\.\...) und UNC-Pfade (\\server\share) ab, da diese
  // ausnahmslos mit Backslashes beginnen.
  if (raw.includes('\\')) {
    throw new InvalidSourceAccessPathError('Backslashes sind nicht erlaubt - die kanonische Form ist vorwaerts-schraegstrich-getrennt.')
  }
  if (raw.startsWith('/')) {
    throw new InvalidSourceAccessPathError('Ein fuehrender Schraegstrich (absoluter Pfad) ist nicht erlaubt.')
  }
  if (raw.startsWith('//')) {
    throw new InvalidSourceAccessPathError('UNC-artige Pfade sind nicht erlaubt.')
  }
  if (DRIVE_PREFIX_RE.test(raw)) {
    throw new InvalidSourceAccessPathError('Laufwerksbuchstaben-/laufwerksrelative Pfade sind nicht erlaubt.')
  }

  const segments = raw.split('/')
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new InvalidSourceAccessPathError('Der Pfad enthaelt ein leeres Segment (doppelter Trenner oder abschliessender Schraegstrich).')
    }
    if (segment === '.' || segment === '..') {
      throw new InvalidSourceAccessPathError('"."- oder ".."-Segmente sind nicht erlaubt.')
    }
    if (INVALID_SEGMENT_CHAR_RE.test(segment)) {
      throw new InvalidSourceAccessPathError(`Ungueltiges Zeichen in Pfadsegment "${segment}".`)
    }
    if (TRAILING_DOT_OR_SPACE_RE.test(segment)) {
      throw new InvalidSourceAccessPathError(`Pfadsegment "${segment}" darf nicht mit Punkt/Leerzeichen enden.`)
    }
    const baseName = segment.includes('.') ? segment.slice(0, segment.indexOf('.')) : segment
    if (RESERVED_WINDOWS_NAMES.has(baseName.toUpperCase())) {
      throw new InvalidSourceAccessPathError(`Pfadsegment "${segment}" ist ein reservierter Windows-Geraetename.`)
    }
  }
}

function assertNotExcluded(raw: string): void {
  const segments = raw.split('/')
  for (const segment of segments) {
    if (EXCLUDED_DIRECTORY_SEGMENTS.has(segment.toLowerCase())) {
      throw new InvalidSourceAccessPathError('Der Pfad liegt innerhalb eines kategorisch ausgeschlossenen Verzeichnisses.')
    }
    if (EXCLUDED_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))) {
      throw new InvalidSourceAccessPathError('Der Pfad liegt innerhalb von oder repraesentiert .env/.env.* und ist kategorisch ausgeschlossen.')
    }
  }
  const filename = segments[segments.length - 1]
  if (EXCLUDED_FILENAME_PATTERNS.some((pattern) => pattern.test(filename))) {
    throw new InvalidSourceAccessPathError('Der Dateiname entspricht einem ausgeschlossenen Geheimnis-/Credential-Muster.')
  }
}

/**
 * Validiert EINEN Pfad vollstaendig (Syntax + kategorischer Ausschluss) und
 * gibt ihn UNVERAENDERT zurueck. Wirft bei jedem unsicheren/ausgeschlossenen
 * Input - niemals stillschweigendes Bereinigen/Normalisieren.
 */
export function validateSourceAccessPath(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new InvalidSourceAccessPathError('Der Pfad muss ein Text sein.')
  }
  assertSyntax(raw)
  assertNotExcluded(raw)
  return raw
}

/**
 * Case-insensitive Duplikat-/Alias-Pruefung fuer eine bereits einzeln
 * validierte Pfadliste (siehe Vorgabe: "case-insensitive aliases where a
 * list is validated" - Windows-Dateisysteme sind case-insensitive, zwei
 * unterschiedlich geschriebene Eintraege duerfen nicht als zwei
 * unterschiedliche Ziele behandelt werden).
 */
export function assertNoCaseInsensitiveDuplicatePaths(paths: readonly string[], contextLabel: string): void {
  const seen = new Set<string>()
  for (const entry of paths) {
    const key = entry.toLowerCase()
    if (seen.has(key)) {
      throw new InvalidSourceAccessPathError(`${contextLabel} enthaelt doppelte Pfade (auch Gross-/Kleinschreibungs-Alias): "${entry}".`)
    }
    seen.add(key)
  }
}
