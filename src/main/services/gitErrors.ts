const messages = {
  GIT_BUSY: 'Es laufen bereits Repository-Abfragen. Bitte erneut versuchen.',
  GIT_UNAVAILABLE: 'Git ist nicht installiert oder nicht erreichbar.',
  GIT_PATH_MISSING: 'Der Projektordner fehlt.',
  GIT_PATH_NOT_DIRECTORY: 'Der Projektpfad ist kein Verzeichnis.',
  GIT_NOT_REPOSITORY: 'Der Projektordner ist kein Git-Repository.',
  GIT_INVALID_ROOT: 'Das Repository muss direkt im Projektordner liegen.',
  GIT_UNSAFE_PATH: 'Die Repository-Grenze konnte nicht sicher bestaetigt werden.',
  GIT_UNSAFE_CONFIG: 'Diese Repository-Konfiguration wird aus Sicherheitsgruenden nicht unterstuetzt.',
  GIT_TIMEOUT: 'Die Git-Abfrage hat das Zeitlimit ueberschritten.',
  GIT_OUTPUT_LIMIT: 'Die Git-Ausgabe ist zu gross. Es werden keine unvollstaendigen Daten angezeigt.',
  GIT_FAILED: 'Die Git-Abfrage ist fehlgeschlagen.'
} as const

export class GitError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code])
    this.name = 'GitError'
  }
}
