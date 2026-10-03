import {
  CAPABILITY_IDS,
  CAPABILITY_POLICY_MODES,
  type CapabilityEvaluation,
  type CapabilityId,
  type CapabilityPolicyContext,
  type CapabilityPolicyMode,
  type CapabilityRequest
} from '@shared/permissionTypes'

// Meilenstein 4.5 - Capabilities/Permissions-Vertragsschicht. Reiner
// Code-Ebene Gate: KEINE Datenbank/Filesystem/Git-Zugriffe, KEINE Uhr, KEINE
// Umgebungsvariablen, KEIN globaler Zustand, KEINE Ausfuehrung. Ein
// ALLOW-Ergebnis ist keine vollstaendige Operations-Autorisierung (siehe
// shared/permissionTypes.ts).

export class InvalidCapabilityInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCapabilityInputError'
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
    throw new InvalidCapabilityInputError(
      `${contextLabel} enthaelt unbekannte(s) Feld(er): ${extra.join(', ')}. Erlaubt sind ausschliesslich: ${allowedKeys.join(', ')}.`
    )
  }
}

function validatePositiveIntegerProjectId(raw: unknown, contextLabel: string): number {
  if (!Number.isInteger(raw) || (raw as number) <= 0) {
    throw new InvalidCapabilityInputError(`${contextLabel}.projectId muss eine positive Ganzzahl sein.`)
  }
  return raw as number
}

const CAPABILITY_ID_SET: ReadonlySet<string> = new Set(CAPABILITY_IDS)

/** Exported so runService.ts (RunPolicySnapshot) reuses this exact validation instead of duplicating it. */
export function validateCapabilityIdList(raw: unknown, fieldLabel: string): CapabilityId[] {
  if (!Array.isArray(raw)) {
    throw new InvalidCapabilityInputError(`${fieldLabel} muss eine Liste sein.`)
  }
  for (const entry of raw) {
    if (typeof entry !== 'string' || !CAPABILITY_ID_SET.has(entry)) {
      throw new InvalidCapabilityInputError(`${fieldLabel} enthaelt eine unbekannte Capability: ${String(entry)}.`)
    }
  }
  const list = raw as CapabilityId[]
  if (new Set(list).size !== list.length) {
    throw new InvalidCapabilityInputError(`${fieldLabel} enthaelt doppelte Eintraege.`)
  }
  // Snapshot, not the caller-owned array - a later mutation of the original
  // must not retroactively change an already-validated result.
  return [...list]
}

const CAPABILITY_REQUEST_ALLOWED_KEYS = ['projectId', 'capabilities'] as const

/**
 * Fail-closed: unbekannte Felder (z. B. approved/permissions/
 * supportedCapabilities/autonomy/agentId/provider/projectRoot) werden
 * abgelehnt statt stillschweigend ignoriert - dieser Vertrag darf niemals
 * versehentlich zu einem Autoritaets-/Konfigurationskanal werden.
 */
export function validateCapabilityRequest(raw: unknown): CapabilityRequest {
  if (!isPlainObject(raw)) throw new InvalidCapabilityInputError('CapabilityRequest muss ein Objekt sein.')
  assertExactKeys(raw, CAPABILITY_REQUEST_ALLOWED_KEYS, 'CapabilityRequest')

  const projectId = validatePositiveIntegerProjectId(raw.projectId, 'CapabilityRequest')
  const capabilities = validateCapabilityIdList(raw.capabilities, 'CapabilityRequest.capabilities')

  return { projectId, capabilities }
}

const CAPABILITY_POLICY_CONTEXT_ALLOWED_KEYS = [
  'projectId',
  'isArchived',
  'supportedCapabilities',
  'policy',
  'ruleDeniedCapabilities'
] as const

const CAPABILITY_POLICY_MODE_SET: ReadonlySet<string> = new Set(CAPABILITY_POLICY_MODES)

/** Exported so runService.ts (RunPolicySnapshot) reuses this exact validation instead of duplicating it. */
export function validatePolicyMap(raw: unknown): Partial<Record<CapabilityId, CapabilityPolicyMode>> {
  if (!isPlainObject(raw)) {
    throw new InvalidCapabilityInputError('CapabilityPolicyContext.policy muss ein einfaches Objekt sein (keine Liste/Klasse).')
  }
  const policy: Partial<Record<CapabilityId, CapabilityPolicyMode>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!CAPABILITY_ID_SET.has(key)) {
      throw new InvalidCapabilityInputError(`CapabilityPolicyContext.policy enthaelt einen unbekannten Schluessel: ${key}.`)
    }
    if (typeof value !== 'string' || !CAPABILITY_POLICY_MODE_SET.has(value)) {
      throw new InvalidCapabilityInputError(`CapabilityPolicyContext.policy["${key}"] ist kein gueltiger CapabilityPolicyMode.`)
    }
    policy[key as CapabilityId] = value as CapabilityPolicyMode
  }
  return policy
}

/**
 * Fail-closed, analog validateCapabilityRequest. Alle fuenf Felder sind
 * PFLICHT - ein fehlender Policy-EINTRAG (innerhalb von `policy`) ist
 * weiterhin erlaubt und bedeutet DENY, aber das `policy`-FELD selbst muss
 * vorhanden sein.
 */
export function validateCapabilityPolicyContext(raw: unknown): CapabilityPolicyContext {
  if (!isPlainObject(raw)) throw new InvalidCapabilityInputError('CapabilityPolicyContext muss ein Objekt sein.')
  assertExactKeys(raw, CAPABILITY_POLICY_CONTEXT_ALLOWED_KEYS, 'CapabilityPolicyContext')

  const projectId = validatePositiveIntegerProjectId(raw.projectId, 'CapabilityPolicyContext')
  if (typeof raw.isArchived !== 'boolean') {
    throw new InvalidCapabilityInputError('CapabilityPolicyContext.isArchived muss ein Boolean sein.')
  }
  const supportedCapabilities = validateCapabilityIdList(raw.supportedCapabilities, 'CapabilityPolicyContext.supportedCapabilities')
  const ruleDeniedCapabilities = validateCapabilityIdList(raw.ruleDeniedCapabilities, 'CapabilityPolicyContext.ruleDeniedCapabilities')
  const policy = validatePolicyMap(raw.policy)

  return { projectId, isArchived: raw.isArchived, supportedCapabilities, policy, ruleDeniedCapabilities }
}

// Fuer archivierte Projekte muessen grobe Mutations-/Ausfuehrungs-
// Capabilities ablehnen - Policy kann das nicht ueberschreiben. Lese-
// Capabilities (filesystem.read/git.read) duerfen weiterhin normal der
// Policy folgen (bestehende, archivierte Nur-Lese-Inspektion bleibt
// erhalten).
const ARCHIVE_RESTRICTED_CAPABILITIES: ReadonlySet<CapabilityId> = new Set(['filesystem.write', 'git.write', 'command.execute'])

/**
 * Reiner Resolver - keine Datenbank/Filesystem/Git/Uhr/Umgebung/globaler
 * Zustand, keine Prompt-/Agent-/Projekt-Inspektion, keine Freigabe-
 * Persistenz, keine Seiteneffekte. Mutiert weder `request` noch `context`.
 *
 * Feste, deterministische Praezedenz je angefragter Capability (hoehere
 * Stufe kann von keiner niedrigeren Stufe uebersteuert werden):
 *   1. PROJECT_MISMATCH
 *   2. UNSUPPORTED
 *   3. PROJECT_ARCHIVED (nur filesystem.write/git.write/command.execute)
 *   4. RULE_RESTRICTION
 *   5. explizite Policy: DENY->POLICY_DENIED, REQUIRES_APPROVAL->
 *      APPROVAL_REQUIRED, ALLOW->POLICY_ALLOWED
 *   6. fehlender Policy-Eintrag -> POLICY_UNSET / DENY
 *
 * Ausgabe immer in kanonischer CAPABILITY_IDS-Reihenfolge, unabhaengig von
 * der Reihenfolge in `request.capabilities`. Eine leere Anfrage liefert []
 * - das beweist NICHT, dass eine zukuenftige Operation keine Berechtigungen
 * braucht (siehe shared/permissionTypes.ts: CapabilityRequest).
 */
export function resolveCapabilityRequest(request: CapabilityRequest, context: CapabilityPolicyContext): CapabilityEvaluation[] {
  const requested = new Set(request.capabilities)
  const supported = new Set(context.supportedCapabilities)
  const ruleDenied = new Set(context.ruleDeniedCapabilities)
  const projectMatches = request.projectId === context.projectId

  return CAPABILITY_IDS.filter((capability) => requested.has(capability)).map((capability): CapabilityEvaluation => {
    if (!projectMatches) {
      return { projectId: request.projectId, capability, decision: 'DENY', reason: 'PROJECT_MISMATCH' }
    }
    if (!supported.has(capability)) {
      return { projectId: request.projectId, capability, decision: 'DENY', reason: 'UNSUPPORTED' }
    }
    if (context.isArchived && ARCHIVE_RESTRICTED_CAPABILITIES.has(capability)) {
      return { projectId: request.projectId, capability, decision: 'DENY', reason: 'PROJECT_ARCHIVED' }
    }
    if (ruleDenied.has(capability)) {
      return { projectId: request.projectId, capability, decision: 'DENY', reason: 'RULE_RESTRICTION' }
    }
    const mode = context.policy[capability]
    if (mode === 'DENY') return { projectId: request.projectId, capability, decision: 'DENY', reason: 'POLICY_DENIED' }
    if (mode === 'REQUIRES_APPROVAL') {
      return { projectId: request.projectId, capability, decision: 'REQUIRES_APPROVAL', reason: 'APPROVAL_REQUIRED' }
    }
    if (mode === 'ALLOW') return { projectId: request.projectId, capability, decision: 'ALLOW', reason: 'POLICY_ALLOWED' }
    return { projectId: request.projectId, capability, decision: 'DENY', reason: 'POLICY_UNSET' }
  })
}
