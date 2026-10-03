// Meilenstein 4.8B.2B - Durable Journal + State Machine (Admission Only).
// Reine Typen/Konstanten, keine Logik (siehe shared/types.ts's Datei-
// Kommentar-Konvention) - der frozen state vocabulary fuer apply_batches /
// apply_batch_entries, EXAKT wie im genehmigten Design festgelegt
// (M4.8B2B-Implementation-Spec.md). Main-only in der Praxis (keine IPC-
// Anbindung existiert oder wird durch dieses Milestone hinzugefuegt) - lebt
// unter @shared nur aus Konsistenz mit den uebrigen Typ-Dateien, nicht weil
// der Renderer sie erreicht.
//
// KRITISCH: eine apply_batches/apply_batch_entries-Zeile ist NIEMALS eine
// Autorisierung fuer eine neue oder erneute Filesystem-Mutation - sie ist
// ausschliesslich unveraenderliche Recovery-/Audit-Evidenz eines bereits
// (fresh) autorisierten authorizeApply()-Aufrufs. Jede zukuenftige Mutation
// verlangt einen erneuten, frischen authorizeApply()-Aufruf (siehe
// applyAuthorityService.ts) - keine Zeile hier ersetzt das je.

export const APPLY_BATCH_STATES = [
  'ADMITTED',
  'PREPARED',
  'APPLYING',
  'SUCCEEDED',
  'ROLLING_BACK',
  'ROLLED_BACK',
  'RECOVERY_REQUIRED',
  'RECOVERY_CONFLICT'
] as const
export type ApplyBatchState = (typeof APPLY_BATCH_STATES)[number]

// Durable recovery-origin marker's own domain - a STRICT SUBSET of
// ApplyBatchState, stored in a separate column (`pre_recovery_state`). This
// is NOT a ninth batch state.
export const APPLY_BATCH_RECOVERY_ORIGIN_STATES = ['ADMITTED', 'PREPARED', 'APPLYING', 'ROLLING_BACK'] as const
export type ApplyBatchRecoveryOriginState = (typeof APPLY_BATCH_RECOVERY_ORIGIN_STATES)[number]

export const APPLY_BATCH_ENTRY_STATES = [
  'PENDING',
  'PREPARED',
  'APPLY_ATTEMPTING',
  'APPLIED',
  'ROLLBACK_ATTEMPTING',
  'ROLLED_BACK',
  'RECOVERY_CONFLICT'
] as const
export type ApplyBatchEntryState = (typeof APPLY_BATCH_ENTRY_STATES)[number]

export const APPLY_BATCH_ENTRY_MUTATION_TYPES = ['MODIFY', 'CREATE'] as const
export type ApplyBatchEntryMutationType = (typeof APPLY_BATCH_ENTRY_MUTATION_TYPES)[number]

// admitBatch()'s classified failure set (applyBatchJournalService.ts). Never
// leaks WHY within PROVENANCE_MISMATCH (which exact field disagreed) - see
// that module's own error class for the precedent (ApplyAuthorityError's
// identical classification discipline).
export const APPLY_BATCH_ADMISSION_ERROR_CODES = ['PROVENANCE_MISMATCH', 'PROJECT_HAS_UNRESOLVED_BATCH'] as const
export type ApplyBatchAdmissionErrorCode = (typeof APPLY_BATCH_ADMISSION_ERROR_CODES)[number]
