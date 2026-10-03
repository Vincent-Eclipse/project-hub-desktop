import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../connection'
import { getPendingMigrationVersions, runMigrations } from './index'

function fingerprint(seed: string): string {
  return createHash('sha256').update(seed).digest('hex')
}

describe('runMigrations', () => {
  it('wendet alle Migrationen auf einer leeren Datenbank an', () => {
    const db = openDatabase(':memory:')
    const { applied } = runMigrations(db)
    expect(applied).toEqual([1, 2, 3, 4, 5, 6, 7])

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toContain('projects')
    expect(names).toContain('project_context_versions')
    expect(names).toContain('project_rule_versions')
    expect(names).toContain('chat_messages')
    expect(names).toContain('project_role_template_overrides')
    expect(names).toContain('app_settings')
    expect(names).toContain('event_log_entries')
    expect(names).toContain('response_imports')
    expect(names).toContain('sessions')
    expect(names).toContain('continuation_snapshots')
    expect(names).toContain('session_chat_messages')
    expect(names).toContain('session_events')
    expect(names).toContain('intervention_alerts')
    expect(names).toContain('intervention_alert_revisions')
    expect(names).toContain('continuation_required_files')
    expect(names).toContain('tasks')
    expect(names).toContain('task_dependencies')
    expect(names).toContain('work_requests')
    expect(names).toContain('work_request_decisions')
    expect(names).toContain('work_request_tasks')
    expect(names).toContain('apply_batches')
    expect(names).toContain('apply_batch_entries')
    expect(names).toContain('_migrations')
  })

  it('ist idempotent - ein zweiter Lauf wendet nichts erneut an', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const second = runMigrations(db)
    expect(second.applied).toEqual([])

    const count = db.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }
    expect(count.c).toBe(7)
  })

  it('erlaubt Insert/Select entlang der Fremdschluessel nach der Migration', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)

    const result = db
      .prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)')
      .run('Testprojekt', 'testprojekt', 'Sonstiges')
    const projectId = Number(result.lastInsertRowid)

    db.prepare(
      'INSERT INTO project_context_versions (project_id, version_number, content_markdown, created_by) VALUES (?, 1, ?, ?)'
    ).run(projectId, '# Hallo', 'LEON')

    const row = db.prepare('SELECT * FROM project_context_versions WHERE project_id = ?').get(projectId) as {
      content_markdown: string
      created_by: string
    }
    expect(row.content_markdown).toBe('# Hallo')
    expect(row.created_by).toBe('LEON')
  })

  it('verhindert das Anlegen von Chat-Nachrichten fuer nicht existierende Projekte (Fremdschluessel)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    expect(() =>
      db.prepare('INSERT INTO chat_messages (project_id, author, content) VALUES (?, ?, ?)').run(
        9999,
        'LEON',
        'Test'
      )
    ).toThrow()
  })

  it('lehnt HUMAN als next_actor ab (durch LEON ersetzt)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    expect(() =>
      db
        .prepare('INSERT INTO projects (name, slug, project_type, next_actor) VALUES (?, ?, ?, ?)')
        .run('Test', 'test', 'Typ', 'HUMAN')
    ).toThrow()
  })

  it('akzeptiert LEON als next_actor', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    expect(() =>
      db
        .prepare('INSERT INTO projects (name, slug, project_type, next_actor) VALUES (?, ?, ?, ?)')
        .run('Test', 'test', 'Typ', 'LEON')
    ).not.toThrow()
  })

  it('akzeptiert SYSTEM als Chat-Autor', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const project = db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run(
      'Test',
      'test',
      'Typ'
    )
    expect(() =>
      db
        .prepare('INSERT INTO chat_messages (project_id, author, content) VALUES (?, ?, ?)')
        .run(Number(project.lastInsertRowid), 'SYSTEM', 'Automatischer Hinweis')
    ).not.toThrow()
  })

  it('erzwingt Eindeutigkeit von slug', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run(
      'A',
      'doppelt',
      'Typ'
    )
    expect(() =>
      db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run(
        'B',
        'doppelt',
        'Typ'
      )
    ).toThrow()
  })

  it('erzwingt per Fremdschluessel, dass current_context_version_id auf eine existierende Kontext-Version zeigt', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const project = db
      .prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)')
      .run('Test', 'test', 'Typ')
    const projectId = Number(project.lastInsertRowid)

    // Zeigt auf eine Versions-ID, die es nicht gibt - muss an der
    // Fremdschluessel-Constraint scheitern, auch wenn project_context_versions
    // im Migrationsskript erst NACH projects angelegt wird (vorwaertsgerichtete
    // Referenz).
    expect(() =>
      db.prepare('UPDATE projects SET current_context_version_id = ? WHERE id = ?').run(9999, projectId)
    ).toThrow()
  })

  it('erlaubt current_context_version_id auf eine tatsaechlich existierende Version zu zeigen und meldet keine Verletzungen', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const project = db
      .prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)')
      .run('Test', 'test', 'Typ')
    const projectId = Number(project.lastInsertRowid)

    const version = db
      .prepare(
        'INSERT INTO project_context_versions (project_id, version_number, content_markdown, created_by) VALUES (?, 1, ?, ?)'
      )
      .run(projectId, '# Hallo', 'LEON')
    const versionId = Number(version.lastInsertRowid)

    expect(() =>
      db.prepare('UPDATE projects SET current_context_version_id = ? WHERE id = ?').run(versionId, projectId)
    ).not.toThrow()

    const violations = db.pragma('foreign_key_check') as unknown[]
    expect(violations).toHaveLength(0)
  })

  it('erlaubt mehrere Projekte ohne Ordner (NULL ist bei UNIQUE nicht kollidierend), verhindert aber doppelte folder_comparison_key', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run('A', 'a', 'Typ')
    expect(() =>
      db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run('B', 'b', 'Typ')
    ).not.toThrow()

    db.prepare(
      'INSERT INTO projects (name, slug, project_type, folder_comparison_key) VALUES (?, ?, ?, ?)'
    ).run('C', 'c', 'Typ', '/gleicher/ordner')
    expect(() =>
      db
        .prepare('INSERT INTO projects (name, slug, project_type, folder_comparison_key) VALUES (?, ?, ?, ?)')
        .run('D', 'd', 'Typ', '/gleicher/ordner')
    ).toThrow()
  })
})

describe('Migration 2 - response_imports (Meilenstein 2)', () => {
  it('legt die Tabelle und die erwarteten Indizes an', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'response_imports'")
      .all() as Array<{ name: string }>
    const names = indexes.map((i) => i.name)
    expect(names).toContain('idx_response_imports_project')
    expect(names).toContain('idx_response_imports_created_at')
  })

  it('erzwingt source nur CHATGPT oder CLAUDE', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const project = db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run(
      'Test',
      'test',
      'Typ'
    )
    const projectId = Number(project.lastInsertRowid)
    expect(() =>
      db
        .prepare(
          `INSERT INTO response_imports
            (project_id, source, raw_response, parser_version, parsed_result_json, selected_actions_json)
           VALUES (?, 'LEON', 'x', 1, '{}', '{}')`
        )
        .run(projectId)
    ).toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO response_imports
            (project_id, source, raw_response, parser_version, parsed_result_json, selected_actions_json)
           VALUES (?, 'CLAUDE', 'x', 1, '{}', '{}')`
        )
        .run(projectId)
    ).not.toThrow()
  })

  it('erzwingt gueltiges JSON in parsed_result_json und selected_actions_json', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const project = db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run(
      'Test',
      'test',
      'Typ'
    )
    const projectId = Number(project.lastInsertRowid)
    expect(() =>
      db
        .prepare(
          `INSERT INTO response_imports
            (project_id, source, raw_response, parser_version, parsed_result_json, selected_actions_json)
           VALUES (?, 'CLAUDE', 'x', 1, 'kein json', '{}')`
        )
        .run(projectId)
    ).toThrow()
  })

  it('loescht response_imports-Zeilen kaskadierend mit dem Projekt', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const project = db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run(
      'Test',
      'test',
      'Typ'
    )
    const projectId = Number(project.lastInsertRowid)
    db.prepare(
      `INSERT INTO response_imports
        (project_id, source, raw_response, parser_version, parsed_result_json, selected_actions_json)
       VALUES (?, 'CLAUDE', 'x', 1, '{}', '{}')`
    ).run(projectId)

    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    const remaining = db.prepare('SELECT COUNT(*) as c FROM response_imports').get() as { c: number }
    expect(remaining.c).toBe(0)
  })

  it('kann result_context_version_id als NULL speichern, wenn kein Kontext erzeugt wurde', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const project = db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run(
      'Test',
      'test',
      'Typ'
    )
    const projectId = Number(project.lastInsertRowid)
    expect(() =>
      db
        .prepare(
          `INSERT INTO response_imports
            (project_id, source, raw_response, parser_version, parsed_result_json, selected_actions_json, result_context_version_id)
           VALUES (?, 'CLAUDE', 'x', 1, '{}', '{}', NULL)`
        )
        .run(projectId)
    ).not.toThrow()
  })
})

describe('Migration 3 - sessions_continuations (Meilenstein 3)', () => {
  function insertProject(db: ReturnType<typeof openDatabase>, slug = 'test'): number {
    const result = db
      .prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)')
      .run('Test', slug, 'Typ')
    return Number(result.lastInsertRowid)
  }

  function insertSession(
    db: ReturnType<typeof openDatabase>,
    projectId: number,
    overrides: Partial<{ id: number; provider: string; status: string; predecessorSessionId: number | null }> = {}
  ): number {
    const provider = overrides.provider ?? 'CHATGPT'
    const status = overrides.status ?? 'ACTIVE'
    if (overrides.id !== undefined) {
      db.prepare(
        'INSERT INTO sessions (id, project_id, provider, status, predecessor_session_id) VALUES (?, ?, ?, ?, ?)'
      ).run(overrides.id, projectId, provider, status, overrides.predecessorSessionId ?? null)
      return overrides.id
    }
    const result = db
      .prepare('INSERT INTO sessions (project_id, provider, status, predecessor_session_id) VALUES (?, ?, ?, ?)')
      .run(projectId, provider, status, overrides.predecessorSessionId ?? null)
    return Number(result.lastInsertRowid)
  }

  function insertConfirmedSnapshot(db: ReturnType<typeof openDatabase>, projectId: number, sessionId: number): number {
    const result = db
      .prepare(
        `INSERT INTO continuation_snapshots
          (project_id, session_id, version_number, provider, confirmation_state, created_by)
         VALUES (?, ?, 1, 'CHATGPT', 'CONFIRMED', 'LEON')`
      )
      .run(projectId, sessionId)
    return Number(result.lastInsertRowid)
  }

  function insertSnapshotRaw(
    db: ReturnType<typeof openDatabase>,
    projectId: number,
    sessionId: number,
    overrides: Partial<{
      versionNumber: number
      provider: string
      reasonCode: string
      confirmationState: string
      createdBy: string
      derivedFromSnapshotId: number | null
    }> = {}
  ) {
    return db
      .prepare(
        `INSERT INTO continuation_snapshots
          (project_id, session_id, version_number, provider, reason_code, confirmation_state, created_by, derived_from_snapshot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectId,
        sessionId,
        overrides.versionNumber ?? 1,
        overrides.provider ?? 'CHATGPT',
        overrides.reasonCode ?? 'OTHER',
        overrides.confirmationState ?? 'DRAFT',
        overrides.createdBy ?? 'LEON',
        overrides.derivedFromSnapshotId ?? null
      )
  }

  function insertChatMessage(db: ReturnType<typeof openDatabase>, projectId: number): number {
    const result = db
      .prepare('INSERT INTO chat_messages (project_id, author, content) VALUES (?, ?, ?)')
      .run(projectId, 'CHATGPT', 'Hallo')
    return Number(result.lastInsertRowid)
  }

  function insertAlertRaw(
    db: ReturnType<typeof openDatabase>,
    projectId: number,
    overrides: Partial<{
      sessionId: number | null
      type: string
      priority: string
      status: string
      dedupeFingerprint: string
      contentVersion: number
      popupAcknowledgedVersion: number | null
    }> = {}
  ) {
    return db
      .prepare(
        `INSERT INTO intervention_alerts
          (project_id, session_id, type, priority, status, dedupe_fingerprint, content_version, popup_acknowledged_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectId,
        overrides.sessionId ?? null,
        overrides.type ?? 'USAGE_LIMIT_REACHED',
        overrides.priority ?? 'NORMAL',
        overrides.status ?? 'OPEN',
        overrides.dedupeFingerprint ?? fingerprint(`alert-${Math.random()}`),
        overrides.contentVersion ?? 1,
        overrides.popupAcknowledgedVersion ?? null
      )
  }

  it('legt alle sieben neuen Tabellen mit den erwarteten Indizes an', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
    ).map((i) => i.name)
    expect(indexNames).toContain('idx_sessions_project')
    expect(indexNames).toContain('idx_sessions_status')
    expect(indexNames).toContain('idx_sessions_one_active_per_provider')
    expect(indexNames).toContain('idx_snapshots_session')
    expect(indexNames).toContain('idx_snapshots_project')
    expect(indexNames).toContain('idx_snapshots_confirmation_state')
    expect(indexNames).toContain('idx_session_chat_messages_session')
    expect(indexNames).toContain('idx_session_events_session')
    expect(indexNames).toContain('idx_session_events_type')
    expect(indexNames).toContain('idx_intervention_project')
    expect(indexNames).toContain('idx_intervention_status')
    expect(indexNames).toContain('idx_intervention_priority')
    expect(indexNames).toContain('idx_intervention_dedupe_active')
    expect(indexNames).toContain('idx_intervention_revisions_intervention')
    expect(indexNames).toContain('idx_required_files_snapshot')
    expect(indexNames).toContain('idx_required_files_intervention_revision')
  })

  it('erzwingt provider nur CHATGPT oder CLAUDE bei sessions', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() =>
      db.prepare("INSERT INTO sessions (project_id, provider) VALUES (?, 'GEMINI')").run(projectId)
    ).toThrow()
    expect(() =>
      db.prepare("INSERT INTO sessions (project_id, provider) VALUES (?, 'CHATGPT')").run(projectId)
    ).not.toThrow()
  })

  it('erzwingt einen gueltigen Sitzungsstatus', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() =>
      db.prepare("INSERT INTO sessions (project_id, provider, status) VALUES (?, 'CHATGPT', 'SLEEPING')").run(projectId)
    ).toThrow()
  })

  it('erzwingt predecessor_session_id < id (Zyklensicherheit) - Ablehnungs- und Erfolgsfall', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    // status 'PAUSED' ueberall, damit die Ein-ACTIVE-je-Provider-Regel hier nicht mit hineinspielt.
    const first = insertSession(db, projectId, { status: 'PAUSED' })

    // Selbstverweis (predecessor == id) muss scheitern.
    expect(() =>
      db
        .prepare(
          "INSERT INTO sessions (id, project_id, provider, status, predecessor_session_id) VALUES (10, ?, ?, 'PAUSED', 10)"
        )
        .run(projectId, 'CHATGPT')
    ).toThrow()

    // Verweis auf eine hoehere/zukuenftige id muss scheitern, auch wenn diese
    // (zufaellig) tatsaechlich existiert.
    db.prepare("INSERT INTO sessions (id, project_id, provider, status) VALUES (20, ?, ?, 'PAUSED')").run(
      projectId,
      'CHATGPT'
    )
    expect(() =>
      db
        .prepare(
          "INSERT INTO sessions (id, project_id, provider, status, predecessor_session_id) VALUES (15, ?, ?, 'PAUSED', 20)"
        )
        .run(projectId, 'CHATGPT')
    ).toThrow()

    // Verweis auf eine kleinere, tatsaechlich existierende id gelingt.
    expect(() =>
      db
        .prepare(
          "INSERT INTO sessions (id, project_id, provider, status, predecessor_session_id) VALUES (30, ?, ?, 'PAUSED', ?)"
        )
        .run(projectId, 'CHATGPT', first)
    ).not.toThrow()
  })

  it('erlaubt hoechstens einen direkten Nachfolger je Sitzung (UNIQUE predecessor_session_id)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const first = insertSession(db, projectId, { status: 'PAUSED' })
    insertSession(db, projectId, { predecessorSessionId: first })
    expect(() => insertSession(db, projectId, { predecessorSessionId: first })).toThrow()
  })

  it('erlaubt hoechstens eine ACTIVE-Sitzung je Projekt und Provider, aber CHATGPT und CLAUDE gleichzeitig ACTIV', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    insertSession(db, projectId, { provider: 'CHATGPT', status: 'ACTIVE' })
    expect(() => insertSession(db, projectId, { provider: 'CHATGPT', status: 'ACTIVE' })).toThrow()
    expect(() => insertSession(db, projectId, { provider: 'CLAUDE', status: 'ACTIVE' })).not.toThrow()
    // Ein zweites Projekt ist von der Eindeutigkeit des ersten unberuehrt.
    const otherProjectId = insertProject(db, 'anderes-projekt')
    expect(() => insertSession(db, otherProjectId, { provider: 'CHATGPT', status: 'ACTIVE' })).not.toThrow()
  })

  it('erzwingt gueltiges JSON in den Listenfeldern von continuation_snapshots', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId)
    expect(() =>
      db
        .prepare(
          `INSERT INTO continuation_snapshots
            (project_id, session_id, version_number, provider, confirmed_done_json, created_by)
           VALUES (?, ?, 1, 'CHATGPT', 'kein json', 'LEON')`
        )
        .run(projectId, sessionId)
    ).toThrow()
  })

  it('erzwingt UNIQUE(session_id, version_number) bei continuation_snapshots', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId)
    insertConfirmedSnapshot(db, projectId, sessionId)
    expect(() =>
      db
        .prepare(
          `INSERT INTO continuation_snapshots
            (project_id, session_id, version_number, provider, confirmation_state, created_by)
           VALUES (?, ?, 1, 'CHATGPT', 'DRAFT', 'LEON')`
        )
        .run(projectId, sessionId)
    ).toThrow()
  })

  it('loest den Zyklus sessions <-> continuation_snapshots ueber ON DELETE SET NULL auf', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const firstSession = insertSession(db, projectId, { status: 'PAUSED' })
    const snapshotId = insertConfirmedSnapshot(db, projectId, firstSession)
    const secondSession = insertSession(db, projectId, { predecessorSessionId: firstSession })
    db.prepare('UPDATE sessions SET based_on_snapshot_id = ? WHERE id = ?').run(snapshotId, secondSession)

    // Den referenzierten Snapshot direkt loeschen (nicht ueber die Sitzung) -
    // darf NICHT an einer blockierenden FK-Pruefung scheitern.
    expect(() => db.prepare('DELETE FROM continuation_snapshots WHERE id = ?').run(snapshotId)).not.toThrow()

    const refreshed = db.prepare('SELECT based_on_snapshot_id FROM sessions WHERE id = ?').get(secondSession) as {
      based_on_snapshot_id: number | null
    }
    expect(refreshed.based_on_snapshot_id).toBeNull()
  })

  it('kaskadiert eine Projektloeschung ueber den vollstaendigen Verweisgraphen ohne Fremdschluessel-Verletzung', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const firstSession = insertSession(db, projectId, { status: 'PAUSED' })
    const snapshotId = insertConfirmedSnapshot(db, projectId, firstSession)
    const secondSession = insertSession(db, projectId, { predecessorSessionId: firstSession })
    db.prepare('UPDATE sessions SET based_on_snapshot_id = ? WHERE id = ?').run(snapshotId, secondSession)

    const chatMessage = db
      .prepare('INSERT INTO chat_messages (project_id, author, content) VALUES (?, ?, ?)')
      .run(projectId, 'CHATGPT', 'Hallo')
    const chatMessageId = Number(chatMessage.lastInsertRowid)
    db.prepare(
      'INSERT INTO session_chat_messages (chat_message_id, session_id, sequence_number) VALUES (?, ?, 1)'
    ).run(chatMessageId, firstSession)

    const sessionEvent = db
      .prepare(
        `INSERT INTO session_events (session_id, event_type, chat_message_id, continuation_snapshot_id, created_by)
         VALUES (?, 'LIMIT_REACHED', ?, ?, 'LEON')`
      )
      .run(firstSession, chatMessageId, snapshotId)
    expect(sessionEvent.changes).toBe(1)

    const alert = db
      .prepare(
        `INSERT INTO intervention_alerts (project_id, session_id, type, dedupe_fingerprint)
         VALUES (?, ?, 'USAGE_LIMIT_REACHED', ?)`
      )
      .run(projectId, firstSession, fingerprint('cascade-test'))
    const alertId = Number(alert.lastInsertRowid)

    const revision = db
      .prepare(
        `INSERT INTO intervention_alert_revisions (intervention_id, content_version, priority, created_by)
         VALUES (?, 1, 'NORMAL', 'LEON')`
      )
      .run(alertId)
    const revisionId = Number(revision.lastInsertRowid)

    db.prepare(
      'INSERT INTO continuation_required_files (intervention_revision_id, display_name) VALUES (?, ?)'
    ).run(revisionId, 'Datei A')
    db.prepare('INSERT INTO continuation_required_files (snapshot_id, display_name) VALUES (?, ?)').run(
      snapshotId,
      'Datei B'
    )

    expect(() => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)).not.toThrow()

    const violations = db.pragma('foreign_key_check') as unknown[]
    expect(violations).toHaveLength(0)

    for (const table of [
      'sessions',
      'continuation_snapshots',
      'session_chat_messages',
      'session_events',
      'intervention_alerts',
      'intervention_alert_revisions',
      'continuation_required_files'
    ]) {
      const remaining = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }
      expect(remaining.c).toBe(0)
    }
  })

  it('erzwingt genau einen Besitzer (XOR) bei continuation_required_files', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId)
    const snapshotId = insertConfirmedSnapshot(db, projectId, sessionId)

    // Weder snapshot_id noch intervention_revision_id gesetzt.
    expect(() =>
      db.prepare('INSERT INTO continuation_required_files (display_name) VALUES (?)').run('Ohne Besitzer')
    ).toThrow()

    // Beide gleichzeitig gesetzt.
    const alert = db
      .prepare(
        `INSERT INTO intervention_alerts (project_id, type, dedupe_fingerprint) VALUES (?, 'FILE_UPLOAD_REQUIRED', ?)`
      )
      .run(projectId, fingerprint('xor-test'))
    const revision = db
      .prepare(
        `INSERT INTO intervention_alert_revisions (intervention_id, content_version, priority, created_by)
         VALUES (?, 1, 'NORMAL', 'LEON')`
      )
      .run(Number(alert.lastInsertRowid))
    expect(() =>
      db
        .prepare(
          'INSERT INTO continuation_required_files (snapshot_id, intervention_revision_id, display_name) VALUES (?, ?, ?)'
        )
        .run(snapshotId, Number(revision.lastInsertRowid), 'Beide')
    ).toThrow()

    // Genau ein Besitzer - gueltig.
    expect(() =>
      db.prepare('INSERT INTO continuation_required_files (snapshot_id, display_name) VALUES (?, ?)').run(
        snapshotId,
        'Gueltig'
      )
    ).not.toThrow()
  })

  it('erzwingt Deduplizierung ueber OPEN und SNOOZED, nicht aber ueber RESOLVED/DISMISSED', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const fpDateiA = fingerprint('datei-a')
    const fpDateiB = fingerprint('datei-b')

    db.prepare(
      `INSERT INTO intervention_alerts (project_id, type, status, dedupe_fingerprint)
       VALUES (?, 'FILE_UPLOAD_REQUIRED', 'OPEN', ?)`
    ).run(projectId, fpDateiA)

    // Zweite OPEN-Warnung mit demselben Fingerprint scheitert.
    expect(() =>
      db
        .prepare(
          `INSERT INTO intervention_alerts (project_id, type, status, dedupe_fingerprint)
           VALUES (?, 'FILE_UPLOAD_REQUIRED', 'OPEN', ?)`
        )
        .run(projectId, fpDateiA)
    ).toThrow()

    // Eine SNOOZED-Warnung mit demselben Fingerprint scheitert ebenso (OPEN+SNOOZED zaehlen gemeinsam).
    db.prepare('UPDATE intervention_alerts SET status = ? WHERE dedupe_fingerprint = ?').run('SNOOZED', fpDateiA)
    expect(() =>
      db
        .prepare(
          `INSERT INTO intervention_alerts (project_id, type, status, dedupe_fingerprint)
           VALUES (?, 'FILE_UPLOAD_REQUIRED', 'OPEN', ?)`
        )
        .run(projectId, fpDateiA)
    ).toThrow()

    // Ein unterschiedlicher dedupeKey (hier direkt am Fingerprint simuliert) darf
    // parallel existieren - zwei verschiedene Dateien duerfen gleichzeitig offen sein.
    expect(() =>
      db
        .prepare(
          `INSERT INTO intervention_alerts (project_id, type, status, dedupe_fingerprint)
           VALUES (?, 'FILE_UPLOAD_REQUIRED', 'OPEN', ?)`
        )
        .run(projectId, fpDateiB)
    ).not.toThrow()

    // Nach RESOLVED darf derselbe Fingerprint erneut als neue OPEN-Zeile auftreten.
    db.prepare('UPDATE intervention_alerts SET status = ? WHERE dedupe_fingerprint = ?').run('RESOLVED', fpDateiA)
    expect(() =>
      db
        .prepare(
          `INSERT INTO intervention_alerts (project_id, type, status, dedupe_fingerprint)
           VALUES (?, 'FILE_UPLOAD_REQUIRED', 'OPEN', ?)`
        )
        .run(projectId, fpDateiA)
    ).not.toThrow()
  })

  it.each([
    ['provider', { provider: 'GEMINI' }],
    ['reason_code', { reasonCode: 'UNKNOWN' }],
    ['confirmation_state', { confirmationState: 'MAYBE' }],
    ['created_by', { createdBy: 'ANONYMOUS' }]
  ] as const)('lehnt einen ungueltigen Wert fuer continuation_snapshots.%s ab', (_column, override) => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId)
    expect(() => insertSnapshotRaw(db, projectId, sessionId, override)).toThrow()
  })

  it('erzwingt version_number >= 1 bei continuation_snapshots', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId)
    expect(() => insertSnapshotRaw(db, projectId, sessionId, { versionNumber: 0 })).toThrow()
  })

  it('lehnt Selbstverweis bei continuation_snapshots.derived_from_snapshot_id ab', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId)
    expect(() =>
      db
        .prepare(
          `INSERT INTO continuation_snapshots (id, project_id, session_id, version_number, provider, created_by, derived_from_snapshot_id)
           VALUES (500, ?, ?, 1, 'CHATGPT', 'LEON', 500)`
        )
        .run(projectId, sessionId)
    ).toThrow()
  })

  it('lehnt einen Verweis auf eine hoehere Snapshot-ID bei derived_from_snapshot_id ab', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId)
    db.prepare(
      `INSERT INTO continuation_snapshots (id, project_id, session_id, version_number, provider, created_by)
       VALUES (600, ?, ?, 1, 'CHATGPT', 'LEON')`
    ).run(projectId, sessionId)
    expect(() =>
      db
        .prepare(
          `INSERT INTO continuation_snapshots (id, project_id, session_id, version_number, provider, created_by, derived_from_snapshot_id)
           VALUES (550, ?, ?, 2, 'CHATGPT', 'LEON', 600)`
        )
        .run(projectId, sessionId)
    ).toThrow()
  })

  it('erlaubt eine gueltige Ableitung von einem frueheren, tatsaechlich existierenden Snapshot', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId)
    const draftId = Number(insertSnapshotRaw(db, projectId, sessionId, { versionNumber: 1 }).lastInsertRowid)
    expect(() =>
      insertSnapshotRaw(db, projectId, sessionId, {
        versionNumber: 2,
        confirmationState: 'CONFIRMED',
        derivedFromSnapshotId: draftId
      })
    ).not.toThrow()
  })

  it.each([
    ['event_type', { eventType: 'UNKNOWN' }],
    ['created_by', { createdBy: 'ANONYMOUS' }]
  ] as Array<[string, Partial<{ eventType: string; createdBy: string }>]>)(
    'lehnt einen ungueltigen Wert fuer session_events.%s ab',
    (_column, override) => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const sessionId = insertSession(db, projectId)
      expect(() =>
        db
          .prepare('INSERT INTO session_events (session_id, event_type, created_by) VALUES (?, ?, ?)')
          .run(sessionId, override.eventType ?? 'MANUAL_PAUSE', override.createdBy ?? 'LEON')
      ).toThrow()
    }
  )

  it('setzt session_events.chat_message_id auf NULL, wenn die referenzierte Chat-Nachricht geloescht wird', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId)
    const messageId = insertChatMessage(db, projectId)
    const eventResult = db
      .prepare(
        `INSERT INTO session_events (session_id, event_type, chat_message_id, created_by)
         VALUES (?, 'MANUAL_PAUSE', ?, 'LEON')`
      )
      .run(sessionId, messageId)
    const eventId = Number(eventResult.lastInsertRowid)

    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(messageId)

    const row = db.prepare('SELECT chat_message_id FROM session_events WHERE id = ?').get(eventId) as {
      chat_message_id: number | null
    }
    expect(row.chat_message_id).toBeNull()
  })

  it.each([
    ['type', { type: 'UNKNOWN' }],
    ['priority', { priority: 'URGENT' }],
    ['status', { status: 'ARCHIVED' }]
  ] as const)('lehnt einen ungueltigen Wert fuer intervention_alerts.%s ab', (_column, override) => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() => insertAlertRaw(db, projectId, override)).toThrow()
  })

  it.each([
    ['zu kurz', 'abc123'],
    ['64 Zeichen mit Nicht-Hex-Zeichen', 'g'.repeat(64)],
    ['Grossbuchstaben', fingerprint('gross').toUpperCase()]
  ])('lehnt einen ungueltigen dedupe_fingerprint ab (%s)', (_label, invalidFingerprint) => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() => insertAlertRaw(db, projectId, { dedupeFingerprint: invalidFingerprint })).toThrow()
  })

  it('akzeptiert einen gueltigen 64-stelligen Kleinbuchstaben-Hex-Fingerprint', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() => insertAlertRaw(db, projectId, { dedupeFingerprint: fingerprint('gueltig') })).not.toThrow()
  })

  it('erzwingt content_version >= 1 bei intervention_alerts', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() => insertAlertRaw(db, projectId, { contentVersion: 0 })).toThrow()
  })

  it('erzwingt popup_acknowledged_version >= 1 und <= content_version', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() => insertAlertRaw(db, projectId, { contentVersion: 2, popupAcknowledgedVersion: 0 })).toThrow()
    expect(() => insertAlertRaw(db, projectId, { contentVersion: 2, popupAcknowledgedVersion: 3 })).toThrow()
    expect(() => insertAlertRaw(db, projectId, { contentVersion: 2, popupAcknowledgedVersion: 2 })).not.toThrow()
  })

  it('setzt intervention_alerts.session_id auf NULL, wenn die referenzierte Sitzung geloescht wird', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId, { status: 'PAUSED' })
    const alertResult = insertAlertRaw(db, projectId, { sessionId })
    const alertId = Number(alertResult.lastInsertRowid)

    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)

    const row = db.prepare('SELECT session_id FROM intervention_alerts WHERE id = ?').get(alertId) as {
      session_id: number | null
    }
    expect(row.session_id).toBeNull()
  })

  it('erzwingt content_version >= 1 bei intervention_alert_revisions', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const alertId = Number(insertAlertRaw(db, projectId).lastInsertRowid)
    expect(() =>
      db
        .prepare(
          `INSERT INTO intervention_alert_revisions (intervention_id, content_version, priority, created_by)
           VALUES (?, 0, 'NORMAL', 'LEON')`
        )
        .run(alertId)
    ).toThrow()
  })

  it.each(['is_required', 'reupload_required', 'is_sensitive'] as const)(
    'lehnt einen ungueltigen Boolean-Wert fuer continuation_required_files.%s ab',
    (column) => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const sessionId = insertSession(db, projectId)
      const snapshotId = insertConfirmedSnapshot(db, projectId, sessionId)
      expect(() =>
        db
          .prepare(`INSERT INTO continuation_required_files (snapshot_id, display_name, ${column}) VALUES (?, ?, 2)`)
          .run(snapshotId, 'Datei')
      ).toThrow()
    }
  )

  it('erzwingt sequence_number >= 1 bei session_chat_messages', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId)
    const messageId = insertChatMessage(db, projectId)
    expect(() =>
      db
        .prepare('INSERT INTO session_chat_messages (chat_message_id, session_id, sequence_number) VALUES (?, ?, 0)')
        .run(messageId, sessionId)
    ).toThrow()
  })

  it('lehnt doppelte sequence_number innerhalb derselben Sitzung ab', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionId = insertSession(db, projectId)
    const messageA = insertChatMessage(db, projectId)
    const messageB = insertChatMessage(db, projectId)
    db.prepare(
      'INSERT INTO session_chat_messages (chat_message_id, session_id, sequence_number) VALUES (?, ?, 1)'
    ).run(messageA, sessionId)
    expect(() =>
      db
        .prepare('INSERT INTO session_chat_messages (chat_message_id, session_id, sequence_number) VALUES (?, ?, 1)')
        .run(messageB, sessionId)
    ).toThrow()
  })

  it('lehnt es ab, dieselbe chat_message_id zwei Sitzungen zuzuordnen', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const sessionA = insertSession(db, projectId, { status: 'PAUSED' })
    const sessionB = insertSession(db, projectId, { provider: 'CLAUDE', status: 'PAUSED' })
    const messageId = insertChatMessage(db, projectId)
    db.prepare(
      'INSERT INTO session_chat_messages (chat_message_id, session_id, sequence_number) VALUES (?, ?, 1)'
    ).run(messageId, sessionA)
    expect(() =>
      db
        .prepare('INSERT INTO session_chat_messages (chat_message_id, session_id, sequence_number) VALUES (?, ?, 1)')
        .run(messageId, sessionB)
    ).toThrow()
  })

  it('kann auf eine bereits mit Migration 1+2 initialisierte Datenbank angewendet werden (Teil-Upgrade)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    db.exec('DROP TABLE continuation_required_files;')
    db.exec('DROP TABLE intervention_alert_revisions;')
    db.exec('DROP TABLE intervention_alerts;')
    db.exec('DROP TABLE session_events;')
    db.exec('DROP TABLE session_chat_messages;')
    db.exec('DROP TABLE continuation_snapshots;')
    db.exec('DROP TABLE sessions;')
    db.prepare('DELETE FROM _migrations WHERE version = 3').run()

    const second = runMigrations(db)
    expect(second.applied).toEqual([3])

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(tables).toContain('sessions')
    expect(tables).toContain('continuation_snapshots')
  })
})

describe('Migration 2 auf bestehendem Meilenstein-1-Schema', () => {
  it('kann auf eine bereits mit Migration 1 initialisierte Datenbank angewendet werden, ohne bestehende Daten zu veraendern', () => {
    const db = openDatabase(':memory:')
    // Volle Migration auf frischer DB (repraesentiert eine bestehende
    // Meilenstein-1-Installation, bei der runMigrations() beim naechsten
    // App-Start automatisch Migration 2 nachzieht), dann Insert eines
    // Projekts (repraesentiert bestehende Meilenstein-1-Daten), danach
    // erneuter Migrationslauf (idempotent) - Daten bleiben unveraendert.
    runMigrations(db)
    db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run(
      'Bestandsprojekt',
      'bestandsprojekt',
      'Typ'
    )
    const before = db.prepare('SELECT * FROM projects WHERE slug = ?').get('bestandsprojekt')

    const second = runMigrations(db)
    expect(second.applied).toEqual([])

    const after = db.prepare('SELECT * FROM projects WHERE slug = ?').get('bestandsprojekt')
    expect(after).toEqual(before)
  })

  it('wendet Migration 2 und 3 an, wenn nur Migration 1 bereits als angewendet vermerkt ist', () => {
    const db = openDatabase(':memory:')
    const first = runMigrations(db)
    expect(first.applied).toEqual([1, 2, 3, 4, 5, 6, 7])

    // Migration 3 haengt von response_imports ab (session_events.response_import_id)
    // und muss daher vor Migration 2 zurueckgesetzt werden.
    db.exec('DROP TABLE continuation_required_files;')
    db.exec('DROP TABLE intervention_alert_revisions;')
    db.exec('DROP TABLE intervention_alerts;')
    db.exec('DROP TABLE session_events;')
    db.exec('DROP TABLE session_chat_messages;')
    db.exec('DROP TABLE continuation_snapshots;')
    db.exec('DROP TABLE sessions;')
    db.prepare('DELETE FROM _migrations WHERE version = 3').run()
    db.exec('DROP TABLE response_imports;')
    db.prepare('DELETE FROM _migrations WHERE version = 2').run()

    const second = runMigrations(db)
    expect(second.applied).toEqual([2, 3])

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'response_imports'")
      .all()
    expect(tables).toHaveLength(1)
  })
})

describe('Migration 5 - tasks (Meilenstein 4.2)', () => {
  function insertProject(db: ReturnType<typeof openDatabase>, slug = 'test'): number {
    const result = db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run('Test', slug, 'Typ')
    return Number(result.lastInsertRowid)
  }

  function insertTask(
    db: ReturnType<typeof openDatabase>,
    projectId: number,
    overrides: Partial<{ title: string; priority: string; status: string; createdBy: string }> = {}
  ): number {
    const result = db
      .prepare(
        `INSERT INTO tasks (project_id, title, priority, status, created_by)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        projectId,
        overrides.title ?? 'Task',
        overrides.priority ?? 'MEDIUM',
        overrides.status ?? 'BACKLOG',
        overrides.createdBy ?? 'LEON'
      )
    return Number(result.lastInsertRowid)
  }

  it('legt die tasks/task_dependencies-Tabellen mit den erwarteten Indizes an', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
    ).map((i) => i.name)
    expect(indexNames).toContain('idx_tasks_project')
    expect(indexNames).toContain('idx_tasks_status')
    expect(indexNames).toContain('idx_task_dependencies_depends_on')
  })

  it('setzt Standardwerte fuer Prioritaet und Status', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const taskId = db
      .prepare('INSERT INTO tasks (project_id, title, created_by) VALUES (?, ?, ?)')
      .run(projectId, 'Minimal', 'LEON').lastInsertRowid
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>
    expect(row.priority).toBe('MEDIUM')
    expect(row.status).toBe('BACKLOG')
    expect(row.relevant_files_json).toBe('[]')
    expect(row.goal_markdown).toBe('')
    expect(row.blocked_reason).toBe('')
  })

  it.each([
    ['priority', { priority: 'URGENT' }],
    ['status', { status: 'UNKNOWN' }],
    ['created_by', { createdBy: 'ANONYMOUS' }]
  ] as const)('lehnt einen ungueltigen Wert fuer tasks.%s ab', (_column, override) => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() => insertTask(db, projectId, override)).toThrow()
  })

  it('erzwingt gueltiges JSON in relevant_files_json', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() =>
      db
        .prepare('INSERT INTO tasks (project_id, title, created_by, relevant_files_json) VALUES (?, ?, ?, ?)')
        .run(projectId, 'Task', 'LEON', 'kein json')
    ).toThrow()
  })

  it('verhindert das Anlegen von Aufgaben fuer nicht existierende Projekte (Fremdschluessel)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    expect(() =>
      db.prepare("INSERT INTO tasks (project_id, title, created_by) VALUES (9999, 'X', 'LEON')").run()
    ).toThrow()
  })

  it('loescht tasks und task_dependencies kaskadierend mit dem Projekt', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const a = insertTask(db, projectId, { title: 'A' })
    const b = insertTask(db, projectId, { title: 'B' })
    db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)').run(a, b)

    expect(() => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)).not.toThrow()
    const violations = db.pragma('foreign_key_check') as unknown[]
    expect(violations).toHaveLength(0)
    expect((db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) as c FROM task_dependencies').get() as { c: number }).c).toBe(0)
  })

  it('lehnt Selbstverweise in task_dependencies ab (CHECK task_id != depends_on_task_id)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const a = insertTask(db, projectId, { title: 'A' })
    expect(() =>
      db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)').run(a, a)
    ).toThrow()
  })

  it('verhindert doppelte Abhaengigkeits-Zeilen (PRIMARY KEY task_id, depends_on_task_id)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const a = insertTask(db, projectId, { title: 'A' })
    const b = insertTask(db, projectId, { title: 'B' })
    db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)').run(a, b)
    expect(() =>
      db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)').run(a, b)
    ).toThrow()
  })

  it('erzwingt per Fremdschluessel, dass beide Seiten von task_dependencies existierende Aufgaben referenzieren', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const a = insertTask(db, projectId, { title: 'A' })
    expect(() =>
      db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, 99999)').run(a)
    ).toThrow()
    expect(() =>
      db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (99999, ?)').run(a)
    ).toThrow()
  })

  it('kann auf eine bereits mit Migration 1-4 initialisierte Datenbank angewendet werden (Teil-Upgrade)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    db.exec('DROP TABLE task_dependencies;')
    db.exec('DROP TABLE tasks;')
    db.prepare('DELETE FROM _migrations WHERE version = 5').run()

    const second = runMigrations(db)
    expect(second.applied).toEqual([5])

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(tables).toContain('tasks')
    expect(tables).toContain('task_dependencies')
  })
})

describe('Migration 6 - work_requests (Meilenstein 4.3)', () => {
  function insertProject(db: ReturnType<typeof openDatabase>, slug = 'test'): number {
    const result = db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run('Test', slug, 'Typ')
    return Number(result.lastInsertRowid)
  }

  function insertTask(db: ReturnType<typeof openDatabase>, projectId: number, title = 'Task'): number {
    const result = db
      .prepare('INSERT INTO tasks (project_id, title, created_by) VALUES (?, ?, ?)')
      .run(projectId, title, 'LEON')
    return Number(result.lastInsertRowid)
  }

  function insertWorkRequest(
    db: ReturnType<typeof openDatabase>,
    projectId: number,
    overrides: Partial<{ status: string; createdBy: string }> = {}
  ): number {
    const result = db
      .prepare('INSERT INTO work_requests (project_id, title, intent_markdown, status, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, 'Titel', 'Intent', overrides.status ?? 'IDEA', overrides.createdBy ?? 'LEON')
    return Number(result.lastInsertRowid)
  }

  it('legt die work_requests/work_request_decisions/work_request_tasks-Tabellen mit den erwarteten Indizes an', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
    ).map((i) => i.name)
    expect(indexNames).toContain('idx_work_requests_project')
    expect(indexNames).toContain('idx_work_requests_status')
    expect(indexNames).toContain('idx_work_request_decisions_request')
    expect(indexNames).toContain('idx_work_request_decisions_status')
    expect(indexNames).toContain('idx_work_request_tasks_request')
  })

  it('setzt Standardwerte fuer status und erlaubt NULL fuer plan_markdown', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const id = db
      .prepare('INSERT INTO work_requests (project_id, title, intent_markdown, created_by) VALUES (?, ?, ?, ?)')
      .run(projectId, 'Titel', 'Intent', 'LEON').lastInsertRowid
    const row = db.prepare('SELECT * FROM work_requests WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.status).toBe('IDEA')
    expect(row.plan_markdown).toBeNull()
  })

  it.each([
    ['status', "INSERT INTO work_requests (project_id, title, intent_markdown, status, created_by) VALUES (?, 'T', 'I', 'UNKNOWN', 'LEON')"],
    ['created_by', "INSERT INTO work_requests (project_id, title, intent_markdown, created_by) VALUES (?, 'T', 'I', 'ANONYMOUS')"]
  ])('lehnt einen ungueltigen Wert fuer work_requests.%s ab', (_column, sql) => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() => db.prepare(sql).run(projectId)).toThrow()
  })

  it('verhindert das Anlegen von Work Requests fuer nicht existierende Projekte (Fremdschluessel)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    expect(() =>
      db
        .prepare("INSERT INTO work_requests (project_id, title, intent_markdown, created_by) VALUES (9999, 'T', 'I', 'LEON')")
        .run()
    ).toThrow()
  })

  it('loescht work_requests kaskadierend mit dem Projekt', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    insertWorkRequest(db, projectId)
    expect(() => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)).not.toThrow()
    expect((db.prepare('SELECT COUNT(*) as c FROM work_requests').get() as { c: number }).c).toBe(0)
    const violations = db.pragma('foreign_key_check') as unknown[]
    expect(violations).toHaveLength(0)
  })

  it('erzwingt gueltiges JSON in options_json und einen gueltigen status fuer work_request_decisions', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const workRequestId = insertWorkRequest(db, projectId)
    expect(() =>
      db
        .prepare(
          'INSERT INTO work_request_decisions (work_request_id, question_markdown, options_json) VALUES (?, ?, ?)'
        )
        .run(workRequestId, 'Frage?', 'kein json')
    ).toThrow()
    expect(() =>
      db
        .prepare(
          "INSERT INTO work_request_decisions (work_request_id, question_markdown, options_json, status) VALUES (?, ?, '[]', 'UNKNOWN')"
        )
        .run(workRequestId, 'Frage?')
    ).toThrow()
    expect(() =>
      db
        .prepare(
          'INSERT INTO work_request_decisions (work_request_id, question_markdown, options_json) VALUES (?, ?, ?)'
        )
        .run(workRequestId, 'Frage?', '[]')
    ).not.toThrow()
  })

  it('loescht work_request_decisions kaskadierend mit dem Work Request', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const workRequestId = insertWorkRequest(db, projectId)
    db.prepare(
      'INSERT INTO work_request_decisions (work_request_id, question_markdown, options_json) VALUES (?, ?, ?)'
    ).run(workRequestId, 'Frage?', '[]')
    db.prepare('DELETE FROM work_requests WHERE id = ?').run(workRequestId)
    expect((db.prepare('SELECT COUNT(*) as c FROM work_request_decisions').get() as { c: number }).c).toBe(0)
  })

  it('erzwingt per PRIMARY KEY, dass eine Aufgabe zu hoechstens einem Work Request gehoert', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const taskId = insertTask(db, projectId)
    const requestA = insertWorkRequest(db, projectId)
    const requestB = insertWorkRequest(db, projectId)
    db.prepare('INSERT INTO work_request_tasks (task_id, work_request_id, position) VALUES (?, ?, 0)').run(
      taskId,
      requestA
    )
    expect(() =>
      db.prepare('INSERT INTO work_request_tasks (task_id, work_request_id, position) VALUES (?, ?, 0)').run(
        taskId,
        requestB
      )
    ).toThrow()
  })

  it('erzwingt UNIQUE(work_request_id, position) fuer work_request_tasks', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const taskA = insertTask(db, projectId, 'A')
    const taskB = insertTask(db, projectId, 'B')
    const workRequestId = insertWorkRequest(db, projectId)
    db.prepare('INSERT INTO work_request_tasks (task_id, work_request_id, position) VALUES (?, ?, 0)').run(
      taskA,
      workRequestId
    )
    expect(() =>
      db.prepare('INSERT INTO work_request_tasks (task_id, work_request_id, position) VALUES (?, ?, 0)').run(
        taskB,
        workRequestId
      )
    ).toThrow()
  })

  it('erzwingt position >= 0 fuer work_request_tasks', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const taskId = insertTask(db, projectId)
    const workRequestId = insertWorkRequest(db, projectId)
    expect(() =>
      db.prepare('INSERT INTO work_request_tasks (task_id, work_request_id, position) VALUES (?, ?, -1)').run(
        taskId,
        workRequestId
      )
    ).toThrow()
  })

  it('loescht work_request_tasks kaskadierend mit der Aufgabe UND mit dem Work Request', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const taskA = insertTask(db, projectId, 'A')
    const taskB = insertTask(db, projectId, 'B')
    const workRequestId = insertWorkRequest(db, projectId)
    db.prepare('INSERT INTO work_request_tasks (task_id, work_request_id, position) VALUES (?, ?, 0)').run(
      taskA,
      workRequestId
    )
    db.prepare('INSERT INTO work_request_tasks (task_id, work_request_id, position) VALUES (?, ?, 1)').run(
      taskB,
      workRequestId
    )

    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskA)
    expect((db.prepare('SELECT COUNT(*) as c FROM work_request_tasks').get() as { c: number }).c).toBe(1)

    db.prepare('DELETE FROM work_requests WHERE id = ?').run(workRequestId)
    expect((db.prepare('SELECT COUNT(*) as c FROM work_request_tasks').get() as { c: number }).c).toBe(0)

    const violations = db.pragma('foreign_key_check') as unknown[]
    expect(violations).toHaveLength(0)
  })

  it('kann auf eine bereits mit Migration 1-5 initialisierte Datenbank angewendet werden (Teil-Upgrade)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    db.exec('DROP TABLE work_request_tasks;')
    db.exec('DROP TABLE work_request_decisions;')
    db.exec('DROP TABLE work_requests;')
    db.prepare('DELETE FROM _migrations WHERE version = 6').run()

    const second = runMigrations(db)
    expect(second.applied).toEqual([6])

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(tables).toContain('work_requests')
    expect(tables).toContain('work_request_decisions')
    expect(tables).toContain('work_request_tasks')
  })
})

describe('Migration 7 - apply_batches (Meilenstein 4.8B.2B)', () => {
  function insertProject(db: ReturnType<typeof openDatabase>, slug = 'test'): number {
    const result = db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run('Test', slug, 'Typ')
    return Number(result.lastInsertRowid)
  }

  const VALID_FILE_ID = 'a1'.repeat(16) // 32 lowercase hex chars
  const VALID_VOLUME_SERIAL = '123456789'
  const VALID_SHA256 = 'b2'.repeat(32) // 64 lowercase hex chars
  const VALID_AUTHORIZATION_JSON = JSON.stringify({ schemaVersion: 'eclipse-apply-authorization-v1' })

  interface BatchOverrides {
    reviewId?: string
    fingerprint?: string
    schemaVersion?: string
    authorizationJson?: string
    rootFileId?: string | null
    rootVolumeSerial?: string | null
    state?: string
    preRecoveryState?: string | null
  }

  function insertBatch(db: ReturnType<typeof openDatabase>, projectId: number, overrides: BatchOverrides = {}): number {
    const result = db
      .prepare(
        `INSERT INTO apply_batches
           (project_id, review_id, fingerprint, schema_version, authorization_json,
            root_native_file_id_128_hex, root_native_volume_serial, state, pre_recovery_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectId,
        overrides.reviewId ?? 'review-1',
        overrides.fingerprint ?? 'fp-1',
        overrides.schemaVersion ?? 'eclipse-apply-authorization-v1',
        overrides.authorizationJson ?? VALID_AUTHORIZATION_JSON,
        overrides.rootFileId ?? null,
        overrides.rootVolumeSerial ?? null,
        overrides.state ?? 'ADMITTED',
        overrides.preRecoveryState ?? null
      )
    return Number(result.lastInsertRowid)
  }

  interface EntryOverrides {
    ordinal?: number
    mutationType?: string
    relPath?: string
    proposedSha256?: string
    proposedByteLength?: number
    originalBytes?: Buffer | null
    originalSha256?: string | null
    originalByteLength?: number | null
    preparedFileId?: string | null
    preparedVolumeSerial?: string | null
    state?: string
    nativeFileId?: string | null
    nativeVolumeSerial?: string | null
    writtenSha256?: string | null
    writtenByteLength?: number | null
  }

  function insertEntry(db: ReturnType<typeof openDatabase>, batchId: number, overrides: EntryOverrides = {}): number {
    const mutationType = overrides.mutationType ?? 'CREATE'
    const isModify = mutationType === 'MODIFY'
    const defaultOriginalBytes = isModify ? Buffer.from('orig') : null
    const originalBytes = overrides.originalBytes !== undefined ? overrides.originalBytes : defaultOriginalBytes
    const originalSha256 = overrides.originalSha256 !== undefined ? overrides.originalSha256 : isModify ? VALID_SHA256 : null
    const originalByteLength =
      overrides.originalByteLength !== undefined ? overrides.originalByteLength : originalBytes ? originalBytes.length : null

    const result = db
      .prepare(
        `INSERT INTO apply_batch_entries
           (batch_id, ordinal, mutation_type, rel_path, proposed_sha256, proposed_byte_length,
            original_bytes, original_sha256, original_byte_length,
            prepared_native_file_id_128_hex, prepared_native_volume_serial,
            state, native_file_id_128_hex, native_volume_serial, written_sha256, written_byte_length)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        batchId,
        overrides.ordinal ?? 0,
        mutationType,
        overrides.relPath ?? 'src/a.ts',
        overrides.proposedSha256 ?? VALID_SHA256,
        overrides.proposedByteLength ?? 10,
        originalBytes,
        originalSha256,
        originalByteLength,
        overrides.preparedFileId ?? null,
        overrides.preparedVolumeSerial ?? null,
        overrides.state ?? 'PENDING',
        overrides.nativeFileId ?? null,
        overrides.nativeVolumeSerial ?? null,
        overrides.writtenSha256 ?? null,
        overrides.writtenByteLength ?? null
      )
    return Number(result.lastInsertRowid)
  }

  it('legt beide Tabellen mit den erwarteten Indizes und Triggern an', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (t) => t.name
    )
    expect(tables).toContain('apply_batches')
    expect(tables).toContain('apply_batch_entries')

    const indexNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
      (i) => i.name
    )
    expect(indexNames).toContain('idx_apply_batches_one_unresolved_per_project')
    expect(indexNames).toContain('idx_apply_batches_project')
    expect(indexNames).toContain('idx_apply_batches_state')
    expect(indexNames).toContain('idx_apply_batch_entries_batch')
    expect(indexNames).toContain('idx_apply_batch_entries_state')

    const triggerNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(triggerNames).toContain('apply_batches_no_update_terminal')
    expect(triggerNames).toContain('apply_batch_entries_no_update_terminal')
  })

  it('erzwingt mutation_type nur MODIFY oder CREATE', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId)
    expect(() => insertEntry(db, batchId, { mutationType: 'DELETE' })).toThrow()
    expect(() => insertEntry(db, batchId, { mutationType: 'MODIFY', ordinal: 0 })).not.toThrow()
    expect(() => insertEntry(db, batchId, { mutationType: 'CREATE', ordinal: 1, relPath: 'src/b.ts' })).not.toThrow()
  })

  it('erzwingt state nur aus dem eingefrorenen batch-Vokabular', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() => insertBatch(db, projectId, { state: 'DONE' })).toThrow()
    // Each of these is itself an unresolved state (idx_apply_batches_one_unresolved_per_project) -
    // a fresh project per iteration avoids colliding with the previous iteration's still-unresolved row.
    for (const state of ['ADMITTED', 'PREPARED', 'APPLYING', 'ROLLING_BACK']) {
      const stateProjectId = insertProject(db, `state-${state}`)
      expect(() =>
        insertBatch(db, stateProjectId, {
          state,
          rootFileId: state === 'ADMITTED' ? null : VALID_FILE_ID,
          rootVolumeSerial: state === 'ADMITTED' ? null : VALID_VOLUME_SERIAL
        })
      ).not.toThrow()
    }
  })

  it('erzwingt state nur aus dem eingefrorenen entry-Vokabular', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId)
    expect(() => insertEntry(db, batchId, { state: 'FINISHED' })).toThrow()
  })

  it.each([
    ['zu kurz', 'ab'],
    ['Grossbuchstaben', VALID_SHA256.toUpperCase()],
    ['ungueltiges Hex-Zeichen', 'g'.repeat(64)]
  ])('lehnt ein ungueltiges proposed_sha256-Format ab (%s)', (_label, invalid) => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId)
    expect(() => insertEntry(db, batchId, { proposedSha256: invalid })).toThrow()
  })

  it('akzeptiert ein gueltiges 64-stelliges Kleinbuchstaben-Hex proposed_sha256', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId)
    expect(() => insertEntry(db, batchId, { proposedSha256: VALID_SHA256 })).not.toThrow()
  })

  it.each([
    ['zu kurz', 'a1'],
    ['Grossbuchstaben', VALID_FILE_ID.toUpperCase()],
    ['ungueltiges Hex-Zeichen', 'g'.repeat(32)]
  ])('lehnt ein ungueltiges native_file_id_128_hex-Format ab (%s)', (_label, invalid) => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId)
    expect(() =>
      insertEntry(db, batchId, {
        mutationType: 'CREATE',
        state: 'APPLIED',
        nativeFileId: invalid,
        nativeVolumeSerial: VALID_VOLUME_SERIAL,
        writtenSha256: VALID_SHA256,
        writtenByteLength: 10
      })
    ).toThrow()
  })

  it.each([
    ['nicht-dezimal', '12a'],
    ['leer', '']
  ])('lehnt ein ungueltiges volume_serial-Format ab (%s)', (_label, invalid) => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() => insertBatch(db, projectId, { state: 'PREPARED', rootFileId: VALID_FILE_ID, rootVolumeSerial: invalid })).toThrow()
  })

  it('erzwingt nicht-negative Laengen (proposed/original/written byte length)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId)
    expect(() => insertEntry(db, batchId, { proposedByteLength: -1 })).toThrow()
    expect(() =>
      insertEntry(db, batchId, { mutationType: 'MODIFY', originalByteLength: -1, originalBytes: Buffer.from('x') })
    ).toThrow()
  })

  describe('MODIFY/CREATE original_bytes XOR + Rekonstruktions-Laengenpruefung', () => {
    it('verlangt original_bytes/original_sha256/original_byte_length fuer MODIFY', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      expect(() =>
        insertEntry(db, batchId, { mutationType: 'MODIFY', originalBytes: null, originalSha256: null, originalByteLength: null })
      ).toThrow()
      expect(() => insertEntry(db, batchId, { mutationType: 'MODIFY' })).not.toThrow()
    })

    it('verbietet original_bytes/original_sha256/original_byte_length fuer CREATE', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      expect(() =>
        insertEntry(db, batchId, { mutationType: 'CREATE', originalBytes: Buffer.from('x'), originalSha256: VALID_SHA256, originalByteLength: 1 })
      ).toThrow()
      expect(() => insertEntry(db, batchId, { mutationType: 'CREATE' })).not.toThrow()
    })

    it('erzwingt length(original_bytes) = original_byte_length', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      expect(() =>
        insertEntry(db, batchId, { mutationType: 'MODIFY', originalBytes: Buffer.from('12345'), originalByteLength: 999 })
      ).toThrow()
    })
  })

  describe('prepared_native_* (Pre-Forward-Zielidentitaet)', () => {
    it('verbietet prepared_native_* fuer CREATE, unabhaengig vom state', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      expect(() =>
        insertEntry(db, batchId, { mutationType: 'CREATE', preparedFileId: VALID_FILE_ID, preparedVolumeSerial: VALID_VOLUME_SERIAL })
      ).toThrow()
    })

    it.each(['PREPARED', 'APPLY_ATTEMPTING', 'APPLIED', 'ROLLBACK_ATTEMPTING'])(
      'verlangt prepared_native_* fuer MODIFY im Zustand %s',
      (state) => {
        const db = openDatabase(':memory:')
        runMigrations(db)
        const projectId = insertProject(db)
        const batchId = insertBatch(db, projectId)
        const applyEvidence =
          state === 'APPLIED'
            ? { nativeFileId: VALID_FILE_ID, nativeVolumeSerial: VALID_VOLUME_SERIAL, writtenSha256: VALID_SHA256, writtenByteLength: 10 }
            : {}
        expect(() => insertEntry(db, batchId, { mutationType: 'MODIFY', state, ...applyEvidence })).toThrow()
        expect(() =>
          insertEntry(db, batchId, {
            mutationType: 'MODIFY',
            state,
            preparedFileId: VALID_FILE_ID,
            preparedVolumeSerial: VALID_VOLUME_SERIAL,
            ...applyEvidence
          })
        ).not.toThrow()
      }
    )

    it('erlaubt PENDING/ROLLED_BACK/RECOVERY_CONFLICT fuer MODIFY sowohl mit als auch ohne prepared_native_*', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      let ordinal = 0
      for (const state of ['PENDING', 'ROLLED_BACK', 'RECOVERY_CONFLICT']) {
        expect(() =>
          insertEntry(db, batchId, { mutationType: 'MODIFY', state, ordinal: ordinal++, relPath: `src/${state}-a.ts` })
        ).not.toThrow()
        expect(() =>
          insertEntry(db, batchId, {
            mutationType: 'MODIFY',
            state,
            ordinal: ordinal++,
            relPath: `src/${state}-b.ts`,
            preparedFileId: VALID_FILE_ID,
            preparedVolumeSerial: VALID_VOLUME_SERIAL
          })
        ).not.toThrow()
      }
    })
  })

  describe('APPLIED verlangt Post-Forward-Evidenz', () => {
    it('lehnt APPLIED ohne vollstaendige native_*/written_*-Evidenz ab', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      expect(() => insertEntry(db, batchId, { mutationType: 'CREATE', state: 'APPLIED' })).toThrow()
    })

    it('akzeptiert APPLIED mit vollstaendiger Evidenz', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      expect(() =>
        insertEntry(db, batchId, {
          mutationType: 'CREATE',
          state: 'APPLIED',
          nativeFileId: VALID_FILE_ID,
          nativeVolumeSerial: VALID_VOLUME_SERIAL,
          writtenSha256: VALID_SHA256,
          writtenByteLength: 10
        })
      ).not.toThrow()
    })

    it('verlangt KEINE native_*/written_*-Evidenz bei RECOVERY_CONFLICT oder ROLLBACK_ATTEMPTING (irreduzibles CREATE-Absturzfenster)', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      expect(() => insertEntry(db, batchId, { mutationType: 'CREATE', state: 'RECOVERY_CONFLICT' })).not.toThrow()
      expect(() =>
        insertEntry(db, batchId, { mutationType: 'CREATE', state: 'ROLLBACK_ATTEMPTING', ordinal: 1, relPath: 'src/c.ts' })
      ).not.toThrow()
    })
  })

  describe('pre_recovery_state - Herkunfts-Marker (KEIN neunter Zustand)', () => {
    it('verbietet pre_recovery_state auf ADMITTED/PREPARED/APPLYING/ROLLING_BACK', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      expect(() => insertBatch(db, projectId, { state: 'ADMITTED', preRecoveryState: 'ADMITTED' })).toThrow()
      for (const state of ['PREPARED', 'APPLYING', 'ROLLING_BACK']) {
        expect(() =>
          insertBatch(db, projectId, { state, preRecoveryState: 'PREPARED', rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL })
        ).toThrow()
      }
    })

    it('verlangt pre_recovery_state, solange der Batch aktiv in einem Recovery-Zustand ist', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      expect(() => insertBatch(db, projectId, { state: 'RECOVERY_REQUIRED', preRecoveryState: null })).toThrow()
      expect(() => insertBatch(db, projectId, { state: 'RECOVERY_CONFLICT', preRecoveryState: null })).toThrow()
    })

    it('lehnt SUCCEEDED mit pre_recovery_state=ADMITTED ab (logisch unmoeglich - siehe M4.8B2B-Implementation-Spec.md)', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      expect(() => insertBatch(db, projectId, { state: 'SUCCEEDED', preRecoveryState: 'ADMITTED' })).toThrow()
    })

    it('erlaubt SUCCEEDED mit pre_recovery_state=PREPARED/ROLLING_BACK auf Schema-Ebene (Repraesentierbarkeit) - die feinere Regel, dass NUR APPLYING SUCCEEDED erreichen darf, ist Transitions-History-Durchsetzung und gehoert zum kuenftigen B.2C-Service, nicht zu diesem Schema-Test', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      expect(() =>
        insertBatch(db, projectId, {
          state: 'SUCCEEDED',
          preRecoveryState: 'PREPARED',
          rootFileId: VALID_FILE_ID,
          rootVolumeSerial: VALID_VOLUME_SERIAL
        })
      ).not.toThrow()
      expect(() =>
        insertBatch(db, projectId, {
          state: 'SUCCEEDED',
          preRecoveryState: 'ROLLING_BACK',
          rootFileId: VALID_FILE_ID,
          rootVolumeSerial: VALID_VOLUME_SERIAL,
          reviewId: 'review-2'
        })
      ).not.toThrow()
    })
  })

  describe('Root-Evidenz-Anforderung (NULL-sicher IS/IS NOT)', () => {
    it('verbietet Root-Evidenz bei ADMITTED', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      expect(() => insertBatch(db, projectId, { state: 'ADMITTED', rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL })).toThrow()
    })

    it('verlangt Root-Evidenz bei PREPARED/APPLYING/ROLLING_BACK/SUCCEEDED (Normalpfad)', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      for (const state of ['PREPARED', 'APPLYING', 'ROLLING_BACK', 'SUCCEEDED']) {
        expect(() => insertBatch(db, projectId, { state, rootFileId: null, rootVolumeSerial: null, reviewId: `r-${state}` })).toThrow()
      }
    })

    it('verlangt Root-Evidenz bei ROLLED_BACK auf dem Normalpfad (pre_recovery_state=NULL)', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      expect(() => insertBatch(db, projectId, { state: 'ROLLED_BACK', rootFileId: null, rootVolumeSerial: null })).toThrow()
      expect(() =>
        insertBatch(db, projectId, { state: 'ROLLED_BACK', rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL })
      ).not.toThrow()
    })

    it('verbietet Root-Evidenz bei RECOVERY_REQUIRED/RECOVERY_CONFLICT/ROLLED_BACK mit pre_recovery_state=ADMITTED', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      // Ein frisches Projekt je Zustand: RECOVERY_REQUIRED/RECOVERY_CONFLICT sind
      // selbst ungeloeste Zustaende (idx_apply_batches_one_unresolved_per_project) -
      // dasselbe Projekt ueber mehrere Iterationen hinweg wiederzuverwenden wuerde
      // mit der aus der vorherigen Iteration bereits erfolgreich eingefuegten,
      // weiterhin ungeloesten Zeile kollidieren.
      for (const state of ['RECOVERY_REQUIRED', 'RECOVERY_CONFLICT', 'ROLLED_BACK']) {
        const projectId = insertProject(db, `forbid-${state}`)
        expect(() =>
          insertBatch(db, projectId, { state, preRecoveryState: 'ADMITTED', rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL, reviewId: `r-${state}` })
        ).toThrow()
        expect(() => insertBatch(db, projectId, { state, preRecoveryState: 'ADMITTED', reviewId: `r2-${state}` })).not.toThrow()
      }
    })

    it('verlangt Root-Evidenz bei RECOVERY_REQUIRED/RECOVERY_CONFLICT/ROLLED_BACK mit pre_recovery_state != ADMITTED', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      for (const state of ['RECOVERY_REQUIRED', 'RECOVERY_CONFLICT', 'ROLLED_BACK']) {
        const projectId = insertProject(db, `require-${state}`)
        expect(() =>
          insertBatch(db, projectId, { state, preRecoveryState: 'PREPARED', rootFileId: null, rootVolumeSerial: null, reviewId: `r3-${state}` })
        ).toThrow()
        expect(() =>
          insertBatch(db, projectId, {
            state,
            preRecoveryState: 'PREPARED',
            rootFileId: VALID_FILE_ID,
            rootVolumeSerial: VALID_VOLUME_SERIAL,
            reviewId: `r4-${state}`
          })
        ).not.toThrow()
      }
    })
  })

  describe('Paar-Vollstaendigkeit der nativen Evidenz-Paare (kein einseitig gesetztes Paar)', () => {
    it('lehnt ein ADMITTED-Batch mit genau einem gesetzten Root-Identitaets-Feld ab (beide Richtungen)', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId1 = insertProject(db, 'root-pair-a')
      expect(() =>
        insertBatch(db, projectId1, { state: 'ADMITTED', rootFileId: VALID_FILE_ID, rootVolumeSerial: null })
      ).toThrow()
      const projectId2 = insertProject(db, 'root-pair-b')
      expect(() =>
        insertBatch(db, projectId2, { state: 'ADMITTED', rootFileId: null, rootVolumeSerial: VALID_VOLUME_SERIAL })
      ).toThrow()
    })

    it('lehnt eine MODIFY-Entry in einem permissiven Zustand (PENDING) mit genau einem gesetzten prepared_native_*-Feld ab (beide Richtungen)', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      expect(() =>
        insertEntry(db, batchId, {
          mutationType: 'MODIFY',
          state: 'PENDING',
          ordinal: 0,
          relPath: 'src/a.ts',
          preparedFileId: VALID_FILE_ID,
          preparedVolumeSerial: null
        })
      ).toThrow()
      expect(() =>
        insertEntry(db, batchId, {
          mutationType: 'MODIFY',
          state: 'PENDING',
          ordinal: 1,
          relPath: 'src/b.ts',
          preparedFileId: null,
          preparedVolumeSerial: VALID_VOLUME_SERIAL
        })
      ).toThrow()
    })

    it('lehnt eine Entry in einem permissiven Zustand (PENDING) mit genau einem gesetzten Post-Forward-native_*-Feld ab (beide Richtungen)', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      expect(() =>
        insertEntry(db, batchId, {
          mutationType: 'CREATE',
          state: 'PENDING',
          ordinal: 0,
          relPath: 'src/a.ts',
          nativeFileId: VALID_FILE_ID,
          nativeVolumeSerial: null
        })
      ).toThrow()
      expect(() =>
        insertEntry(db, batchId, {
          mutationType: 'CREATE',
          state: 'PENDING',
          ordinal: 1,
          relPath: 'src/b.ts',
          nativeFileId: null,
          nativeVolumeSerial: VALID_VOLUME_SERIAL
        })
      ).toThrow()
    })

    it('lehnt eine Entry in einem permissiven Zustand (PENDING) mit genau einem gesetzten written_*-Feld ab (beide Richtungen)', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      expect(() =>
        insertEntry(db, batchId, {
          mutationType: 'CREATE',
          state: 'PENDING',
          ordinal: 0,
          relPath: 'src/a.ts',
          writtenSha256: VALID_SHA256,
          writtenByteLength: null
        })
      ).toThrow()
      expect(() =>
        insertEntry(db, batchId, {
          mutationType: 'CREATE',
          state: 'PENDING',
          ordinal: 1,
          relPath: 'src/b.ts',
          writtenSha256: null,
          writtenByteLength: 10
        })
      ).toThrow()
    })

    it('erlaubt weiterhin vollstaendige Paare (beide NULL oder beide gesetzt) fuer alle vier Evidenz-Paare', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      // Root: beide NULL (ADMITTED) und beide gesetzt (PREPARED) sind bereits
      // durch die bestehenden Root-Evidenz-Tests abgedeckt - hier zusaetzlich
      // explizit fuer die neuen Paar-Checks bestaetigt.
      expect(() => insertBatch(db, projectId, { state: 'ADMITTED', rootFileId: null, rootVolumeSerial: null })).not.toThrow()
      const preparedProjectId = insertProject(db, 'pair-complete-prepared')
      expect(() =>
        insertBatch(db, preparedProjectId, { state: 'PREPARED', rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL })
      ).not.toThrow()

      const batchId = insertBatch(db, insertProject(db, 'pair-complete-entries'))
      expect(() =>
        insertEntry(db, batchId, { mutationType: 'MODIFY', state: 'PENDING', ordinal: 0, relPath: 'src/a.ts', preparedFileId: null, preparedVolumeSerial: null })
      ).not.toThrow()
      expect(() =>
        insertEntry(db, batchId, {
          mutationType: 'MODIFY',
          state: 'PREPARED',
          ordinal: 1,
          relPath: 'src/b.ts',
          preparedFileId: VALID_FILE_ID,
          preparedVolumeSerial: VALID_VOLUME_SERIAL
        })
      ).not.toThrow()
      expect(() =>
        insertEntry(db, batchId, {
          mutationType: 'CREATE',
          state: 'APPLIED',
          ordinal: 2,
          relPath: 'src/c.ts',
          nativeFileId: VALID_FILE_ID,
          nativeVolumeSerial: VALID_VOLUME_SERIAL,
          writtenSha256: VALID_SHA256,
          writtenByteLength: 10
        })
      ).not.toThrow()
    })
  })

  describe('die drei vorgeschriebenen Batch-Uebergangsketten (M4.8B.2B controller mandate)', () => {
    it('ADMITTED -> RECOVERY_REQUIRED(origin ADMITTED, keine Root-Evidenz) -> ROLLED_BACK gelingt', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId, { state: 'ADMITTED' })

      expect(() =>
        db.prepare("UPDATE apply_batches SET state = 'RECOVERY_REQUIRED', pre_recovery_state = 'ADMITTED' WHERE id = ?").run(batchId)
      ).not.toThrow()
      expect(() => db.prepare("UPDATE apply_batches SET state = 'ROLLED_BACK' WHERE id = ?").run(batchId)).not.toThrow()

      const row = db.prepare('SELECT * FROM apply_batches WHERE id = ?').get(batchId) as Record<string, unknown>
      expect(row.state).toBe('ROLLED_BACK')
      expect(row.pre_recovery_state).toBe('ADMITTED')
      expect(row.root_native_file_id_128_hex).toBeNull()
      expect(row.root_native_volume_serial).toBeNull()
    })

    it('PREPARED -> RECOVERY_REQUIRED(origin PREPARED, fehlende Root-Evidenz) schlaegt fehl', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId, { state: 'PREPARED', rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL })

      expect(() =>
        db
          .prepare(
            `UPDATE apply_batches
             SET state = 'RECOVERY_REQUIRED', pre_recovery_state = 'PREPARED',
                 root_native_file_id_128_hex = NULL, root_native_volume_serial = NULL
             WHERE id = ?`
          )
          .run(batchId)
      ).toThrow()
    })

    it('PREPARED -> RECOVERY_REQUIRED(origin PREPARED, gueltige Root-Evidenz) -> ROLLED_BACK gelingt und die Evidenz bleibt unveraendert erhalten', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId, { state: 'PREPARED', rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL })

      expect(() =>
        db.prepare("UPDATE apply_batches SET state = 'RECOVERY_REQUIRED', pre_recovery_state = 'PREPARED' WHERE id = ?").run(batchId)
      ).not.toThrow()
      expect(() => db.prepare("UPDATE apply_batches SET state = 'ROLLED_BACK' WHERE id = ?").run(batchId)).not.toThrow()

      const row = db.prepare('SELECT * FROM apply_batches WHERE id = ?').get(batchId) as Record<string, unknown>
      expect(row.state).toBe('ROLLED_BACK')
      expect(row.pre_recovery_state).toBe('PREPARED')
      expect(row.root_native_file_id_128_hex).toBe(VALID_FILE_ID)
      expect(row.root_native_volume_serial).toBe(VALID_VOLUME_SERIAL)
    })
  })

  describe('ein ungeloester Batch je Projekt', () => {
    const unresolvedCombos: Array<{ state: string; preRecoveryState: string | null; rootFileId: string | null; rootVolumeSerial: string | null }> = [
      { state: 'ADMITTED', preRecoveryState: null, rootFileId: null, rootVolumeSerial: null },
      { state: 'PREPARED', preRecoveryState: null, rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL },
      { state: 'APPLYING', preRecoveryState: null, rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL },
      { state: 'ROLLING_BACK', preRecoveryState: null, rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL },
      { state: 'RECOVERY_REQUIRED', preRecoveryState: 'ADMITTED', rootFileId: null, rootVolumeSerial: null },
      { state: 'RECOVERY_CONFLICT', preRecoveryState: 'ADMITTED', rootFileId: null, rootVolumeSerial: null }
    ]

    it.each(unresolvedCombos)('lehnt einen zweiten ungeloesten Batch fuer dasselbe Projekt ab (bestehender Zustand: %s)', (combo) => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      insertBatch(db, projectId, {
        state: combo.state,
        preRecoveryState: combo.preRecoveryState,
        rootFileId: combo.rootFileId,
        rootVolumeSerial: combo.rootVolumeSerial
      })
      expect(() => insertBatch(db, projectId, { state: 'ADMITTED', reviewId: 'review-2' })).toThrow()

      // Ein anderes Projekt ist von dieser Eindeutigkeit unberuehrt.
      const otherProjectId = insertProject(db, 'other')
      expect(() => insertBatch(db, otherProjectId, { state: 'ADMITTED', reviewId: 'review-3' })).not.toThrow()
    })

    it('ein terminaler Batch (SUCCEEDED oder ROLLED_BACK) blockiert KEINEN neuen Batch fuer dasselbe Projekt', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      insertBatch(db, projectId, { state: 'SUCCEEDED', rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL })
      expect(() => insertBatch(db, projectId, { state: 'ADMITTED', reviewId: 'review-2' })).not.toThrow()

      const secondProjectId = insertProject(db, 'second')
      insertBatch(db, secondProjectId, { state: 'ROLLED_BACK', rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL })
      expect(() => insertBatch(db, secondProjectId, { state: 'ADMITTED', reviewId: 'review-4' })).not.toThrow()
    })
  })

  describe('Terminal-Unveraenderlichkeit', () => {
    it('verbietet jedes UPDATE auf einem SUCCEEDED- oder ROLLED_BACK-Batch', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const succeededId = insertBatch(db, projectId, { state: 'SUCCEEDED', rootFileId: VALID_FILE_ID, rootVolumeSerial: VALID_VOLUME_SERIAL })
      expect(() => db.prepare("UPDATE apply_batches SET fingerprint = 'changed' WHERE id = ?").run(succeededId)).toThrow()

      const rolledBackId = insertBatch(db, insertProject(db, 'p2'), {
        state: 'ROLLED_BACK',
        rootFileId: VALID_FILE_ID,
        rootVolumeSerial: VALID_VOLUME_SERIAL
      })
      expect(() => db.prepare("UPDATE apply_batches SET fingerprint = 'changed' WHERE id = ?").run(rolledBackId)).toThrow()
    })

    it('verbietet jedes UPDATE auf einer ROLLED_BACK-Entry, erlaubt aber ein UPDATE auf einer APPLIED-Entry (Geschwister-Rollback)', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      const rolledBackEntryId = insertEntry(db, batchId, { mutationType: 'CREATE', state: 'ROLLED_BACK' })
      expect(() => db.prepare("UPDATE apply_batch_entries SET rel_path = 'changed.ts' WHERE id = ?").run(rolledBackEntryId)).toThrow()

      const appliedEntryId = insertEntry(db, batchId, {
        mutationType: 'CREATE',
        ordinal: 1,
        relPath: 'src/applied.ts',
        state: 'APPLIED',
        nativeFileId: VALID_FILE_ID,
        nativeVolumeSerial: VALID_VOLUME_SERIAL,
        writtenSha256: VALID_SHA256,
        writtenByteLength: 10
      })
      expect(() =>
        db.prepare("UPDATE apply_batch_entries SET state = 'ROLLBACK_ATTEMPTING' WHERE id = ?").run(appliedEntryId)
      ).not.toThrow()
    })
  })

  describe('Entry-Uebergaenge - PENDING/PREPARED werden nie direkt zu RECOVERY_CONFLICT (M4.8B2B-Implementation-Spec.md Abschnitt 4)', () => {
    it('PENDING -> ROLLED_BACK gelingt ohne jede prepared_native_*-Evidenz (Batch abgebrochen, bevor je versucht wurde)', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      const entryId = insertEntry(db, batchId, { mutationType: 'MODIFY', state: 'PENDING' })
      expect(() => db.prepare("UPDATE apply_batch_entries SET state = 'ROLLED_BACK' WHERE id = ?").run(entryId)).not.toThrow()
    })

    it('PREPARED -> ROLLED_BACK gelingt, und die bei PREPARED gesetzte prepared_native_*-Evidenz bleibt erhalten', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      const entryId = insertEntry(db, batchId, {
        mutationType: 'MODIFY',
        state: 'PREPARED',
        preparedFileId: VALID_FILE_ID,
        preparedVolumeSerial: VALID_VOLUME_SERIAL
      })
      expect(() => db.prepare("UPDATE apply_batch_entries SET state = 'ROLLED_BACK' WHERE id = ?").run(entryId)).not.toThrow()
      const row = db.prepare('SELECT * FROM apply_batch_entries WHERE id = ?').get(entryId) as Record<string, unknown>
      expect(row.prepared_native_file_id_128_hex).toBe(VALID_FILE_ID)
      expect(row.prepared_native_volume_serial).toBe(VALID_VOLUME_SERIAL)
    })

    // Controller-Klarstellung: KEIN Test behandelt PENDING -> RECOVERY_CONFLICT
    // oder PREPARED -> RECOVERY_CONFLICT als gueltigen Workflow - dieser
    // Uebergang existiert bewusst nicht (siehe M4.8B2B-Implementation-Spec.md
    // Abschnitt 4.2/4.4). RECOVERY_CONFLICT ist ausschliesslich von
    // APPLY_ATTEMPTING/ROLLBACK_ATTEMPTING aus erreichbar - unten getestet.
    it('APPLY_ATTEMPTING -> RECOVERY_CONFLICT und ROLLBACK_ATTEMPTING -> RECOVERY_CONFLICT sind die EINZIGEN Quellzustaende', () => {
      const db = openDatabase(':memory:')
      runMigrations(db)
      const projectId = insertProject(db)
      const batchId = insertBatch(db, projectId)
      const fromApplyAttempting = insertEntry(db, batchId, {
        mutationType: 'MODIFY',
        state: 'APPLY_ATTEMPTING',
        preparedFileId: VALID_FILE_ID,
        preparedVolumeSerial: VALID_VOLUME_SERIAL
      })
      expect(() =>
        db.prepare("UPDATE apply_batch_entries SET state = 'RECOVERY_CONFLICT' WHERE id = ?").run(fromApplyAttempting)
      ).not.toThrow()

      const fromRollbackAttempting = insertEntry(db, batchId, {
        mutationType: 'MODIFY',
        ordinal: 1,
        relPath: 'src/other.ts',
        state: 'ROLLBACK_ATTEMPTING',
        preparedFileId: VALID_FILE_ID,
        preparedVolumeSerial: VALID_VOLUME_SERIAL
      })
      expect(() =>
        db.prepare("UPDATE apply_batch_entries SET state = 'RECOVERY_CONFLICT' WHERE id = ?").run(fromRollbackAttempting)
      ).not.toThrow()
    })
  })

  it('UNIQUE(batch_id, ordinal) und UNIQUE(batch_id, rel_path) werden erzwungen', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId)
    insertEntry(db, batchId, { ordinal: 0, relPath: 'src/a.ts' })
    expect(() => insertEntry(db, batchId, { ordinal: 0, relPath: 'src/b.ts' })).toThrow()
    expect(() => insertEntry(db, batchId, { ordinal: 1, relPath: 'src/a.ts' })).toThrow()
    expect(() => insertEntry(db, batchId, { ordinal: 1, relPath: 'src/b.ts' })).not.toThrow()
  })

  it('loescht apply_batch_entries kaskadierend mit dem apply_batches-Eintrag', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    const batchId = insertBatch(db, projectId)
    insertEntry(db, batchId)
    db.prepare('DELETE FROM apply_batches WHERE id = ?').run(batchId)
    expect((db.prepare('SELECT COUNT(*) as c FROM apply_batch_entries').get() as { c: number }).c).toBe(0)
    const violations = db.pragma('foreign_key_check') as unknown[]
    expect(violations).toHaveLength(0)
  })

  it('verhindert das Anlegen eines Batches fuer ein nicht existierendes Projekt (Fremdschluessel)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    expect(() => insertBatch(db, 999999)).toThrow()
  })

  it('erzwingt gueltiges JSON in authorization_json', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    const projectId = insertProject(db)
    expect(() => insertBatch(db, projectId, { authorizationJson: 'kein json' })).toThrow()
  })

  it('kann auf eine bereits mit Migration 1-6 initialisierte Datenbank angewendet werden (Teil-Upgrade)', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    db.exec('DROP TABLE apply_batch_entries;')
    db.exec('DROP TABLE apply_batches;')
    db.prepare('DELETE FROM _migrations WHERE version = 7').run()

    const second = runMigrations(db)
    expect(second.applied).toEqual([7])

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (t) => t.name
    )
    expect(tables).toContain('apply_batches')
    expect(tables).toContain('apply_batch_entries')
  })
})

describe('getPendingMigrationVersions', () => {
  it('liefert alle Migrationen fuer eine frische Datenbank', () => {
    const db = openDatabase(':memory:')
    expect(getPendingMigrationVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('liefert eine leere Liste, nachdem alle Migrationen angewendet wurden', () => {
    const db = openDatabase(':memory:')
    runMigrations(db)
    expect(getPendingMigrationVersions(db)).toEqual([])
  })

  it('veraendert die Datenbank nicht (reine Abfrage)', () => {
    const db = openDatabase(':memory:')
    getPendingMigrationVersions(db)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != '_migrations'")
      .all()
    expect(tables).toHaveLength(0)
  })
})
