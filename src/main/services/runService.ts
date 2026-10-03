import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { CapabilityEvaluation, CapabilityId, CapabilityPolicyContext, CapabilityPolicyMode } from '@shared/permissionTypes'
import {
  OPERATION_IDS,
  type OperationId,
  type RepositoryDiagnosticsSummary,
  type RunFailureCode,
  type RunOutcome,
  type RunRequest
} from '@shared/runTypes'
import type { ProjectTextFileResult, ProjectTextReadRequest } from '@shared/projectTextReadTypes'
import {
  resolveCapabilityRequest,
  validateCapabilityIdList,
  validateCapabilityPolicyContext,
  validateCapabilityRequest,
  validatePolicyMap
} from './capabilityPolicy'
import { getOperationDefinition, InvalidOperationInputError, OperationExecutionError } from './runOperations'
import { getProjectById, ProjectNotFoundError } from './projectsService'
import type { Project } from '@shared/types'
import { getTaskForProject, TaskMismatchError, TaskNotFoundError } from './taskService'
import { assertNoCaseInsensitiveDuplicatePaths, validateSourceAccessPath } from './sourceAccessPath'

// Meilenstein 4.6 (erweitert in 4.7B.1) - Run/Execution-Engine-Grundlage.
// Fuehrt genau EINE vertrauenswuerdige Operation innerhalb EINES Projekts
// aus, nach vollstaendiger Capability-Gate-Pruefung (M4.5). Kein
// Migration-007-Schema, keine Persistenz - das Ergebnis geht ausschliesslich
// an den internen Main-Aufrufer und verschwindet beim App-Ende.
//
// Der Aufrufer liefert NUR das RunPolicySnapshot (policy/ruleDeniedCapabilities)
// und - fuer project.readTextFiles - das RunTrustedScope. Alles, was Main
// selbst kennt (projectId, isArchived, welche Capabilities die Laufzeit
// tatsaechlich unterstuetzt), wird HIER aus dem bereits aufgeloesten Projekt
// konstruiert, nie vom Aufrufer uebernommen. Ein Aufrufer, der z. B.
// isArchived=false vorgaeukelt, waehrend das Projekt in der DB archiviert
// ist, kann dadurch keinen Widerspruch mehr erzeugen - diese Felder
// existieren im Aufrufer-Vertrag schlicht nicht.

export class InvalidRunRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRunRequestError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function assertExactKeys(raw: Record<string, unknown>, allowedKeys: readonly string[], contextLabel: string): void {
  const allowed = new Set(allowedKeys)
  const extra = Object.keys(raw).filter((key) => !allowed.has(key))
  if (extra.length > 0) {
    throw new InvalidRunRequestError(
      `${contextLabel} enthaelt unbekannte(s) Feld(er): ${extra.join(', ')}. Erlaubt sind ausschliesslich: ${allowedKeys.join(', ')}.`
    )
  }
}

function validatePositiveInteger(raw: unknown, fieldLabel: string): number {
  if (!Number.isInteger(raw) || (raw as number) <= 0) {
    throw new InvalidRunRequestError(`${fieldLabel} muss eine positive Ganzzahl sein.`)
  }
  return raw as number
}

const RUN_REQUEST_ALLOWED_KEYS = ['projectId', 'taskId', 'operation'] as const
const OPERATION_ALLOWED_KEYS = ['id', 'input'] as const

/**
 * Fail-closed, exakte Form. Operation-ID und -Eingabe werden HIER bereits
 * gegen die vertrauenswuerdige Operation-Definition geprueft - eine
 * ungueltige rohe Anfrage wirft, BEVOR ueberhaupt ein Run existiert (siehe
 * runService.ts-Dateikommentar). Die validierte, operation-spezifische
 * Eingabe (siehe runOperations.ts's validateInput-Rueckgabewert) wird
 * UNVERAENDERT in RunRequest.operation.input uebernommen - nie erneut aus
 * dem rohen Request abgeleitet, nie durch ein hartkodiertes leeres Objekt
 * ersetzt (siehe M4.7B.1-Vorgabe Teil J).
 */
export function validateRunRequest(raw: unknown): RunRequest {
  if (!isPlainObject(raw)) throw new InvalidRunRequestError('RunRequest muss ein Objekt sein.')
  assertExactKeys(raw, RUN_REQUEST_ALLOWED_KEYS, 'RunRequest')

  const projectId = validatePositiveInteger(raw.projectId, 'RunRequest.projectId')
  const taskId = raw.taskId === undefined ? undefined : validatePositiveInteger(raw.taskId, 'RunRequest.taskId')

  if (!isPlainObject(raw.operation)) throw new InvalidRunRequestError('RunRequest.operation muss ein Objekt sein.')
  assertExactKeys(raw.operation, OPERATION_ALLOWED_KEYS, 'RunRequest.operation')

  const rawOperationId = raw.operation.id
  if (typeof rawOperationId !== 'string' || !(OPERATION_IDS as readonly string[]).includes(rawOperationId)) {
    throw new InvalidRunRequestError('RunRequest.operation.id ist unbekannt.')
  }
  const operationId = rawOperationId as OperationId
  const definition = getOperationDefinition(operationId)
  if (!definition) throw new InvalidRunRequestError('RunRequest.operation.id ist unbekannt.')
  // Normalized to one error type at this outer boundary - callers of
  // validateRunRequest() must not need to know which internal validator
  // (here vs. a trusted operation definition) rejected the raw input.
  let validatedInput: unknown
  try {
    validatedInput = definition.validateInput(raw.operation.input)
  } catch (error) {
    if (error instanceof InvalidOperationInputError) {
      throw new InvalidRunRequestError('RunRequest.operation.input ist ungueltig.')
    }
    throw error
  }

  const operation: RunRequest['operation'] =
    operationId === 'repository.getDiagnostics'
      ? { id: 'repository.getDiagnostics', input: validatedInput as Record<string, never> }
      : { id: 'project.readTextFiles', input: validatedInput as ProjectTextReadRequest }

  return {
    projectId,
    ...(taskId === undefined ? {} : { taskId }),
    operation
  }
}

/**
 * NARROW trusted Main-owned input - only what Main genuinely cannot derive
 * itself. Deliberately excludes projectId/isArchived/supportedCapabilities:
 * those come exclusively from the resolved DB project and the fixed
 * runtime capability set (see buildCapabilityPolicyContext below), never
 * from a caller-supplied duplicate that could disagree with reality (e.g. a
 * caller claiming isArchived=false for a project the DB says is archived).
 * Still not authorization by itself and never sourced from RunRequest,
 * agent output, the renderer, a Task, a Work Request, or repository content.
 */
export interface RunPolicySnapshot {
  policy: Partial<Record<CapabilityId, CapabilityPolicyMode>>
  ruleDeniedCapabilities: CapabilityId[]
}

const RUN_POLICY_SNAPSHOT_ALLOWED_KEYS = ['policy', 'ruleDeniedCapabilities'] as const

/** Fail-closed, exact shape - reuses the M4.5 field-level validators verbatim. */
export function validateRunPolicySnapshot(raw: unknown): RunPolicySnapshot {
  if (!isPlainObject(raw)) throw new InvalidRunRequestError('RunPolicySnapshot muss ein Objekt sein.')
  assertExactKeys(raw, RUN_POLICY_SNAPSHOT_ALLOWED_KEYS, 'RunPolicySnapshot')

  let policy: Partial<Record<CapabilityId, CapabilityPolicyMode>>
  let ruleDeniedCapabilities: CapabilityId[]
  try {
    policy = validatePolicyMap(raw.policy)
    ruleDeniedCapabilities = validateCapabilityIdList(raw.ruleDeniedCapabilities, 'RunPolicySnapshot.ruleDeniedCapabilities')
  } catch (error) {
    throw new InvalidRunRequestError(error instanceof Error ? error.message : String(error))
  }

  return { policy, ruleDeniedCapabilities }
}

export class InvalidRunTrustedScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRunTrustedScopeError'
  }
}

/**
 * Main-eigene, vertrauenswuerdige Lesebereich-Autoritaet fuer
 * project.readTextFiles - NIEMALS Teil von RunRequest, niemals vom
 * Renderer/einem Task/dem Modell geliefert (siehe Datei-Kommentar oben).
 * `null` ist der einzig gueltige Wert fuer jede Operation, die keinen
 * Lesebereich braucht (aktuell repository.getDiagnostics). Enthaelt
 * bewusst KEIN root/policy/capability/provider/model/agent-Feld und kann
 * sich nie ueber die eigene, explizite Liste hinaus erweitern.
 */
export type RunTrustedScope =
  | {
      operationId: 'project.readTextFiles'
      allowedRelativePaths: string[]
    }
  | null

const RUN_TRUSTED_SCOPE_ALLOWED_KEYS = ['operationId', 'allowedRelativePaths'] as const

export function validateRunTrustedScope(raw: unknown, requestedOperationId: OperationId): RunTrustedScope {
  if (raw === null || raw === undefined) return null
  if (!isPlainObject(raw)) throw new InvalidRunTrustedScopeError('RunTrustedScope muss ein Objekt oder null sein.')
  // assertExactKeys() throws InvalidRunRequestError (its one shared error type across this file) -
  // normalize to InvalidRunTrustedScopeError so every rejection from this function has the same type.
  try {
    assertExactKeys(raw, RUN_TRUSTED_SCOPE_ALLOWED_KEYS, 'RunTrustedScope')
  } catch (error) {
    throw new InvalidRunTrustedScopeError(error instanceof Error ? error.message : String(error))
  }

  if (requestedOperationId !== 'project.readTextFiles' || raw.operationId !== 'project.readTextFiles') {
    throw new InvalidRunTrustedScopeError('RunTrustedScope.operationId stimmt nicht mit der angeforderten Operation ueberein.')
  }
  if (!Array.isArray(raw.allowedRelativePaths)) {
    throw new InvalidRunTrustedScopeError('RunTrustedScope.allowedRelativePaths muss eine Liste sein.')
  }

  let allowedRelativePaths: string[]
  try {
    allowedRelativePaths = raw.allowedRelativePaths.map((entry) => validateSourceAccessPath(entry))
    assertNoCaseInsensitiveDuplicatePaths(allowedRelativePaths, 'RunTrustedScope.allowedRelativePaths')
  } catch (error) {
    throw new InvalidRunTrustedScopeError(error instanceof Error ? error.message : String(error))
  }

  // Defensive copy - a later mutation of the caller's original array must
  // not retroactively change an already-validated scope.
  return { operationId: 'project.readTextFiles', allowedRelativePaths: [...allowedRelativePaths] }
}

// Der einzige Satz an Capabilities, den die aktuelle Laufzeitumgebung
// ueberhaupt unterstuetzt - niemals vom Aufrufer uebernommen, niemals aus
// Agent-Eingabe abgeleitet. "Technisch unterstuetzt" ist etwas anderes als
// "per Policy erlaubt" (siehe resolveCapabilityRequest: UNSUPPORTED schlaegt
// selbst ein ALLOW).
const RUNTIME_SUPPORTED_CAPABILITIES: readonly CapabilityId[] = ['git.read', 'filesystem.read']

function buildCapabilityPolicyContext(project: Project, snapshot: RunPolicySnapshot): CapabilityPolicyContext {
  return validateCapabilityPolicyContext({
    projectId: project.id,
    isArchived: project.isArchived,
    supportedCapabilities: [...RUNTIME_SUPPORTED_CAPABILITIES],
    policy: snapshot.policy,
    ruleDeniedCapabilities: snapshot.ruleDeniedCapabilities
  })
}

interface RunClock {
  now(): Date
}

const SYSTEM_CLOCK: RunClock = { now: () => new Date() }

function envelope(runId: string, request: RunRequest, startedAt: string, finishedAt: string, evaluations: CapabilityEvaluation[]) {
  return {
    runId,
    projectId: request.projectId,
    ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    startedAt,
    finishedAt,
    capabilityEvaluations: evaluations
  }
}

/**
 * Fuehrt genau eine Operation innerhalb eines Projekts aus. `rawRequest` ist
 * unvertrauenswuerdig (siehe shared/runTypes.ts). `rawPolicySnapshot` und
 * `rawTrustedScope` sind SEPARATE, vertrauenswuerdige Main-eigene Argumente
 * (siehe RunPolicySnapshot/RunTrustedScope oben) - TypeScript macht sie
 * nicht vertrauenswuerdig, das ist ausschliesslich Aufgabe des Aufrufers. Es
 * gibt in M4.7B.1 keinen Renderer-/Agent-Aufrufer - nur interner
 * Main-Code/Tests. Die vollstaendige CapabilityPolicyContext (inkl.
 * projectId/isArchived/supportedCapabilities) wird ERST NACH
 * Projektaufloesung intern konstruiert (siehe buildCapabilityPolicyContext)
 * - der Aufrufer kann diese Felder nicht liefern oder ueberschreiben.
 */
export async function runOperation(
  db: Database.Database,
  rawRequest: unknown,
  rawPolicySnapshot: unknown,
  rawTrustedScope: unknown = null,
  clock: RunClock = SYSTEM_CLOCK
): Promise<RunOutcome> {
  const request = validateRunRequest(rawRequest)
  const definition = getOperationDefinition(request.operation.id)
  if (!definition) throw new InvalidRunRequestError('RunRequest.operation.id ist unbekannt.')
  const policySnapshot = validateRunPolicySnapshot(rawPolicySnapshot)

  // Trusted-scope validation/authorization happens BEFORE any DB access or
  // capability evaluation - a missing/invalid scope or an out-of-scope
  // requested path must fail closed before the operation handler could ever
  // run (see M4.7B.1-Vorgabe Teil K: "fail CLOSED before handler").
  const trustedScope = validateRunTrustedScope(rawTrustedScope, request.operation.id)
  if (request.operation.id === 'project.readTextFiles') {
    if (trustedScope === null) {
      throw new InvalidRunTrustedScopeError('project.readTextFiles erfordert einen vertrauenswuerdigen Lesebereich.')
    }
    const allowedLookup = new Set(trustedScope.allowedRelativePaths.map((entry) => entry.toLowerCase()))
    const notAllowed = request.operation.input.relativePaths.find((requested) => !allowedLookup.has(requested.toLowerCase()))
    if (notAllowed !== undefined) {
      throw new InvalidRunTrustedScopeError('Ein angeforderter Pfad liegt ausserhalb des vertrauenswuerdigen Lesebereichs.')
    }
  }

  const runId = randomUUID()
  const startedAtDate = clock.now()
  const startedAt = startedAtDate.toISOString()
  // Zwei Wanduhr-Messungen koennten durch eine Systemzeit-Korrektur
  // scheinbar rueckwaerts laufen - finishedAt wird nie fruener als
  // startedAt zurueckgegeben.
  const finish = (): string => {
    const now = clock.now()
    return now.getTime() < startedAtDate.getTime() ? startedAt : now.toISOString()
  }
  const fail = (failureCode: RunFailureCode, evaluations: CapabilityEvaluation[] = []): RunOutcome => ({
    ...envelope(runId, request, startedAt, finish(), evaluations),
    operationId: request.operation.id,
    status: 'FAILED',
    failureCode
  })

  let project
  try {
    project = getProjectById(db, request.projectId)
  } catch (error) {
    if (error instanceof ProjectNotFoundError) return fail('PROJECT_NOT_FOUND')
    throw error
  }

  if (request.taskId !== undefined) {
    try {
      getTaskForProject(db, request.projectId, request.taskId)
    } catch (error) {
      if (error instanceof TaskNotFoundError || error instanceof TaskMismatchError) {
        return fail('TASK_NOT_FOUND_OR_MISMATCH')
      }
      throw error
    }
  }

  const policyContext = buildCapabilityPolicyContext(project, policySnapshot)
  const capabilityRequest = validateCapabilityRequest({
    projectId: request.projectId,
    capabilities: [...definition.requiredCapabilities]
  })
  const evaluations = resolveCapabilityRequest(capabilityRequest, policyContext)

  // Jede erforderliche Capability MUSS eine eigene ALLOW-Bewertung haben -
  // niemals nur `evaluations.every(...)` auf einer moeglicherweise leeren
  // Liste pruefen, sonst wuerde eine leere Bewertungsliste faelschlich als
  // "alles erlaubt" durchgehen.
  const missingOrBlocked = definition.requiredCapabilities.find(
    (capability) => !evaluations.some((evaluation) => evaluation.capability === capability && evaluation.decision === 'ALLOW')
  )
  if (missingOrBlocked !== undefined || definition.requiredCapabilities.length === 0) {
    const blockingEvaluation = evaluations.find((evaluation) => evaluation.capability === missingOrBlocked)
    return {
      ...envelope(runId, request, startedAt, finish(), evaluations),
      operationId: request.operation.id,
      status: 'BLOCKED',
      blockedReason: blockingEvaluation?.reason ?? 'POLICY_UNSET'
    }
  }

  // Operation-spezifische, staerkere Einschraenkung ueber das grobe
  // Capability-Gate hinaus (siehe M4.7B.1-Vorgabe "ARCHIVED PROJECT
  // DECISION"): filesystem.read auf einem archivierten Projekt ist per M4.5
  // technisch weiterhin erlaubbar, project.readTextFiles (Quell-Offenlegungs-
  // Vorbereitung) lehnt ein archiviertes Projekt in V1 dennoch explizit ab.
  // Das ist eine operation-spezifische Einschraenkung, KEINE Aenderung an
  // der generischen M4.5-Archiv-Semantik (siehe capabilityPolicy.ts, dort
  // unveraendert).
  if (request.operation.id === 'project.readTextFiles' && project.isArchived) {
    return {
      ...envelope(runId, request, startedAt, finish(), evaluations),
      operationId: request.operation.id,
      status: 'BLOCKED',
      blockedReason: 'PROJECT_ARCHIVED'
    }
  }

  const projectFolderPathBefore = project.folderPath
  let result: unknown
  try {
    result = await definition.execute(projectFolderPathBefore, request.operation.input)
  } catch (error) {
    return fail(error instanceof OperationExecutionError ? error.failureCode : 'OPERATION_FAILED', evaluations)
  }

  // Die gespeicherte Projekt-Ordner-Zuordnung ist mutable - eine Aenderung
  // waehrend der laufenden Operation verwirft das Ergebnis, statt ein
  // moeglicherweise falsch zugeordnetes Ergebnis zurueckzugeben.
  let projectAfter
  try {
    projectAfter = getProjectById(db, request.projectId)
  } catch (error) {
    if (error instanceof ProjectNotFoundError) return fail('PROJECT_CHANGED', evaluations)
    throw error
  }
  if (projectAfter.folderPath !== projectFolderPathBefore) {
    return fail('PROJECT_CHANGED', evaluations)
  }
  // project.readTextFiles returns source content (see M4.7B.1-Vorgabe Teil M
  // "SENSITIVE RUN RESULT") - if the project's archive state changed WHILE
  // the read was in flight (e.g. archived mid-operation), the already-
  // computed sensitive result must never be returned, even though the
  // folder path itself did not change (see self-review: "archive state
  // changes -> no sensitive result returned").
  if (request.operation.id === 'project.readTextFiles' && projectAfter.isArchived !== project.isArchived) {
    return fail('PROJECT_CHANGED', evaluations)
  }

  const base = envelope(runId, request, startedAt, finish(), evaluations)
  // Der Handler ist vertrauenswuerdig (siehe runOperations.ts) und liefert
  // fuer die angefragte Operation garantiert die dazu passende Ergebnisform.
  if (request.operation.id === 'repository.getDiagnostics') {
    return { ...base, operationId: 'repository.getDiagnostics', status: 'SUCCEEDED', result: result as RepositoryDiagnosticsSummary }
  }
  return { ...base, operationId: 'project.readTextFiles', status: 'SUCCEEDED', result: result as ProjectTextFileResult[] }
}
