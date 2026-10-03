import { app } from 'electron'
import { join } from 'path'

// userData-Verzeichnis buendelt DB, Backups und Logs. Diese Datei importiert
// bewusst 'electron' und ist daher NICHT in einer reinen Node-Testumgebung
// ladbar. Die eigentliche, testbare Pfad-Normalisierungslogik (fuer
// Projektordner-Vergleiche etc.) liegt getrennt in pathNormalization.ts
// und wird hier nur re-exportiert, damit bestehender Main-Code weiterhin
// aus './paths' importieren kann.
export {
  normalizePath,
  pathsPointToSameLocation,
  resolveExistingFolder,
  checkFolderStatus,
  FolderNotFoundError,
  type NormalizedPath
} from './pathNormalization'

export function getUserDataDir(): string {
  return app.getPath('userData')
}

export function getDbPath(): string {
  return join(getUserDataDir(), 'eclipse-hub.sqlite3')
}

export function getBackupDir(): string {
  return join(getUserDataDir(), 'backups')
}

export function getLogDir(): string {
  return join(getUserDataDir(), 'logs')
}
