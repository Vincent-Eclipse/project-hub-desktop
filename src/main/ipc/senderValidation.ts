// Meilenstein 4.8A Teil P - kleine, dedizierte Sender-Identitaets-Pruefung
// NUR fuer die neuen Review-Entscheidungs-Kanaele (approve/requestChanges,
// und - da Quelltext sensibel ist - auch list/get). Bewusst KEIN generisches
// Authentifizierungs-Framework, KEINE Aenderung an jedem bestehenden
// IPC-Kanal.
//
// Reine, ohne Electron testbare Funktion (analog navigationPolicy.ts) - der
// eigentliche Electron-Aufruf (ipcMainInvokeEvent.sender/.senderFrame) lebt
// ausschliesslich in registerIpc.ts, das diese Funktion mit den bereits aus
// dem echten Event extrahierten primitiven Werten aufruft.

export interface TrustedSenderCheck {
  /** WebContents-ID des tatsaechlichen Senders dieses IPC-Aufrufs. */
  senderId: number
  /** true, wenn `event.senderFrame === event.sender.mainFrame` (kein Subframe/Iframe). */
  senderFrameIsMainFrame: boolean
  /** true, wenn der sendende WebContents bereits zerstoert ist. */
  senderIsDestroyed: boolean
  /** WebContents-ID des registrierten Eclipse-Project-Hub-Hauptfensters, oder `null`, falls (noch) kein Fenster existiert. */
  expectedWebContentsId: number | null
}

/**
 * Liefert `true` ausschliesslich fuer einen IPC-Aufruf vom TOP-LEVEL-Frame
 * des tatsaechlich registrierten Hauptfensters. Lehnt ab: kein registriertes
 * Fenster, ein zerstoerter Sender, ein Sender mit abweichender WebContents-ID
 * (ein fremdes/geforgtes Fenster), und jeden Aufruf aus einem Subframe/Iframe
 * (selbst innerhalb desselben WebContents).
 */
export function isTrustedTopLevelSender(check: TrustedSenderCheck): boolean {
  if (check.expectedWebContentsId === null) return false
  if (check.senderIsDestroyed) return false
  if (check.senderId !== check.expectedWebContentsId) return false
  if (!check.senderFrameIsMainFrame) return false
  return true
}
