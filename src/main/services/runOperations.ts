import type { CapabilityId } from '@shared/permissionTypes'
import type { OperationId, RepositoryDiagnosticsSummary, RunFailureCode } from '@shared/runTypes'
import { GitError } from './gitErrors'
import { getDiagnostics } from './gitService'
import type { RepositoryDiagnostics } from '@shared/types'
import { PROJECT_TEXT_READ_MAX_FILES, type ProjectTextReadRequest } from '@shared/projectTextReadTypes'
import { ProjectTextReadError, readProjectTextFiles } from './projectTextReadService'
import { assertNoCaseInsensitiveDuplicatePaths, InvalidSourceAccessPathError, validateSourceAccessPath } from './sourceAccessPath'

// Meilenstein 4.6 (erweitert in 4.7B.1) - vertrauenswuerdige Operation-
// Definitionen. Jede Definition legt ihre erforderlichen Capabilities SELBST
// fest - ein Run Request kann das niemals beeinflussen (siehe runService.ts).
// Lookup ueber eine echte Map statt eines Plain-Objects - `Map.get('__proto__')`
// oder `Map.get('constructor')` sind bei einer Map immer sichere, normale
// Schluessel-Vergleiche, unabhaengig von der JS-Prototypkette.

export class InvalidOperationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidOperationInputError'
  }
}

export class OperationExecutionError extends Error {
  constructor(public readonly failureCode: RunFailureCode) {
    super(`Operation-Ausfuehrung fehlgeschlagen: ${failureCode}`)
    this.name = 'OperationExecutionError'
  }
}

/**
 * `validateInput` liefert die validierte, operation-spezifisch getypte
 * Eingabe zurueck (nicht `void`) - runService.ts uebernimmt dieses Ergebnis
 * unveraendert in RunRequest.operation.input und reicht es unveraendert an
 * `execute` weiter. Es wird NIE erneut aus dem rohen Request abgeleitet
 * (siehe M4.7B.1-Vorgabe Teil J: "Never pass arbitrary unknown input through").
 */
export interface OperationDefinition {
  readonly id: OperationId
  readonly requiredCapabilities: readonly CapabilityId[]
  validateInput(raw: unknown): unknown
  execute(projectFolderPath: string | null, input: unknown): Promise<unknown>
}

// `typeof x === 'object' && !Array.isArray(x)` alone still accepts
// Date/Map/class instances with zero own enumerable keys - a real
// prototype check is required for a genuine "exact empty object".
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function validateEmptyInput(raw: unknown): Record<string, never> {
  if (!isPlainObject(raw) || Object.keys(raw).length > 0) {
    throw new InvalidOperationInputError('repository.getDiagnostics erwartet ein exaktes leeres Eingabeobjekt.')
  }
  return {}
}

/**
 * Reduziert die vollstaendigen Git-Diagnosedaten auf eine sichere,
 * inhaltsfreie Zusammenfassung - niemals Pfade, Branch-Namen, Dateinamen
 * oder sonstigen Repository-Text. Kein Repository ist eine erfolgreiche
 * Beobachtung, kein Fehler.
 */
function summarizeDiagnostics(diagnostics: RepositoryDiagnostics): RepositoryDiagnosticsSummary {
  if (!diagnostics.detected) {
    return { repositoryDetected: false, clean: null, counts: null }
  }
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicts = 0
  for (const file of diagnostics.files) {
    if (file.kind === 'untracked') {
      untracked++
      continue
    }
    if (file.kind === 'conflicted') {
      conflicts++
      continue
    }
    if (file.index !== ' ') staged++
    if (file.worktree !== ' ') unstaged++
  }
  return { repositoryDetected: true, clean: diagnostics.state === 'clean', counts: { staged, unstaged, untracked, conflicts } }
}

function mapGitError(error: GitError): RunFailureCode {
  if (error.code === 'GIT_BUSY') return 'BUSY'
  if (error.code === 'GIT_TIMEOUT') return 'TIMEOUT'
  if (error.code === 'GIT_OUTPUT_LIMIT') return 'OUTPUT_LIMIT'
  return 'OPERATION_FAILED'
}

const PROJECT_TEXT_READ_REQUEST_ALLOWED_KEYS = ['relativePaths'] as const

/**
 * Exakte Form - `relativePaths` ist die ROHE, unvertrauenswuerdige
 * Anfrageliste, NIEMALS eine Autorisierung (siehe runService.ts's
 * RunTrustedScope-Abgleich, der NACH dieser Validierung erfolgt). Jeder
 * einzelne Pfad wird bereits hier syntaktisch/kategorisch geprueft (Teil
 * C/D der Vorgabe) - eine unsichere Anfrage wird nie bis zum Main-eigenen
 * Scope-Abgleich durchgereicht.
 */
function validateProjectTextReadRequest(raw: unknown): ProjectTextReadRequest {
  if (!isPlainObject(raw)) {
    throw new InvalidOperationInputError('project.readTextFiles erwartet ein Objekt.')
  }
  const extra = Object.keys(raw).filter((key) => !(PROJECT_TEXT_READ_REQUEST_ALLOWED_KEYS as readonly string[]).includes(key))
  if (extra.length > 0) {
    throw new InvalidOperationInputError(
      `project.readTextFiles.input enthaelt unbekannte(s) Feld(er): ${extra.join(', ')}. Erlaubt ist ausschliesslich: relativePaths.`
    )
  }
  if (!Array.isArray(raw.relativePaths)) {
    throw new InvalidOperationInputError('project.readTextFiles.input.relativePaths muss eine Liste sein.')
  }
  if (raw.relativePaths.length === 0) {
    throw new InvalidOperationInputError('project.readTextFiles.input.relativePaths darf nicht leer sein.')
  }
  if (raw.relativePaths.length > PROJECT_TEXT_READ_MAX_FILES) {
    throw new InvalidOperationInputError(
      `project.readTextFiles.input.relativePaths enthaelt zu viele Eintraege (max. ${PROJECT_TEXT_READ_MAX_FILES}).`
    )
  }
  const relativePaths = raw.relativePaths.map((entry) => {
    try {
      return validateSourceAccessPath(entry)
    } catch (error) {
      throw new InvalidOperationInputError(
        error instanceof InvalidSourceAccessPathError ? error.message : 'project.readTextFiles.input.relativePaths enthaelt einen ungueltigen Pfad.'
      )
    }
  })
  // Zwei unterschiedlich geschriebene Eintraege koennten auf Windows dieselbe
  // Datei doppelt referenzieren (z. B. "src/a.ts" und "SRC/A.ts") - das wird
  // hier abgelehnt, NIE stillschweigend zusammengefuehrt/normalisiert.
  try {
    assertNoCaseInsensitiveDuplicatePaths(relativePaths, 'project.readTextFiles.input.relativePaths')
  } catch (error) {
    throw new InvalidOperationInputError(error instanceof Error ? error.message : String(error))
  }
  return { relativePaths }
}

function mapProjectTextReadError(error: ProjectTextReadError): RunFailureCode {
  if (error.code === 'LIMIT_EXCEEDED') return 'OUTPUT_LIMIT'
  return 'OPERATION_FAILED'
}

const OPERATIONS: ReadonlyMap<OperationId, OperationDefinition> = new Map([
  [
    'repository.getDiagnostics',
    {
      id: 'repository.getDiagnostics',
      requiredCapabilities: ['git.read'],
      validateInput: validateEmptyInput,
      async execute(projectFolderPath: string | null): Promise<RepositoryDiagnosticsSummary> {
        try {
          return summarizeDiagnostics(await getDiagnostics(projectFolderPath))
        } catch (error) {
          throw new OperationExecutionError(error instanceof GitError ? mapGitError(error) : 'OPERATION_FAILED')
        }
      }
    } satisfies OperationDefinition
  ],
  [
    'project.readTextFiles',
    {
      id: 'project.readTextFiles',
      requiredCapabilities: ['filesystem.read'],
      validateInput: validateProjectTextReadRequest,
      async execute(projectFolderPath: string | null, input: unknown) {
        const { relativePaths } = input as ProjectTextReadRequest
        try {
          return await readProjectTextFiles(projectFolderPath, relativePaths)
        } catch (error) {
          throw new OperationExecutionError(error instanceof ProjectTextReadError ? mapProjectTextReadError(error) : 'OPERATION_FAILED')
        }
      }
    } satisfies OperationDefinition
  ]
])

/** `undefined` fuer jede unbekannte ID - inklusive `constructor`/`__proto__`, die bei einer Map niemals besonders behandelt werden. */
export function getOperationDefinition(id: unknown): OperationDefinition | undefined {
  if (typeof id !== 'string') return undefined
  return OPERATIONS.get(id as OperationId)
}
