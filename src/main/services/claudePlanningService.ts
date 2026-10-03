import type Database from 'better-sqlite3'
import type { ControllerPlan, WorkDecisionStatus } from '@shared/types'
import { getProjectById, ProjectArchivedError } from './projectsService'
import { getWorkRequestForProject } from './workRequestService'
import { getCurrentProjectRules } from './rulesService'
import { getCurrentContextVersion } from './contextService'
import { type ClaudeAdapterFailureCode, type ClaudeCliAdapterDeps, invokeClaudePlanning } from './claudeCliAdapter'

// Meilenstein 4.7A - Claude Code Planning Adapter. Diese Datei ist die
// EINZIGE Stelle, die (a) eine ClaudePlanningRequest entgegennimmt, (b) einen
// begrenzten, DB-gestuetzten Context Pack baut, und (c) claudeCliAdapter
// aufruft. Sie liest NIE das Dateisystem/Repository (kein fs.readFile, kein
// gitService, kein Projektordner) - siehe Vorgabe Abschnitt 28. Sie ist KEIN
// ExecutionManager: sie ruft niemals applyPlanningResult/createTask/
// resolveDecision/updateWorkRequest/setWorkRequestStatus auf. Ihr Ergebnis
// ist immer UNTRUSTED planning data, nie eine Freigabe (siehe Vorgabe
// Abschnitt "CRITICAL TRUST MODEL").

export class InvalidClaudePlanningRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidClaudePlanningRequestError'
  }
}

// Bewusst die kleinstmoegliche Main-seitige Planungsanfrage - siehe Vorgabe
// Abschnitt 3: KEIN projectRoot/folder/prompt/systemPrompt/model/provider/
// executable/tools/permissions/capabilities/policy/arguments/flags/
// sessionId/resumeId/agent/approval. Jedes zusaetzliche Feld wird von
// validateClaudePlanningRequest abgelehnt (Positivliste, kein Blacklist).
export interface ClaudePlanningRequest {
  projectId: number
  workRequestId: number
}

const ALLOWED_REQUEST_KEYS: readonly string[] = ['projectId', 'workRequestId']

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function validateClaudePlanningRequest(raw: unknown): ClaudePlanningRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidClaudePlanningRequestError('ClaudePlanningRequest muss ein Objekt sein.')
  }
  const record = raw as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => !ALLOWED_REQUEST_KEYS.includes(key))
  if (unknownKeys.length > 0) {
    throw new InvalidClaudePlanningRequestError(
      `ClaudePlanningRequest enthaelt unbekannte(s) Feld(er): ${unknownKeys.join(', ')}. Erlaubt sind ausschliesslich: projectId, workRequestId.`
    )
  }
  if (!isPositiveInteger(record.projectId)) {
    throw new InvalidClaudePlanningRequestError('projectId muss eine positive Ganzzahl sein.')
  }
  if (!isPositiveInteger(record.workRequestId)) {
    throw new InvalidClaudePlanningRequestError('workRequestId muss eine positive Ganzzahl sein.')
  }
  return { projectId: record.projectId, workRequestId: record.workRequestId }
}

// ---------------------------------------------------------------------------
// Context Pack - AUSSCHLIESSLICH anwendungseigene DB-Datensaetze, niemals
// Quelldateien/Repository-Pfade/Git-Status/Chat-Historie/Anhaenge/
// Umgebungsvariablen (siehe Vorgabe Abschnitt 4).
// ---------------------------------------------------------------------------

export interface ClaudeContextPackDecision {
  questionMarkdown: string
  status: WorkDecisionStatus
  resolvedOptionKey: string | null
  resolutionNote: string
}

export interface ClaudeContextPack {
  project: {
    name: string
    projectType: string
    description: string
  }
  workRequest: {
    intentMarkdown: string
  }
  rules: { versionId: number; versionNumber: number; contentMarkdown: string } | null
  context: { versionId: number; versionNumber: number; contentMarkdown: string } | null
  decisions: ClaudeContextPackDecision[]
}

/**
 * Baut den Context Pack frisch aus dem aktuellen DB-Zustand. Wird sowohl VOR
 * der Invocation (als das tatsaechlich gesendete stdinPayload) als auch
 * DANACH (fuer den Stale-Input-Recheck, siehe planWithClaude) aufgerufen -
 * absichtlich dieselbe einzige Quelle fuer beide Zeitpunkte, damit der
 * Recheck garantiert JEDES Feld abdeckt, das wirklich in den Prompt
 * eingeflossen ist, statt eine zweite, von Hand gepflegte Snapshot-Liste
 * (die leicht aus dem Takt geraet) parallel zu pflegen.
 */
function buildContextPack(db: Database.Database, request: ClaudePlanningRequest): ClaudeContextPack {
  const project = getProjectById(db, request.projectId)
  if (project.isArchived) throw new ProjectArchivedError(request.projectId)

  const workRequest = getWorkRequestForProject(db, request.projectId, request.workRequestId)
  const rules = getCurrentProjectRules(db, request.projectId)
  const context = getCurrentContextVersion(db, request.projectId)

  return {
    project: {
      name: project.name,
      projectType: project.projectType,
      description: project.description
    },
    workRequest: {
      intentMarkdown: workRequest.intentMarkdown
    },
    rules: rules ? { versionId: rules.id, versionNumber: rules.versionNumber, contentMarkdown: rules.contentMarkdown } : null,
    context: context
      ? { versionId: context.id, versionNumber: context.versionNumber, contentMarkdown: context.contentMarkdown }
      : null,
    decisions: workRequest.decisions.map((decision) => ({
      questionMarkdown: decision.questionMarkdown,
      status: decision.status,
      resolvedOptionKey: decision.resolvedOptionKey,
      resolutionNote: decision.resolutionNote
    }))
  }
}

// ---------------------------------------------------------------------------
// Ergebnis - immer vom Hub konstruiert, nie von Claude (siehe Vorgabe
// Abschnitt 23/27). INPUT_CHANGED ist eine reine Vorbereitungs-/
// Nachpruef-Klassifikation dieses Service, kein CLI-Fehler.
// ---------------------------------------------------------------------------

export type ClaudePlanningFailureCode = ClaudeAdapterFailureCode | 'INPUT_CHANGED'

export type ClaudePlanningOutcome =
  | { status: 'SUCCEEDED'; proposal: ControllerPlan }
  | { status: 'FAILED'; failureCode: ClaudePlanningFailureCode }

export const CONTEXT_PACK_MAX_BYTES = 64 * 1024

export interface ClaudePlanningOptions {
  signal?: AbortSignal
}

/**
 * Vollstaendiger M4.7A-Ablauf: Anfrage validieren -> Projekt/Work Request
 * aufloesen -> Context Pack bauen -> Claude einmalig, tool-los aufrufen ->
 * denselben Context Pack aus dem AKTUELLEN DB-Zustand neu bauen und exakt
 * (als serialisierter String) mit dem tatsaechlich gesendeten Payload
 * vergleichen -> UNTRUSTED Vorschlag zurueckgeben. Ruft NIEMALS eine
 * mutierende Funktion auf.
 *
 * Der Nachpruef-Vergleich verwendet bewusst denselben buildContextPack()-
 * Aufruf und dieselbe JSON.stringify()-Serialisierung wie die urspruengliche
 * Versendung (keine zweite, von Hand gepflegte Feldliste) - jede Aenderung
 * an irgendeinem Feld, das tatsaechlich im Prompt stand (Projektname/-typ/
 * -beschreibung, Work-Request-Absicht, Regeln, Kontext, JEDE Entscheidung
 * inkl. Status/aufgeloester Option/Notiz), macht die Strings unterschiedlich
 * und fuehrt zu INPUT_CHANGED. Ein Fehlschlag beim Neubau (Projekt geloescht/
 * archiviert, Work Request verschwunden/nicht mehr zugeordnet) zaehlt
 * ebenfalls als geaenderte Eingabe.
 */
export async function planWithClaude(
  db: Database.Database,
  adapterDeps: ClaudeCliAdapterDeps,
  rawRequest: unknown,
  options: ClaudePlanningOptions = {}
): Promise<ClaudePlanningOutcome> {
  const request = validateClaudePlanningRequest(rawRequest)
  const stdinPayload = JSON.stringify(buildContextPack(db, request))
  if (Buffer.byteLength(stdinPayload, 'utf8') > CONTEXT_PACK_MAX_BYTES) {
    return { status: 'FAILED', failureCode: 'INPUT_LIMIT' }
  }

  const outcome = await invokeClaudePlanning(adapterDeps, { stdinPayload, signal: options.signal })
  if (outcome.status === 'FAILED') return outcome

  let currentPayload: string
  try {
    currentPayload = JSON.stringify(buildContextPack(db, request))
  } catch {
    return { status: 'FAILED', failureCode: 'INPUT_CHANGED' }
  }
  if (currentPayload !== stdinPayload) {
    return { status: 'FAILED', failureCode: 'INPUT_CHANGED' }
  }

  return { status: 'SUCCEEDED', proposal: outcome.proposal }
}
