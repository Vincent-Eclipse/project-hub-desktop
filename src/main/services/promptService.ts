import type Database from 'better-sqlite3'
import type { AiRole, GeneratedPrompt, RoleTemplateInfo } from '@shared/types'
import { getProjectById } from './projectsService'
import { getCurrentContextVersion } from './contextService'
import { getCurrentProjectRules } from './rulesService'
import { getRoleTemplateOverride, getSettings } from './settingsService'

function globalTemplateFor(role: AiRole, settings: { chatgptGlobalTemplate: string; claudeGlobalTemplate: string }): string {
  return role === 'CHATGPT' ? settings.chatgptGlobalTemplate : settings.claudeGlobalTemplate
}

/**
 * Ermittelt die fuer eine Rolle tatsaechlich wirksame Vorlage.
 * Aufloesung (Memo Punkt 12.9): projektspezifisches Override, falls
 * vorhanden, sonst die globale Vorlage aus den Einstellungen. Diese
 * Aufloesung passiert ausschliesslich hier im Main-Prozess - der
 * Renderer bekommt immer nur das fertige Ergebnis, nie eigene Logik
 * zur Vorlagen-Aufloesung.
 */
export function getRoleTemplateInfo(
  db: Database.Database,
  projectId: number,
  role: AiRole
): RoleTemplateInfo {
  getProjectById(db, projectId)
  const settings = getSettings(db)
  const globalTemplate = globalTemplateFor(role, settings)
  const overrideTemplate = getRoleTemplateOverride(db, projectId, role)

  return {
    role,
    effectiveTemplate: overrideTemplate ?? globalTemplate,
    isOverridden: overrideTemplate !== null,
    globalTemplate,
    overrideTemplate
  }
}

function applyPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  })
}

/**
 * Erzeugt den Prompt-Text fuer eine Rolle. Der zurueckgegebene String ist
 * exakt der Text, der in der Vorschau angezeigt und - unveraendert - in
 * die Zwischenablage kopiert wird (siehe system:copyToClipboard-Handler).
 * Es gibt keinen zweiten Code-Pfad, der den Prompt erneut generiert.
 *
 * WICHTIG: Es fliesst absichtlich KEIN Chat-Verlauf automatisch ein. Der
 * Chat ist reine Chronik, massgeblich fuer den Prompt ist ausschliesslich
 * die aktuelle Kontext-Version plus die von Leon explizit uebergebene
 * konkrete Aufgabe (`concreteTask`). Wer Chat-Inhalte in eine Uebergabe
 * bringen will, muss sie bewusst in die konkrete Aufgabe oder den
 * Projekt-Kontext uebernehmen.
 */
export function generatePrompt(
  db: Database.Database,
  projectId: number,
  role: AiRole,
  concreteTask: string
): GeneratedPrompt {
  // One SQLite read snapshot resolves the complete generation state, even
  // if another connection commits a new version between these reads.
  const { project, templateInfo, currentContext, currentRules } = db.transaction(() => ({
    project: getProjectById(db, projectId),
    templateInfo: getRoleTemplateInfo(db, projectId, role),
    currentContext: getCurrentContextVersion(db, projectId),
    currentRules: getCurrentProjectRules(db, projectId)
  }))()

  const promptText = applyPlaceholders(templateInfo.effectiveTemplate, {
    projectName: project.name,
    projectType: project.projectType,
    projectDescription: project.description,
    projectStatus: project.status,
    currentStep: project.currentStep,
    nextAction: project.nextAction,
    nextActor: project.nextActor,
    contextVersion: currentContext ? String(currentContext.versionNumber) : '(noch keine Version)',
    contextMarkdown: currentContext ? currentContext.contentMarkdown : '(noch kein Projekt-Kontext angelegt)',
    concreteTask
  })

  return {
    role,
    promptText: currentRules
      ? `PROJECT RULES\nRegeln bestimmen das erwartete Verhalten und haben bei Widerspruechen Vorrang vor Aufgaben und Projekt-Kontext. Sie erteilen keine Datei-, Befehls-, Git- oder Netzwerkberechtigungen und erweitern keine technischen Faehigkeiten.\n\n${currentRules.contentMarkdown}\n\n---\n\n${promptText}`
      : promptText,
    generatedAt: new Date().toISOString()
  }
}
