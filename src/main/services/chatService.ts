import type Database from 'better-sqlite3'
import type { AddChatMessageInput, ChatAuthor, ChatMessage } from '@shared/types'
import { getProjectById, ProjectArchivedError } from './projectsService'
import { logEvent } from './eventLogService'
import { assignChatMessageToSession } from './sessionService'

interface ChatMessageRow {
  id: number
  project_id: number
  author: string
  content: string
  created_at: string
}

function mapRow(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    projectId: row.project_id,
    author: row.author as ChatAuthor,
    content: row.content,
    createdAt: row.created_at
  }
}

export function listChatMessages(db: Database.Database, projectId: number): ChatMessage[] {
  getProjectById(db, projectId)
  const rows = db
    .prepare('SELECT * FROM chat_messages WHERE project_id = ? ORDER BY id ASC')
    .all(projectId) as ChatMessageRow[]
  return rows.map(mapRow)
}

/**
 * Gemeinsame interne Speicherlogik fuer beide oeffentlichen Varianten unten
 * (manueller Verlaufseintrag UND Antwort-Import) - Projektschutz-,
 * Transaktions-, Event- und Mapping-Logik bleiben dadurch garantiert
 * identisch. Unterscheidet sich nur darin, OB `content` vor dem Speichern
 * getrimmt wird.
 */
function insertChatMessage(
  db: Database.Database,
  input: { projectId: number; author: ChatAuthor; content: string; sessionId?: number | null },
  storedContent: string
): ChatMessage {
  const project = getProjectById(db, input.projectId)
  if (project.isArchived) throw new ProjectArchivedError(input.projectId)

  const messageId = db.transaction(() => {
    const result = db
      .prepare('INSERT INTO chat_messages (project_id, author, content) VALUES (?, ?, ?)')
      .run(input.projectId, input.author, storedContent)
    const id = Number(result.lastInsertRowid)
    logEvent(db, {
      projectId: input.projectId,
      type: 'CHAT_MESSAGE_ADDED',
      payload: { messageId: id, author: input.author }
    })
    // Optionale Sitzungszuordnung innerhalb derselben Transaktion.
    if (input.sessionId !== undefined && input.sessionId !== null) {
      assignChatMessageToSession(db, { sessionId: input.sessionId, chatMessageId: id })
    }
    return id
  })()

  const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId) as ChatMessageRow
  return mapRow(row)
}

export function addChatMessage(db: Database.Database, input: AddChatMessageInput): ChatMessage {
  // Bestehendes, unveraendertes Verhalten fuer manuell erfasste
  // Verlaufseintraege (ChatTab.tsx): fuehrende/abschliessende Leerzeichen
  // werden getrimmt.
  return insertChatMessage(db, input, input.content.trim())
}

/**
 * Speichert eine importierte Original-Antwort EXAKT, string-identisch und
 * OHNE trim() im Projektverlauf (Meilenstein 2, RC2-Korrektur - RC1 nutzte
 * faelschlich das trimmende addChatMessage() auch fuer Importe). Nutzt
 * dieselbe Projektschutz-, Transaktions-, Event- und Mapping-Logik wie
 * addChatMessage() (siehe insertChatMessage() oben) - keine zweite,
 * parallele Verlaufstabelle. Bewusst NICHT als eigener generischer
 * IPC-Kanal exponiert - ausschliesslich fuer den internen Gebrauch durch
 * responseImportService.ts.
 */
export function addImportedChatMessage(
  db: Database.Database,
  input: { projectId: number; author: ChatAuthor; content: string; sessionId?: number | null }
): ChatMessage {
  return insertChatMessage(db, input, input.content)
}

/** Liefert die letzten `limit` Chat-Eintraege in chronologischer Reihenfolge, formatiert als Klartext. */
export function formatRecentChatAsPlainText(
  db: Database.Database,
  projectId: number,
  limit = 10
): string {
  const rows = db
    .prepare('SELECT * FROM chat_messages WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .all(projectId, limit) as ChatMessageRow[]
  const chronological = rows.reverse()
  if (chronological.length === 0) return '(noch keine Verlaufseintraege)'
  return chronological
    .map((row) => `[${row.created_at}] ${row.author}: ${row.content}`)
    .join('\n')
}
