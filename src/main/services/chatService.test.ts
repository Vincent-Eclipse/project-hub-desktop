import { describe, expect, it } from 'vitest'
import { createTestDb } from '../testUtils/testDb'
import { createProject, archiveProject, ProjectArchivedError } from './projectsService'
import { addChatMessage, addImportedChatMessage, formatRecentChatAsPlainText, listChatMessages } from './chatService'
import { listEventLog } from './eventLogService'
import { createSession } from './sessionService'
import { ChatMessageProviderMismatchError } from './sessionErrors'

function newProject(db: ReturnType<typeof createTestDb>) {
  return createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
}

describe('chatService', () => {
  it('speichert und listet Nachrichten in chronologischer Reihenfolge', () => {
    const db = createTestDb()
    const project = newProject(db)
    addChatMessage(db, { projectId: project.id, author: 'LEON', content: 'Erste Nachricht' })
    addChatMessage(db, { projectId: project.id, author: 'CLAUDE', content: 'Zweite Nachricht' })

    const messages = listChatMessages(db, project.id)
    expect(messages.map((m) => m.content)).toEqual(['Erste Nachricht', 'Zweite Nachricht'])
  })

  it('erlaubt SYSTEM als Autor', () => {
    const db = createTestDb()
    const project = newProject(db)
    const message = addChatMessage(db, {
      projectId: project.id,
      author: 'SYSTEM',
      content: 'Automatischer Hinweis'
    })
    expect(message.author).toBe('SYSTEM')
  })

  it('verhindert neue Nachrichten fuer archivierte Projekte', () => {
    const db = createTestDb()
    const project = newProject(db)
    archiveProject(db, project.id)
    expect(() =>
      addChatMessage(db, { projectId: project.id, author: 'LEON', content: 'Sollte fehlschlagen' })
    ).toThrow(ProjectArchivedError)
  })

  it('die Fehlermeldung bei einer archivierten Chat-Ablehnung erwaehnt keine Kontext-Versionen', () => {
    const db = createTestDb()
    const project = newProject(db)
    archiveProject(db, project.id)
    try {
      addChatMessage(db, { projectId: project.id, author: 'LEON', content: 'Sollte fehlschlagen' })
      throw new Error('haette werfen muessen')
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectArchivedError)
      expect((err as Error).message).not.toContain('Kontext-Version')
    }
  })

  it('schreibt ein CHAT_MESSAGE_ADDED-Ereignis', () => {
    const db = createTestDb()
    const project = newProject(db)
    addChatMessage(db, { projectId: project.id, author: 'LEON', content: 'Test' })
    const events = listEventLog(db, { projectId: project.id, type: 'CHAT_MESSAGE_ADDED' })
    expect(events).toHaveLength(1)
  })

  it('formatRecentChatAsPlainText liefert einen lesbaren Platzhalter ohne Eintraege', () => {
    const db = createTestDb()
    const project = newProject(db)
    expect(formatRecentChatAsPlainText(db, project.id)).toContain('keine Verlaufseintraege')
  })

  it('formatRecentChatAsPlainText begrenzt auf die letzten N Eintraege in chronologischer Reihenfolge', () => {
    const db = createTestDb()
    const project = newProject(db)
    for (let i = 1; i <= 5; i++) {
      addChatMessage(db, { projectId: project.id, author: 'LEON', content: `Nachricht ${i}` })
    }
    const text = formatRecentChatAsPlainText(db, project.id, 2)
    const lines = text.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Nachricht 4')
    expect(lines[1]).toContain('Nachricht 5')
  })

  it('mehrzeilige, sehr lange Nachrichten werden vollstaendig gespeichert', () => {
    const db = createTestDb()
    const project = newProject(db)
    const longContent = Array.from({ length: 500 }, (_, i) => `Zeile ${i} mit etwas Text.`).join('\n')
    const message = addChatMessage(db, { projectId: project.id, author: 'CHATGPT', content: longContent })
    expect(message.content.split('\n')).toHaveLength(500)
  })
})

describe('addImportedChatMessage - exakte, unveraenderte Speicherung (Meilenstein 2, RC2-Korrektur)', () => {
  it('behaelt eine fuehrende Leerzeile bei', () => {
    const db = createTestDb()
    const project = newProject(db)
    const content = '\nAntwort mit fuehrender Leerzeile'
    const message = addImportedChatMessage(db, { projectId: project.id, author: 'CLAUDE', content })
    expect(message.content).toBe(content)
    expect(listChatMessages(db, project.id)[0].content).toBe(content)
  })

  it('behaelt eine abschliessende Leerzeile bei', () => {
    const db = createTestDb()
    const project = newProject(db)
    const content = 'Antwort mit abschliessender Leerzeile\n'
    const message = addImportedChatMessage(db, { projectId: project.id, author: 'CLAUDE', content })
    expect(message.content).toBe(content)
  })

  it('behaelt fuehrende und abschliessende Leerzeichen bei', () => {
    const db = createTestDb()
    const project = newProject(db)
    const content = '\n  Antwort mit Einrueckung  \n'
    const message = addImportedChatMessage(db, { projectId: project.id, author: 'CLAUDE', content })
    expect(message.content).toBe(content)
  })

  it('behaelt CRLF-Zeilenumbrueche exakt bei', () => {
    const db = createTestDb()
    const project = newProject(db)
    const content = 'Zeile 1\r\nZeile 2\r\n'
    const message = addImportedChatMessage(db, { projectId: project.id, author: 'CLAUDE', content })
    expect(message.content).toBe(content)
  })

  it('unterscheidet sich dadurch bewusst vom trimmenden addChatMessage()', () => {
    const db = createTestDb()
    const project = newProject(db)
    const content = '  Text mit Rand  '
    const manual = addChatMessage(db, { projectId: project.id, author: 'LEON', content })
    const imported = addImportedChatMessage(db, { projectId: project.id, author: 'CLAUDE', content })
    expect(manual.content).toBe('Text mit Rand')
    expect(imported.content).toBe('  Text mit Rand  ')
  })

  it('respektiert weiterhin den Archiv-Schutz', () => {
    const db = createTestDb()
    const project = newProject(db)
    archiveProject(db, project.id)
    expect(() => addImportedChatMessage(db, { projectId: project.id, author: 'CLAUDE', content: 'x' })).toThrow(
      ProjectArchivedError
    )
  })

  it('schreibt weiterhin ein CHAT_MESSAGE_ADDED-Ereignis', () => {
    const db = createTestDb()
    const project = newProject(db)
    addImportedChatMessage(db, { projectId: project.id, author: 'CLAUDE', content: 'x' })
    const events = listEventLog(db, { projectId: project.id, type: 'CHAT_MESSAGE_ADDED' })
    expect(events).toHaveLength(1)
  })
})

describe('addChatMessage/addImportedChatMessage - optionale Sitzungszuordnung (Meilenstein 3)', () => {
  it('bleibt ohne sessionId unveraendert - keine session_chat_messages-Zeile', () => {
    const db = createTestDb()
    const project = newProject(db)
    const message = addChatMessage(db, { projectId: project.id, author: 'LEON', content: 'Ohne Sitzung' })
    const row = db
      .prepare('SELECT COUNT(*) as c FROM session_chat_messages WHERE chat_message_id = ?')
      .get(message.id) as { c: number }
    expect(row.c).toBe(0)
  })

  it('ordnet eine manuelle CHATGPT-Nachricht der passenden Sitzung atomar zu', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CHATGPT' })
    const message = addChatMessage(db, {
      projectId: project.id,
      author: 'CHATGPT',
      content: 'Mit Sitzung',
      sessionId: session.id
    })
    const row = db
      .prepare('SELECT session_id, sequence_number FROM session_chat_messages WHERE chat_message_id = ?')
      .get(message.id) as { session_id: number; sequence_number: number }
    expect(row.session_id).toBe(session.id)
    expect(row.sequence_number).toBe(1)
  })

  it('ordnet eine importierte Originalantwort exakt und der passenden Sitzung atomar zu', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CLAUDE' })
    const content = '  Antwort mit Rand  '
    const message = addImportedChatMessage(db, {
      projectId: project.id,
      author: 'CLAUDE',
      content,
      sessionId: session.id
    })
    expect(message.content).toBe(content)
    const row = db
      .prepare('SELECT session_id FROM session_chat_messages WHERE chat_message_id = ?')
      .get(message.id) as { session_id: number }
    expect(row.session_id).toBe(session.id)
  })

  it('rollt die gesamte Nachricht zurueck, wenn die Sitzungszuordnung an einem Provider-Mismatch scheitert', () => {
    const db = createTestDb()
    const project = newProject(db)
    const session = createSession(db, { projectId: project.id, provider: 'CLAUDE' })
    expect(() =>
      addChatMessage(db, { projectId: project.id, author: 'CHATGPT', content: 'Sollte scheitern', sessionId: session.id })
    ).toThrow(ChatMessageProviderMismatchError)
    expect(listChatMessages(db, project.id)).toHaveLength(0)
  })
})
