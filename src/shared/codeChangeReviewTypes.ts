import type { DiffLine } from './types'
import type { LineEnding } from './projectTextReadTypes'

// Meilenstein 4.8A - Code Change Review Vertrag. Diese Datei enthaelt
// AUSSCHLIESSLICH die RENDERER-SICHERE Projektion + die kleinen IPC-
// Anfrageformen - NIEMALS Main-eigene Provenienz/Fingerprint-Interna (root/
// Dateisystem-Identitaet, Policy/Scope-Rohobjekte, das volle
// CodeChangeGenerationProvenance, Claude-Session-Metadaten). Jene Interna
// leben ausschliesslich in codeChangeReviewService.ts (Main-only, siehe
// Vorgabe Teil E: "Do NOT put Main-only provenance into shared renderer
// types").
//
// KRITISCH (siehe Vorgabe Teil M "APPROVAL SEMANTICS"): eine Review, ein
// reviewId und ein Fingerprint sind NIEMALS eine Autorisierung fuer
// filesystem.write/command.execute/git.write/provider-Offenlegung. Sie
// bedeuten AUSSCHLIESSLICH "der Nutzer hat GENAU diesen unveraenderlichen,
// Main-eigenen Datensatz explizit entschieden". M4.8B muss jede tatsaechliche
// Ausfuehrungs-Autoritaet vollstaendig unabhaengig neu pruefen.

export const CODE_CHANGE_REVIEW_STATES = ['PENDING', 'APPROVED', 'CHANGES_REQUESTED'] as const
export type CodeChangeReviewState = (typeof CODE_CHANGE_REVIEW_STATES)[number]

// V1-Grenzwerte, die sowohl Main (codeChangeReviewService.ts) als auch der
// Renderer (Eingabe-Laengenanzeige) kennen muessen.
export const CODE_CHANGE_REVIEW_FEEDBACK_MAX_BYTES = 8 * 1024
export const CODE_CHANGE_REVIEW_TTL_MS = 2 * 60 * 60 * 1000
export const CODE_CHANGE_REVIEW_MAX_LIVE_PER_PROJECT = 20
export const CODE_CHANGE_REVIEW_MAX_ROWS_PER_FILE = 10_000
export const CODE_CHANGE_REVIEW_MAX_TOTAL_ROWS = 20_000

/** Rein informatives Format-Metadatum fuer die Anzeige - gewaehrt KEINE Autoritaet (siehe Vorgabe Teil J). */
export interface CodeChangeReviewFormatInfo {
  utf8Bom: boolean
  lineEnding: LineEnding
  finalNewline: boolean
  byteLength: number
}

export interface CodeChangeReviewInvisibleAnnotation {
  codePoint: string
  line: number
  side: 'before' | 'after'
}

/**
 * Datei-Projektion je vorgeschlagener Aenderung - AUSSCHLIESSLICH review-
 * relevante Information (siehe Vorgabe Teil E "Suggested renderer concept").
 * `beforeText` ist `null` fuer CREATE (absent). KEIN absoluter Pfad, KEINE
 * rohen SHA-256-Hashes (die UI braucht sie nicht), KEINE Dateisystem-
 * Identitaet.
 */
export interface CodeChangeReviewFile {
  path: string
  type: 'MODIFY' | 'CREATE'
  beforeText: string | null
  afterText: string
  diff: DiffLine[]
  whitespaceOnlyChangedLines: number[]
  invisibleAnnotations: CodeChangeReviewInvisibleAnnotation[]
  beforeFormat: CodeChangeReviewFormatInfo | null
  afterFormat: CodeChangeReviewFormatInfo
}

/**
 * Renderer-sichere Review-Projektion. KEIN Policy/Capability/Disclosure-
 * Scope/Dateisystem-Identitaet/Main-Fingerprint-internas/Claude-Session-
 * Metadaten (siehe Vorgabe Teil E "Do NOT expose"). NUR ueber getReview()
 * erreichbar - listReviewsForProject() liefert ausschliesslich die
 * schlankere CodeChangeReviewSummary unten (M4.8A V2).
 */
export interface CodeChangeReviewProjection {
  reviewId: string
  projectId: number
  taskId: number
  workRequestId: number
  state: CodeChangeReviewState
  summary: string
  warnings: string[]
  files: CodeChangeReviewFile[]
  feedback: string | null
  createdAt: string
  expiresAt: string
}

/**
 * M4.8A V2 - schlanke Listen-Projektion. `listReviewsForProject()` liefert
 * NIEMALS beforeText/afterText/diff/Quellinhalte/Provenienz/Fingerprint -
 * nur `fileCount` statt der vollstaendigen `files`-Liste. Die vollstaendige
 * CodeChangeReviewProjection (mit Diff) ist ausschliesslich ueber
 * getReview() fuer EINE konkrete Review erreichbar (siehe Vorgabe Teil 8/9).
 */
export interface CodeChangeReviewSummary {
  reviewId: string
  projectId: number
  taskId: number
  workRequestId: number
  state: CodeChangeReviewState
  summary: string
  warnings: string[]
  fileCount: number
  feedback: string | null
  createdAt: string
  expiresAt: string
}

// ---------------------------------------------------------------------------
// IPC-Anfrageformen (Vorgabe Teil O) - exakte Form, identifier-only wo
// moeglich. KEIN CREATE-Kanal (Review-Erstellung ist Main-internal only),
// KEIN Apply-Kanal.
// ---------------------------------------------------------------------------

export interface CodeChangeReviewListRequest {
  projectId: number
}

export interface CodeChangeReviewGetRequest {
  projectId: number
  reviewId: string
}

export interface CodeChangeReviewApproveRequest {
  projectId: number
  reviewId: string
}

export interface CodeChangeReviewRequestChangesRequest {
  projectId: number
  reviewId: string
  feedback: string
}
