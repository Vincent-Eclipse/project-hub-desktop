// Feste Kanalnamen fuer die IPC-Kommunikation. Main und Preload importieren
// beide aus dieser Datei, damit Tippfehler in Kanalnamen zu Compile-Fehlern
// werden statt zu stillen Laufzeitfehlern.

export const IpcChannels = {
  repositoryDiagnostics: 'repository:diagnostics',
  repositoryDiff: 'repository:diff',
  projectsList: 'projects:list',
  projectsGet: 'projects:get',
  projectsCreate: 'projects:create',
  projectsUpdate: 'projects:update',
  projectsArchive: 'projects:archive',
  projectsRestore: 'projects:restore',
  projectsSelectFolder: 'projects:selectFolder',
  // Ermittelt den LIVE-Status des gespeicherten Projektordners (existiert er
  // noch, ist es noch ein Verzeichnis, ist er zugaenglich) - reine Abfrage,
  // veraendert nichts. Wird beim Oeffnen/Aktualisieren eines Projekts
  // aufgerufen, kein permanenter Watcher.
  projectsGetFolderStatus: 'projects:getFolderStatus',

  contextListVersions: 'context:listVersions',
  contextGetVersion: 'context:getVersion',
  contextCreateVersion: 'context:createVersion',
  contextDiff: 'context:diff',

  rulesListVersions: 'rules:listVersions',
  rulesGetVersion: 'rules:getVersion',
  rulesCreateVersion: 'rules:createVersion',
  rulesDiff: 'rules:diff',

  chatList: 'chat:list',
  chatAddMessage: 'chat:addMessage',

  promptsGetRoleInfo: 'prompts:getRoleInfo',
  promptsGenerate: 'prompts:generate',
  promptsSetOverride: 'prompts:setOverride',
  promptsGenerateContinuation: 'prompts:generateContinuation',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  systemOpenExternal: 'system:openExternal',
  systemGetAppInfo: 'system:getAppInfo',
  // Generischer Zwischenablage-Kopiervorgang. Wird sowohl von der
  // Prompt-Vorschau (Uebergabe-Tab) als auch vom Kopieren-Button einzelner
  // Chat-Nachrichten verwendet - kopiert in beiden Faellen exakt den
  // uebergebenen String, ohne ihn erneut zu erzeugen oder zu veraendern.
  systemCopyToClipboard: 'system:copyToClipboard',

  // Meilenstein 2 - Strukturierter Antwort-Import (rein lokal, kein
  // list-Kanal: die Oberflaeche zeigt aktuell keine Importhistorie an,
  // siehe MILESTONE2-RC1-NOTES.md).
  responseImportAnalyze: 'responseImport:analyze',
  responseImportApply: 'responseImport:apply',

  // Sitzungen
  sessionsList: 'sessions:list',
  sessionsGet: 'sessions:get',
  sessionsGetSuccessor: 'sessions:getSuccessor',
  sessionsListChain: 'sessions:listChain',
  sessionsCreate: 'sessions:create',
  sessionsUpdate: 'sessions:update',
  sessionsCreateContinuation: 'sessions:createContinuation',
  sessionsAssignChatMessage: 'sessions:assignChatMessage',

  // Fortsetzungs-Snapshots
  snapshotsList: 'snapshots:list',
  snapshotsGet: 'snapshots:get',
  snapshotsCreateDraft: 'snapshots:createDraft',
  snapshotsConfirm: 'snapshots:confirm',

  // Meilenstein 4.2 - Aufgaben-Grundlage (Storage + Verwaltung, KEINE
  // Ausfuehrung). Aufgaben sind mutable Current-State-Datensaetze - kein
  // eigener diff-Kanal, da keine Versionshistorie existiert.
  tasksList: 'tasks:list',
  tasksGet: 'tasks:get',
  tasksCreate: 'tasks:create',
  tasksUpdate: 'tasks:update',
  tasksUpdateStatus: 'tasks:updateStatus',
  tasksUpdateDependencies: 'tasks:updateDependencies',

  // Meilenstein 4.3 - Work Request + Automation-UX-Grundlage. Nur die vom
  // Renderer erlaubten Operationen erhalten einen Kanal - applyPlanningResult,
  // replaceTaskLinks und setWorkRequestStatus sind Main/intern only und
  // bekommen bewusst KEINEN IPC-Kanal.
  workRequestsList: 'workRequests:list',
  workRequestsGet: 'workRequests:get',
  workRequestsCreate: 'workRequests:create',
  workRequestsUpdateIntent: 'workRequests:updateIntent',
  workRequestsResolveDecision: 'workRequests:resolveDecision',

  // Meilenstein 4.8A - Code Change Review + Exact Approval Binding. NUR
  // Review-ENTSCHEIDUNGS-Kanaele - Review-ERSTELLUNG ist bewusst Main-
  // internal only (siehe claudeCodeChangeService.ts/codeChangeReviewService.ts)
  // und bekommt KEINEN IPC-Kanal. Es gibt ebenfalls KEINEN Apply-Kanal in
  // diesem Meilenstein.
  codeChangeReviewsList: 'codeChangeReviews:list',
  codeChangeReviewsGet: 'codeChangeReviews:get',
  codeChangeReviewsApprove: 'codeChangeReviews:approve',
  codeChangeReviewsRequestChanges: 'codeChangeReviews:requestChanges'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]
