import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3'

const MAX_BACKUPS_TO_KEEP = 10

/**
 * Erstellt vor einer Migration eine konsistente Kopie der Datenbankdatei.
 * `db.backup()` (better-sqlite3, nutzt SQLites Online-Backup-API) erzeugt
 * eine korrekte Kopie auch im WAL-Modus, ohne die App zu blockieren.
 * Alte Backups werden auf die letzten MAX_BACKUPS_TO_KEEP begrenzt.
 */
export async function backupDatabaseBeforeMigration(
  db: Database.Database,
  backupDir: string
): Promise<string> {
  fs.mkdirSync(backupDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(backupDir, `eclipse-hub-pre-migration-${timestamp}.sqlite3`)

  await db.backup(backupPath)
  pruneOldBackups(backupDir)
  return backupPath
}

function pruneOldBackups(backupDir: string): void {
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('eclipse-hub-pre-migration-') && f.endsWith('.sqlite3'))
    .map((f) => ({ name: f, fullPath: path.join(backupDir, f) }))
    .sort((a, b) => (a.name < b.name ? 1 : -1)) // neueste zuerst (Zeitstempel im Namen)

  for (const stale of files.slice(MAX_BACKUPS_TO_KEEP)) {
    fs.rmSync(stale.fullPath, { force: true })
  }
}
