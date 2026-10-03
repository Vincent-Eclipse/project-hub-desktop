import type { ResponseImportSelectedActions } from '@shared/types'

// Reine, ohne React testbare Logik fuer die Import-Erfolgsmeldung
// (RC4-Korrektur, Abschnitt 6 der RC4-Vorgabe). Kein React-Import, daher
// direkt in Vitest testbar - analog zu utils/responseImportGuard.ts.
//
// RC3-Korrektur (Abschnitt 8 der RC3-Vorgabe, hierher verschoben in RC4):
// die Erfolgsmeldung haengt von den tatsaechlich ausgefuehrten
// Aktionstypen ab, statt immer denselben Text zu zeigen. `selected`
// spiegelt an der Aufrufstelle (ImportTab.tsx) exakt die Aktionen wider,
// die der Main-Prozess soeben erfolgreich (und vollstaendig, keine
// Teiluebernahme) angewendet hat - jede ungueltige oder wirkungslose
// Auswahl haette applyResponseImport() bereits vorher mit einem Fehler
// abgelehnt.
export function buildSuccessMessage(selected: ResponseImportSelectedActions, createdContextVersion: boolean): string {
  const hasHistory = selected.saveHistory
  const hasContext = createdContextVersion
  const hasMetadata =
    selected.changeStatus || selected.changeCurrentStep || selected.changeNextAction || selected.changeNextActor

  if (hasHistory && !hasContext && !hasMetadata) return 'Originalantwort wurde im Verlauf gespeichert.'
  if (hasContext && !hasHistory && !hasMetadata) return 'Import übernommen und neue Kontext-Version erstellt.'
  if (hasMetadata && !hasHistory && !hasContext) return 'Import übernommen und Projektinformationen aktualisiert.'
  if (hasHistory && hasContext && !hasMetadata) return 'Originalantwort gespeichert und neue Kontext-Version erstellt.'
  return 'Import wurde erfolgreich übernommen.'
}
