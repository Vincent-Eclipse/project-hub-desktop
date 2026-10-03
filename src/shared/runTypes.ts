import type { CapabilityEvaluation, CapabilityEvaluationReason } from './permissionTypes'
import type { ProjectTextFileResult, ProjectTextReadRequest } from './projectTextReadTypes'

// Meilenstein 4.6 - Run/Execution-Engine-Grundlage. Erste echte
// Ausfuehrungsgrenze: intern, read-only, sehr klein.
//
// Ein Run ist EIN begrenzter, Main-kontrollierter Versuch EINER Operation
// innerhalb EINES Projekts. Ein Run ist KEINE Agent-Sitzung, KEIN
// vollstaendiger Work Request, KEIN abgeschlossener Task, KEIN Chat, KEINE
// Freigabe und KEIN wiederverwendbares Autorisierungs-Artefakt. Ein
// erfolgreicher Run bedeutet, dass GENAU DIESE EINE Operation erfolgreich
// war - er bedeutet NICHT, dass ein Task DONE ist. Ein Retry ist ein NEUER
// Run mit einer neuen runId.
//
// AGENT/REQUEST WAEHLT NIEMALS DIE ERFORDERLICHEN CAPABILITIES - das legt
// ausschliesslich die vertrauenswuerdige Operation-Definition fest (siehe
// runOperations.ts). Ein Request, der `git.read` gar nicht erwaehnt,
// umgeht dadurch NICHTS - repository.getDiagnostics verlangt es trotzdem.

export const OPERATION_IDS = ['repository.getDiagnostics', 'project.readTextFiles'] as const
export type OperationId = (typeof OPERATION_IDS)[number]

/**
 * Rohe, unvalidierte Run-Anfrage. Enthaelt AUSSCHLIESSLICH: Projekt-
 * Identitaet, optionale Task-Zuordnung, Operation-ID, operation-spezifische
 * (untrusted) Eingabe. Kein Feld hier kann jemals vertrauenswuerdigen
 * Ausfuehrungskontext herstellen - insbesondere NICHT: requiredCapabilities,
 * capabilities, policy, supportedCapabilities, ruleDeniedCapabilities,
 * approved/approval, permissions, projectRoot/repositoryRoot/folder,
 * handler/executable/arguments/command, provider/model/agent/autonomy,
 * allowedRelativePaths (das ist NIEMALS Autorisierung - siehe
 * runService.ts's RunTrustedScope, ein separates, Main-eigenes Argument).
 *
 * Operation-spezifische Vereinigung statt eines generischen `input:
 * Record<string, never>` - jede Operation bekommt ihre eigene, echt
 * validierte Eingabeform (siehe M4.7B.1-Vorgabe Teil J: "Run parsing must
 * reconstruct validated operation-specific inputs. Never pass arbitrary
 * unknown input through").
 */
export interface RunRequest {
  projectId: number
  taskId?: number
  operation:
    | {
        id: 'repository.getDiagnostics'
        // Diese Operation hat keine sinnvolle Nutzereingabe - ein exaktes
        // leeres Objekt ist Pflicht, kein optionales Feld.
        input: Record<string, never>
      }
    | {
        id: 'project.readTextFiles'
        input: ProjectTextReadRequest
      }
}

export const RUN_STATUSES = ['SUCCEEDED', 'FAILED', 'BLOCKED'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

// Absichtlich KEIN RUNNING/PENDING/CANCELLED/PAUSED - es gibt weder ein
// persistentes Run-Protokoll noch eine Warteschlange, Beobachtung,
// Hintergrund-UI oder Abbruch-API. Der Aufrufer erhaelt ausschliesslich das
// Endergebnis eines bereits abgeschlossenen Versuchs.

export const RUN_FAILURE_CODES = [
  'PROJECT_NOT_FOUND',
  'TASK_NOT_FOUND_OR_MISMATCH',
  'PROJECT_CHANGED',
  'BUSY',
  'TIMEOUT',
  'OUTPUT_LIMIT',
  'OPERATION_FAILED'
] as const
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number]

/**
 * Reduzierte, sichere Zusammenfassung fuer repository.getDiagnostics -
 * NIEMALS rohe Pfade, Branch-Namen, Dateinamen, Diff-Text oder Git-
 * Stdout/Stderr. Wenn kein Repository erkannt wurde, ist das eine
 * erfolgreiche Beobachtung (repositoryDetected: false), kein Engine-Fehler.
 */
export interface RepositoryDiagnosticsSummary {
  repositoryDetected: boolean
  clean: boolean | null
  counts: {
    staged: number
    unstaged: number
    untracked: number
    conflicts: number
  } | null
}

interface RunEnvelope {
  runId: string
  projectId: number
  taskId?: number
  operationId: OperationId
  startedAt: string
  finishedAt: string
  // Vertrauenswuerdige Ausfuehrungshuelle, keine wiederverwendbare
  // Autorisierung - siehe capabilityPolicy.ts (CapabilityEvaluation ist ein
  // Snapshot, kein Grant/Token).
  capabilityEvaluations: CapabilityEvaluation[]
}

// Operation-spezifische Vereinigung statt eines einzelnen, generischen
// `result`-Felds - jede Operation liefert ihre eigene, tatsaechlich
// getypte Ergebnisform zurueck (siehe M4.7B.1-Vorgabe Teil J). Wichtig fuer
// project.readTextFiles: das Ergebnis enthaelt Quelltextinhalt - siehe
// Vorgabe Teil M ("Sensitive Run Result") - dieser Typ macht KEINE Aussage
// darueber, wo das Ergebnis landen darf; das entscheidet ausschliesslich
// der Main-eigene Aufrufer (siehe runService.ts, keine Persistenz/kein
// eventLog/kein IPC fuer dieses Ergebnis in M4.7B.1).
export type RunSucceeded =
  | (Omit<RunEnvelope, 'operationId'> & {
      status: 'SUCCEEDED'
      operationId: 'repository.getDiagnostics'
      result: RepositoryDiagnosticsSummary
    })
  | (Omit<RunEnvelope, 'operationId'> & {
      status: 'SUCCEEDED'
      operationId: 'project.readTextFiles'
      result: ProjectTextFileResult[]
    })

export interface RunBlocked extends RunEnvelope {
  status: 'BLOCKED'
  blockedReason: CapabilityEvaluationReason
}

export interface RunFailed extends RunEnvelope {
  status: 'FAILED'
  failureCode: RunFailureCode
}

export type RunOutcome = RunSucceeded | RunBlocked | RunFailed
