import type Database from 'better-sqlite3'
import crypto from 'crypto'
import { MIGRATION_001_INIT } from './001_init'
import { MIGRATION_002_RESPONSE_IMPORTS } from './002_response_imports'
import { MIGRATION_003_SESSIONS_CONTINUATIONS } from './003_sessions_continuations'
import { MIGRATION_004_PROJECT_RULES } from './004_project_rules'
import { MIGRATION_005_TASKS } from './005_tasks'
import { MIGRATION_006_WORK_REQUESTS } from './006_work_requests'
import { MIGRATION_007_APPLY_BATCHES } from './007_apply_batches'

export interface Migration {
  version: number
  name: string
  sql: string
}

// Migrationen werden hier in aufsteigender Reihenfolge registriert.
// Bewusste Entscheidung (Memo Punkt 12.6): Migrationen sind vorwaerts-only.
// SQLites eingeschraenktes ALTER TABLE macht generische Rollbacks
// unzuverlaessig; stattdessen wird vor jeder Migration ein Datei-Backup
// erstellt (siehe backup.ts), aus dem im Fehlerfall manuell wiederhergestellt
// werden kann.
export const MIGRATIONS: Migration[] = [
  MIGRATION_001_INIT,
  MIGRATION_002_RESPONSE_IMPORTS,
  MIGRATION_003_SESSIONS_CONTINUATIONS,
  MIGRATION_004_PROJECT_RULES,
  MIGRATION_005_TASKS,
  MIGRATION_006_WORK_REQUESTS,
  MIGRATION_007_APPLY_BATCHES
]

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql, 'utf-8').digest('hex')
}

export class MigrationIntegrityError extends Error {}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `)
}

/**
 * Ermittelt, ob beim naechsten runMigrations()-Aufruf tatsaechlich neue
 * Migrationen angewendet wuerden - OHNE etwas zu veraendern. Wird beim
 * Start genutzt, um zu entscheiden, ob ein fehlgeschlagenes Backup fatal
 * sein muss (nur relevant, wenn wirklich migriert werden soll) oder nur
 * eine Warnung verdient (kein Migrationsbedarf).
 */
export function getPendingMigrationVersions(db: Database.Database): number[] {
  ensureMigrationsTable(db)
  const appliedRows = db.prepare('SELECT version FROM _migrations').all() as Array<{
    version: number
  }>
  const appliedVersions = new Set(appliedRows.map((r) => r.version))
  return MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).map((m) => m.version)
}

/**
 * Wendet alle noch nicht angewendeten Migrationen an. Jede Migration laeuft
 * in einer eigenen Transaktion - schlaegt eine SQL-Anweisung fehl, wird die
 * gesamte Migration zurueckgerollt und die Funktion wirft einen Fehler.
 * Bereits angewendete Migrationen werden per Checksum gegen den
 * registrierten Quelltext geprueft, um unbemerkte Drift zwischen
 * ausgelieferter App-Version und bestehender Datenbank zu erkennen.
 */
export function runMigrations(db: Database.Database): { applied: number[] } {
  ensureMigrationsTable(db)

  const appliedRows = db
    .prepare('SELECT version, name, checksum FROM _migrations ORDER BY version ASC')
    .all() as Array<{ version: number; name: string; checksum: string }>

  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]))
  const appliedNow: number[] = []

  for (const migration of MIGRATIONS) {
    const existing = appliedByVersion.get(migration.version)
    const expectedChecksum = checksum(migration.sql)

    if (existing) {
      if (existing.checksum !== expectedChecksum) {
        throw new MigrationIntegrityError(
          `Migration ${migration.version} (${migration.name}) wurde bereits angewendet, ` +
            `aber der gespeicherte Pruefsummen-Wert weicht vom aktuellen Migrationstext ab. ` +
            `Datenbank und App-Version passen moeglicherweise nicht zusammen.`
        )
      }
      continue
    }

    const applyMigration = db.transaction(() => {
      db.exec(migration.sql)
      db.prepare(
        'INSERT INTO _migrations (version, name, checksum) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, expectedChecksum)
    })

    applyMigration()
    appliedNow.push(migration.version)
  }

  return { applied: appliedNow }
}
