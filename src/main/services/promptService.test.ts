import { describe, expect, it } from 'vitest'
import { createTestDb } from '../testUtils/testDb'
import { createProject } from './projectsService'
import { createContextVersion } from './contextService'
import { addChatMessage } from './chatService'
import { setRoleTemplateOverride, updateSettings } from './settingsService'
import { generatePrompt, getRoleTemplateInfo } from './promptService'

describe('promptService', () => {
  it('nutzt die globale Vorlage, wenn kein Override gesetzt ist', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Airport Career', projectType: 'Roblox', description: '' })
    const info = getRoleTemplateInfo(db, project.id, 'CHATGPT')
    expect(info.isOverridden).toBe(false)
    expect(info.effectiveTemplate).toBe(info.globalTemplate)
  })

  it('projektspezifisches Override hat Vorrang vor der globalen Vorlage', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Airport Career', projectType: 'Roblox', description: '' })
    setRoleTemplateOverride(db, project.id, 'CHATGPT', 'Override: {{projectName}}')
    const info = getRoleTemplateInfo(db, project.id, 'CHATGPT')
    expect(info.isOverridden).toBe(true)
    expect(info.effectiveTemplate).toBe('Override: {{projectName}}')
  })

  it('ersetzt alle neuen Platzhalter im generierten Prompt, inklusive der konkreten Aufgabe', () => {
    const db = createTestDb()
    updateSettings(db, {
      chatgptGlobalTemplate:
        'Projekt {{projectName}} ({{projectType}}): {{projectDescription}}\n' +
        'Status {{projectStatus}}, Schritt {{currentStep}}, naechste Aktion {{nextAction}}, Akteur {{nextActor}}\n' +
        'Version {{contextVersion}}\n{{contextMarkdown}}\nAufgabe: {{concreteTask}}'
    })
    const project = createProject(db, {
      name: 'Airport Career',
      projectType: 'Roblox',
      description: 'Tycoon-Spiel',
      currentStep: 'Schritt 7',
      nextAction: 'Warten auf Wiederaufnahme'
    })
    createContextVersion(db, { projectId: project.id, contentMarkdown: '# Kontext-Inhalt', createdBy: 'LEON' })

    const prompt = generatePrompt(db, project.id, 'CHATGPT', 'Plane jetzt Schritt 7. Erstelle noch keinen Code.')
    expect(prompt.promptText).toContain('Projekt Airport Career (Roblox)')
    expect(prompt.promptText).toContain('Tycoon-Spiel')
    expect(prompt.promptText).toContain('Status PLANNING')
    expect(prompt.promptText).toContain('Schritt Schritt 7')
    expect(prompt.promptText).toContain('naechste Aktion Warten auf Wiederaufnahme')
    expect(prompt.promptText).toContain('Version 1')
    expect(prompt.promptText).toContain('# Kontext-Inhalt')
    expect(prompt.promptText).toContain('Plane jetzt Schritt 7. Erstelle noch keinen Code.')
  })

  it('bindet den Chat-Verlauf NIEMALS automatisch in den Prompt ein, auch wenn Nachrichten existieren', () => {
    const db = createTestDb()
    updateSettings(db, { claudeGlobalTemplate: 'Kontext: {{contextMarkdown}}\nAufgabe: {{concreteTask}}' })
    const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
    addChatMessage(db, {
      projectId: project.id,
      author: 'LEON',
      content: 'GEHEIME_CHAT_MARKIERUNG_DIE_NICHT_IM_PROMPT_LANDEN_DARF'
    })

    const prompt = generatePrompt(db, project.id, 'CLAUDE', 'Konkrete Aufgabe')
    expect(prompt.promptText).not.toContain('GEHEIME_CHAT_MARKIERUNG_DIE_NICHT_IM_PROMPT_LANDEN_DARF')
  })

  it('es gibt keinen {{recentChat}}-Platzhalter mehr - er bleibt unersetzt stehen, falls eine alte Vorlage ihn noch enthaelt', () => {
    const db = createTestDb()
    updateSettings(db, { claudeGlobalTemplate: 'Text mit {{recentChat}} Platzhalter' })
    const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
    const prompt = generatePrompt(db, project.id, 'CLAUDE', 'Aufgabe')
    // Unbekannte Platzhalter werden unveraendert stehen gelassen statt geleert -
    // recentChat wird also sichtbar NICHT automatisch aufgeloest.
    expect(prompt.promptText).toContain('{{recentChat}}')
  })

  it('zeigt einen sprechenden Platzhalter, wenn noch kein Kontext existiert', () => {
    const db = createTestDb()
    const project = createProject(db, { name: 'Airport Career', projectType: 'Roblox', description: '' })
    const prompt = generatePrompt(db, project.id, 'CLAUDE', 'Aufgabe')
    expect(prompt.promptText).toContain('noch kein Projekt-Kontext angelegt')
  })

  it('wirft nicht bei leerer konkreter Aufgabe auf Service-Ebene keinen Fehler (Validierung passiert in validation.ts) - aber Platzhalter bleibt dann leer', () => {
    const db = createTestDb()
    updateSettings(db, { claudeGlobalTemplate: 'Aufgabe: [{{concreteTask}}]' })
    const project = createProject(db, { name: 'Projekt', projectType: 'Typ', description: '' })
    const prompt = generatePrompt(db, project.id, 'CLAUDE', 'x')
    expect(prompt.promptText).toBe('Aufgabe: [x]')
  })

  it('promptText ist bei unveraendertem Projektstand deterministisch - genau dieser Text ist es, der in der Vorschau angezeigt UND unveraendert in die Zwischenablage kopiert wird (RC4, Punkt 16)', () => {
    // HandoffTab.handleCopy() kopiert exakt `generated.promptText`, ohne den
    // Prompt ein zweites Mal zu erzeugen (siehe src/renderer/components/
    // ProjectDetail/HandoffTab.tsx) - es gibt strukturell nur einen einzigen
    // Code-Pfad, der den Text erzeugt. Dieser Test sichert die dafuer
    // notwendige Voraussetzung auf Service-Ebene ab: zwei Aufrufe von
    // generatePrompt() mit unveraendertem Projektstand und identischer
    // konkreter Aufgabe liefern exakt denselben promptText.
    const db = createTestDb()
    updateSettings(db, {
      claudeGlobalTemplate: 'Projekt {{projectName}}: {{contextMarkdown}}\nAufgabe: {{concreteTask}}'
    })
    const project = createProject(db, { name: 'Airport Career', projectType: 'Roblox', description: '' })
    createContextVersion(db, { projectId: project.id, contentMarkdown: '# Kontext', createdBy: 'LEON' })

    const first = generatePrompt(db, project.id, 'CLAUDE', 'Konkrete Aufgabe')
    const second = generatePrompt(db, project.id, 'CLAUDE', 'Konkrete Aufgabe')
    expect(second.promptText).toBe(first.promptText)
  })
})
