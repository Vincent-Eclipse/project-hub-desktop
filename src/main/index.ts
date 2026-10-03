import { app, BrowserWindow, dialog, session } from 'electron'
import path from 'path'
import { pathToFileURL } from 'url'
import { isNavigationTargetAllowed } from './navigationPolicy'
import { buildContentSecurityPolicy, isUsableDevRendererUrl } from './contentSecurityPolicy'
import { is } from './isDev'
import { getBackupDir, getDbPath, getLogDir, getUserDataDir } from './paths'
import { FileLogger } from './logger'
import { openDatabase } from './db/connection'
import { getPendingMigrationVersions, runMigrations } from './db/migrations'
import { backupDatabaseBeforeMigration } from './db/backup'
import { registerIpc } from './ipc/registerIpc'
import { createCodeChangeReviewRegistry } from './services/codeChangeReviewService'
import { createApplyBatchRecoveryService, realWindowsSafeApplyNativeDependencies } from './services/applyBatchRecoveryService'
import type { AppInfo } from '@shared/types'

let mainWindow: BrowserWindow | null = null

/**
 * Zeigt einen fatalen Startfehler als klar verstaendliches Betriebssystem-
 * Dialogfenster (dialog.showErrorBox) - die App verschwindet nicht einfach
 * kommentarlos. Loggt zusaetzlich, sofern der Logger ueberhaupt schon
 * verfuegbar ist, und beendet den Prozess danach kontrolliert (statt in
 * einem unklaren Zustand weiterzulaufen).
 */
function failFatally(logger: FileLogger | null, title: string, message: string, error: unknown): never {
  const details = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)
  logger?.error(`${title}: ${message}`, error)
  // eslint-disable-next-line no-console
  console.error(title, message, error)
  dialog.showErrorBox(title, `${message}\n\nDetails:\n${details}`)
  app.exit(1)
  throw new Error('unreachable') // fuer den TypeScript-Kontrollfluss (never)
}

async function bootstrap(): Promise<void> {
  let logger: FileLogger | null = null
  try {
    logger = new FileLogger(getLogDir())
  } catch (error) {
    // Selbst wenn das Log-Verzeichnis nicht angelegt werden kann, darf die
    // App nicht kommentarlos verschwinden.
    failFatally(null, 'Start fehlgeschlagen', 'Das Anwendungsverzeichnis konnte nicht angelegt werden.', error)
  }
  logger.info('App startet', { version: app.getVersion(), userDataDir: getUserDataDir() })

  const dbPath = getDbPath()
  let db: ReturnType<typeof openDatabase>
  try {
    db = openDatabase(dbPath)
  } catch (error) {
    // Eine beschaedigte oder gesperrte Datenbankdatei wird NIEMALS
    // automatisch ueberschrieben - die App bricht stattdessen kontrolliert ab.
    failFatally(
      logger,
      'Datenbank konnte nicht geoeffnet werden',
      `Die Datenbankdatei unter "${dbPath}" konnte nicht geoeffnet werden. ` +
        `Sie wurde NICHT veraendert oder ueberschrieben. Bitte pruefe die Datei manuell ` +
        `oder stelle sie aus einem Backup unter "${getBackupDir()}" wieder her.`,
      error
    )
  }

  // Backup vor einer Migration ist nur dann zwingend, wenn tatsaechlich
  // migriert werden muesste (Punkt 14 der Korrektur-Anforderungen): schlaegt
  // das Backup fehl, obwohl neue Migrationen anstehen, wird die Migration
  // gestoppt statt stillschweigend ignoriert.
  let pendingVersions: number[]
  try {
    pendingVersions = getPendingMigrationVersions(db)
  } catch (error) {
    failFatally(logger, 'Migrationsstatus konnte nicht ermittelt werden', 'Die Datenbank scheint beschaedigt zu sein.', error)
  }

  if (pendingVersions.length > 0) {
    try {
      const backupPath = await backupDatabaseBeforeMigration(db, getBackupDir())
      logger.info('Backup vor notwendiger Migration erstellt', { backupPath, pendingVersions })
    } catch (error) {
      failFatally(
        logger,
        'Backup vor Migration fehlgeschlagen',
        `Es stehen Datenbank-Migrationen an (Versionen: ${pendingVersions.join(', ')}), ` +
          `aber das vorherige Sicherungs-Backup ist fehlgeschlagen. Die Migration wurde ` +
          `zum Schutz deiner Daten NICHT durchgefuehrt.`,
        error
      )
    }
  } else {
    // Kein Migrationsbedarf - ein fehlschlagendes Backup ist hier nicht
    // fatal, wird aber protokolliert.
    try {
      await backupDatabaseBeforeMigration(db, getBackupDir())
    } catch (error) {
      logger.warn('Routine-Backup fehlgeschlagen (keine Migration noetig, daher nicht fatal)', error)
    }
  }

  try {
    const { applied } = runMigrations(db)
    if (applied.length > 0) {
      logger.info('Migrationen angewendet', { applied })
    }
  } catch (error) {
    failFatally(
      logger,
      'Migration fehlgeschlagen',
      'Eine Datenbank-Migration konnte nicht angewendet werden. Die App wird beendet, ' +
        `um die Datenbank nicht in einem inkonsistenten Zustand zu belassen. Ein Backup ` +
        `liegt unter "${getBackupDir()}".`,
      error
    )
  }

  // Meilenstein 4.8B.3 Slice 5 - Startup-Recovery-Scan. Muss nach erfolgreicher
  // Migration (Schema muss aktuell sein) und VOR registerIpc() laufen (kein
  // zukuenftiger apply:submit-Kanal darf jemals vor diesem Scan erreichbar
  // sein). recoverAllUnresolvedBatches() setzt niemals unvollstaendige
  // Forward-Apply-Arbeit fort und erzeugt keine neue Autoritaet - siehe
  // applyBatchRecoveryService.ts's eigenen Datei-Kommentar. Ein klassifiziertes
  // Pro-Batch-Ergebnis (SUCCEEDED/ROLLED_BACK/RECOVERY_CONFLICT) ist ein
  // normaler Start-Vorgang, kein fataler Fehler - nur ein unerwarteter Wurf
  // (ein echter Bug oder DB-Fehler) fuehrt zu failFatally().
  try {
    const recoveryResults = createApplyBatchRecoveryService({ db, native: realWindowsSafeApplyNativeDependencies }).recoverAllUnresolvedBatches()
    const conflicts = recoveryResults.filter((r) => r.finalState === 'RECOVERY_CONFLICT')
    if (recoveryResults.length > 0) {
      logger.info('Apply-Batch-Wiederherstellung beim Start abgeschlossen', {
        total: recoveryResults.length,
        succeeded: recoveryResults.filter((r) => r.finalState === 'SUCCEEDED').length,
        rolledBack: recoveryResults.filter((r) => r.finalState === 'ROLLED_BACK').length,
        recoveryConflicts: conflicts.length
      })
    }
    // RECOVERY_CONFLICT ist bereits durabel und strukturell nie erneut
    // versuchbar - hier wird es ausschliesslich sichtbar gemacht (WARN),
    // niemals automatisch erneut versucht, fortgesetzt, oder eskaliert.
    for (const conflict of conflicts) {
      logger.warn('Apply-Batch verbleibt in RECOVERY_CONFLICT - manuelle Pruefung erforderlich', { batchId: conflict.batchId })
    }
  } catch (error) {
    failFatally(
      logger,
      'Apply-Wiederherstellung beim Start fehlgeschlagen',
      'Beim Ueberpruefen unterbrochener Apply-Vorgaenge ist ein unerwarteter Fehler aufgetreten. ' +
        'Die App wird kontrolliert beendet, um keinen unklaren Dateisystemzustand zu riskieren.',
      error
    )
  }

  const appInfo: AppInfo = {
    appVersion: app.getVersion(),
    dbPath,
    logPath: getLogDir()
  }

  // Meilenstein 4.8A - EINE In-Memory-Registry pro App-Lauf (kein DB-Schema,
  // keine Persistenz - siehe codeChangeReviewService.ts's Datei-Kommentar).
  // Ein Neustart der App loescht absichtlich jede ausstehende Review/
  // Freigabe/Rueckmeldung.
  const codeChangeReviews = createCodeChangeReviewRegistry()

  registerIpc({
    db,
    logger,
    appInfo,
    codeChangeReviews,
    // Lazy ausgewertet (siehe registerIpc.ts) - zum Zeitpunkt dieses Aufrufs
    // existiert `mainWindow` (siehe createMainWindow() unten) noch nicht.
    getMainWebContentsId: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null)
  })

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Verhindert, dass Links versehentlich neue BrowserWindows oder
  // eingebettete Webviews oeffnen. Externe Links laufen ausschliesslich
  // ueber shell.openExternal im Standardbrowser (system:openExternal-IPC).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Zusaetzlich zum WindowOpenHandler wird auch die Navigation DES
  // bestehenden Hauptfensters selbst eingeschraenkt: erlaubt ist
  // ausschliesslich die interne Dev-URL (nur im Entwicklungsmodus) bzw. die
  // lokale Renderer-Datei. Jede Navigation zu einer fremden Seite - egal ob
  // durch einen Klick, ein manipuliertes Skript oder sonst eine Quelle
  // ausgeloest - wird verhindert. Es gibt bewusst keinen eingebetteten
  // Browser und keine Login-Funktion; externe Seiten oeffnen weiterhin
  // ausschliesslich ueber das validierte system:openExternal-IPC im
  // Standardbrowser.
  //
  // Die eigentliche Entscheidung liegt in der reinen, ohne Electron
  // testbaren Funktion isNavigationTargetAllowed() (navigationPolicy.ts):
  // exakter Origin-Vergleich fuer die Dev-URL (kein String.startsWith()
  // mehr, das faelschlich auch "http://localhost:5173.evil.example" als
  // Praefix-Treffer erlaubt haette) bzw. exakter Dateipfad-Vergleich fuer
  // den produktiven file://-Fall. Im produktiven Modus ist NUR die lokale
  // Renderer-Datei erlaubt - jede fremde http(s)-Navigation wird geblockt.
  const allowedDevOrigin = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const allowedFileUrl = pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString()
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isNavigationTargetAllowed(url, { allowedDevOrigin, allowedFileUrl })) return
    event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function applyContentSecurityPolicy(): void {
  // Die eigentliche Policy-Erzeugung liegt in der reinen, ohne Electron
  // testbaren Funktion buildContentSecurityPolicy() (contentSecurityPolicy.ts,
  // RC4-DevStartFix) - hier wird nur noch der Modus bestimmt, die Policy
  // erzeugt und der Header gesetzt. Die Produktions-Policy bleibt dabei
  // unveraendert streng; nur im Entwicklungsmodus wird gezielt die fuer
  // Vite React Refresh/HMR noetige Freigabe ergaenzt.
  const rendererUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined

  if (is.dev && !isUsableDevRendererUrl(rendererUrl)) {
    // Kein Absturz und keine breite Freigabe "ins Blaue": es wird auf die
    // sichere, produktionsgleiche Fallback-Policy zurueckgefallen. Der
    // Logger ist an dieser Stelle (vor bootstrap()) noch nicht verfuegbar,
    // daher lokale Konsolenausgabe - bewusst ohne die eigentliche
    // (unkritische, aber nicht benoetigte) URL mitzuloggen.
    // eslint-disable-next-line no-console
    console.warn(
      'Content-Security-Policy: ELECTRON_RENDERER_URL fehlt oder ist ungueltig - verwende sichere, produktionsgleiche Fallback-Policy statt einer Development-Freigabe.'
    )
  }

  const contentSecurityPolicy = buildContentSecurityPolicy({ development: is.dev, rendererUrl })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy]
      }
    })
  })
}

app.whenReady().then(() => {
  applyContentSecurityPolicy()
  bootstrap().catch((error) => {
    // Letzte Absicherung: sollte trotz aller try/catch-Bloecke in
    // bootstrap() doch noch ein unbehandelter Fehler durchrutschen, zeigt
    // auch dieser Pfad einen Dialog statt eines stillen Verschwindens.
    dialog.showErrorBox('Unerwarteter Startfehler', String(error))
    app.exit(1)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
