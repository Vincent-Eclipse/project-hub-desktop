import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  FolderNotFoundError,
  checkFolderStatus,
  normalizePath,
  pathsPointToSameLocation,
  resolveExistingFolder
} from './pathNormalization'

describe('normalizePath', () => {
  it('behandelt Windows-Pfade unterschiedlicher Gross-/Kleinschreibung als gleich', () => {
    const a = normalizePath('C:\\Users\\Leon\\Projects\\Hub', 'win32')
    const b = normalizePath('c:\\users\\leon\\projects\\hub', 'win32')
    expect(a.comparisonKey).toBe(b.comparisonKey)
  })

  it('behaelt die urspruengliche Schreibweise fuer die Anzeige bei', () => {
    const result = normalizePath('C:\\Users\\Leon\\Projects\\Hub', 'win32')
    expect(result.display).toContain('Projects')
    expect(result.display).not.toBe(result.comparisonKey)
  })

  it('normalisiert Rueckwaerts- zu Vorwaertsschraegstrichen im Vergleichs-Schluessel', () => {
    const result = normalizePath('C:\\Users\\Leon', 'win32')
    expect(result.comparisonKey).not.toContain('\\')
  })

  it('normalisiert abschliessende Trennzeichen unter Windows', () => {
    const a = normalizePath('C:\\Projekte\\Airport Career\\', 'win32')
    const b = normalizePath('C:\\Projekte\\Airport Career', 'win32')
    expect(a.comparisonKey).toBe(b.comparisonKey)
  })

  it('erhaelt Leerzeichen und Umlaute in der Anzeige', () => {
    const result = normalizePath('C:\\Projekte\\Flughafen Übergabe', 'win32')
    expect(result.display).toContain('Übergabe')
  })

  it('behandelt auf Nicht-Windows-Systemen unterschiedliche Gross-/Kleinschreibung als NICHT gleich', () => {
    const a = normalizePath('/home/user/Projects', 'linux')
    const b = normalizePath('/home/user/projects', 'linux')
    expect(a.comparisonKey).not.toBe(b.comparisonKey)
  })
})

describe('pathsPointToSameLocation', () => {
  it('erkennt identische Windows-Pfade trotz unterschiedlicher Schreibweise als Duplikat', () => {
    expect(
      pathsPointToSameLocation('D:\\Airport Career\\Backups', 'd:\\airport career\\backups\\', 'win32')
    ).toBe(true)
  })

  it('erkennt unterschiedliche Pfade als unterschiedlich', () => {
    expect(pathsPointToSameLocation('D:\\A', 'D:\\B', 'win32')).toBe(false)
  })
})

describe('resolveExistingFolder', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-folder-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('akzeptiert einen tatsaechlich existierenden Ordner', () => {
    const result = resolveExistingFolder(tmpDir)
    expect(result.display).toContain(path.basename(tmpDir))
  })

  it('wirft FolderNotFoundError fuer einen nicht existierenden Pfad', () => {
    const missing = path.join(tmpDir, 'existiert-nicht')
    expect(() => resolveExistingFolder(missing)).toThrow(FolderNotFoundError)
  })

  it('wirft FolderNotFoundError, wenn der Pfad eine Datei statt eines Verzeichnisses ist', () => {
    const filePath = path.join(tmpDir, 'datei.txt')
    fs.writeFileSync(filePath, 'Inhalt')
    expect(() => resolveExistingFolder(filePath)).toThrow(FolderNotFoundError)
  })

  it('loest relative Pfade gegen das Arbeitsverzeichnis auf', () => {
    const cwdBefore = process.cwd()
    try {
      process.chdir(tmpDir)
      const result = resolveExistingFolder('.')
      expect(path.isAbsolute(result.display)).toBe(true)
    } finally {
      process.chdir(cwdBefore)
    }
  })

  it('erkennt zwei Symlinks auf denselben Ordner ueber realpath als Duplikat (soweit Symlinks auf dem System unterstuetzt werden)', () => {
    const target = path.join(tmpDir, 'echter-ordner')
    fs.mkdirSync(target)
    const linkPath = path.join(tmpDir, 'verknuepfung')
    try {
      fs.symlinkSync(target, linkPath, 'dir')
    } catch {
      // Symlink-Erstellung kann auf manchen Systemen/Rechten fehlschlagen -
      // dann ist dieser Teil des Tests nicht sinnvoll pruefbar.
      return
    }
    const a = resolveExistingFolder(target)
    const b = resolveExistingFolder(linkPath)
    expect(a.comparisonKey).toBe(b.comparisonKey)
  })
})

describe('checkFolderStatus (RC4, Projektordner-Status)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-folder-status-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('AVAILABLE: ein tatsaechlich existierendes Verzeichnis', () => {
    expect(checkFolderStatus(tmpDir)).toBe('AVAILABLE')
  })

  it('MISSING: ein Pfad, der nicht (mehr) existiert', () => {
    const missing = path.join(tmpDir, 'existiert-nicht-mehr')
    expect(checkFolderStatus(missing)).toBe('MISSING')
  })

  it('MISSING: ein geloeschter, vormals existierender Ordner', () => {
    const target = path.join(tmpDir, 'wird-geloescht')
    fs.mkdirSync(target)
    fs.rmSync(target, { recursive: true, force: true })
    expect(checkFolderStatus(target)).toBe('MISSING')
  })

  it('INVALID: der Pfad existiert, ist aber inzwischen eine Datei statt eines Verzeichnisses', () => {
    const filePath = path.join(tmpDir, 'jetzt-eine-datei.txt')
    fs.writeFileSync(filePath, 'Inhalt')
    expect(checkFolderStatus(filePath)).toBe('INVALID')
  })

  it('INACCESSIBLE: ein injizierter Berechtigungsfehler (EACCES) wird als unzugreifbar erkannt', () => {
    // Ein echter Berechtigungsfehler laesst sich in dieser Testumgebung
    // (laeuft ggf. als root) nicht zuverlaessig ueber echte Dateisystem-
    // Rechte erzeugen - stattdessen wird die injizierbare statFn genutzt, um
    // exakt das Fehlerverhalten zu simulieren, das ein echtes EACCES
    // ausloesen wuerde.
    const eacces = () => {
      const err = new Error('permission denied') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    }
    expect(checkFolderStatus(tmpDir, eacces)).toBe('INACCESSIBLE')
  })

  it('INACCESSIBLE: ein unbekannter/sonstiger Dateisystemfehler wird vorsichtig als unzugreifbar behandelt statt zu crashen', () => {
    const unknownError = () => {
      throw new Error('irgendein unerwarteter Fehler ohne .code')
    }
    expect(checkFolderStatus(tmpDir, unknownError)).toBe('INACCESSIBLE')
  })

  it('MISSING: ein injiziertes ENOTDIR (ein Pfadbestandteil ist eine Datei) wird wie fehlend behandelt', () => {
    const enotdir = () => {
      const err = new Error('not a directory') as NodeJS.ErrnoException
      err.code = 'ENOTDIR'
      throw err
    }
    expect(checkFolderStatus(tmpDir, enotdir)).toBe('MISSING')
  })
})
