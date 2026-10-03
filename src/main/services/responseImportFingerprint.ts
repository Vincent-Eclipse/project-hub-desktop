import { createHash } from 'node:crypto'
import type { ParsedResponse, ResponseImportSource } from '@shared/types'

// Abschnitt 12 der Vorgabe: deterministischer Vorschau-Fingerprint, der bei
// der Uebernahme erneut berechnet und mit dem vom Renderer mitgegebenen
// Wert verglichen wird. Weicht er ab, wird STALE_PREVIEW geworfen und
// nichts uebernommen (siehe responseImportService.ts). Nutzt ausschliesslich
// Node-Bordmittel (node:crypto) - keine neue Abhaengigkeit.

export interface FingerprintInput {
  projectId: number
  source: ResponseImportSource
  rawResponse: string
  parserVersion: number
  parsedResult: ParsedResponse
  baseContextVersionId: number | null
  // Der zuletzt bekannte projects.updated_at-Wert - erkennt zusaetzlich
  // Projektaenderungen, die den Kontext nicht direkt betreffen (z. B. ein
  // Metadatenwechsel durch Leon waehrend die Vorschau offen war).
  projectUpdatedAt: string
}

/**
 * `parsedResult` wird bewusst NICHT eigens sortiert oder normalisiert, bevor
 * es serialisiert wird: parseResponse() baut das Objekt bei jedem Aufruf mit
 * exakt derselben Feldreihenfolge auf (siehe emptyResult() in
 * responseImportParser.ts), JSON.stringify() serialisiert
 * Objektschluessel deshalb bei gleichem Inhalt immer identisch - ein erneuter
 * Parse-Lauf desselben Rohtexts erzeugt daher garantiert denselben String.
 */
export function computeResponseImportFingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify({
    projectId: input.projectId,
    source: input.source,
    rawResponse: input.rawResponse,
    parserVersion: input.parserVersion,
    parsedResult: input.parsedResult,
    baseContextVersionId: input.baseContextVersionId,
    projectUpdatedAt: input.projectUpdatedAt
  })
  return createHash('sha256').update(canonical, 'utf-8').digest('hex')
}
