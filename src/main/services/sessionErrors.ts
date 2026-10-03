import type { ContinuationErrorCode, SessionErrorCode } from '@shared/types'

export class SessionNotFoundError extends Error {
  constructor(id: number) {
    super(`Sitzung mit ID ${id} wurde nicht gefunden.`)
    this.name = 'SessionNotFoundError'
  }
}

export class SnapshotNotFoundError extends Error {
  constructor(id: number) {
    super(`Fortsetzungs-Snapshot mit ID ${id} wurde nicht gefunden.`)
    this.name = 'SnapshotNotFoundError'
  }
}

/** Wird geworfen, wenn ein Snapshot existiert, aber nicht zur angegebenen Sitzung gehoert. */
export class SnapshotSessionMismatchError extends Error {
  constructor(snapshotId: number, sessionId: number) {
    super(`Snapshot ${snapshotId} gehoert nicht zu Sitzung ${sessionId}.`)
    this.name = 'SnapshotSessionMismatchError'
  }
}

/** Wird geworfen, wenn eine angegebene Kontext-Version nicht zum selben Projekt gehoert. */
export class SessionContextMismatchError extends Error {
  constructor(contextVersionId: number, projectId: number) {
    super(`Kontext-Version ${contextVersionId} gehoert nicht zu Projekt ${projectId}.`)
    this.name = 'SessionContextMismatchError'
  }
}

export class AnotherActiveSessionExistsError extends Error {
  constructor(projectId: number, provider: string) {
    super(`Projekt ${projectId} hat bereits eine aktive ${provider}-Sitzung.`)
    this.name = 'AnotherActiveSessionExistsError'
  }
}

export class ChatMessageAlreadyAssignedError extends Error {
  constructor(chatMessageId: number) {
    super(`Chat-Nachricht ${chatMessageId} ist bereits einer Sitzung zugeordnet.`)
    this.name = 'ChatMessageAlreadyAssignedError'
  }
}

export class ChatMessageSessionProjectMismatchError extends Error {
  constructor(chatMessageId: number, sessionId: number) {
    super(`Chat-Nachricht ${chatMessageId} und Sitzung ${sessionId} gehoeren nicht zum selben Projekt.`)
    this.name = 'ChatMessageSessionProjectMismatchError'
  }
}

export class ChatMessageProviderMismatchError extends Error {
  constructor(chatMessageId: number, sessionId: number) {
    super(`Chat-Nachricht ${chatMessageId} passt nicht zum Provider von Sitzung ${sessionId}.`)
    this.name = 'ChatMessageProviderMismatchError'
  }
}

export class ChatMessageNotFoundError extends Error {
  constructor(chatMessageId: number) {
    super(`Chat-Nachricht mit ID ${chatMessageId} wurde nicht gefunden.`)
    this.name = 'ChatMessageNotFoundError'
  }
}

/** Wird geworfen, wenn ein Snapshot einen anderen Provider hat als die Sitzung, die ihn verwenden soll. */
export class SnapshotProviderMismatchError extends Error {
  constructor(snapshotId: number, snapshotProvider: string, sessionProvider: string) {
    super(`Snapshot ${snapshotId} hat Provider "${snapshotProvider}", erwartet wurde "${sessionProvider}".`)
    this.name = 'SnapshotProviderMismatchError'
  }
}

/** Fester Fehlercode, analog ResponseImportError - siehe SessionErrorCode. */
export class SessionError extends Error {
  code: SessionErrorCode

  constructor(code: SessionErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'SessionError'
  }
}

/** Fester Fehlercode, analog SessionError - siehe ContinuationErrorCode. */
export class ContinuationError extends Error {
  code: ContinuationErrorCode

  constructor(code: ContinuationErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ContinuationError'
  }
}
