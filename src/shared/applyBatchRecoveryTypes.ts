// Meilenstein 4.8B.2C (Recovery Core) - reine Typen/Konstanten, keine Logik
// (siehe applyBatchTypes.ts's Datei-Kommentar-Konvention). Main-only in der
// Praxis - keine IPC-Anbindung existiert oder wird durch dieses Milestone
// hinzugefuegt.

export const APPLY_BATCH_TRANSITION_ERROR_CODES = [
  'BATCH_NOT_FOUND',
  'ENTRY_NOT_FOUND',
  'INVALID_BATCH_TRANSITION',
  'INVALID_ENTRY_TRANSITION'
] as const
export type ApplyBatchTransitionErrorCode = (typeof APPLY_BATCH_TRANSITION_ERROR_CODES)[number]

// ---------------------------------------------------------------------------
// apply_batch_entries.failure_note contract (v3 - corrected).
//
// v2 modeled every value this service could ever write to failure_note as
// ONE closed union of seven fixed string literals - but two of those seven
// ('APPLY_MODIFY:UNEXPECTED_RESULT', 'CREATE:UNEXPECTED_RESULT') are never
// actually written bare; the algorithm (applyBatchRecoveryService.ts) always
// appends ':<nativeCode>', where <nativeCode> is whatever string
// callNative()'s NativeCallResult.code happens to hold at that moment - a
// WindowsSafeApplyResultCode name (e.g. 'BUSY', 'PRECONDITION_FAILED'), or
// one of callNative()'s own synthetic codes ('NATIVE_MODULE_UNAVAILABLE',
// 'UNKNOWN_ERROR'). A dynamically-suffixed string can never be a member of a
// union of exact literals, so v2's own algorithm did not actually
// type-check as written.
//
// Fixed below by separating three concepts:
//   1. ApplyBatchRecoveryFailureReason - the seven CATEGORY names, kept
//      verbatim from v2, for documentation/grouping/analytics use only (e.g.
//      "which of the seven diagnostic categories does this note belong to,
//      stripped of any native-code suffix"). NOT the type used by any
//      function that reads or writes an actual persisted failure_note value
//      - see (3) below for that.
//   2. Two TEMPLATE LITERAL types, one per suffixed category, each requiring
//      (not merely conventionally expecting) a ':<code>' suffix - assigning
//      a bare 'APPLY_MODIFY:UNEXPECTED_RESULT' with no suffix to either is a
//      compile error, not just a lint warning (see the compile-time proof at
//      the bottom of this file).
//   3. ApplyBatchRecoveryFailureNote - the COMPLETE, closed union of every
//      value this service is ever allowed to persist: the five
//      never-suffixed categories, verbatim, plus the two template-literal
//      types. This - never ApplyBatchRecoveryFailureReason - is the type
//      resolveEntryConflict() and ApplyBatchRecoveryEntryOutcome.failureReason
//      actually use (see applyBatchRecoveryService.ts, S8.0/S11).
//
// DIAGNOSTIC-ONLY, NEVER AUTHORITY: the ':<code>' suffix's own content is
// deliberately typed as `${string}` - NOT narrowed to the closed
// WindowsSafeApplyResultCode union (or that union plus the two synthetic
// callNative() codes), even though every value actually written there today
// comes from exactly that closed set. Narrowing it further would imply the
// suffix is a trusted, exhaustive, switchable enum - it is not, and must
// never become one: failure_note is written once, for a human operator
// reading the row later, and is NEVER read back by this service for any
// control-flow decision (see applyBatchRecoveryService.ts S11's
// column-write-scope statement, unchanged from v2 - this service only ever
// WRITES failure_note, never branches on its content). Keeping the suffix as
// unconstrained `${string}` is the type-level expression of that same
// "native codes are diagnostic only, never authority" rule the recovery
// algorithm itself already follows (every actual admission/recovery decision
// is driven by callNative()'s `ok`/`code` fields directly, in-memory, at the
// moment of the call - never by re-parsing a previously-persisted
// failure_note string).
// ---------------------------------------------------------------------------

/** Documentation/grouping only - see the file-header note above. */
export const APPLY_BATCH_RECOVERY_FAILURE_REASONS = [
  'ROOT_LOCATOR:INVALID',
  'AS_APPLIED:IDENTITY_MISMATCH',
  'AS_ORIGINAL:IDENTITY_MISMATCH',
  'NEITHER_PROBE_MATCHED',
  'APPLY_MODIFY:UNEXPECTED_RESULT',
  'CREATE:NO_DURABLE_EVIDENCE',
  'CREATE:UNEXPECTED_RESULT'
] as const
export type ApplyBatchRecoveryFailureReason = (typeof APPLY_BATCH_RECOVERY_FAILURE_REASONS)[number]

/** The five categories ALWAYS written verbatim, with no suffix ever appended. */
export const APPLY_BATCH_RECOVERY_FIXED_FAILURE_NOTES = [
  'ROOT_LOCATOR:INVALID',
  'AS_APPLIED:IDENTITY_MISMATCH',
  'AS_ORIGINAL:IDENTITY_MISMATCH',
  'NEITHER_PROBE_MATCHED',
  'CREATE:NO_DURABLE_EVIDENCE'
] as const
export type ApplyBatchRecoveryFixedFailureNote = (typeof APPLY_BATCH_RECOVERY_FIXED_FAILURE_NOTES)[number]

/**
 * The two categories ALWAYS written WITH a ':<nativeCode>' suffix. Modeled as
 * template literal types so the suffix is structurally required - see the
 * file-header note above for why the suffix itself stays `${string}` rather
 * than a narrower, closed union.
 */
export type ApplyBatchRecoveryModifyNativeFailureNote = `APPLY_MODIFY:UNEXPECTED_RESULT:${string}`
export type ApplyBatchRecoveryCreateNativeFailureNote = `CREATE:UNEXPECTED_RESULT:${string}`

/**
 * The COMPLETE, closed, persisted apply_batch_entries.failure_note contract -
 * every value applyBatchRecoveryService.ts ever writes there, and nothing
 * else. This is the type resolveEntryConflict() and
 * ApplyBatchRecoveryEntryOutcome.failureReason actually use (never
 * ApplyBatchRecoveryFailureReason above, and never plain `string`).
 */
export type ApplyBatchRecoveryFailureNote =
  | ApplyBatchRecoveryFixedFailureNote
  | ApplyBatchRecoveryModifyNativeFailureNote
  | ApplyBatchRecoveryCreateNativeFailureNote

// ---------------------------------------------------------------------------
// Compile-time-only proof (implementation spec S13 item 1), co-located here
// so it is type-checked every time this file itself is compiled, by the SAME
// `npm run typecheck` command already used throughout this codebase - no new
// tooling, no `tsd`/typecheck-mode dependency). Never called at runtime; its
// entire purpose is for `tsc` to accept or reject the assignments below.
// If this stops compiling, the fix this document describes has regressed.
// ---------------------------------------------------------------------------
function _typeProof_dynamicNativeCodeFailureNotesAreAssignable(): void {
  const nativeCode: string = 'BUSY' // stands in for NativeCallResult['code'], which is exactly `string`

  // 1) A dynamically-suffixed note, built via TEMPLATE LITERAL SYNTAX (never
  //    `+` concatenation - see the file-header note on why), assigns to
  //    ApplyBatchRecoveryFailureNote with NO cast.
  const modifyNote: ApplyBatchRecoveryFailureNote = `APPLY_MODIFY:UNEXPECTED_RESULT:${nativeCode}`
  const createNote: ApplyBatchRecoveryFailureNote = `CREATE:UNEXPECTED_RESULT:${nativeCode}`

  // 2) A fixed, never-suffixed note still assigns with no cast either.
  const fixedNote: ApplyBatchRecoveryFailureNote = 'NEITHER_PROBE_MATCHED'

  // 3) The suffix is structurally MANDATORY, not conventional - a bare
  //    category name with no ':<code>' is a compile error. If the
  //    `@ts-expect-error` directive below ever becomes unnecessary (i.e. the
  //    assignment starts compiling), that is itself a compile error (an
  //    unused `@ts-expect-error`), so this line fails loudly in either
  //    direction rather than silently passing.
  // @ts-expect-error - 'APPLY_MODIFY:UNEXPECTED_RESULT' with no ':<code>' suffix is not a valid ApplyBatchRecoveryFailureNote
  const invalidBareNote: ApplyBatchRecoveryFailureNote = 'APPLY_MODIFY:UNEXPECTED_RESULT'

  void modifyNote
  void createNote
  void fixedNote
  void invalidBareNote
}
void _typeProof_dynamicNativeCodeFailureNotesAreAssignable

export const APPLY_BATCH_RECOVERY_BATCH_OUTCOMES = ['SUCCEEDED', 'ROLLED_BACK', 'RECOVERY_CONFLICT'] as const
export type ApplyBatchRecoveryBatchOutcome = (typeof APPLY_BATCH_RECOVERY_BATCH_OUTCOMES)[number]
