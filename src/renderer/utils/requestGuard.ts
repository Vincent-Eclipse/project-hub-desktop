// Reine Zustandsmaschine fuer den "nur die neueste Anfrage gewinnt"-Schutz
// gegen Race Conditions bei schnell aufeinanderfolgenden asynchronen
// Ladevorgaengen (RC4, Punkt 11 - z. B. Projektwechsel A -> B -> A). Kein
// React-Import, daher ohne Rendering in Vitest testbar.
//
// Ein reiner Vergleich der projectId reicht fuer den A-B-A-Fall NICHT aus:
// beide Anfragen fuer A tragen dieselbe ID, ein ID-Vergleich allein kann die
// erste (veraltete) von der zweiten (aktuellen) A-Anfrage nicht
// unterscheiden. Ein monoton steigender Zaehler ("Generation") loest das:
// jede neue Anfrage bekommt ein hoeheres Ticket, nur das zuletzt vergebene
// Ticket gilt beim Aufloesen noch als aktuell.
export class LatestRequestGuard {
  private generation = 0

  /** Vor dem Start eines neuen asynchronen Ladevorgangs aufrufen. Liefert ein Ticket fuer diesen Ladevorgang. */
  start(): number {
    this.generation += 1
    return this.generation
  }

  /** Liefert true, wenn `ticket` noch dem zuletzt gestarteten Ladevorgang entspricht (also nicht durch einen neueren Aufruf ueberholt wurde). */
  isCurrent(ticket: number): boolean {
    return ticket === this.generation
  }

  /**
   * RC5-Korrektur (Abschnitt 2 der RC5-Vorgabe): macht JEDES aktuell
   * ausstehende Ticket sofort und deterministisch ungueltig, OHNE selbst
   * einen neuen fachlichen Request zu starten. Wird verwendet, wenn ein
   * Ereignis (z. B. ein Quellenwechsel oder eine Rohtextaenderung
   * waehrend einer laufenden Analyse) eine laufende Anfrage invalidieren
   * soll, aber noch keine neue Anfrage tatsaechlich beginnt - im
   * Unterschied zu `start()`, das ein neues, gueltiges Ticket fuer eine
   * WIRKLICH neu gestartete Anfrage vergibt. Monoton: jeder Aufruf erhoeht
   * `generation` genau wie `start()`, sodass wiederholtes Invalidieren
   * deterministisch bleibt und niemals ein altes Ticket reaktiviert.
   */
  invalidate(): void {
    this.generation += 1
  }
}
