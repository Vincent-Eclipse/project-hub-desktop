import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '@shared/ipcChannels'
import type { CodeChangeReviewProjection, CodeChangeReviewSummary } from '@shared/codeChangeReviewTypes'
import type {
  AddChatMessageInput,
  AiRole,
  AppInfo,
  AppSettings,
  AssignChatMessageToSessionInput,
  ChatMessage,
  ConfirmSnapshotInput,
  ContinuationSnapshot,
  CreateContextVersionInput,
  CreateRuleVersionInput,
  ProjectRuleVersion,
  CreateContinuationSessionInput,
  CreateDraftSnapshotInput,
  CreateProjectInput,
  CreateSessionInput,
  DiffLine,
  FolderStatus,
  GenerateContinuationPromptInput,
  GenerateContinuationPromptResult,
  GeneratedPrompt,
  IpcResult,
  Project,
  RepositoryDiagnostics,
  RepositoryDiff,
  ProjectContextVersion,
  ResponseImportAnalyzeInput,
  ResponseImportAnalyzeResult,
  ResponseImportApplyInput,
  ResponseImportApplyResult,
  RoleTemplateInfo,
  SelectedFolder,
  Session,
  SessionChatMessageAssignment,
  SetRoleTemplateOverrideInput,
  CreateTaskInput,
  Task,
  UpdateProjectInput,
  UpdateSessionInput,
  UpdateSettingsInput,
  UpdateTaskDependenciesInput,
  UpdateTaskInput,
  UpdateTaskStatusInput,
  ResolveDecisionInput,
  UpdateWorkRequestIntentInput,
  WorkRequestDetail,
  WorkRequestSummary
} from '@shared/types'

// Die Preload-Bruecke ist die einzige Verbindung zwischen dem
// abgeschotteten Renderer (contextIsolation, kein nodeIntegration, sandbox)
// und dem Main-Prozess. Sie exponiert ausschliesslich diese fest
// typisierten Funktionen - kein roher ipcRenderer-Zugriff, kein
// Dateisystem- oder Node-API-Zugriff aus dem Renderer heraus.
function invoke<T>(channel: string, payload?: unknown): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, payload)
}

const api = {
  repository: {
    diagnostics: (id: number) => invoke<RepositoryDiagnostics>(IpcChannels.repositoryDiagnostics, { id }),
    diff: (id: number) => invoke<RepositoryDiff>(IpcChannels.repositoryDiff, { id })
  },
  projects: {
    list: (includeArchived: boolean) =>
      invoke<Project[]>(IpcChannels.projectsList, { includeArchived }),
    get: (id: number) => invoke<Project>(IpcChannels.projectsGet, { id }),
    create: (input: CreateProjectInput) => invoke<Project>(IpcChannels.projectsCreate, input),
    update: (input: UpdateProjectInput) => invoke<Project>(IpcChannels.projectsUpdate, input),
    archive: (id: number) => invoke<Project>(IpcChannels.projectsArchive, { id }),
    restore: (id: number) => invoke<Project>(IpcChannels.projectsRestore, { id }),
    // Oeffnet den nativen Ordnerdialog. Liefert { folderPath: null } bei Abbruch.
    selectFolder: () => invoke<SelectedFolder>(IpcChannels.projectsSelectFolder),
    // Reine, live ermittelte Statusabfrage des gespeicherten Projektordners
    // (existiert er noch, ist es noch ein Verzeichnis, zugreifbar) -
    // veraendert nichts, kein automatisches Anlegen/Loeschen.
    getFolderStatus: (id: number) => invoke<FolderStatus>(IpcChannels.projectsGetFolderStatus, { id })
  },
  context: {
    listVersions: (projectId: number) =>
      invoke<ProjectContextVersion[]>(IpcChannels.contextListVersions, { id: projectId }),
    // projectId ist zwingend erforderlich - der Main-Prozess prueft, dass
    // versionId tatsaechlich zu diesem Projekt gehoert, statt einer
    // beliebigen Versions-ID blind zu vertrauen.
    getVersion: (projectId: number, versionId: number) =>
      invoke<ProjectContextVersion>(IpcChannels.contextGetVersion, { projectId, versionId }),
    createVersion: (input: CreateContextVersionInput) =>
      invoke<ProjectContextVersion>(IpcChannels.contextCreateVersion, input),
    diff: (projectId: number, fromVersionId: number, toVersionId: number) =>
      invoke<DiffLine[]>(IpcChannels.contextDiff, { projectId, fromVersionId, toVersionId })
  },
  rules: {
    listVersions: (projectId: number) =>
      invoke<ProjectRuleVersion[]>(IpcChannels.rulesListVersions, { id: projectId }),
    getVersion: (projectId: number, versionId: number) =>
      invoke<ProjectRuleVersion>(IpcChannels.rulesGetVersion, { projectId, versionId }),
    createVersion: (input: CreateRuleVersionInput) =>
      invoke<ProjectRuleVersion>(IpcChannels.rulesCreateVersion, input),
    diff: (projectId: number, fromVersionId: number, toVersionId: number) =>
      invoke<DiffLine[]>(IpcChannels.rulesDiff, { projectId, fromVersionId, toVersionId })
  },
  chat: {
    list: (projectId: number) => invoke<ChatMessage[]>(IpcChannels.chatList, { id: projectId }),
    addMessage: (input: AddChatMessageInput) => invoke<ChatMessage>(IpcChannels.chatAddMessage, input)
  },
  prompts: {
    getRoleInfo: (projectId: number, role: AiRole) =>
      invoke<RoleTemplateInfo>(IpcChannels.promptsGetRoleInfo, { projectId, role }),
    generate: (projectId: number, role: AiRole, concreteTask: string) =>
      invoke<GeneratedPrompt>(IpcChannels.promptsGenerate, { projectId, role, concreteTask }),
    setOverride: (input: SetRoleTemplateOverrideInput) =>
      invoke<RoleTemplateInfo>(IpcChannels.promptsSetOverride, input),
    generateContinuation: (input: GenerateContinuationPromptInput) =>
      invoke<GenerateContinuationPromptResult>(IpcChannels.promptsGenerateContinuation, input)
  },
  settings: {
    get: () => invoke<AppSettings>(IpcChannels.settingsGet),
    update: (input: UpdateSettingsInput) => invoke<AppSettings>(IpcChannels.settingsUpdate, input)
  },
  system: {
    openExternal: (url: string) => invoke<{ opened: true }>(IpcChannels.systemOpenExternal, { url }),
    getAppInfo: () => invoke<AppInfo>(IpcChannels.systemGetAppInfo),
    // Generischer Zwischenablage-Kopiervorgang - kopiert exakt den
    // uebergebenen Text (Prompt-Vorschau UND einzelne Chat-Nachrichten).
    copyToClipboard: (text: string) => invoke<{ copied: true }>(IpcChannels.systemCopyToClipboard, { text })
  },
  // Meilenstein 2 - Strukturierter Antwort-Import. analyze() liest nur
  // (keine Datenbankaenderung), apply() fuehrt die tatsaechliche,
  // vollstaendig serverseitig erneut geprueften Uebernahme in einer
  // Transaktion aus (siehe responseImportService.ts).
  responseImport: {
    analyze: (input: ResponseImportAnalyzeInput) =>
      invoke<ResponseImportAnalyzeResult>(IpcChannels.responseImportAnalyze, input),
    apply: (input: ResponseImportApplyInput) =>
      invoke<ResponseImportApplyResult>(IpcChannels.responseImportApply, input)
  },
  sessions: {
    list: (projectId: number) => invoke<Session[]>(IpcChannels.sessionsList, { projectId }),
    get: (id: number) => invoke<Session>(IpcChannels.sessionsGet, { id }),
    getSuccessor: (sessionId: number) =>
      invoke<Session | null>(IpcChannels.sessionsGetSuccessor, { sessionId }),
    listChain: (sessionId: number) => invoke<Session[]>(IpcChannels.sessionsListChain, { sessionId }),
    create: (input: CreateSessionInput) => invoke<Session>(IpcChannels.sessionsCreate, input),
    update: (input: UpdateSessionInput) => invoke<Session>(IpcChannels.sessionsUpdate, input),
    createContinuation: (input: CreateContinuationSessionInput) =>
      invoke<Session>(IpcChannels.sessionsCreateContinuation, input),
    assignChatMessage: (input: AssignChatMessageToSessionInput) =>
      invoke<SessionChatMessageAssignment>(IpcChannels.sessionsAssignChatMessage, input)
  },
  snapshots: {
    list: (projectId: number, sessionId: number) =>
      invoke<ContinuationSnapshot[]>(IpcChannels.snapshotsList, { projectId, sessionId }),
    get: (projectId: number, sessionId: number, snapshotId: number) =>
      invoke<ContinuationSnapshot>(IpcChannels.snapshotsGet, { projectId, sessionId, snapshotId }),
    createDraft: (input: CreateDraftSnapshotInput) =>
      invoke<ContinuationSnapshot>(IpcChannels.snapshotsCreateDraft, input),
    confirm: (input: ConfirmSnapshotInput) => invoke<ContinuationSnapshot>(IpcChannels.snapshotsConfirm, input)
  },
  // Meilenstein 4.2 - Aufgaben-Grundlage (Storage + Verwaltung, KEINE
  // Ausfuehrung). Kein diff()-Kanal: Aufgaben sind mutable Current-State-
  // Datensaetze ohne Versionshistorie.
  tasks: {
    list: (projectId: number) => invoke<Task[]>(IpcChannels.tasksList, { projectId }),
    get: (projectId: number, taskId: number) => invoke<Task>(IpcChannels.tasksGet, { projectId, taskId }),
    create: (input: CreateTaskInput) => invoke<Task>(IpcChannels.tasksCreate, input),
    update: (input: UpdateTaskInput) => invoke<Task>(IpcChannels.tasksUpdate, input),
    updateStatus: (input: UpdateTaskStatusInput) => invoke<Task>(IpcChannels.tasksUpdateStatus, input),
    updateDependencies: (input: UpdateTaskDependenciesInput) =>
      invoke<Task>(IpcChannels.tasksUpdateDependencies, input)
  },
  // Meilenstein 4.3 - Work Request + Automation-UX-Grundlage. Nur die vom
  // Renderer erlaubten Operationen sind hier exponiert - applyPlanningResult,
  // replaceTaskLinks und setWorkRequestStatus bleiben Main/intern only und
  // haben bewusst KEINE Entsprechung hier. `create()` nimmt niemals ein
  // `createdBy`-Feld entgegen (Main setzt es serverseitig fest auf 'LEON').
  workRequests: {
    list: (projectId: number) => invoke<WorkRequestSummary[]>(IpcChannels.workRequestsList, { projectId }),
    get: (projectId: number, id: number) => invoke<WorkRequestDetail>(IpcChannels.workRequestsGet, { projectId, id }),
    create: (input: { projectId: number; intentMarkdown: string }) =>
      invoke<WorkRequestDetail>(IpcChannels.workRequestsCreate, input),
    updateIntent: (input: UpdateWorkRequestIntentInput) =>
      invoke<WorkRequestDetail>(IpcChannels.workRequestsUpdateIntent, input),
    resolveDecision: (input: ResolveDecisionInput) =>
      invoke<WorkRequestDetail>(IpcChannels.workRequestsResolveDecision, input)
  },
  // Meilenstein 4.8A - Code Change Review + Exact Approval Binding. NUR
  // Entscheidungs-/Lese-Methoden - KEINE create()-Methode (Review-Erstellung
  // ist Main-internal only) und KEINE apply()-Methode (M4.8A schreibt
  // nichts). Der Renderer erhaelt niemals das Main-eigene
  // ValidatedCodeChangePackage/den Fingerprint/root/policy/capabilities/
  // writeScope - nur die bereits bounded, renderer-sichere
  // CodeChangeReviewProjection.
  codeChangeReviews: {
    list: (projectId: number) => invoke<CodeChangeReviewSummary[]>(IpcChannels.codeChangeReviewsList, { projectId }),
    get: (projectId: number, reviewId: string) =>
      invoke<CodeChangeReviewProjection>(IpcChannels.codeChangeReviewsGet, { projectId, reviewId }),
    approve: (projectId: number, reviewId: string) =>
      invoke<CodeChangeReviewProjection>(IpcChannels.codeChangeReviewsApprove, { projectId, reviewId }),
    requestChanges: (projectId: number, reviewId: string, feedback: string) =>
      invoke<CodeChangeReviewProjection>(IpcChannels.codeChangeReviewsRequestChanges, { projectId, reviewId, feedback })
  }
}

export type EclipseHubApi = typeof api

contextBridge.exposeInMainWorld('eclipseHub', api)
