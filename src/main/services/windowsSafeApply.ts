// Meilenstein 4.8B.0 - duennes TypeScript-Handle fuer den nativen Windows-
// "guarded mutation"-Prototyp (native/windows-safe-apply). Dies ist KEINE
// produktive Schreib-Funktion - es gibt bewusst KEINEN Aufrufer in
// src/main/index.ts, registerIpc.ts, preload oder RunOperations. Der einzige
// Zweck dieser Datei ist, den Test-/Akzeptanz-Suiten einen typisierten,
// bequemen Zugriff auf das native Modul zu geben, ohne dass jeder Test die
// rohe .node-Datei selbst laden und das JS<->native-Vertragsformat duplizieren
// muss.
//
// WICHTIG: Es gibt HIER keine eigene Sicherheitslogik - jede Pruefung
// (Pfad-Validierung, Reparse-/Hardlink-Ablehnung, Verzeichnis-Pinning,
// exklusive Handle-Besitznahme) passiert ausschliesslich im nativen Modul
// selbst (native/windows-safe-apply/src/*.cc). Dieser Wrapper fuegt keine
// zusaetzliche Business-Logik hinzu - er ist nur eine typisierte Bruecke.

import path from 'node:path'

export interface WindowsSafeApplySourcePlan {
  path: string
}

export interface WindowsSafeApplyModifyPlan {
  path: string
  expectedSha256Hex: string
  expectedLength: number
  proposedBytes: Buffer
}

export interface WindowsSafeApplyCreatePlan {
  path: string
  proposedBytes: Buffer
}

export interface WindowsSafeApplyPlan {
  root: string
  sources?: WindowsSafeApplySourcePlan[]
  modifies?: WindowsSafeApplyModifyPlan[]
  creates?: WindowsSafeApplyCreatePlan[]
}

export type WindowsSafeApplyResultCode =
  | 'OK'
  | 'INVALID_PLAN'
  | 'UNSUPPORTED_PATH'
  | 'ROOT_INVALID'
  | 'PARENT_INVALID'
  | 'REPARSE_REJECTED'
  | 'HARDLINK_REJECTED'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'BUSY'
  | 'PRECONDITION_FAILED'
  | 'IO_FAILED'
  | 'VERIFY_FAILED'
  | 'FAULT_INJECTED'
  | 'BAD_HANDLE'
  | 'UNSUPPORTED_STORAGE_PROFILE'
  | 'CASE_SENSITIVE_REJECTED'
  | 'INTERNAL_ERROR'

export interface WindowsSafeApplyOutcome {
  code: WindowsSafeApplyResultCode
  sha256Hex: string
  length: number
  nativeFileId128Hex: string
  nativeVolumeSerial: string
}

export interface WindowsSafeApplyPrepareResult {
  lease: unknown
  root: WindowsSafeApplyOutcome
  modifies: WindowsSafeApplyOutcome[]
}

/**
 * Meilenstein 4.8B.2A - Eingabe fuer die schmale, einzweckige CREATE-
 * Recovery-Delete-Primitive. KEINE generische Loeschautoritaet: jedes Feld
 * ist Pflicht, nichts wird aus dem Pfad oder aus Inhalt allein abgeleitet.
 * `expectedRootVolumeSerial`/`expectedVolumeSerial` sind dezimale
 * Ziffernstrings (dieselbe Kodierung wie WindowsSafeApplyOutcome.
 * nativeVolumeSerial - niemals als JS-Number, um stille Praezisionsverluste
 * bei 64-Bit-Werten zu vermeiden). `expectedRootFileId128Hex`/
 * `expectedFileId128Hex` sind exakt 32-stellige Kleinbuchstaben-Hex-Strings
 * (dieselbe Kodierung wie nativeFileId128Hex). Diese Datei enthaelt KEINE
 * eigene Sicherheitslogik - jede Pruefung (Root-/Ziel-Identitaet, Inhalt,
 * Reparse-/Hardlink-Ablehnung) passiert ausschliesslich im nativen Modul
 * selbst (native/windows-safe-apply/src/recovery_delete.cc).
 */
export interface WindowsSafeApplyRecoverDeleteCreatedRequest {
  root: string
  relPath: string
  expectedRootVolumeSerial: string
  expectedRootFileId128Hex: string
  expectedVolumeSerial: string
  expectedFileId128Hex: string
  expectedSha256Hex: string
  expectedLength: number
}

export type WindowsSafeApplyFaultPoint =
  | 'NONE'
  | 'FAIL_BEFORE_FIRST_WRITE'
  | 'SHORT_WRITE'
  | 'FAIL_DURING_WRITE'
  | 'FAIL_BEFORE_FINAL_LENGTH'
  | 'FAIL_BEFORE_FLUSH'
  | 'FAIL_AFTER_FLUSH_BEFORE_VERIFY'
  | 'VERIFY_MISMATCH'
  | 'ROLLBACK_WRITE_FAILURE'
  | 'FORCE_IDENTITY_CAPTURE_FAILURE'
  | 'FORCE_SHA256_FAILURE'

interface NativeAddon {
  platformSupported: boolean
  prepareLease(plan: unknown): WindowsSafeApplyPrepareResult
  applyModify(lease: unknown, index: number): WindowsSafeApplyOutcome
  createFile(lease: unknown, index: number): WindowsSafeApplyOutcome
  verifyFile(lease: unknown, index: number, isCreate: boolean): WindowsSafeApplyOutcome
  rollbackFile(lease: unknown, index: number, isCreate: boolean): WindowsSafeApplyOutcome
  closeLease(lease: unknown): void
  // Present in BOTH build targets (test AND production-shaped) - unlike
  // setFaultPoint/setForceCaseSensitiveForTests below, this is a legitimate
  // recovery primitive, never test-only. See windowsSafeApply.
  // productionShape.windows.test.ts's M4.8B.2A additions.
  recoverDeleteCreated(request: unknown): WindowsSafeApplyOutcome
  // Absent entirely on the production-shaped build (windows_safe_apply_production.node)
  // - see windowsSafeApply.productionShape.windows.test.ts. Only the test-shaped build
  // (windows_safe_apply.node, the default this wrapper loads) exposes these.
  setFaultPoint?(lease: unknown, index: number, isCreate: boolean, faultPoint: WindowsSafeApplyFaultPoint): void
  setForceCaseSensitiveForTests?(force: boolean): void
}

export class WindowsSafeApplyUnavailableError extends Error {
  constructor(reason: string) {
    super(`windows-safe-apply native module unavailable: ${reason}`)
    this.name = 'WindowsSafeApplyUnavailableError'
  }
}

let cachedAddon: NativeAddon | null = null
let cachedLoadError: string | null = null

// Test-only override so a test can point this at a specific rebuilt binary
// path (e.g. after an Electron-ABI rebuild) instead of the default
// build/Release path resolved relative to this file's native/ sibling.
let addonPathOverride: string | null = null
export function __setAddonPathOverrideForTests(overridePath: string | null): void {
  addonPathOverride = overridePath
  cachedAddon = null
  cachedLoadError = null
}

function defaultAddonPath(): string {
  // native/windows-safe-apply/build/Release/windows_safe_apply.node, resolved
  // relative to the repository layout (src/main/services/.. -> src/main ->
  // src -> repo root -> native/...). Never derived from any caller input.
  return path.join(__dirname, '..', '..', '..', 'native', 'windows-safe-apply', 'build', 'Release', 'windows_safe_apply.node')
}

function loadAddon(): NativeAddon {
  if (cachedAddon) return cachedAddon
  if (cachedLoadError) throw new WindowsSafeApplyUnavailableError(cachedLoadError)
  if (process.platform !== 'win32') {
    cachedLoadError = 'not running on win32'
    throw new WindowsSafeApplyUnavailableError(cachedLoadError)
  }
  const addonPath = addonPathOverride ?? defaultAddonPath()
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(addonPath) as NativeAddon
    if (!mod.platformSupported) {
      cachedLoadError = 'native module reports platformSupported=false'
      throw new WindowsSafeApplyUnavailableError(cachedLoadError)
    }
    cachedAddon = mod
    return mod
  } catch (err) {
    cachedLoadError = err instanceof Error ? err.message : String(err)
    throw new WindowsSafeApplyUnavailableError(cachedLoadError)
  }
}

export function isWindowsSafeApplySupported(): boolean {
  try {
    loadAddon()
    return true
  } catch {
    return false
  }
}

function toNativePlan(plan: WindowsSafeApplyPlan) {
  return {
    root: plan.root,
    sources: (plan.sources ?? []).map((s) => ({ path: s.path })),
    modifies: (plan.modifies ?? []).map((m) => ({
      path: m.path,
      expectedSha256Hex: m.expectedSha256Hex,
      expectedLength: m.expectedLength,
      proposedBytes: m.proposedBytes
    })),
    creates: (plan.creates ?? []).map((c) => ({ path: c.path, proposedBytes: c.proposedBytes }))
  }
}

export function prepareLease(plan: WindowsSafeApplyPlan): WindowsSafeApplyPrepareResult {
  return loadAddon().prepareLease(toNativePlan(plan))
}

export function applyModify(lease: unknown, index: number): WindowsSafeApplyOutcome {
  return loadAddon().applyModify(lease, index)
}

export function createFile(lease: unknown, index: number): WindowsSafeApplyOutcome {
  return loadAddon().createFile(lease, index)
}

export function verifyFile(lease: unknown, index: number, isCreate: boolean): WindowsSafeApplyOutcome {
  return loadAddon().verifyFile(lease, index, isCreate)
}

export function rollbackFile(lease: unknown, index: number, isCreate: boolean): WindowsSafeApplyOutcome {
  return loadAddon().rollbackFile(lease, index, isCreate)
}

export function closeLease(lease: unknown): void {
  loadAddon().closeLease(lease)
}

/**
 * Meilenstein 4.8B.2A - schmale CREATE-Recovery-Delete-Primitive. Loescht
 * eine Datei NUR dann, wenn Root- UND Ziel-Identitaet (natives 128-Bit-
 * FileId + Volume-Serial), Byte-Laenge UND SHA-256 exakt mit den vom Aufrufer
 * gelieferten, durablen Evidenz-Werten uebereinstimmen - alle Pruefungen
 * laufen ausschliesslich nativ (siehe recovery_delete.cc's Dateikommentar)
 * gegen EIN offen gehaltenes, exklusives Handle (kein Check-Pfad-dann-
 * loesche-nach-Name). Kein Lease, kein Batch-Kontext - ein eigenstaendiger,
 * einmaliger Aufruf. Bei jeder Abweichung schlaegt dies geschlossen fehl
 * (PRECONDITION_FAILED o.ae.) und die Datei bleibt vollstaendig unberuehrt.
 */
export function recoverDeleteCreated(request: WindowsSafeApplyRecoverDeleteCreatedRequest): WindowsSafeApplyOutcome {
  return loadAddon().recoverDeleteCreated(request)
}

/**
 * Test-only. Never reachable from production - there is no production caller of this
 * module at all, and the production-SHAPED build target doesn't even export this
 * function (see windowsSafeApply.productionShape.windows.test.ts).
 */
export function __setFaultPointForTests(lease: unknown, index: number, isCreate: boolean, faultPoint: WindowsSafeApplyFaultPoint): void {
  const addon = loadAddon()
  if (!addon.setFaultPoint) throw new WindowsSafeApplyUnavailableError('setFaultPoint not exported by this build (production-shaped build loaded?)')
  addon.setFaultPoint(lease, index, isCreate, faultPoint)
}

/** Test-only. See __setFaultPointForTests. */
export function __setForceCaseSensitiveForTests(force: boolean): void {
  const addon = loadAddon()
  if (!addon.setForceCaseSensitiveForTests) {
    throw new WindowsSafeApplyUnavailableError('setForceCaseSensitiveForTests not exported by this build (production-shaped build loaded?)')
  }
  addon.setForceCaseSensitiveForTests(force)
}
