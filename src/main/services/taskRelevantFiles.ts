import { TASK_RELEVANT_FILES_MAX_ITEMS, TASK_RELEVANT_FILE_PATH_MAX_LENGTH } from '@shared/types'

// Aufgaben duerfen "relevante Dateien" als rein logische, projektrelative
// Pfadangaben speichern (Meilenstein 4.2 - Abschnitt "Relevant Files"). Diese
// Funktionen fuehren AUSSCHLIESSLICH String-Validierung durch - kein
// fs.stat/readFile/existsSync, kein path.resolve gegen ein echtes
// Projektverzeichnis, kein Oeffnen, Aendern oder Ausfuehren irgendeiner
// Datei. Das ist bewusst so: Relevant Files sind Planungs-Metadaten, keine
// Dateizugriffs-Berechtigung - letztere bleibt einer zukuenftigen
// Capabilities-/Permissions-Schicht vorbehalten.

export class InvalidRelevantFileError extends Error {
  constructor(reason: string) {
    super(`Ungueltiger relevanter Dateipfad: ${reason}`)
    this.name = 'InvalidRelevantFileError'
  }
}

const DRIVE_QUALIFIED = /^[A-Za-z]:/
const NUL_CHARACTER = String.fromCharCode(0)

/**
 * Validiert und normalisiert einen einzelnen logischen, projektrelativen
 * Pfad. Lehnt mindestens ab: leere Pfade, NUL-Zeichen, CR-/LF-Zeichen,
 * fuehrenden/nachgestellten Leerraum, absolute Windows-Pfade,
 * laufwerksqualifizierte Pfade, UNC-Pfade, absolute POSIX-Pfade und
 * ".."-Traversal. Normalisiert Backslashes zu Slashes, damit gleichwertige
 * Eingaben identisch gespeichert werden - reine Textumformung, kein
 * Dateisystemzugriff.
 *
 * ChatGPT-Review Fix 4: die Oberflaeche zeigt/bearbeitet relevante Dateien
 * als "eine je Zeile" (Textarea, per '\n' verbunden/aufgeteilt und je Zeile
 * getrimmt). Ein an dieser Stelle akzeptierter, aber nicht bereits
 * kanonischer Wert (enthaelt CR/LF, oder fuehrenden/nachgestellten
 * Leerraum) koennte beim naechsten Laden/Bearbeiten in der Oberflaeche
 * unbemerkt veraendert werden (Round-Trip-Bruch) oder als mehrere/kuerzere
 * Zeilen erscheinen. Deshalb wird hier NICHT stillschweigend getrimmt -
 * ein nicht-kanonischer Wert wird abgelehnt, nie unsichtbar veraendert.
 * Leerzeichen INNERHALB eines Pfads (z. B. "my folder/file.ts") bleiben
 * ausdruecklich erlaubt.
 */
export function validateRelevantFilePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidRelevantFileError('muss ein Text sein.')
  if (raw.length === 0) throw new InvalidRelevantFileError('darf nicht leer sein.')
  if (raw.length > TASK_RELEVANT_FILE_PATH_MAX_LENGTH) {
    throw new InvalidRelevantFileError(`ist zu lang (max. ${TASK_RELEVANT_FILE_PATH_MAX_LENGTH} Zeichen).`)
  }
  if (raw.includes(NUL_CHARACTER)) throw new InvalidRelevantFileError('enthaelt ein NUL-Zeichen.')
  if (raw.includes('\r')) throw new InvalidRelevantFileError('enthaelt ein Wagenruecklauf-Zeichen (CR).')
  if (raw.includes('\n')) throw new InvalidRelevantFileError('enthaelt ein Zeilenumbruch-Zeichen (LF).')
  if (/^\s/.test(raw)) throw new InvalidRelevantFileError('darf nicht mit Leerraum beginnen.')
  if (/\s$/.test(raw)) throw new InvalidRelevantFileError('darf nicht mit Leerraum enden.')
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    throw new InvalidRelevantFileError('UNC-Pfade sind nicht erlaubt.')
  }
  if (DRIVE_QUALIFIED.test(raw)) {
    throw new InvalidRelevantFileError('laufwerksqualifizierte/absolute Windows-Pfade sind nicht erlaubt.')
  }
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    throw new InvalidRelevantFileError('absolute Pfade sind nicht erlaubt.')
  }
  const segments = raw.split(/[\\/]+/)
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new InvalidRelevantFileError('enthaelt leere Pfadsegmente.')
  }
  if (segments.some((segment) => segment === '..')) {
    throw new InvalidRelevantFileError('Pfad-Traversal ("..") ist nicht erlaubt.')
  }
  return segments.join('/')
}

/** Validiert eine vollstaendige Liste relevanter Dateien (Reihenfolge bleibt erhalten, keine Deduplizierung erzwungen). */
export function validateRelevantFilesList(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new InvalidRelevantFileError('Liste muss ein Array sein.')
  if (raw.length > TASK_RELEVANT_FILES_MAX_ITEMS) {
    throw new InvalidRelevantFileError(`enthaelt zu viele Eintraege (max. ${TASK_RELEVANT_FILES_MAX_ITEMS}).`)
  }
  return raw.map((entry) => validateRelevantFilePath(entry))
}
