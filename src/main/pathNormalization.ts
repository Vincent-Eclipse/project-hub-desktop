import fs from 'fs'
import path from 'path'
import type { FolderStatus } from '@shared/types'

// Reine Pfad-Normalisierungslogik OHNE 'electron'-Import. Dieses Modul
// laesst sich dadurch in einer normalen Node-Testumgebung (Vitest) testen,
// ohne dass Electron installiert/geladen sein muss - auch wenn das Modul
// selbst 'fs' fuer echte Existenzpruefungen nutzt (das ist reines
// Node-Core-API, keine Electron-Abhaengigkeit).

export interface NormalizedPath {
  /** Anzeigbare, kanonische Form - behaelt die urspruengliche Schreibweise. */
  display: string
  /** Kleingeschriebener, schraegstrich-normalisierter Vergleichsschluessel (nur Windows case-insensitive). */
  comparisonKey: string
}

/**
 * Normalisiert einen Dateisystempfad fuer Anzeige- und Vergleichszwecke.
 *
 * - loest relative Pfade gegen das aktuelle Arbeitsverzeichnis auf
 * - entfernt abschliessende Pfadtrenner (bis auf Laufwerkswurzeln)
 * - Windows: Dateisysteme sind case-insensitive, aber case-preserving.
 *   Der Vergleichsschluessel wird daher kleingeschrieben und auf
 *   Vorwaertsschraegstriche normalisiert; die Anzeige behaelt Gross-/
 *   Kleinschreibung sowie Leerzeichen und Umlaute unveraendert bei.
 * - Nicht-Windows: Dateisysteme sind in der Regel case-sensitive, daher
 *   bleibt die Gross-/Kleinschreibung auch im Vergleichsschluessel erhalten.
 */
export function normalizePath(
  rawPath: string,
  platform: NodeJS.Platform = process.platform
): NormalizedPath {
  const isWindowsLike = platform === 'win32'
  const resolved = isWindowsLike ? path.win32.resolve(rawPath) : path.posix.resolve(rawPath)
  const display = resolved
  const slashForm = resolved.replace(/\\/g, '/')
  const comparisonKey = isWindowsLike ? slashForm.toLowerCase() : slashForm
  return { display, comparisonKey }
}

export function pathsPointToSameLocation(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return normalizePath(a, platform).comparisonKey === normalizePath(b, platform).comparisonKey
}

export class FolderNotFoundError extends Error {
  constructor(rawPath: string) {
    super(`Der Ordner "${rawPath}" existiert nicht oder ist kein Verzeichnis.`)
    this.name = 'FolderNotFoundError'
  }
}

/**
 * Prueft, ob `rawPath` ein tatsaechlich existierendes Verzeichnis ist, loest
 * dabei Symlinks/Junctions nach Moeglichkeit ueber realpath auf (zwei
 * unterschiedliche Links auf denselben echten Ordner sollen als Duplikat
 * erkannt werden) und liefert die normalisierte Anzeige-/Vergleichsform.
 *
 * Wirft FolderNotFoundError, wenn der Pfad nicht existiert oder keine
 * Verzeichnis ist. Nutzt ausschliesslich echte Dateisystem-Aufrufe auf dem
 * tatsaechlich laufenden Betriebssystem (kein simuliertes `platform`-Arg -
 * realpath/Existenzpruefung ergeben fuer ein fremdes Zielsystem keinen Sinn).
 */
export function resolveExistingFolder(rawPath: string): NormalizedPath {
  const resolved = path.resolve(rawPath)

  let statResult: fs.Stats
  try {
    statResult = fs.statSync(resolved)
  } catch {
    throw new FolderNotFoundError(rawPath)
  }
  if (!statResult.isDirectory()) {
    throw new FolderNotFoundError(rawPath)
  }

  let canonical = resolved
  try {
    // Loest Symlinks/Junctions auf, damit zwei unterschiedliche
    // Schreibweisen/Verknuepfungen desselben Ordners denselben
    // Vergleichsschluessel ergeben.
    canonical = fs.realpathSync(resolved)
  } catch {
    // Wenn realpath fehlschlaegt (z. B. Berechtigungsproblem), wird der
    // bereits verifizierte aufgeloeste Pfad als Fallback verwendet - lieber
    // eine etwas schwaechere Duplikat-Erkennung als ein harter Fehler fuer
    // einen Ordner, der laut statSync() nachweislich existiert.
  }

  return normalizePath(canonical)
}

/**
 * Ermittelt den aktuellen Status eines bereits gespeicherten Projektordners
 * (RC4, Punkt 12). Anders als resolveExistingFolder() (die beim AUSWAEHLEN
 * eines neuen Ordners einen harten Fehler wirft, wenn er nicht existiert)
 * wirft diese Funktion NIE - ein fehlender/ungueltiger/unzugaenglicher
 * gespeicherter Ordner ist ein normaler, anzuzeigender Zustand, kein
 * Ausnahmefall, der die App zum Abstuerzen bringen darf.
 *
 * `statFn` ist per Default `fs.statSync`, kann aber fuer Tests injiziert
 * werden - insbesondere um INACCESSIBLE (Berechtigungsfehler) zuverlaessig
 * zu simulieren, unabhaengig davon, mit welchem Betriebssystem-Benutzer die
 * Tests tatsaechlich laufen (ein als root laufender Testprozess wuerde einen
 * echten Berechtigungsfehler oft gar nicht erzeugen).
 */
export function checkFolderStatus(
  rawPath: string,
  statFn: (targetPath: string) => fs.Stats = fs.statSync
): FolderStatus {
  let statResult: fs.Stats
  try {
    statResult = statFn(rawPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // ENOENT: Pfad existiert nicht mehr. ENOTDIR: ein Bestandteil des Pfads
    // ist mittlerweile eine Datei statt eines Verzeichnisses - in beiden
    // Faellen ist der Ordner an der erwarteten Stelle nicht mehr auffindbar.
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'MISSING'
    // EACCES/EPERM (fehlende Berechtigung) und jeder andere, nicht naeher
    // bekannte Dateisystemfehler werden vorsichtig als "nicht zugreifbar"
    // behandelt statt die App abstuerzen zu lassen.
    return 'INACCESSIBLE'
  }
  return statResult.isDirectory() ? 'AVAILABLE' : 'INVALID'
}
