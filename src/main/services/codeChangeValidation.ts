import {
  CODE_CHANGE_MAX_CONTENT_BYTES_PER_FILE,
  CODE_CHANGE_MAX_CREATE_ENTRIES,
  CODE_CHANGE_MAX_MODIFY_ENTRIES,
  CODE_CHANGE_MAX_SERIALIZED_PROPOSAL_BYTES,
  CODE_CHANGE_MAX_SUMMARY_BYTES,
  CODE_CHANGE_MAX_TOTAL_CHANGES,
  CODE_CHANGE_MAX_TOTAL_CONTENT_BYTES,
  CODE_CHANGE_MAX_WARNINGS,
  CODE_CHANGE_MAX_WARNING_BYTES,
  type CodeChangeProposal,
  type CodeFileChange
} from '@shared/codeChangeTypes'
import { assertNoCaseInsensitiveDuplicatePaths, InvalidSourceAccessPathError, validateSourceAccessPath } from './sourceAccessPath'

// Meilenstein 4.7B.1 - PURE Validierung eines von Claude (oder einem
// zukuenftigen anderen Provider) gelieferten CodeChangeProposal. KEIN
// Dateisystem-Zugriff, KEIN DB-Zugriff, KEIN Git-Zugriff - reine
// Code-Ebene-Pruefung, analog controllerPlanValidation.ts.
//
// Der vertrauenswuerdige Scope (welche Pfade ueberhaupt MODIFY/CREATE
// erreichen duerfen) ist NIEMALS Teil des Modell-Vorschlags - er wird als
// separates, Main-eigenes Argument uebergeben (siehe TrustedCodeChangeScope
// unten). Ein gueltiger Vorschlag ist NIEMALS automatisch autorisiert,
// angewendet oder freigegeben - M4.7B.1 wendet NICHTS an (siehe Vorgabe
// "FROZEN WRITER MODEL": Claude VERFASST CODE, Main MUTIERT DATEIEN).

export class InvalidCodeChangeProposalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCodeChangeProposalError'
  }
}

/**
 * Main-eigene, vertrauenswuerdige Zugriffsgrenze - NIEMALS Teil des
 * Modell-Vorschlags. Konzeptionell dieselbe Rolle wie RunTrustedScope in
 * runService.ts, nur fuer Code-Aenderungen statt Lesezugriff.
 */
export interface TrustedCodeChangeScope {
  modifyPaths: string[]
  createPaths: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}

function requireOwnProperty(raw: Record<string, unknown>, key: string): unknown {
  if (!hasOwn(raw, key)) {
    throw new InvalidCodeChangeProposalError(`Feld "${key}" fehlt - dieses Feld ist erforderlich (auch ein leerer Wert muss explizit angegeben werden).`)
  }
  return raw[key]
}

function assertExactKeys(raw: Record<string, unknown>, allowedKeys: readonly string[], contextLabel: string): void {
  const allowed = new Set(allowedKeys)
  const extra = Object.keys(raw).filter((key) => !allowed.has(key))
  if (extra.length > 0) {
    throw new InvalidCodeChangeProposalError(
      `${contextLabel} enthaelt unbekannte(s) Feld(er): ${extra.join(', ')}. Erlaubt sind ausschliesslich: ${allowedKeys.join(', ')}.`
    )
  }
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

// \x00-\x1f deckt NUL und alle ASCII-Steuerzeichen ab; \t/\n/\r bleiben als
// gewoehnlicher Quelltext-Whitespace erlaubt.
const DISALLOWED_CONTENT_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/

// Ein einzelnes, nicht gepaartes UTF-16-Surrogat (hoch: \uD800-\uDBFF ohne
// unmittelbar folgendes Tief-Surrogat; tief: \uDC00-\uDFFF ohne unmittelbar
// vorangehendes Hoch-Surrogat) repraesentiert KEIN gueltiges Unicode-Zeichen.
// Eine spaetere UTF-8-Kodierung wuerde es stillschweigend durch U+FFFD
// ersetzen - der validierte Vorschlag und die spaeter tatsaechlich
// geschriebenen Bytes waeren dann nicht mehr derselbe Text. Ein KORREKT
// gepaartes Surrogatpaar (z. B. ein Emoji) bleibt unveraendert zulaessig.
const UNPAIRED_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function validateFileContent(raw: unknown, fieldLabel: string): string {
  if (typeof raw !== 'string') {
    throw new InvalidCodeChangeProposalError(`${fieldLabel} muss Text sein.`)
  }
  const byteLength = utf8ByteLength(raw)
  if (byteLength > CODE_CHANGE_MAX_CONTENT_BYTES_PER_FILE) {
    throw new InvalidCodeChangeProposalError(
      `${fieldLabel} ueberschreitet das Limit von ${CODE_CHANGE_MAX_CONTENT_BYTES_PER_FILE} Bytes (UTF-8).`
    )
  }
  if (DISALLOWED_CONTENT_CHAR_RE.test(raw)) {
    throw new InvalidCodeChangeProposalError(`${fieldLabel} enthaelt ein NUL- oder binaerartiges Steuerzeichen.`)
  }
  if (UNPAIRED_SURROGATE_RE.test(raw)) {
    throw new InvalidCodeChangeProposalError(`${fieldLabel} enthaelt ein nicht gepaartes UTF-16-Surrogat.`)
  }
  return raw
}

const FILE_CHANGE_ALLOWED_KEYS = ['type', 'path', 'content'] as const

function validateFileChange(raw: unknown, index: number, scope: TrustedCodeChangeScope): CodeFileChange {
  if (!isPlainObject(raw)) {
    throw new InvalidCodeChangeProposalError(`changes[${index}] muss ein Objekt sein.`)
  }
  assertExactKeys(raw, FILE_CHANGE_ALLOWED_KEYS, `changes[${index}]`)

  const type = requireOwnProperty(raw, 'type')
  if (type !== 'MODIFY' && type !== 'CREATE') {
    // V1 unterstuetzt nur MODIFY/CREATE - DELETE/RENAME und jeder andere Wert
    // werden hier explizit abgelehnt (siehe Vorgabe Teil A "Defer: DELETE/RENAME/...").
    throw new InvalidCodeChangeProposalError(`changes[${index}].type muss "MODIFY" oder "CREATE" sein.`)
  }

  const pathRaw = requireOwnProperty(raw, 'path')
  let path: string
  try {
    path = validateSourceAccessPath(pathRaw)
  } catch (error) {
    throw new InvalidCodeChangeProposalError(
      `changes[${index}].path ist ungueltig: ${error instanceof InvalidSourceAccessPathError ? error.message : String(error)}`
    )
  }

  const trustedScope = type === 'MODIFY' ? scope.modifyPaths : scope.createPaths
  const allowed = trustedScope.some((candidate) => candidate === path)
  if (!allowed) {
    throw new InvalidCodeChangeProposalError(
      `changes[${index}].path "${path}" liegt ausserhalb des vertrauenswuerdigen ${type === 'MODIFY' ? 'MODIFY' : 'CREATE'}-Bereichs.`
    )
  }

  const content = validateFileContent(requireOwnProperty(raw, 'content'), `changes[${index}].content`)

  return type === 'MODIFY' ? { type: 'MODIFY', path, content } : { type: 'CREATE', path, content }
}

function validateWarningsList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new InvalidCodeChangeProposalError('warnings muss eine Liste sein.')
  }
  if (raw.length > CODE_CHANGE_MAX_WARNINGS) {
    throw new InvalidCodeChangeProposalError(`warnings enthaelt zu viele Eintraege (max. ${CODE_CHANGE_MAX_WARNINGS}).`)
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new InvalidCodeChangeProposalError(`warnings[${index}] muss Text sein.`)
    }
    if (utf8ByteLength(entry) > CODE_CHANGE_MAX_WARNING_BYTES) {
      throw new InvalidCodeChangeProposalError(`warnings[${index}] ueberschreitet das Limit von ${CODE_CHANGE_MAX_WARNING_BYTES} Bytes (UTF-8).`)
    }
    return entry
  })
}

const PROPOSAL_ALLOWED_KEYS = ['summary', 'changes', 'warnings'] as const

/**
 * Validiert einen rohen, unvertrauenswuerdigen Modell-Vorschlag gegen den
 * exakten V1-Vertrag PLUS den separat uebergebenen, vertrauenswuerdigen
 * Scope. Wirft bei jeder Abweichung - kein stillschweigendes Reparieren,
 * Umbenennen, Kuerzen oder Uebernehmen unbekannter Felder.
 */
export function validateCodeChangeProposal(raw: unknown, scope: TrustedCodeChangeScope): CodeChangeProposal {
  if (!isPlainObject(raw)) {
    throw new InvalidCodeChangeProposalError('CodeChangeProposal muss ein Objekt sein.')
  }
  assertExactKeys(raw, PROPOSAL_ALLOWED_KEYS, 'CodeChangeProposal')

  const summaryRaw = requireOwnProperty(raw, 'summary')
  if (typeof summaryRaw !== 'string') {
    throw new InvalidCodeChangeProposalError('summary muss Text sein.')
  }
  if (utf8ByteLength(summaryRaw) > CODE_CHANGE_MAX_SUMMARY_BYTES) {
    throw new InvalidCodeChangeProposalError(`summary ueberschreitet das Limit von ${CODE_CHANGE_MAX_SUMMARY_BYTES} Bytes (UTF-8).`)
  }

  const changesRaw = requireOwnProperty(raw, 'changes')
  if (!Array.isArray(changesRaw)) {
    throw new InvalidCodeChangeProposalError('changes muss eine Liste sein.')
  }
  if (changesRaw.length === 0) {
    throw new InvalidCodeChangeProposalError('changes darf nicht leer sein.')
  }
  if (changesRaw.length > CODE_CHANGE_MAX_TOTAL_CHANGES) {
    throw new InvalidCodeChangeProposalError(`changes enthaelt zu viele Eintraege (max. ${CODE_CHANGE_MAX_TOTAL_CHANGES}).`)
  }

  const changes = changesRaw.map((entry, index) => validateFileChange(entry, index, scope))

  const modifyCount = changes.filter((change) => change.type === 'MODIFY').length
  const createCount = changes.filter((change) => change.type === 'CREATE').length
  if (modifyCount > CODE_CHANGE_MAX_MODIFY_ENTRIES) {
    throw new InvalidCodeChangeProposalError(`changes enthaelt zu viele MODIFY-Eintraege (max. ${CODE_CHANGE_MAX_MODIFY_ENTRIES}).`)
  }
  if (createCount > CODE_CHANGE_MAX_CREATE_ENTRIES) {
    throw new InvalidCodeChangeProposalError(`changes enthaelt zu viele CREATE-Eintraege (max. ${CODE_CHANGE_MAX_CREATE_ENTRIES}).`)
  }

  // Case-insensitive Alias-/Duplikat-Pruefung UEBER MODIFY+CREATE hinweg
  // zusammen - ein MODIFY und ein CREATE auf denselben (oder alias-gleichen)
  // Pfad ist genauso eine Kollision wie zwei MODIFY-Eintraege auf denselben
  // Pfad (siehe Vorgabe: "Reject: duplicate changes, MODIFY + CREATE
  // collision, case aliases").
  try {
    assertNoCaseInsensitiveDuplicatePaths(
      changes.map((change) => change.path),
      'changes'
    )
  } catch (error) {
    throw new InvalidCodeChangeProposalError(error instanceof Error ? error.message : String(error))
  }

  const totalContentBytes = changes.reduce((sum, change) => sum + utf8ByteLength(change.content), 0)
  if (totalContentBytes > CODE_CHANGE_MAX_TOTAL_CONTENT_BYTES) {
    throw new InvalidCodeChangeProposalError(
      `Der Gesamtinhalt aller changes ueberschreitet das Limit von ${CODE_CHANGE_MAX_TOTAL_CONTENT_BYTES} Bytes (UTF-8).`
    )
  }

  const warnings = validateWarningsList(requireOwnProperty(raw, 'warnings'))

  const proposal: CodeChangeProposal = { summary: summaryRaw, changes, warnings }

  const serializedByteLength = utf8ByteLength(JSON.stringify(proposal))
  if (serializedByteLength > CODE_CHANGE_MAX_SERIALIZED_PROPOSAL_BYTES) {
    throw new InvalidCodeChangeProposalError(
      `Der vollstaendig serialisierte, validierte Vorschlag ueberschreitet das Limit von ${CODE_CHANGE_MAX_SERIALIZED_PROPOSAL_BYTES} Bytes (UTF-8).`
    )
  }

  return proposal
}
