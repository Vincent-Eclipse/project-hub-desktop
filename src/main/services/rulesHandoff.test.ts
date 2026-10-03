import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createTestDb } from '../testUtils/testDb'
import { openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrations'
import { createProject } from './projectsService'
import * as context from './contextService'
import { createRuleVersion } from './rulesService'
import { generatePrompt } from './promptService'
import { setRoleTemplateOverride, updateSettings } from './settingsService'
import { addChatMessage } from './chatService'

afterEach(() => vi.restoreAllMocks())

describe('mandatory Rules in Handoffs', () => {
  it.each(['CHATGPT', 'CLAUDE'] as const)('preserves %s global and project templates while injecting exact current Rules', (role) => {
    const db = createTestDb()
    try {
      const project = createProject(db, { name: 'Example', projectType: 'App', description: '' })
      context.createContextVersion(db, { projectId: project.id, contentMarkdown: 'CURATED_CONTEXT', createdBy: 'LEON' })
      createRuleVersion(db, { projectId: project.id, contentMarkdown: 'OLD_RULES', createdBy: 'LEON' })
      const rules = '  # Security\r\nKeep {{projectName}} and $& literal.\n\n'
      createRuleVersion(db, { projectId: project.id, contentMarkdown: rules, createdBy: 'LEON' })
      addChatMessage(db, { projectId: project.id, author: 'LEON', content: 'PRIVATE_CHAT_MARKER' })
      updateSettings(db, { chatgptGlobalTemplate: 'GLOBAL {{projectName}} {{contextVersion}} {{contextMarkdown}} {{concreteTask}} {{unknown}}',
        claudeGlobalTemplate: 'GLOBAL {{projectName}} {{contextVersion}} {{contextMarkdown}} {{concreteTask}} {{unknown}}' })
      for (const override of [null, 'PROJECT {{projectName}} {{contextVersion}} {{contextMarkdown}} {{concreteTask}} {{unknown}}', 'No placeholders']) {
        setRoleTemplateOverride(db, project.id, role, override)
        const result = generatePrompt(db, project.id, role, 'TASK')
        expect(result.promptText).toContain(`\n\n${rules}\n\n---\n\n`)
        expect(result.promptText).toMatch(/^PROJECT RULES\n/)
        expect(result.promptText).not.toContain('OLD_RULES')
        expect(result.promptText).not.toContain('PRIVATE_CHAT_MARKER')
        if (override !== 'No placeholders') {
          expect(result.promptText).toContain(`${override ? 'PROJECT' : 'GLOBAL'} Example 1 CURATED_CONTEXT TASK {{unknown}}`)
        } else expect(result.promptText).toMatch(/No placeholders$/)
      }
    } finally { db.close() }
  })

  it('keeps no-Rules output exactly backward compatible and never fabricates the starter template', () => {
    const db = createTestDb()
    try {
      const p = createProject(db, { name: 'Legacy', projectType: 'App', description: '' })
      updateSettings(db, { chatgptGlobalTemplate: '{{projectName}} {{concreteTask}}' })
      expect(generatePrompt(db, p.id, 'CHATGPT', 'Task').promptText).toBe('Legacy Task')
    } finally { db.close() }
  })

  it('isolates Rules by project and includes an explicitly saved empty version', () => {
    const db = createTestDb()
    try {
      const p = createProject(db, { name: 'A', projectType: 'App', description: '' })
      const other = createProject(db, { name: 'B', projectType: 'App', description: '' })
      createRuleVersion(db, { projectId: other.id, contentMarkdown: 'OTHER_PROJECT_RULES', createdBy: 'LEON' })
      expect(generatePrompt(db, p.id, 'CLAUDE', 'Task').promptText).not.toContain('OTHER_PROJECT_RULES')
      createRuleVersion(db, { projectId: p.id, contentMarkdown: '', createdBy: 'LEON' })
      expect(generatePrompt(db, p.id, 'CLAUDE', 'Task').promptText).toMatch(/^PROJECT RULES\n/)
    } finally { db.close() }
  })

  it('uses one real SQLite snapshot when another connection commits Context and Rules between reads', () => {
    const tempRoot = resolve('temp')
    mkdirSync(tempRoot, { recursive: true })
    const directory = mkdtempSync(join(tempRoot, 'rules-snapshot-test-'))
    const reader = openDatabase(join(directory, 'snapshot.sqlite3'))
    runMigrations(reader)
    const writer = openDatabase(join(directory, 'snapshot.sqlite3'))
    try {
      const p = createProject(reader, { name: 'Pair', projectType: 'App', description: '' })
      context.createContextVersion(reader, { projectId: p.id, contentMarkdown: 'CONTEXT_BEFORE', createdBy: 'LEON' })
      createRuleVersion(reader, { projectId: p.id, contentMarkdown: 'RULES_BEFORE', createdBy: 'LEON' })
      const original = context.getCurrentContextVersion
      vi.spyOn(context, 'getCurrentContextVersion').mockImplementationOnce((db, id) => {
        const selected = original(db, id)
        expect(db.inTransaction).toBe(true)
        writer.transaction(() => {
          context.createContextVersion(writer, { projectId: p.id, contentMarkdown: 'CONTEXT_AFTER', createdBy: 'LEON' })
          createRuleVersion(writer, { projectId: p.id, contentMarkdown: 'RULES_AFTER', createdBy: 'LEON' })
        })()
        return selected
      })
      const first = generatePrompt(reader, p.id, 'CHATGPT', 'Task').promptText
      expect(first).toContain('CONTEXT_BEFORE')
      expect(first).toContain('RULES_BEFORE')
      expect(first).not.toContain('CONTEXT_AFTER')
      expect(first).not.toContain('RULES_AFTER')
      const next = generatePrompt(reader, p.id, 'CHATGPT', 'Task').promptText
      expect(next).toContain('CONTEXT_AFTER')
      expect(next).toContain('RULES_AFTER')
      expect(reader.inTransaction).toBe(false)
    } finally {
      writer.close()
      reader.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
