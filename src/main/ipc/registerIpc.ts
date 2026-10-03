import { clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type Database from 'better-sqlite3'
import { IpcChannels } from '@shared/ipcChannels'
import type { AppInfo, IpcResult } from '@shared/types'
import type { FileLogger } from '../logger'
import * as projectsService from '../services/projectsService'
import * as gitService from '../services/gitService'
import * as contextService from '../services/contextService'
import * as rulesService from '../services/rulesService'
import * as chatService from '../services/chatService'
import * as promptService from '../services/promptService'
import * as settingsService from '../services/settingsService'
import * as sessionService from '../services/sessionService'
import * as continuationSnapshotService from '../services/continuationSnapshotService'
import * as taskService from '../services/taskService'
import * as workRequestService from '../services/workRequestService'
import { generateContinuationPrompt } from '../services/continuationPromptService'
import { analyzeResponseImport, applyResponseImport } from '../services/responseImportService'
import type { CodeChangeReviewRegistry } from '../services/codeChangeReviewService'
import { isTrustedTopLevelSender } from './senderValidation'
import { toIpcError } from './ipcError'
import {
  validateAddChatMessageInput,
  validateAssignChatMessageToSessionInput,
  validateConfirmSnapshotInput,
  validateCopyToClipboardInput,
  validateCreateContextVersionInput,
  validateCreateRuleVersionInput,
  validateCreateContinuationSessionInput,
  validateCreateDraftSnapshotInput,
  validateCreateProjectInput,
  validateCreateSessionInput,
  validateDiffInput,
  validateGenerateContinuationPromptInput,
  validateGeneratePromptInput,
  validateGetContextVersionInput,
  validateGetRuleVersionInput,
  validateRulesDiffInput,
  validateGetSnapshotInput,
  validateIdInput,
  validateRepositoryInput,
  validateListSnapshotsInput,
  validateOpenExternalInput,
  validateResponseImportAnalyzeInput,
  validateResponseImportApplyInput,
  validateRoleInput,
  validateSessionIdInput,
  validateSessionProjectInput,
  validateSetRoleTemplateOverrideInput,
  validateUpdateProjectInput,
  validateUpdateSessionInput,
  validateUpdateSettingsInput,
  validateCreateTaskInput,
  validateGetTaskInput,
  validateListTasksInput,
  validateUpdateTaskDependenciesInput,
  validateUpdateTaskInput,
  validateUpdateTaskStatusInput,
  validateCreateWorkRequestInput,
  validateGetWorkRequestInput,
  validateListWorkRequestsInput,
  validateResolveDecisionInput,
  validateUpdateWorkRequestIntentInput,
  validateCodeChangeReviewApproveInput,
  validateCodeChangeReviewGetInput,
  validateCodeChangeReviewListInput,
  validateCodeChangeReviewRequestChangesInput,
  ValidationError
} from './validation'

interface RegisterIpcOptions {
  db: Database.Database
  logger: FileLogger
  appInfo: AppInfo
  // Meilenstein 4.8A - lazy statt einer direkten BrowserWindow-Referenz: wird
  // bei JEDEM sensiblen Aufruf frisch ausgewertet, damit die Reihenfolge
  // "registerIpc() vor createMainWindow()" (siehe main/index.ts) keine Rolle
  // spielt und ein spaeter ersetztes/neu erstelltes Fenster automatisch
  // erkannt wird - niemals ein einmalig eingefrorener Wert.
  getMainWebContentsId: () => number | null
  codeChangeReviews: CodeChangeReviewRegistry
}

/**
 * Registriert alle IPC-Handler. Jeder Handler folgt demselben Muster:
 * Eingabe validieren -> Service-Funktion aufrufen -> Ergebnis oder
 * strukturierten Fehler zurueckgeben. Es wird nie eine rohe Exception
 * ueber ipcMain.handle zurueckgegeben (siehe IpcResult in shared/types.ts).
 */
export function registerIpc({ db, logger, appInfo, getMainWebContentsId, codeChangeReviews }: RegisterIpcOptions): void {
  // fn darf synchron ODER asynchron sein (z. B. system:openExternal,
  // projects:selectFolder). Der Handler wartet in beiden Faellen korrekt
  // auf das Ergebnis, bevor er antwortet - ein haeufiger Fehler waere hier,
  // ein von fn() zurueckgegebenes Promise ungeprueft als `data` zu
  // verpacken, statt es aufzuloesen (das wuerde beim Structured-Clone ueber
  // die IPC-Grenze fehlschlagen bzw. eine leere Antwort erzeugen).
  function handle<T>(channel: string, fn: (raw: unknown) => T | Promise<T>): void {
    ipcMain.handle(channel, async (_event, raw: unknown): Promise<IpcResult<T>> => {
      try {
        const data = await fn(raw)
        return { ok: true, data }
      } catch (error) {
        return toIpcError(channel, error, logger)
      }
    })
  }

  // Meilenstein 4.8A Teil P - dedizierte Sender-Identitaets-Pruefung NUR fuer
  // die Review-Kanaele (Entscheidungen UND Lesen, da Quelltext sensibel ist -
  // siehe Vorgabe). Reine Erweiterung von handle() oben, kein Ersatz fuer
  // jeden bestehenden Kanal. Ein nicht-vertrauenswuerdiger Sender (fremdes
  // Fenster, zerstoerter WebContents, Subframe/Iframe) erhaelt denselben
  // generischen VALIDATION_ERROR wie jede andere ungueltige Eingabe - niemals
  // eine Unterscheidung, die einem Angreifer verraten wuerde, WARUM genau
  // abgelehnt wurde.
  function handleSensitive<T>(channel: string, fn: (raw: unknown) => T | Promise<T>): void {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown): Promise<IpcResult<T>> => {
      try {
        const trusted = isTrustedTopLevelSender({
          senderId: event.sender.id,
          senderFrameIsMainFrame: event.senderFrame === event.sender.mainFrame,
          senderIsDestroyed: event.sender.isDestroyed(),
          expectedWebContentsId: getMainWebContentsId()
        })
        if (!trusted) throw new ValidationError('Nicht autorisierter Aufrufer.')
        const data = await fn(raw)
        return { ok: true, data }
      } catch (error) {
        return toIpcError(channel, error, logger)
      }
    })
  }

  handle(IpcChannels.repositoryDiagnostics, (raw) =>
    gitService.getDiagnostics(projectsService.getProjectById(db, validateRepositoryInput(raw)).folderPath)
  )
  handle(IpcChannels.repositoryDiff, (raw) =>
    gitService.getDiff(projectsService.getProjectById(db, validateRepositoryInput(raw)).folderPath)
  )

  handle(IpcChannels.projectsList, (raw) => {
    const includeArchived = isPlainObject(raw) && raw.includeArchived === true
    return projectsService.listProjects(db, includeArchived)
  })

  handle(IpcChannels.projectsGet, (raw) => projectsService.getProjectById(db, validateIdInput(raw)))

  handle(IpcChannels.projectsCreate, (raw) =>
    projectsService.createProject(db, validateCreateProjectInput(raw))
  )

  handle(IpcChannels.projectsUpdate, (raw) =>
    projectsService.updateProject(db, validateUpdateProjectInput(raw))
  )

  handle(IpcChannels.projectsArchive, (raw) => projectsService.archiveProject(db, validateIdInput(raw)))

  handle(IpcChannels.projectsRestore, (raw) => projectsService.restoreProject(db, validateIdInput(raw)))

  handle(IpcChannels.projectsGetFolderStatus, (raw) =>
    projectsService.getProjectFolderStatus(db, validateIdInput(raw))
  )

  // Oeffnet den nativen Betriebssystem-Ordnerdialog (nur Verzeichnisse,
  // keine Dateiauswahl). Legt nichts an, erstellt keine Ordner - liefert
  // entweder einen ausgewaehlten, existierenden Pfad oder null bei Abbruch.
  // Die eigentliche Existenz-/Duplikat-Pruefung passiert serverseitig noch
  // einmal beim tatsaechlichen Anlegen/Speichern (siehe validateFolderForProject).
  handle(IpcChannels.projectsSelectFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Projektordner auswaehlen',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { folderPath: null }
    return { folderPath: result.filePaths[0] }
  })

  handle(IpcChannels.contextListVersions, (raw) =>
    contextService.listContextVersions(db, validateIdInput(raw))
  )

  handle(IpcChannels.contextGetVersion, (raw) => {
    const { projectId, versionId } = validateGetContextVersionInput(raw)
    return contextService.getContextVersionForProject(db, projectId, versionId)
  })

  handle(IpcChannels.contextCreateVersion, (raw) =>
    contextService.createContextVersion(db, validateCreateContextVersionInput(raw))
  )

  handle(IpcChannels.contextDiff, (raw) => {
    const { projectId, fromVersionId, toVersionId } = validateDiffInput(raw)
    return contextService.getContextDiffForProject(db, projectId, fromVersionId, toVersionId)
  })

  handle(IpcChannels.rulesListVersions, (raw) => rulesService.listRuleVersions(db, validateIdInput(raw)))

  handle(IpcChannels.rulesGetVersion, (raw) => {
    const { projectId, versionId } = validateGetRuleVersionInput(raw)
    return rulesService.getRuleVersionForProject(db, projectId, versionId)
  })

  handle(IpcChannels.rulesCreateVersion, (raw) =>
    rulesService.createRuleVersion(db, validateCreateRuleVersionInput(raw))
  )

  handle(IpcChannels.rulesDiff, (raw) => {
    const { projectId, fromVersionId, toVersionId } = validateRulesDiffInput(raw)
    return rulesService.getRulesDiffForProject(db, projectId, fromVersionId, toVersionId)
  })

  handle(IpcChannels.chatList, (raw) => chatService.listChatMessages(db, validateIdInput(raw)))

  handle(IpcChannels.chatAddMessage, (raw) =>
    chatService.addChatMessage(db, validateAddChatMessageInput(raw))
  )

  handle(IpcChannels.promptsGetRoleInfo, (raw) => {
    const { projectId, role } = validateRoleInput(raw)
    return promptService.getRoleTemplateInfo(db, projectId, role)
  })

  handle(IpcChannels.promptsGenerate, (raw) => {
    const { projectId, role, concreteTask } = validateGeneratePromptInput(raw)
    return promptService.generatePrompt(db, projectId, role, concreteTask)
  })

  handle(IpcChannels.promptsSetOverride, (raw) => {
    const input = validateSetRoleTemplateOverrideInput(raw)
    settingsService.setRoleTemplateOverride(db, input.projectId, input.role, input.template)
    return promptService.getRoleTemplateInfo(db, input.projectId, input.role)
  })

  handle(IpcChannels.promptsGenerateContinuation, (raw) =>
    generateContinuationPrompt(db, validateGenerateContinuationPromptInput(raw))
  )

  // Kopiert exakt den uebergebenen Text - keine erneute Generierung. Wird
  // sowohl von der Prompt-Vorschau als auch vom Kopieren-Button einzelner
  // Chat-Nachrichten verwendet.
  handle(IpcChannels.systemCopyToClipboard, (raw) => {
    const text = validateCopyToClipboardInput(raw)
    clipboard.writeText(text)
    return { copied: true as const }
  })

  handle(IpcChannels.settingsGet, () => settingsService.getSettings(db))

  handle(IpcChannels.settingsUpdate, (raw) =>
    settingsService.updateSettings(db, validateUpdateSettingsInput(raw))
  )

  handle(IpcChannels.systemOpenExternal, async (raw) => {
    const url = validateOpenExternalInput(raw)
    await shell.openExternal(url)
    return { opened: true as const }
  })

  handle(IpcChannels.systemGetAppInfo, () => appInfo)

  // Meilenstein 2 - Strukturierter Antwort-Import. Beide Funktionen liegen
  // vollstaendig in responseImportService.ts (Main-Prozess als
  // Vertrauensgrenze, Abschnitt 11 der Vorgabe) - hier wird nur validiert
  // und weitergereicht, exakt wie bei allen anderen Kanaelen.
  handle(IpcChannels.responseImportAnalyze, (raw) =>
    analyzeResponseImport(db, validateResponseImportAnalyzeInput(raw))
  )

  handle(IpcChannels.responseImportApply, (raw) =>
    applyResponseImport(db, validateResponseImportApplyInput(raw))
  )

  handle(IpcChannels.sessionsList, (raw) => {
    const { projectId } = validateSessionProjectInput(raw)
    return sessionService.listSessions(db, projectId)
  })

  handle(IpcChannels.sessionsGet, (raw) => sessionService.getSessionById(db, validateIdInput(raw)))

  handle(IpcChannels.sessionsGetSuccessor, (raw) => {
    const { sessionId } = validateSessionIdInput(raw)
    return sessionService.getSuccessorSession(db, sessionId)
  })

  handle(IpcChannels.sessionsListChain, (raw) => {
    const { sessionId } = validateSessionIdInput(raw)
    return sessionService.listSessionChain(db, sessionId)
  })

  handle(IpcChannels.sessionsCreate, (raw) =>
    sessionService.createSession(db, validateCreateSessionInput(raw))
  )

  handle(IpcChannels.sessionsUpdate, (raw) =>
    sessionService.updateSession(db, validateUpdateSessionInput(raw))
  )

  handle(IpcChannels.sessionsCreateContinuation, (raw) =>
    sessionService.createContinuationSession(db, validateCreateContinuationSessionInput(raw))
  )

  handle(IpcChannels.sessionsAssignChatMessage, (raw) =>
    sessionService.assignChatMessageToSession(db, validateAssignChatMessageToSessionInput(raw))
  )

  handle(IpcChannels.snapshotsList, (raw) => {
    const { projectId, sessionId } = validateListSnapshotsInput(raw)
    return continuationSnapshotService.listSnapshots(db, projectId, sessionId)
  })

  handle(IpcChannels.snapshotsGet, (raw) => {
    const { projectId, sessionId, snapshotId } = validateGetSnapshotInput(raw)
    return continuationSnapshotService.getSnapshot(db, projectId, sessionId, snapshotId)
  })

  handle(IpcChannels.snapshotsCreateDraft, (raw) =>
    continuationSnapshotService.createDraftSnapshot(db, validateCreateDraftSnapshotInput(raw))
  )

  handle(IpcChannels.snapshotsConfirm, (raw) =>
    continuationSnapshotService.confirmSnapshot(db, validateConfirmSnapshotInput(raw))
  )

  handle(IpcChannels.tasksList, (raw) => {
    const { projectId } = validateListTasksInput(raw)
    return taskService.listTasksForProject(db, projectId)
  })

  handle(IpcChannels.tasksGet, (raw) => {
    const { projectId, taskId } = validateGetTaskInput(raw)
    return taskService.getTaskForProject(db, projectId, taskId)
  })

  handle(IpcChannels.tasksCreate, (raw) => taskService.createTask(db, validateCreateTaskInput(raw)))

  handle(IpcChannels.tasksUpdate, (raw) => taskService.updateTaskDetails(db, validateUpdateTaskInput(raw)))

  handle(IpcChannels.tasksUpdateStatus, (raw) =>
    taskService.updateTaskStatus(db, validateUpdateTaskStatusInput(raw))
  )

  handle(IpcChannels.tasksUpdateDependencies, (raw) =>
    taskService.updateTaskDependencies(db, validateUpdateTaskDependenciesInput(raw))
  )

  // Meilenstein 4.3 - Work Request + Automation-UX-Grundlage. Nur die
  // renderer-erlaubten Operationen bekommen einen Kanal (siehe
  // shared/ipcChannels.ts) - applyPlanningResult/replaceTaskLinks/
  // setWorkRequestStatus bleiben Main/intern only und werden hier bewusst
  // NICHT registriert. `createdBy` wird beim Erstellen NIE aus der
  // Renderer-Eingabe uebernommen, sondern serverseitig fest auf 'LEON'
  // gesetzt (siehe M4.3-Vorgabe "Do NOT expose a createdBy selector").
  handle(IpcChannels.workRequestsList, (raw) => {
    const { projectId } = validateListWorkRequestsInput(raw)
    return workRequestService.listWorkRequestsForProject(db, projectId)
  })

  handle(IpcChannels.workRequestsGet, (raw) => {
    const { projectId, id } = validateGetWorkRequestInput(raw)
    return workRequestService.getWorkRequestForProject(db, projectId, id)
  })

  handle(IpcChannels.workRequestsCreate, (raw) => {
    const { projectId, intentMarkdown } = validateCreateWorkRequestInput(raw)
    return workRequestService.createWorkRequest(db, { projectId, intentMarkdown, createdBy: 'LEON' })
  })

  handle(IpcChannels.workRequestsUpdateIntent, (raw) =>
    workRequestService.updateWorkRequestIntent(db, validateUpdateWorkRequestIntentInput(raw))
  )

  handle(IpcChannels.workRequestsResolveDecision, (raw) =>
    workRequestService.resolveDecision(db, validateResolveDecisionInput(raw))
  )

  // Meilenstein 4.8A - Code Change Review + Exact Approval Binding. NUR
  // Entscheidungs-/Lese-Kanaele - KEIN Erstellungs-Kanal (Review-Erstellung
  // ist Main-internal only, siehe claudeCodeChangeService.ts/
  // codeChangeReviewService.ts) und KEIN Apply-Kanal existiert in diesem
  // Meilenstein. Alle vier Kanaele laufen ueber handleSensitive() (Teil P).
  handleSensitive(IpcChannels.codeChangeReviewsList, (raw) => {
    const { projectId } = validateCodeChangeReviewListInput(raw)
    return codeChangeReviews.listReviewsForProject(projectId)
  })

  handleSensitive(IpcChannels.codeChangeReviewsGet, (raw) => {
    const { projectId, reviewId } = validateCodeChangeReviewGetInput(raw)
    return codeChangeReviews.getReview(projectId, reviewId)
  })

  handleSensitive(IpcChannels.codeChangeReviewsApprove, (raw) => {
    const { projectId, reviewId } = validateCodeChangeReviewApproveInput(raw)
    return codeChangeReviews.approveReview(projectId, reviewId)
  })

  handleSensitive(IpcChannels.codeChangeReviewsRequestChanges, (raw) => {
    const { projectId, reviewId, feedback } = validateCodeChangeReviewRequestChangesInput(raw)
    return codeChangeReviews.requestChanges(projectId, reviewId, feedback)
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
