import Database from 'better-sqlite3'

/**
 * Oeffnet eine SQLite-Datenbank mit den fuer Eclipse Project Hub
 * verbindlichen Pragmas. `filePath` kann auch ':memory:' sein - das wird
 * in den Unit-Tests genutzt, um ohne Electron-Runtime und ohne
 * Dateisystem-Zugriff gegen eine echte better-sqlite3-Instanz zu testen.
 */
export function openDatabase(filePath: string): Database.Database {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  return db
}
