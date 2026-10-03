import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type Database from 'better-sqlite3'
import { openDatabase } from './connection'
import { runMigrations } from './migrations'
import { backupDatabaseBeforeMigration } from './backup'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-backup-test-'))
})

afterEach(() => {
  // Setzt voraus, dass jeder Test seine better-sqlite3-Verbindungen bereits
  // selbst geschlossen hat (try/finally in den Tests unten) - unter Windows
  // schlaegt das Entfernen einer noch offenen Datenbankdatei sonst mit
  // EBUSY fehl. Kein sleep, kein Retry-Loop als Ersatz fuer korrektes close().
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Legt einen minimalen, gueltigen Projekt-Datensatz an (name/slug/project_type sind NOT NULL im aktuellen Schema). */
function insertProjectFixture(db: Database.Database, name: string, slug: string): number {
  const result = db
    .prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)')
    .run(name, slug, 'Test')
  return Number(result.lastInsertRowid)
}

describe('backupDatabaseBeforeMigration', () => {
  it('erstellt eine funktionierende Kopie der Datenbank mit allen Daten', async () => {
    const dbPath = path.join(tmpDir, 'db.sqlite3')
    const db = openDatabase(dbPath)
    let restored: Database.Database | null = null
    try {
      runMigrations(db)
      insertProjectFixture(db, 'Zu sicherndes Projekt', 'zu-sicherndes-projekt')

      const backupDir = path.join(tmpDir, 'backups')
      const backupPath = await backupDatabaseBeforeMigration(db, backupDir)

      expect(fs.existsSync(backupPath)).toBe(true)

      restored = openDatabase(backupPath)
      const row = restored.prepare('SELECT name FROM projects').get() as { name: string }
      expect(row.name).toBe('Zu sicherndes Projekt')
    } finally {
      // Beide Verbindungen werden auch bei einer fehlgeschlagenen Assertion
      // oder einem Fehler oberhalb sicher geschlossen, BEVOR afterEach den
      // temporaeren Ordner entfernt.
      restored?.close()
      db.close()
    }
  })

  it('behaelt nur die letzten 10 Backups', async () => {
    const dbPath = path.join(tmpDir, 'db.sqlite3')
    const db = openDatabase(dbPath)
    try {
      runMigrations(db)
      const backupDir = path.join(tmpDir, 'backups')

      for (let i = 0; i < 12; i++) {
        // Eindeutige Dateinamen erzwingen (Zeitstempel-Aufloesung).
        fs.mkdirSync(backupDir, { recursive: true })
        const manualName = path.join(
          backupDir,
          `eclipse-hub-pre-migration-2024-01-01T00-00-${String(i).padStart(2, '0')}-000Z.sqlite3`
        )
        fs.writeFileSync(manualName, 'dummy')
      }

      await backupDatabaseBeforeMigration(db, backupDir)

      const remaining = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith('eclipse-hub-pre-migration-'))
      expect(remaining.length).toBeLessThanOrEqual(10)
      // Alle verbliebenen Dateien folgen weiterhin dem erwarteten
      // Backup-Namensmuster - keine fremden/kaputten Dateinamen uebrig.
      for (const name of remaining) {
        expect(name).toMatch(/^eclipse-hub-pre-migration-.+\.sqlite3$/)
      }
    } finally {
      db.close()
    }
  })
})
