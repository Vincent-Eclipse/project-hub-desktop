import { openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrations'
import type Database from 'better-sqlite3'

/** Erstellt eine frische In-Memory-Datenbank mit allen Migrationen angewendet - fuer Tests. */
export function createTestDb(): Database.Database {
  const db = openDatabase(':memory:')
  runMigrations(db)
  return db
}
