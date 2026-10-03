import type Database from 'better-sqlite3'
import type { AppSettings, UpdateSettingsInput } from '@shared/types'
import { DEFAULT_CHATGPT_TEMPLATE, DEFAULT_CLAUDE_TEMPLATE } from '@shared/promptTemplates'
import { logEvent } from './eventLogService'
import { getProjectById, ProjectArchivedError } from './projectsService'

const DEFAULTS: AppSettings = {
  chatgptUrl: 'https://chat.openai.com',
  claudeUrl: 'https://claude.ai',
  chatgptGlobalTemplate: DEFAULT_CHATGPT_TEMPLATE,
  claudeGlobalTemplate: DEFAULT_CLAUDE_TEMPLATE
}

const KEY_MAP: Record<keyof AppSettings, string> = {
  chatgptUrl: 'chatgpt_url',
  claudeUrl: 'claude_url',
  chatgptGlobalTemplate: 'chatgpt_global_template',
  claudeGlobalTemplate: 'claude_global_template'
}

export function getSettings(db: Database.Database): AppSettings {
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{
    key: string
    value: string
  }>
  const byKey = new Map(rows.map((r) => [r.key, r.value]))

  return {
    chatgptUrl: byKey.get(KEY_MAP.chatgptUrl) ?? DEFAULTS.chatgptUrl,
    claudeUrl: byKey.get(KEY_MAP.claudeUrl) ?? DEFAULTS.claudeUrl,
    chatgptGlobalTemplate: byKey.get(KEY_MAP.chatgptGlobalTemplate) ?? DEFAULTS.chatgptGlobalTemplate,
    claudeGlobalTemplate: byKey.get(KEY_MAP.claudeGlobalTemplate) ?? DEFAULTS.claudeGlobalTemplate
  }
}

export function updateSettings(db: Database.Database, input: UpdateSettingsInput): AppSettings {
  const upsert = db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )

  const changedKeys: string[] = []

  const apply = db.transaction(() => {
    if (input.chatgptUrl !== undefined) {
      upsert.run(KEY_MAP.chatgptUrl, input.chatgptUrl.trim())
      changedKeys.push('chatgptUrl')
    }
    if (input.claudeUrl !== undefined) {
      upsert.run(KEY_MAP.claudeUrl, input.claudeUrl.trim())
      changedKeys.push('claudeUrl')
    }
    if (input.chatgptGlobalTemplate !== undefined) {
      upsert.run(KEY_MAP.chatgptGlobalTemplate, input.chatgptGlobalTemplate)
      changedKeys.push('chatgptGlobalTemplate')
    }
    if (input.claudeGlobalTemplate !== undefined) {
      upsert.run(KEY_MAP.claudeGlobalTemplate, input.claudeGlobalTemplate)
      changedKeys.push('claudeGlobalTemplate')
    }
    if (changedKeys.length > 0) {
      // Nur geaenderte Schluesselnamen protokollieren, NICHT die
      // (potenziell langen) Vorlagen-Inhalte selbst.
      logEvent(db, { projectId: null, type: 'SETTINGS_UPDATED', payload: { changedKeys } })
    }
  })

  apply()
  return getSettings(db)
}

export function getRoleTemplateOverride(
  db: Database.Database,
  projectId: number,
  role: 'CHATGPT' | 'CLAUDE'
): string | null {
  const row = db
    .prepare('SELECT template FROM project_role_template_overrides WHERE project_id = ? AND role = ?')
    .get(projectId, role) as { template: string } | undefined
  return row?.template ?? null
}

export function setRoleTemplateOverride(
  db: Database.Database,
  projectId: number,
  role: 'CHATGPT' | 'CLAUDE',
  template: string | null
): void {
  // Archivierte Projekte sind ueberall schreibgeschuetzt. Die UI blendet den
  // Editor zwar bereits aus, aber der Main-Prozess darf sich darauf nicht
  // verlassen - die Pruefung muss VOR jeder Datenbankaenderung und VOR dem
  // Event-Log-Eintrag stattfinden, damit bei Ablehnung wirklich nichts
  // geschrieben wird.
  const project = getProjectById(db, projectId)
  if (project.isArchived) {
    throw new ProjectArchivedError(projectId)
  }

  db.transaction(() => {
    if (template === null || template.trim() === '') {
      db.prepare('DELETE FROM project_role_template_overrides WHERE project_id = ? AND role = ?').run(
        projectId,
        role
      )
    } else {
      db.prepare(
        `INSERT INTO project_role_template_overrides (project_id, role, template) VALUES (?, ?, ?)
         ON CONFLICT(project_id, role) DO UPDATE SET template = excluded.template`
      ).run(projectId, role, template)
    }
    logEvent(db, {
      projectId,
      type: 'ROLE_OVERRIDE_UPDATED',
      payload: { role, cleared: template === null || template.trim() === '' }
    })
  })()
}
