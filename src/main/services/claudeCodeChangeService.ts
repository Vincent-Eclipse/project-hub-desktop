import fsp from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { getProjectById, ProjectArchivedError, ProjectNotFoundError } from './projectsService'
import { getWorkRequestForProject, WorkRequestMismatchError, WorkRequestNotFoundError } from './workRequestService'
import { getTaskForProject, TaskMismatchError, TaskNotFoundError } from './taskService'
import { getCurrentProjectRules } from './rulesService'
import { getCurrentContextVersion } from './contextService'
import { ProjectTextReadError, resolveRoot } from './projectTextReadService'
import { runOperation, type RunPolicySnapshot, type RunTrustedScope } from './runService'
import {
  PROJECT_TEXT_READ_MAX_FILES,
  type LineEnding,
  type ProjectTextFileFormat,
  type ProjectTextFileResult
} from '@shared/projectTextReadTypes'
import type { RunFailureCode } from '@shared/runTypes'
import { assertNoCaseInsensitiveDuplicatePaths, InvalidSourceAccessPathError, validateSourceAccessPath } from './sourceAccessPath'
import { CODE_CHANGE_MAX_CREATE_ENTRIES, CODE_CHANGE_MAX_MODIFY_ENTRIES, type CodeChangeProposal } from '@shared/codeChangeTypes'
import type { TrustedCodeChangeScope } from './codeChangeValidation'
import {
  invokeClaudeCodeChange,
  MAX_CODE_CHANGE_STDIN_BYTES,
  type ClaudeAdapterFailureCode,
  type ClaudeCliAdapterDeps
} from './claudeCliAdapter'

// Meilenstein 4.7B.2 (V2 - Security/Authority-Fix) - Claude Code Change
// Proposal Adapter. Diese Datei ist die EINZIGE Stelle, die (a) eine
// ClaudeCodeChangeRequest UND eine separate ClaudeDisclosureScope UND eine
// dritte, separate Quell-Lese-Autoritaet (siehe unten) entgegennimmt, (b) den
// begrenzten Code Context Pack baut, (c) claudeCliAdapter's
// invokeClaudeCodeChange aufruft, und (d) den zurueckgegebenen Vorschlag
// gegen Format-/Frische-/CREATE-Praeconditions prueft. Sie MUTIERT NICHTS:
// kein Dateisystem-Schreibvorgang, kein Git, kein IPC/Renderer-Aufrufer
// existiert in diesem Meilenstein. "Claude VERFASST CODE. Main MUTIERT
// DATEIEN." bleibt vollstaendig eingefroren - dieser Service liefert
// ausschliesslich ein bereits geprueftes, aber weiterhin UNTRUSTED (nicht
// freigegebenes) Vorschlags-Paket im Speicher zurueck.
//
// V2 KRITISCHE AENDERUNG (siehe M4.7B.2-V2-Review "FIX 1"): Quelldateien
// werden NIE mehr direkt per readProjectTextFiles() gelesen - JEDER
// nicht-leere Quell-Snapshot laeuft durch die bestehende M4.7B.1 Run-Grenze
// (runOperation() mit der Operation 'project.readTextFiles'), also durch
// dieselbe filesystem.read-Capability-Bewertung + denselben RunTrustedScope
// + dieselben Run-Postflight-Pruefungen wie jeder andere Run-Aufrufer. Es
// gibt DREI unabhaengige, sich gegenseitig NICHT ersetzende Bedingungen:
//   1. filesystem.read-Policy erlaubt project.readTextFiles (Run-Gate)
//   2. der exakte RunTrustedScope erlaubt die angefragten Quellpfade
//   3. der exakte ClaudeDisclosureScope erlaubt, dass GENAU diese bereits
//      autorisierten Quellbytes das System verlassen (Claude-Offenlegung)
//
// Analog zu claudePlanningService.ts (M4.7A), aber erweitert um: getrennte
// Quell-Lese-Autoritaet (Run-Gate), getrennte Offenlegungs-Autoritaet,
// Quelldateien im Code Context Pack, MODIFY/CREATE-Scope,
// CREATE-Praecondition-Pruefung, formtreue MODIFY-Validierung, und einen
// zusaetzlichen Frische-Kontrollpunkt UNMITTELBAR VOR der Offenlegung (siehe
// proposeCodeChange, "FIX 3").

// ---------------------------------------------------------------------------
// ANFRAGE (Main-eigen, bewusst schlank) - siehe Vorgabe Teil 3/6. KEIN
// projectRoot/policy/capabilities/approval/provider/model/tools/commands/
// executable/environment/Claude-Argumente/RunTrustedScope/RunPolicySnapshot.
// Jedes zusaetzliche Feld wird abgelehnt (Positivliste, kein Blacklist).
// ---------------------------------------------------------------------------

export class InvalidClaudeCodeChangeRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidClaudeCodeChangeRequestError'
  }
}

export class InvalidClaudeDisclosureScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidClaudeDisclosureScopeError'
  }
}

/**
 * Aufgabe innerhalb GENAU eines Projekts/Work Requests/Tasks. `sourcePaths`
 * sind die Kandidaten-Quelldateien, die dieser Aufruf offenlegen MOECHTE -
 * das ist NOCH KEINE Leseautoritaet (siehe die separate Quell-Lese-Autoritaet
 * unten) UND NOCH KEINE Offenlegungs-Freigabe (siehe ClaudeDisclosureScope
 * unten) - drei vollkommen unabhaengige Autoritaeten. `modifyPaths`/
 * `createPaths` sind der Main-eigene MODIFY/CREATE-Scope (siehe
 * codeChangeValidation.ts's TrustedCodeChangeScope) - ebenfalls niemals vom
 * Modell geliefert.
 */
export interface ClaudeCodeChangeRequest {
  projectId: number
  workRequestId: number
  taskId: number
  sourcePaths: string[]
  modifyPaths: string[]
  createPaths: string[]
}

/**
 * Separate, Main-eigene Offenlegungs-Autoritaet (siehe Vorgabe: "provider
 * disclosure is separate authority from filesystem.read"). NIEMALS Teil der
 * rohen Anfrage, NIEMALS vom Modell geliefert, NIEMALS automatisch aus
 * filesystem.read/RunTrustedScope abgeleitet - ein zukuenftiger Aufrufer MUSS
 * diese separat uebergeben. Der eingefrorene V2-Grundsatz (siehe Vorgabe
 * "FIX 2"): eine ClaudeDisclosureScope darf NUR den tatsaechlichen
 * Quell-Snapshot DIESER Invocation autorisieren - `disclosedRelativePaths`
 * MUSS exakt (als Menge, Reihenfolge egal) `sourcePaths` entsprechen. Weder
 * ein fehlender noch ein zusaetzlicher Pfad ist zulaessig - eine Obermenge
 * autorisiert nicht "vorsorglich" mehr, als tatsaechlich gelesen wird.
 */
export interface ClaudeDisclosureScope {
  disclosedRelativePaths: string[]
}

const REQUEST_ALLOWED_KEYS: readonly string[] = ['projectId', 'workRequestId', 'taskId', 'sourcePaths', 'modifyPaths', 'createPaths']
const DISCLOSURE_ALLOWED_KEYS: readonly string[] = ['disclosedRelativePaths']

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Gemeinsame Pfadlisten-Validierung (Syntax + kategorischer Ausschluss +
 * case-insensitive Duplikat-Pruefung + Obergrenze). Wirft ein rohes `Error` -
 * jeder Aufrufer faengt es und wirft seinen eigenen, kontextspezifischen
 * Fehlertyp, damit ClaudeCodeChangeRequest- und ClaudeDisclosureScope-Fehler
 * unterscheidbar bleiben.
 */
function validatePathListGeneric(raw: unknown, fieldLabel: string, maxEntries: number): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${fieldLabel} muss eine Liste sein.`)
  }
  if (raw.length > maxEntries) {
    throw new Error(`${fieldLabel} enthaelt zu viele Eintraege (max. ${maxEntries}).`)
  }
  const validated = raw.map((entry) => {
    try {
      return validateSourceAccessPath(entry)
    } catch (error) {
      throw new Error(`${fieldLabel} enthaelt einen ungueltigen Pfad: ${error instanceof InvalidSourceAccessPathError ? error.message : String(error)}`)
    }
  })
  assertNoCaseInsensitiveDuplicatePaths(validated, fieldLabel)
  return validated
}

/**
 * Validiert eine rohe ClaudeCodeChangeRequest. `modifyPaths` MUSS eine
 * Teilmenge von `sourcePaths` sein (MODIFY nur auf offengelegte Dateien -
 * siehe Vorgabe "MODIFY AUTHORITY"). `createPaths` darf weder `sourcePaths`
 * noch `modifyPaths` case-insensitive ueberschneiden (ein CREATE-Ziel darf
 * keine bereits offengelegte/bestehende Datei sein). Mindestens ein
 * MODIFY- oder CREATE-Kandidat ist erforderlich - eine Anfrage ohne jede
 * Aenderungsmoeglichkeit koennte niemals einen gueltigen Vorschlag ergeben.
 */
export function validateClaudeCodeChangeRequest(raw: unknown): ClaudeCodeChangeRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidClaudeCodeChangeRequestError('ClaudeCodeChangeRequest muss ein Objekt sein.')
  }
  const record = raw as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => !REQUEST_ALLOWED_KEYS.includes(key))
  if (unknownKeys.length > 0) {
    throw new InvalidClaudeCodeChangeRequestError(
      `ClaudeCodeChangeRequest enthaelt unbekannte(s) Feld(er): ${unknownKeys.join(', ')}. Erlaubt sind ausschliesslich: ${REQUEST_ALLOWED_KEYS.join(', ')}.`
    )
  }
  if (!isPositiveInteger(record.projectId)) throw new InvalidClaudeCodeChangeRequestError('projectId muss eine positive Ganzzahl sein.')
  if (!isPositiveInteger(record.workRequestId)) {
    throw new InvalidClaudeCodeChangeRequestError('workRequestId muss eine positive Ganzzahl sein.')
  }
  if (!isPositiveInteger(record.taskId)) throw new InvalidClaudeCodeChangeRequestError('taskId muss eine positive Ganzzahl sein.')

  let sourcePaths: string[]
  let modifyPaths: string[]
  let createPaths: string[]
  try {
    sourcePaths = validatePathListGeneric(record.sourcePaths, 'sourcePaths', PROJECT_TEXT_READ_MAX_FILES)
    modifyPaths = validatePathListGeneric(record.modifyPaths, 'modifyPaths', CODE_CHANGE_MAX_MODIFY_ENTRIES)
    createPaths = validatePathListGeneric(record.createPaths, 'createPaths', CODE_CHANGE_MAX_CREATE_ENTRIES)
  } catch (error) {
    throw new InvalidClaudeCodeChangeRequestError(error instanceof Error ? error.message : String(error))
  }

  if (modifyPaths.length + createPaths.length === 0) {
    throw new InvalidClaudeCodeChangeRequestError('modifyPaths und createPaths duerfen nicht beide leer sein.')
  }

  const sourceSet = new Set(sourcePaths)
  for (const modifyPath of modifyPaths) {
    if (!sourceSet.has(modifyPath)) {
      throw new InvalidClaudeCodeChangeRequestError(`modifyPaths-Eintrag "${modifyPath}" ist nicht in sourcePaths enthalten.`)
    }
  }
  const existingLower = new Set([...sourcePaths, ...modifyPaths].map((entry) => entry.toLowerCase()))
  for (const createPath of createPaths) {
    if (existingLower.has(createPath.toLowerCase())) {
      throw new InvalidClaudeCodeChangeRequestError(
        `createPaths-Eintrag "${createPath}" kollidiert mit einem sourcePaths-/modifyPaths-Eintrag.`
      )
    }
  }

  return {
    projectId: record.projectId,
    workRequestId: record.workRequestId,
    taskId: record.taskId,
    sourcePaths,
    modifyPaths,
    createPaths
  }
}

/** Validiert eine rohe ClaudeDisclosureScope - exakte Form, keine zusaetzlichen Felder. */
export function validateClaudeDisclosureScope(raw: unknown): ClaudeDisclosureScope {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidClaudeDisclosureScopeError('ClaudeDisclosureScope muss ein Objekt sein.')
  }
  const record = raw as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => !DISCLOSURE_ALLOWED_KEYS.includes(key))
  if (unknownKeys.length > 0) {
    throw new InvalidClaudeDisclosureScopeError(
      `ClaudeDisclosureScope enthaelt unbekannte(s) Feld(er): ${unknownKeys.join(', ')}. Erlaubt ist ausschliesslich: disclosedRelativePaths.`
    )
  }
  let disclosedRelativePaths: string[]
  try {
    disclosedRelativePaths = validatePathListGeneric(record.disclosedRelativePaths, 'disclosedRelativePaths', PROJECT_TEXT_READ_MAX_FILES)
  } catch (error) {
    throw new InvalidClaudeDisclosureScopeError(error instanceof Error ? error.message : String(error))
  }
  return { disclosedRelativePaths }
}

/**
 * Exakte Mengen-Gleichheit (Reihenfolge egal, keine Alias-/Case-Toleranz -
 * beide Listen sind bereits case-insensitive-duplikatfrei, ein reiner
 * case-SENSITIVER Vergleich lehnt also einen Case-Alias korrekt als
 * Ungleichheit ab). Siehe M4.7B.2-V2-Review "FIX 2": weder eine fehlende
 * noch eine zusaetzliche Pfad-Autorisierung ist zulaessig.
 */
function pathSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((entry) => setA.has(entry))
}

// ---------------------------------------------------------------------------
// Task<->Work-Request-Bindung - reuse die staerkste bestehende Beziehung
// (work_request_tasks, siehe WorkRequestDetail.taskIds aus M4.3). Kein neues
// Schema/keine neue Persistenz wird erfunden.
// ---------------------------------------------------------------------------

export class ClaudeCodeChangeTaskBindingError extends Error {
  constructor(taskId: number, workRequestId: number) {
    super(`Aufgabe ${taskId} ist nicht mit Work Request ${workRequestId} verknuepft.`)
    this.name = 'ClaudeCodeChangeTaskBindingError'
  }
}

// ---------------------------------------------------------------------------
// QUELL-LESE-AUTORITAET (V2 FIX 1) - jeder nicht-leere Quell-Snapshot laeuft
// AUSSCHLIESSLICH durch die bestehende M4.7B.1 Run-Grenze (runOperation() mit
// 'project.readTextFiles'). Diese Datei dupliziert NIE die
// Capability-Bewertung selbst - sie liefert lediglich die Main-eigene
// RunRequest-Huelle (projectId/taskId/relativePaths, ALLE bereits aus der
// validierten ClaudeCodeChangeRequest abgeleitet, NIE vom Aufrufer der
// Quell-Lese-Autoritaet ueberschreibbar) und reicht policy/scope
// UNVERAENDERT an runOperation() durch.
// ---------------------------------------------------------------------------

/**
 * Main-eigene, von der rohen ClaudeCodeChangeRequest UND von der
 * ClaudeDisclosureScope UNABHAENGIGE Autoritaet fuer den eigentlichen
 * Quell-Lesevorgang - reuse der bestehenden RunPolicySnapshot/RunTrustedScope
 * Typen 1:1 (siehe runService.ts), keine zweite, abweichende Kopie. `policy`
 * fehlt/ist ungueltig, `trustedScope` fehlt/deckt einen angefragten Pfad
 * nicht ab, oder filesystem.read evaluiert zu DENY/REQUIRES_APPROVAL/
 * POLICY_UNSET -> Claude wird NIEMALS aufgerufen (siehe readSourceViaRunGate
 * unten, SourceReadAuthorityError -> SOURCE_UNAVAILABLE).
 */
export interface ClaudeCodeChangeSourceReadAuthority {
  policySnapshot: RunPolicySnapshot
  trustedScope: RunTrustedScope
}

class SourceReadAuthorityError extends Error {
  constructor(
    public readonly kind: 'BLOCKED' | 'FAILED',
    public readonly runFailureCode?: RunFailureCode
  ) {
    super('Quell-Lesevorgang ueber die Run-Grenze wurde abgelehnt.')
    this.name = 'SourceReadAuthorityError'
  }
}

/**
 * Liest die angeforderten Quelldateien AUSSCHLIESSLICH ueber runOperation()
 * ('project.readTextFiles') - niemals per direktem readProjectTextFiles()-
 * Aufruf (siehe M4.7B.2-V2-Review "FIX 1"). `rawPolicySnapshot`/
 * `rawTrustedScope` werden UNVERAENDERT an runOperation() durchgereicht - die
 * vollstaendige Capability-Bewertung (inkl. Projekt-/Archiv-/Rule-Pruefung)
 * bleibt vollstaendig innerhalb von runService.ts, wird hier NICHT dupliziert.
 * Ein fehlgeschlagener/ungueltiger Aufruf (malformed policy/scope) wirft
 * synchron aus runOperation() selbst (validateRunPolicySnapshot/
 * validateRunTrustedScope) - das wird hier als BLOCKED behandelt, exakt wie
 * ein regulaeres BLOCKED-Run-Ergebnis (fail closed in beiden Faellen).
 * Von einem erfolgreichen Run wird AUSSCHLIESSLICH `result` (ProjectTextFileResult[])
 * uebernommen - runId/timestamps/capabilityEvaluations werden NIE an Claude
 * oder den Rueckgabewert weitergereicht.
 */
async function readSourceViaRunGate(
  db: Database.Database,
  request: ClaudeCodeChangeRequest,
  rawPolicySnapshot: unknown,
  rawTrustedScope: unknown
): Promise<ProjectTextFileResult[]> {
  const runRequest = {
    projectId: request.projectId,
    taskId: request.taskId,
    operation: { id: 'project.readTextFiles' as const, input: { relativePaths: [...request.sourcePaths] } }
  }

  let outcome
  try {
    outcome = await runOperation(db, runRequest, rawPolicySnapshot, rawTrustedScope)
  } catch {
    // Missing/malformed RunPolicySnapshot or RunTrustedScope (or an
    // out-of-scope requested path) throws synchronously from runOperation()
    // itself, BEFORE any project/DB/capability resolution - fail closed the
    // same way as an explicit BLOCKED outcome, never crash the caller.
    throw new SourceReadAuthorityError('BLOCKED')
  }

  if (outcome.status === 'SUCCEEDED') {
    // The requested operation is always 'project.readTextFiles' here (fixed above, never
    // caller-influenced) - this check exists purely to let TypeScript narrow RunSucceeded's
    // operation-specific result union, not because the other branch is reachable in practice.
    if (outcome.operationId !== 'project.readTextFiles') throw new SourceReadAuthorityError('FAILED')
    return outcome.result
  }
  if (outcome.status === 'BLOCKED') throw new SourceReadAuthorityError('BLOCKED')
  throw new SourceReadAuthorityError('FAILED', outcome.failureCode)
}

// ---------------------------------------------------------------------------
// Interner Main-eigener Snapshot - dient GLEICHZEITIG als (a) Grundlage fuer
// den tatsaechlich an Claude gesendeten Code Context Pack (siehe
// buildCodeContextPack unten, eine bewusst kleinere Teilmenge) und (b) als
// Vergleichsstruktur fuer BEIDE Frische-Rechecks (siehe proposeCodeChange,
// "FIX 3": ein PRE-DISCLOSURE-Recheck UNMITTELBAR vor der Claude-Invocation
// zusaetzlich zum bestehenden POST-INVOCATION-Recheck) - dieselbe Philosophie
// wie M4.7A's buildContextPack()/JSON.stringify()-Vergleich, hier erweitert
// um Quelldateiinhalt+SHA-256+Projektordner-Identitaet, damit der Recheck
// nicht nur DB-Felder, sondern auch Quell-/Ordner-Frische in EINEM Vergleich
// abdeckt (kein Vergleich nur ueber Zeitstempel).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Meilenstein 4.8A Teil B - kleine, ehrliche ROOT-Identitaets-EVIDENZ (kein
// atomarer/kryptografischer Beweis, siehe Datei-Kommentar oben und
// codeChangeReviewTypes.ts). Wird bei JEDEM Snapshot-Aufbau miterfasst -
// dadurch faellt eine Ordner-Objekt-Aenderung bei GLEICHBLEIBENDEM Textpfad
// bereits in M4.7B.2's bestehenden A/C/I-Frischevergleich (Bonus, keine
// eigene neue Vergleichslogik). `null` bedeutet ehrlich "kein Ordner
// zugeordnet" ODER "Wurzel/Stat derzeit nicht aufloesbar" - niemals eine
// erfundene Identitaet. Wird NIE an den Code Context Pack oder die Renderer-
// Projektion weitergegeben (siehe buildCodeContextPack, das Felder per
// Positivliste kopiert).
// ---------------------------------------------------------------------------

export interface CodeChangeRootIdentityEvidence {
  realPath: string
  dev: string | null
  ino: string | null
}

async function captureRootIdentityEvidence(projectFolderPath: string | null): Promise<CodeChangeRootIdentityEvidence | null> {
  if (projectFolderPath === null) return null
  let realPath: string
  try {
    realPath = await resolveRoot(projectFolderPath)
  } catch {
    // Root derzeit nicht aufloesbar - die tatsaechliche Autoritaetspruefung
    // dafuer bleibt vollstaendig den bestehenden CREATE-Praecondition-
    // resolveRoot()-Aufrufen in proposeCodeChange ueberlassen (B/F/K); diese
    // Evidenz-Erfassung ist rein informativ und schlaegt niemals fehl.
    return null
  }
  try {
    const stat = await fsp.stat(realPath, { bigint: true })
    return { realPath, dev: stat.dev.toString(), ino: stat.ino.toString() }
  } catch {
    return { realPath, dev: null, ino: null }
  }
}

interface CodeChangeInternalSnapshot {
  project: { name: string; projectType: string; description: string }
  projectFolderComparisonKey: string | null
  projectFolderPath: string | null
  rootIdentity: CodeChangeRootIdentityEvidence | null
  workRequest: { intentMarkdown: string; planMarkdown: string | null; status: string }
  task: {
    title: string
    goalMarkdown: string
    descriptionMarkdown: string
    priority: string
    status: string
    acceptanceCriteriaMarkdown: string
    verificationRequirementsMarkdown: string
  }
  rules: { versionNumber: number; contentMarkdown: string } | null
  context: { versionNumber: number; contentMarkdown: string } | null
  decisions: Array<{ questionMarkdown: string; status: string; resolvedOptionKey: string | null; resolutionNote: string }>
  sourceFiles: ProjectTextFileResult[]
  allowedChanges: { modifyPaths: string[]; createPaths: string[] }
  disclosedRelativePaths: string[]
}

async function buildInternalSnapshot(
  db: Database.Database,
  request: ClaudeCodeChangeRequest,
  disclosureScope: ClaudeDisclosureScope,
  rawSourceReadPolicySnapshot: unknown,
  rawSourceReadTrustedScope: unknown
): Promise<CodeChangeInternalSnapshot> {
  const project = getProjectById(db, request.projectId)
  if (project.isArchived) throw new ProjectArchivedError(request.projectId)

  const workRequest = getWorkRequestForProject(db, request.projectId, request.workRequestId)
  const task = getTaskForProject(db, request.projectId, request.taskId)
  if (!workRequest.taskIds.includes(task.id)) {
    throw new ClaudeCodeChangeTaskBindingError(request.taskId, request.workRequestId)
  }

  const rules = getCurrentProjectRules(db, request.projectId)
  const context = getCurrentContextVersion(db, request.projectId)
  const rootIdentity = await captureRootIdentityEvidence(project.folderPath)

  // Leere sourcePaths ueberspringen die Run-Grenze bewusst - project.readTextFiles
  // lehnt eine leere relativePaths-Liste als INVALID_REQUEST ab (sie ist fuer
  // "mindestens eine Datei lesen" gebaut), waehrend hier ein reiner
  // CREATE-only-Auftrag ohne jede Quell-Offenlegung gueltig ist. Kein Run wird
  // in diesem Fall gestartet (siehe Vorgabe: "no project.readTextFiles Run is
  // necessary because no source bytes are read").
  const sourceFiles =
    request.sourcePaths.length > 0
      ? await readSourceViaRunGate(db, request, rawSourceReadPolicySnapshot, rawSourceReadTrustedScope)
      : []

  return {
    project: { name: project.name, projectType: project.projectType, description: project.description },
    projectFolderComparisonKey: project.folderComparisonKey,
    projectFolderPath: project.folderPath,
    rootIdentity,
    workRequest: { intentMarkdown: workRequest.intentMarkdown, planMarkdown: workRequest.planMarkdown, status: workRequest.status },
    task: {
      title: task.title,
      goalMarkdown: task.goalMarkdown,
      descriptionMarkdown: task.descriptionMarkdown,
      priority: task.priority,
      status: task.status,
      acceptanceCriteriaMarkdown: task.acceptanceCriteriaMarkdown,
      verificationRequirementsMarkdown: task.verificationRequirementsMarkdown
    },
    rules: rules ? { versionNumber: rules.versionNumber, contentMarkdown: rules.contentMarkdown } : null,
    context: context ? { versionNumber: context.versionNumber, contentMarkdown: context.contentMarkdown } : null,
    decisions: workRequest.decisions.map((decision) => ({
      questionMarkdown: decision.questionMarkdown,
      status: decision.status,
      resolvedOptionKey: decision.resolvedOptionKey,
      resolutionNote: decision.resolutionNote
    })),
    sourceFiles,
    allowedChanges: { modifyPaths: [...request.modifyPaths], createPaths: [...request.createPaths] },
    disclosedRelativePaths: [...disclosureScope.disclosedRelativePaths]
  }
}

/**
 * Die tatsaechlich an Claude gesendete Teilmenge des internen Snapshots -
 * bewusst OHNE projectFolderPath/projectFolderComparisonKey (kein absoluter
 * Root), OHNE sha256 (Claude soll keinen Hash "bestaetigen" muessen, siehe
 * Vorgabe), OHNE disclosedRelativePaths (reine interne Autoritaets-Buchhaltung).
 */
export interface ClaudeCodeContextPack {
  project: { name: string; projectType: string; description: string }
  workRequest: { intentMarkdown: string; planMarkdown: string | null; status: string }
  task: {
    title: string
    goalMarkdown: string
    descriptionMarkdown: string
    priority: string
    status: string
    acceptanceCriteriaMarkdown: string
    verificationRequirementsMarkdown: string
  }
  rules: { versionNumber: number; contentMarkdown: string } | null
  context: { versionNumber: number; contentMarkdown: string } | null
  decisions: Array<{ questionMarkdown: string; status: string; resolvedOptionKey: string | null; resolutionNote: string }>
  sourceFiles: Array<{ path: string; content: string; format: ProjectTextFileFormat }>
  allowedChanges: { modifyPaths: string[]; createPaths: string[] }
}

function buildCodeContextPack(snapshot: CodeChangeInternalSnapshot): ClaudeCodeContextPack {
  return {
    project: snapshot.project,
    workRequest: snapshot.workRequest,
    task: snapshot.task,
    rules: snapshot.rules,
    context: snapshot.context,
    decisions: snapshot.decisions,
    sourceFiles: snapshot.sourceFiles.map((file) => ({ path: file.path, content: file.content, format: file.format })),
    allowedChanges: snapshot.allowedChanges
  }
}

// ---------------------------------------------------------------------------
// CREATE-Praecondition (siehe Vorgabe Teil "CREATE AUTHORITY") - lstat-
// basierte Abwesenheitspruefung: JEDE Form eines bestehenden Eintrags
// (Datei/Verzeichnis/Symlink/Junction/haengender Link/case-insensitive Alias
// - Windows-Dateisysteme sind case-insensitiv, ein lstat auf "foo.ts"
// findet bereits bestehendes "Foo.ts") blockiert CREATE. Das Elternverzeichnis
// MUSS bereits existieren und innerhalb der vertrauenswuerdigen Wurzel liegen -
// es wird NIEMALS automatisch erstellt. Wird von proposeCodeChange DREIMAL
// aufgerufen (initial, nach dem PRE-DISCLOSURE-Recheck, nach dem
// POST-INVOCATION-Recheck - siehe "FIX 3").
// ---------------------------------------------------------------------------

class CreatePreconditionError extends Error {
  constructor(public readonly path: string) {
    super('CREATE-Zielpfad ist nicht verfuegbar.')
    this.name = 'CreatePreconditionError'
  }
}

async function assertCreateTargetAvailable(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split('/')
  let currentDir = root
  for (let i = 0; i < segments.length - 1; i++) {
    const candidate = path.join(currentDir, segments[i])
    let lst
    try {
      lst = await fsp.lstat(candidate)
    } catch {
      throw new CreatePreconditionError(relativePath)
    }
    if (lst.isSymbolicLink() || !lst.isDirectory()) {
      throw new CreatePreconditionError(relativePath)
    }
    currentDir = candidate
  }

  let realParent: string
  try {
    realParent = await fsp.realpath(currentDir)
  } catch {
    throw new CreatePreconditionError(relativePath)
  }
  const relativeParent = path.relative(root, realParent)
  if (relativeParent.startsWith('..') || path.isAbsolute(relativeParent)) {
    throw new CreatePreconditionError(relativePath)
  }

  const targetPath = path.join(currentDir, segments[segments.length - 1])
  let targetExists = true
  try {
    await fsp.lstat(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      targetExists = false
    } else {
      // Jeder andere lstat-Fehler (z. B. Zugriff verweigert) kann Abwesenheit
      // nicht bestaetigen - konservativ blockieren statt CREATE zu erlauben.
      throw new CreatePreconditionError(relativePath)
    }
  }
  if (targetExists) {
    throw new CreatePreconditionError(relativePath)
  }
}

async function assertAllCreateTargetsAvailable(root: string, createPaths: readonly string[]): Promise<void> {
  for (const relativePath of createPaths) {
    await assertCreateTargetAvailable(root, relativePath)
  }
}

// ---------------------------------------------------------------------------
// Formtreue-Pruefung (siehe Vorgabe Teil "FORMAT RULES FOR MODIFY"/"CREATE
// FORMAT (V1)"). Der CodeChangeProposal-Vertrag enthaelt bewusst KEIN
// separates Format-Feld (siehe codeChangeTypes.ts) - `content` ist daher
// IMMER als BOM-freier Text zu interpretieren; eine kuenftige M4.8-
// Byte-Rekonstruktion haengt die BOM (falls die Basisdatei eine hatte) selbst
// wieder an. Ein literales U+FEFF im Modell-Inhalt waere damit doppeldeutig
// (waere es Teil des Textes oder eine vom Modell "hinzugefuegte" BOM?) und
// wird deshalb kategorisch abgelehnt - keine stillschweigende Transformation.
//
// V2 FIX 4: die Zeilenumbruch-Praeferenz des Originals muss EXAKT erhalten
// bleiben, inklusive NONE - eine leere/zeilenumbruchlose Basisdatei erlaubt
// KEINE neu eingefuehrten internen Zeilenumbrueche (weder LF noch CRLF), und
// eine LF/CRLF-Basisdatei erlaubt NIE ein Kollabieren auf NONE. Es gibt genau
// EINEN gueltigen Zielwert: `baseFormat.lineEnding` selbst.
// ---------------------------------------------------------------------------

export class CodeChangeFormatError extends Error {
  constructor(
    public readonly path: string,
    message: string
  ) {
    super(message)
    this.name = 'CodeChangeFormatError'
  }
}

function assertModifyFormatPreserved(content: string, baseFormat: ProjectTextFileFormat, changePath: string): void {
  if (content.includes(String.fromCharCode(0xfeff))) {
    throw new CodeChangeFormatError(changePath, 'BOM-Zeichen (U+FEFF) ist im Inhalt nicht erlaubt.')
  }
  const withoutCrlf = content.split('\r\n').join('')
  const hasCrlf = withoutCrlf.length !== content.length
  const hasLoneLf = withoutCrlf.includes('\n')
  const hasLoneCr = withoutCrlf.includes('\r')
  if (hasLoneCr) {
    throw new CodeChangeFormatError(changePath, 'Einzelnes CR ist kein unterstuetzter Zeilenumbruch.')
  }
  if (hasCrlf && hasLoneLf) {
    throw new CodeChangeFormatError(changePath, 'Gemischte LF/CRLF-Zeilenumbrueche sind nicht erlaubt.')
  }
  const lineEnding: LineEnding = hasCrlf ? 'CRLF' : hasLoneLf ? 'LF' : 'NONE'
  // Exakte Gleichheit - KEINE Ausnahme fuer NONE auf einer der beiden Seiten
  // (siehe V2 FIX 4: LF/CRLF->NONE und NONE->LF/CRLF sind beide ungueltig).
  if (lineEnding !== baseFormat.lineEnding) {
    throw new CodeChangeFormatError(changePath, `Zeilenumbruch-Stil muss exakt "${baseFormat.lineEnding}" bleiben (wie das Original).`)
  }
  const finalNewline = content.length > 0 && content.endsWith('\n')
  if (finalNewline !== baseFormat.finalNewline) {
    throw new CodeChangeFormatError(changePath, 'Abschliessender Zeilenumbruch muss dem Original entsprechen.')
  }
}

function assertCreateFormatValid(content: string, changePath: string): void {
  if (content.includes(String.fromCharCode(0xfeff))) {
    throw new CodeChangeFormatError(changePath, 'BOM-Zeichen (U+FEFF) ist im Inhalt nicht erlaubt.')
  }
  if (content.includes('\r')) {
    throw new CodeChangeFormatError(changePath, 'Neu erstellte Dateien muessen LF-Zeilenumbrueche verwenden (kein CR).')
  }
  if (content.length === 0 || !content.endsWith('\n')) {
    throw new CodeChangeFormatError(changePath, 'Neu erstellte Dateien muessen mit einem abschliessenden Zeilenumbruch enden.')
  }
}

// ---------------------------------------------------------------------------
// Ergebnis - immer vom Hub konstruiert, nie von Claude. INPUT_CHANGED/
// DISCLOSURE_NOT_ALLOWED/PROJECT_NOT_FOUND/TASK_MISMATCH/WORK_REQUEST_MISMATCH/
// SOURCE_UNAVAILABLE sind reine Vorbereitungs-/Nachpruef-Klassifikationen
// dieses Service, keine CLI-Fehler (siehe claudeCliAdapter.ts's
// ClaudeAdapterFailureCode fuer die Transport-Ebene).
// ---------------------------------------------------------------------------

export type ClaudeCodeChangeFailureCode =
  | ClaudeAdapterFailureCode
  | 'INVALID_REQUEST'
  | 'PROJECT_NOT_FOUND'
  | 'TASK_MISMATCH'
  | 'WORK_REQUEST_MISMATCH'
  | 'DISCLOSURE_NOT_ALLOWED'
  | 'SOURCE_UNAVAILABLE'
  | 'INPUT_CHANGED'

/**
 * Meilenstein 4.8A Teil A - vollstaendige, Main-EIGENE (niemals an Claude
 * gesendete, niemals in shared/ exponierte) Generierungs-Provenienz. Bindet
 * eine spaetere Review (siehe codeChangeReviewService.ts) an den exakten
 * DB-/Quell-/Ordner-Zustand zum Generierungszeitpunkt. Enthaelt bewusst NUR
 * Daten (Pfade/Inhalte/Hashes/Text) - NIEMALS ein RunPolicySnapshot/
 * RunTrustedScope-Objekt selbst (siehe Vorgabe Teil A: "Do NOT retain old
 * policy snapshots as renewable authority" / "Scopes may be retained as
 * historical provenance only" - `sourcePaths`/`modifyPaths`/`createPaths`/
 * `disclosedRelativePaths` sind reine Pfadlisten, keine Autoritaets-Objekte
 * und gewaehren fuer sich genommen nichts).
 */
export interface CodeChangeGenerationProvenance {
  projectId: number
  taskId: number
  workRequestId: number
  project: { name: string; projectType: string; description: string }
  projectFolderPath: string | null
  projectFolderComparisonKey: string | null
  rootIdentity: CodeChangeRootIdentityEvidence | null
  workRequest: { intentMarkdown: string; planMarkdown: string | null; status: string }
  task: {
    title: string
    goalMarkdown: string
    descriptionMarkdown: string
    priority: string
    status: string
    acceptanceCriteriaMarkdown: string
    verificationRequirementsMarkdown: string
  }
  rules: { versionNumber: number; contentMarkdown: string } | null
  context: { versionNumber: number; contentMarkdown: string } | null
  decisions: Array<{ questionMarkdown: string; status: string; resolvedOptionKey: string | null; resolutionNote: string }>
  sourcePaths: string[]
  modifyPaths: string[]
  createPaths: string[]
  disclosedRelativePaths: string[]
  sourceFiles: ProjectTextFileResult[]
  createPreconditions: Array<{ path: string; verifiedAbsent: true }>
}

function buildGenerationProvenance(
  request: ClaudeCodeChangeRequest,
  snapshot: CodeChangeInternalSnapshot,
  createPreconditions: Array<{ path: string; verifiedAbsent: true }>
): CodeChangeGenerationProvenance {
  return {
    projectId: request.projectId,
    taskId: request.taskId,
    workRequestId: request.workRequestId,
    project: snapshot.project,
    projectFolderPath: snapshot.projectFolderPath,
    projectFolderComparisonKey: snapshot.projectFolderComparisonKey,
    rootIdentity: snapshot.rootIdentity,
    workRequest: snapshot.workRequest,
    task: snapshot.task,
    rules: snapshot.rules,
    context: snapshot.context,
    decisions: snapshot.decisions,
    sourcePaths: [...request.sourcePaths],
    modifyPaths: [...request.modifyPaths],
    createPaths: [...request.createPaths],
    disclosedRelativePaths: snapshot.disclosedRelativePaths,
    sourceFiles: snapshot.sourceFiles,
    createPreconditions
  }
}

/**
 * Schmales, Main-eigenes Rueckgabe-Paket - bewusst KEIN Digest/keine
 * kryptografische Zeremonie (siehe Vorgabe: "avoid adding cryptographic
 * ceremony if M4.8 doesn't need it yet"). `sourceSnapshot` traegt die exakten
 * Quell-Provenienz-Daten (inkl. SHA-256/Format) fuer eine zukuenftige
 * Anwendungslogik - Claude hat diese Werte nie gesehen/bestaetigt.
 * `createPreconditions` dokumentiert, welche CREATE-Ziele unmittelbar vor der
 * Rueckgabe als abwesend bestaetigt wurden. `provenance` (M4.8A) traegt die
 * VOLLSTAENDIGE Generierungs-Provenienz fuer die Review-Bindung (siehe
 * CodeChangeGenerationProvenance oben) - `sourceSnapshot`/`createPreconditions`
 * bleiben als eigene Felder erhalten (unveraendertes M4.7B.2-Verhalten),
 * `provenance` dupliziert sie zusaetzlich zusammen mit allem anderen in EINER
 * gebuendelten Struktur.
 */
export interface ValidatedCodeChangePackage {
  proposal: CodeChangeProposal
  sourceSnapshot: ProjectTextFileResult[]
  createPreconditions: Array<{ path: string; verifiedAbsent: true }>
  provenance: CodeChangeGenerationProvenance
}

export type ClaudeCodeChangeOutcome =
  | { status: 'SUCCEEDED'; result: ValidatedCodeChangePackage }
  | { status: 'FAILED'; failureCode: ClaudeCodeChangeFailureCode }

export interface ClaudeCodeChangeOptions {
  signal?: AbortSignal
}

/**
 * Nur fuer die ERSTE (initiale) Snapshot-Vorbereitung verwendet - liefert die
 * bestmoegliche Klassifikation (PROJECT_NOT_FOUND/TASK_MISMATCH/
 * WORK_REQUEST_MISMATCH/SOURCE_UNAVAILABLE/INPUT_CHANGED fuer einen bereits
 * beim ALLERERSTEN Versuch waehrend des Lesens erkannten PROJECT_CHANGED-Fall
 * innerhalb der Run-Grenze). Die BEIDEN Frische-Rechecks (PRE-DISCLOSURE/
 * POST-INVOCATION) verwenden absichtlich NICHT diese Funktion, sondern
 * klassifizieren JEDEN Fehlschlag pauschal als INPUT_CHANGED (siehe
 * proposeCodeChange) - ein Fehlschlag beim Neu-Aufbau ist dort per
 * Definition eine erkannte Zustandsaenderung, keine Erstanfrage.
 */
function mapPreparationError(error: unknown): ClaudeCodeChangeFailureCode {
  if (error instanceof ProjectNotFoundError) return 'PROJECT_NOT_FOUND'
  if (error instanceof ProjectArchivedError) return 'PROJECT_NOT_FOUND'
  if (error instanceof WorkRequestNotFoundError) return 'WORK_REQUEST_MISMATCH'
  if (error instanceof WorkRequestMismatchError) return 'WORK_REQUEST_MISMATCH'
  if (error instanceof TaskNotFoundError) return 'TASK_MISMATCH'
  if (error instanceof TaskMismatchError) return 'TASK_MISMATCH'
  if (error instanceof ClaudeCodeChangeTaskBindingError) return 'TASK_MISMATCH'
  if (error instanceof ProjectTextReadError) return 'SOURCE_UNAVAILABLE'
  if (error instanceof SourceReadAuthorityError) {
    if (error.kind === 'BLOCKED') return 'SOURCE_UNAVAILABLE'
    switch (error.runFailureCode) {
      case 'PROJECT_NOT_FOUND':
        return 'PROJECT_NOT_FOUND'
      case 'TASK_NOT_FOUND_OR_MISMATCH':
        return 'TASK_MISMATCH'
      case 'PROJECT_CHANGED':
        return 'INPUT_CHANGED'
      default:
        return 'SOURCE_UNAVAILABLE'
    }
  }
  return 'SOURCE_UNAVAILABLE'
}

/**
 * Vollstaendiger M4.7B.2-V2-Ablauf. Siehe Datei-Kommentar oben fuer die
 * Gesamtarchitektur. `rawSourceReadPolicySnapshot`/`rawSourceReadTrustedScope`
 * sind die DRITTE, separate Main-eigene Autoritaet (siehe
 * ClaudeCodeChangeSourceReadAuthority oben) - unabhaengig von `rawRequest`
 * und `rawDisclosureScope`. Ablauf (Buchstaben A-L entsprechen der
 * M4.7B.2-V2-Review "FIX 3"-Vorgabe):
 *
 *  1. Anfrage validieren.
 *  2. Offenlegungs-Scope validieren + EXAKTE Mengen-Gleichheit mit
 *     `sourcePaths` pruefen (FIX 2) - VOR jedem DB-/Lese-/Claude-Zugriff.
 *  A. Initialen internen Snapshot bauen (Projekt/Work Request/Task/Regeln/
 *     Kontext + Quelldateien AUSSCHLIESSLICH ueber die Run-Grenze, FIX 1).
 *  B. CREATE-Ziele auf Abwesenheit pruefen.
 *  C. Denselben Snapshot ERNEUT (PRE-DISCLOSURE) aus dem AKTUELLEN Zustand
 *     bauen, ueber dieselbe Policy/denselben Scope.
 *  D/E. Exakt (als serialisierter String) mit dem initialen Snapshot
 *     vergleichen - jede Abweichung -> INPUT_CHANGED, Claude wird NIEMALS
 *     aufgerufen.
 *  F. CREATE-Ziele ERNEUT auf Abwesenheit pruefen.
 *  G. Code Context Pack aus dem PRE-DISCLOSURE-Snapshot bauen,
 *     Groessenlimit pruefen.
 *  H. Claude EINMALIG, tool-los aufrufen (geteilter Transport, eigenes
 *     Profil).
 *  (Formtreue pruefen: MODIFY muss Original-Format exakt erhalten - FIX 4;
 *   CREATE muss die feste V1-Konvention erfuellen.)
 *  I. POST-INVOCATION-Snapshot bauen (dieselbe Autoritaet wie A/C).
 *  J. Exakt mit dem PRE-DISCLOSURE-Snapshot vergleichen - jede Abweichung
 *     -> INPUT_CHANGED.
 *  K. CREATE-Ziele ein drittes Mal auf Abwesenheit pruefen.
 *  L. Erst dann SUCCEEDED zurueckgeben.
 *
 * Dies verengt Races (ein PRE-DISCLOSURE-Snapshot-Wechsel wird VOR der
 * Offenlegung erkannt, nicht erst danach), ist aber KEINE atomare
 * Windows-Dateisystem-Transaktion/Sandbox - ein bösartiger, gleichzeitig
 * manipulierender Akteur mit denselben Benutzerrechten koennte theoretisch
 * exakt zwischen dem letzten Recheck und der Claude-Invocation eingreifen
 * (TOCTOU); siehe projectTextReadService.ts's Datei-Kommentar fuer dieselbe
 * ehrliche Einschraenkung. Ruft NIEMALS eine mutierende Funktion auf - kein
 * Schreiben, kein Anwenden, keine Freigabe, kein automatischer Retry/Rebase/
 * zweiter Claude-Aufruf.
 */
export async function proposeCodeChange(
  db: Database.Database,
  adapterDeps: ClaudeCliAdapterDeps,
  rawRequest: unknown,
  rawDisclosureScope: unknown,
  rawSourceReadPolicySnapshot: unknown,
  rawSourceReadTrustedScope: unknown,
  options: ClaudeCodeChangeOptions = {}
): Promise<ClaudeCodeChangeOutcome> {
  const request = validateClaudeCodeChangeRequest(rawRequest)

  let disclosureScope: ClaudeDisclosureScope
  try {
    disclosureScope = validateClaudeDisclosureScope(rawDisclosureScope)
  } catch {
    return { status: 'FAILED', failureCode: 'DISCLOSURE_NOT_ALLOWED' }
  }
  // FIX 2: exact set equality, not mere coverage - a superset/subset/alias
  // never passes. CREATE-only requests (sourcePaths=[]) require
  // disclosedRelativePaths=[] too, which this equally satisfies.
  if (!pathSetsEqual(request.sourcePaths, disclosureScope.disclosedRelativePaths)) {
    return { status: 'FAILED', failureCode: 'DISCLOSURE_NOT_ALLOWED' }
  }

  // A. initial snapshot (source read via the Run gate - FIX 1).
  let initial: CodeChangeInternalSnapshot
  try {
    initial = await buildInternalSnapshot(db, request, disclosureScope, rawSourceReadPolicySnapshot, rawSourceReadTrustedScope)
  } catch (error) {
    return { status: 'FAILED', failureCode: mapPreparationError(error) }
  }

  // B. CREATE preconditions (initial).
  try {
    const root = await resolveRoot(initial.projectFolderPath)
    await assertAllCreateTargetsAvailable(root, request.createPaths)
  } catch {
    // Both "root unusable" and "CREATE target already taken" count as "state
    // does not match the trusted assumption" here - the same INPUT_CHANGED
    // classification as the later rechecks (see the M4.7B.2 final report's
    // "Error model" section for the documented rationale).
    return { status: 'FAILED', failureCode: 'INPUT_CHANGED' }
  }

  // C. PRE-DISCLOSURE rebuild, through the SAME authority (FIX 3) -
  // immediately before anything leaves the machine.
  let preDisclosure: CodeChangeInternalSnapshot
  try {
    preDisclosure = await buildInternalSnapshot(db, request, disclosureScope, rawSourceReadPolicySnapshot, rawSourceReadTrustedScope)
  } catch {
    return { status: 'FAILED', failureCode: 'INPUT_CHANGED' }
  }
  // D/E. exact comparison - any drift blocks the invocation entirely.
  if (JSON.stringify(preDisclosure) !== JSON.stringify(initial)) {
    return { status: 'FAILED', failureCode: 'INPUT_CHANGED' }
  }

  // F. CREATE preconditions, rechecked once more after the comparison passed.
  try {
    const root = await resolveRoot(preDisclosure.projectFolderPath)
    await assertAllCreateTargetsAvailable(root, request.createPaths)
  } catch {
    return { status: 'FAILED', failureCode: 'INPUT_CHANGED' }
  }

  // G. build/send the pack from the PRE-DISCLOSURE snapshot.
  const pack = buildCodeContextPack(preDisclosure)
  const stdinPayload = JSON.stringify(pack)
  if (Buffer.byteLength(stdinPayload, 'utf8') > MAX_CODE_CHANGE_STDIN_BYTES) {
    return { status: 'FAILED', failureCode: 'INPUT_LIMIT' }
  }

  // H. invoke Claude exactly once.
  const scope: TrustedCodeChangeScope = { modifyPaths: [...request.modifyPaths], createPaths: [...request.createPaths] }
  const outcome = await invokeClaudeCodeChange(adapterDeps, { stdinPayload, signal: options.signal, scope })
  if (outcome.status === 'FAILED') return outcome

  const sourceByPath = new Map(preDisclosure.sourceFiles.map((file) => [file.path, file]))
  try {
    for (const change of outcome.proposal.changes) {
      if (change.type === 'MODIFY') {
        const base = sourceByPath.get(change.path)
        // Kann strukturell nicht passieren (invokeClaudeCodeChange hat den
        // MODIFY-Pfad bereits gegen scope.modifyPaths validiert, und
        // modifyPaths ist per validateClaudeCodeChangeRequest eine Teilmenge
        // von sourcePaths) - dennoch defensiv statt eines nicht abgefangenen
        // Absturzes behandelt.
        if (!base) throw new CodeChangeFormatError(change.path, 'Keine Basisdatei fuer diesen MODIFY-Pfad bekannt.')
        assertModifyFormatPreserved(change.content, base.format, change.path)
      } else {
        assertCreateFormatValid(change.content, change.path)
      }
    }
  } catch {
    return { status: 'FAILED', failureCode: 'INVALID_OUTPUT' }
  }

  // I. POST-INVOCATION rebuild, through the same authority again.
  let postInvocation: CodeChangeInternalSnapshot
  try {
    postInvocation = await buildInternalSnapshot(db, request, disclosureScope, rawSourceReadPolicySnapshot, rawSourceReadTrustedScope)
  } catch {
    return { status: 'FAILED', failureCode: 'INPUT_CHANGED' }
  }
  // J. compare against PRE-DISCLOSURE (not the original initial snapshot).
  if (JSON.stringify(postInvocation) !== JSON.stringify(preDisclosure)) {
    return { status: 'FAILED', failureCode: 'INPUT_CHANGED' }
  }

  // K. CREATE preconditions, a third and final time.
  try {
    const rootAfter = await resolveRoot(postInvocation.projectFolderPath)
    await assertAllCreateTargetsAvailable(rootAfter, request.createPaths)
  } catch {
    return { status: 'FAILED', failureCode: 'INPUT_CHANGED' }
  }

  // L. only now SUCCEEDED.
  const createPreconditions = request.createPaths.map((createPath) => ({ path: createPath, verifiedAbsent: true as const }))
  return {
    status: 'SUCCEEDED',
    result: {
      proposal: outcome.proposal,
      sourceSnapshot: preDisclosure.sourceFiles,
      createPreconditions,
      provenance: buildGenerationProvenance(request, preDisclosure, createPreconditions)
    }
  }
}
