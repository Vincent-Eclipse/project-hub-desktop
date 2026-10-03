import type Database from 'better-sqlite3'
import type { EventLogEntry, EventType } from '@shared/types'

interface EventLogRow {
  id: number
  project_id: number | null
  type: string
  payload_json: string
  created_at: string
}

function mapRow(row: EventLogRow): EventLogEntry {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>
  } catch {
    payload = {}
  }
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type as EventType,
    payload,
    createdAt: row.created_at
  }
}

/**
 * Schreibt einen Ereignisprotokoll-Eintrag. `payload` darf ausschliesslich
 * kleine Metadaten enthalten (IDs, geaenderte Feldnamen, Rollen, o.ae.) -
 * niemals vollstaendige Kontext-Inhalte oder Chat-Nachrichtentexte. Diese
 * Funktion validiert das inhaltlich nicht selbst (das obliegt den
 * aufrufenden Services), haelt sich aber an diese Konvention ueberall,
 * wo sie aufgerufen wird.
 */
export function logEvent(
  db: Database.Database,
  input: { projectId: number | null; type: EventType; payload: Record<string, unknown> }
): void {
  db.prepare('INSERT INTO event_log_entries (project_id, type, payload_json) VALUES (?, ?, ?)').run(
    input.projectId,
    input.type,
    JSON.stringify(input.payload)
  )
}

export function listEventLog(
  db: Database.Database,
  filter?: { projectId?: number; type?: EventType }
): EventLogEntry[] {
  let sql = 'SELECT * FROM event_log_entries'
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter?.projectId !== undefined) {
    conditions.push('project_id = ?')
    params.push(filter.projectId)
  }
  if (filter?.type !== undefined) {
    conditions.push('type = ?')
    params.push(filter.type)
  }
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
  sql += ' ORDER BY id ASC'

  const rows = db.prepare(sql).all(...params) as EventLogRow[]
  return rows.map(mapRow)
}
