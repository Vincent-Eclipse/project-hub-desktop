import type Database from 'better-sqlite3'
import {
  AI_ROLES,
  CONTEXT_MARKDOWN_MAX_LENGTH,
  RESPONSE_IMPORT_MAX_LENGTH,
  type NextActor,
  type ParsedResponse,
  type ProjectStatus,
  type ResponseImportApplyInput,
  type ResponseImportApplyResult,
  type ResponseImportAnalyzeInput,
  type ResponseImportAnalyzeResult,
  type ResponseImportRecord,
  type ResponseImportSelectedActions,
  type ResponseImportSource
} from '@shared/types'
import { getProjectById, updateProject, ProjectNotFoundError } from './projectsService'
import { getCurrentContextVersion, createContextVersion } from './contextService'
import { addImportedChatMessage } from './chatService'
import { logEvent } from './eventLogService'
import { parseResponse, PARSER_VERSION } from './responseImportParser'
import { computeResponseImportFingerprint } from './responseImportFingerprint'
import { ResponseImportError } from './responseImportErrors'
import { formatLocalDate } from '../utils/localDate'

// Abschnitt 11 der Vorgabe: der Main-Prozess ist die Vertrauensgrenze. Diese
// beiden Funktionen sind der EINZIGE Weg, wie ein Antwort-Import analysiert
// bzw. tatsaechlich uebernommen wird - der Renderer liefert ausschliesslich
// projectId, source, den unveraenderten Rohtext, den zuletzt gesehenen
// Fingerprint und die vom Nutzer angekreuzten Aktionen. Jedes Parser-
// Ergebnis, jede Statusableitung und jede Fingerprint-Pruefung wird HIER
// (bzw. in den davon aufgerufenen reinen Modulen) erneut vollstaendig
// berechnet, niemals ungeprueft aus dem Renderer uebernommen.

function assertValidSource(source: unknown): asserts source is ResponseImportSource {
  if (!AI_ROLES.includes(source as ResponseImportSource)) {
    throw new ResponseImportError('INVALID_SOURCE', `Unbekannte Quelle: ${String(source)}.`)
  }
}

function assertNonEmptyAndWithinLimit(rawResponse: string): void {
  if (rawResponse.trim().length === 0) {
    throw new ResponseImportError('EMPTY_RESPONSE', 'Die Antwort ist leer.')
  }
  if (rawResponse.length > RESPONSE_IMPORT_MAX_LENGTH) {
    // Absichtlich KEIN Ausschnitt des tatsaechlichen Antworttexts in der
    // Fehlermeldung (Abschnitt 22 der Vorgabe).
    throw new ResponseImportError(
      'RESPONSE_TOO_LARGE',
      `Die Antwort ist zu lang (max. ${RESPONSE_IMPORT_MAX_LENGTH.toLocaleString('de-DE')} Zeichen).`
    )
  }
}

/**
 * Laedt das Projekt fuer einen Import-Vorgang und wirft die dedizierten,
 * fuer Meilenstein 2 vorgegebenen Fehlercodes (PROJECT_NOT_FOUND/
 * PROJECT_ARCHIVED) - bewusst NICHT die generischen
 * ProjectNotFoundError/ProjectArchivedError aus projectsService, deren Codes
 * (Klassenname) nicht mit der in Abschnitt 24 vorgegebenen Liste
 * uebereinstimmen wuerden (siehe DECISIONS.md).
 *
 * RC2-Korrektur (Abschnitt 10 der RC2-Vorgabe): faengt NUR noch den echten
 * ProjectNotFoundError ab. RC1 fing pauschal JEDEN Fehler aus
 * getProjectById() ab und deklarierte ihn faelschlich als
 * PROJECT_NOT_FOUND - ein unerwarteter Datenbank- oder Integritaetsfehler
 * (z. B. ein ContextIntegrityError aus einer defekten current_context_version_id-
 * Referenz) waere damit faelschlich als "Projekt nicht gefunden" erschienen,
 * statt als echter interner Fehler sichtbar zu werden. Ein solcher
 * unerwarteter Fehler laeuft jetzt unveraendert weiter und wird von
 * registerIpc.ts wie jeder andere interne Fehler behandelt (Logging +
 * generischer INTERNAL_ERROR-Code, keine internen Details am Renderer).
 */
function loadProjectForImport(db: Database.Database, projectId: number, requireWritable: boolean): ReturnType<typeof getProjectById> {
  let project: ReturnType<typeof getProjectById>
  try {
    project = getProjectById(db, projectId)
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      throw new ResponseImportError('PROJECT_NOT_FOUND', `Projekt mit ID ${projectId} wurde nicht gefunden.`)
    }
    throw error
  }
  if (requireWritable && project.isArchived) {
    throw new ResponseImportError(
      'PROJECT_ARCHIVED',
      `Projekt "${project.name}" ist archiviert - ein Antwort-Import kann nicht uebernommen werden.`
    )
  }
  return project
}

export function analyzeResponseImport(
  db: Database.Database,
  input: ResponseImportAnalyzeInput
): ResponseImportAnalyzeResult {
  assertValidSource(input.source)
  assertNonEmptyAndWithinLimit(input.rawResponse)

  // requireWritable=false: Archivierte Projekte duerfen weiterhin analysiert
  // (nur betrachtet) werden - erst die Uebernahme ist gesperrt (Abschnitt 14).
  const project = loadProjectForImport(db, input.projectId, false)

  const baseContextVersion = getCurrentContextVersion(db, input.projectId)
  const parsedResult = parseResponse(input.rawResponse)

  const fingerprint = computeResponseImportFingerprint({
    projectId: input.projectId,
    source: input.source,
    rawResponse: input.rawResponse,
    parserVersion: PARSER_VERSION,
    parsedResult,
    baseContextVersionId: baseContextVersion?.id ?? null,
    projectUpdatedAt: project.updatedAt
  })

  // Reine Analyse - garantiert KEIN Schreibzugriff auf die Datenbank
  // (Abschnitt 10 der Vorgabe). Es folgt ab hier keine einzige
  // db.prepare(...).run(...)-Anweisung mehr in dieser Funktion.
  return {
    parsedResult,
    parserVersion: PARSER_VERSION,
    fingerprint,
    baseContextVersionId: baseContextVersion?.id ?? null,
    projectSnapshot: {
      status: project.status,
      currentStep: project.currentStep,
      nextAction: project.nextAction,
      nextActor: project.nextActor
    }
  }
}

function hasAnySelectedAction(selected: ResponseImportSelectedActions): boolean {
  return (
    selected.saveHistory ||
    selected.changeStatus ||
    selected.changeCurrentStep ||
    selected.changeNextAction ||
    selected.changeNextActor ||
    selected.createContextVersion
  )
}

/** true, wenn mindestens eine contextInclude*-Option gesetzt ist - unabhaengig von createContextVersion. */
function hasAnyContextIncludeFlag(selected: ResponseImportSelectedActions): boolean {
  return (
    selected.contextIncludeCompletedWork ||
    selected.contextIncludeChangedFiles ||
    selected.contextIncludeTestResults ||
    selected.contextIncludeOpenItems ||
    selected.contextIncludeBlockers ||
    selected.contextIncludeNextStep
  )
}

interface ContextSelectionPlan {
  shouldCreate: boolean
  markdownAddition: string
}

interface ContextCategoryDef {
  flag: keyof ResponseImportSelectedActions
  title: string
  lines: string[]
}

function contextCategoryDefs(parsed: ParsedResponse): ContextCategoryDef[] {
  return [
    { flag: 'contextIncludeCompletedWork', title: 'Erledigte Arbeiten', lines: parsed.completedWork },
    { flag: 'contextIncludeChangedFiles', title: 'Geänderte Dateien', lines: parsed.changedFiles },
    { flag: 'contextIncludeTestResults', title: 'Testergebnisse', lines: parsed.testResults },
    { flag: 'contextIncludeOpenItems', title: 'Offene Punkte', lines: parsed.openItems },
    { flag: 'contextIncludeBlockers', title: 'Blocker', lines: parsed.blockers },
    { flag: 'contextIncludeNextStep', title: 'Nächster Schritt', lines: parsed.nextStep }
  ]
}

/**
 * Baut die vom Nutzer ausgewaehlten Kontext-Bloecke zusammen.
 *
 * RC3-Korrektur (Abschnitt 6 der RC3-Vorgabe): RC1/RC2 liessen eine
 * ausgewaehlte, aber LEERE Kontext-Kategorie still aus dem resultierenden
 * Markdown-Block heraus, solange mindestens eine ANDERE ausgewaehlte
 * Kategorie Inhalt hatte - das ist nicht mehr zulaessig. Jede einzelne
 * ausgewaehlte Kategorie MUSS mindestens einen Eintrag haben, sonst wird
 * die GESAMTE Uebernahme mit INVALID_SELECTION abgelehnt (auch bereits
 * gefuellte, gleichzeitig ausgewaehlte Kategorien werden dann NICHT
 * teilweise uebernommen).
 */
function planContextSelection(
  selected: ResponseImportSelectedActions,
  parsed: ParsedResponse
): ContextSelectionPlan {
  if (!selected.createContextVersion) return { shouldCreate: false, markdownAddition: '' }

  const blocks: string[] = []
  let anySelected = false

  for (const cat of contextCategoryDefs(parsed)) {
    if (!selected[cat.flag]) continue
    anySelected = true
    if (cat.lines.length === 0) {
      throw new ResponseImportError(
        'INVALID_SELECTION',
        `Der ausgewählte Kontext-Bereich "${cat.title}" enthält keine erkannten Einträge und kann nicht übernommen werden.`
      )
    }
    blocks.push(`### ${cat.title}\n\n${cat.lines.map((l) => `- ${l}`).join('\n')}`)
  }

  // Kein einziger Bereich ausgewaehlt - das ist KEIN INVALID_SELECTION
  // (keine widerspruechliche/fehlerhafte Auswahl), sondern der bereits
  // bestehende Fall "createContextVersion aktiv, aber nichts dafuer
  // ausgewaehlt" (siehe CONTEXT_SELECTION_EMPTY-Pruefung im Aufrufer).
  if (!anySelected) return { shouldCreate: false, markdownAddition: '' }
  return { shouldCreate: true, markdownAddition: blocks.join('\n\n') }
}

function sourceLabel(source: ResponseImportSource): string {
  return source === 'CHATGPT' ? 'ChatGPT' : 'Claude'
}

/**
 * RC3-Korrektur (Abschnitt 3 der RC3-Vorgabe): baut die vollstaendige neue
 * Kontext-Markdown-Zeichenfolge bereits VOR der Transaktion zusammen und
 * prueft ihre Gesamtlaenge gegen CONTEXT_MARKDOWN_MAX_LENGTH
 * (bestehender Kontext + Trennzeichen + Importueberschrift + ausgewaehlte
 * Ergaenzungen). Eine zu lange resultierende Version wird mit
 * CONTEXT_TOO_LARGE abgelehnt, BEVOR irgendeine Datenbankaenderung
 * stattfindet - kein Teil-Commit moeglich.
 */
function prepareContextMarkdown(
  markdownAddition: string,
  baseContentMarkdown: string | null,
  source: ResponseImportSource
): string {
  const baseMarkdown = baseContentMarkdown ?? ''
  const importHeading = `## Import-Update vom ${formatLocalDate(new Date())}\n\nQuelle: ${sourceLabel(
    source
  )}\n\n${markdownAddition}`
  const newMarkdown = baseMarkdown.length > 0 ? `${baseMarkdown}\n\n${importHeading}` : importHeading

  if (newMarkdown.length > CONTEXT_MARKDOWN_MAX_LENGTH) {
    throw new ResponseImportError(
      'CONTEXT_TOO_LARGE',
      `Die resultierende Kontext-Version wäre zu lang (max. ${CONTEXT_MARKDOWN_MAX_LENGTH.toLocaleString('de-DE')} Zeichen).`
    )
  }

  return newMarkdown
}

export function applyResponseImport(
  db: Database.Database,
  input: ResponseImportApplyInput
): ResponseImportApplyResult {
  assertValidSource(input.source)
  assertNonEmptyAndWithinLimit(input.rawResponse)

  // RC4-Korrektur (Abschnitt 2 der RC4-Vorgabe): diese Pruefung laeuft
  // jetzt bewusst VOR NO_ACTION_SELECTED. hasAnySelectedAction() zaehlt
  // contextInclude*-Felder absichtlich NICHT als eigene Top-Level-Aktion
  // (siehe deren Kommentar) - eine Auswahl, die AUSSCHLIESSLICH aus einer
  // contextInclude*-Option ohne aktives createContextVersion besteht,
  // waere dadurch faelschlich als "gar keine Aktion ausgewaehlt"
  // (NO_ACTION_SELECTED) erschienen, obwohl tatsaechlich eine strukturell
  // widerspruechliche Auswahl vorliegt. INVALID_SELECTION ist in diesem
  // Fall immer der korrekte, spezifischere Code - unabhaengig davon, ob
  // zusaetzlich eine gueltige Hauptaktion wie saveHistory ausgewaehlt ist.
  if (!input.selectedActions.createContextVersion && hasAnyContextIncludeFlag(input.selectedActions)) {
    throw new ResponseImportError(
      'INVALID_SELECTION',
      'Ein Kontext-Bereich ist ausgewählt, aber "Neue Kontext-Version erstellen" ist nicht aktiviert.'
    )
  }

  if (!hasAnySelectedAction(input.selectedActions)) {
    throw new ResponseImportError('NO_ACTION_SELECTED', 'Es wurde keine Aktion ausgewählt.')
  }

  const project = loadProjectForImport(db, input.projectId, true)

  // Main-Prozess parst IMMER erneut aus dem mitgegebenen Rohtext - das vom
  // Renderer mitgegebene "parsedResult" existiert im Apply-Request bewusst
  // NICHT (siehe ResponseImportApplyInput) - es gibt keinen Weg, ein frei
  // erfundenes Parser-Ergebnis zu uebergeben.
  const baseContextVersion = getCurrentContextVersion(db, input.projectId)
  const parsedResult = parseResponse(input.rawResponse)

  const currentFingerprint = computeResponseImportFingerprint({
    projectId: input.projectId,
    source: input.source,
    rawResponse: input.rawResponse,
    parserVersion: PARSER_VERSION,
    parsedResult,
    baseContextVersionId: baseContextVersion?.id ?? null,
    projectUpdatedAt: project.updatedAt
  })

  if (currentFingerprint !== input.fingerprint) {
    throw new ResponseImportError(
      'STALE_PREVIEW',
      'Die Vorschau ist nicht mehr aktuell (Projekt oder Kontext haben sich zwischenzeitlich geändert). Bitte erneut analysieren.'
    )
  }

  // RC2-Korrektur (Abschnitt 5 der RC2-Vorgabe): jede ausgewaehlte
  // Metadaten-Aktion wird jetzt STRIKT gegen das frische Parser-Ergebnis
  // geprueft - fehlt ein eindeutiger Wert (weil er gar nicht erkannt wurde
  // ODER weil er mehrdeutig war, siehe responseImportParser.ts), wird die
  // gesamte Uebernahme abgelehnt statt die einzelne Aktion still zu
  // uebergehen (RC1s dokumentierte Einschraenkung eines dadurch moeglichen
  // "funktional leeren" Imports entfaellt dadurch vollstaendig).
  if (input.selectedActions.changeStatus && parsedResult.suggestedStatus === null) {
    throw new ResponseImportError(
      'INVALID_STATUS',
      'Für die ausgewählte Statusänderung wurde kein gültiger, eindeutiger Status erkannt.'
    )
  }
  if (input.selectedActions.changeNextActor && parsedResult.suggestedNextActor === null) {
    throw new ResponseImportError(
      'INVALID_ACTOR',
      'Für die ausgewählte Änderung des nächsten Akteurs wurde kein gültiger, eindeutiger Akteur erkannt.'
    )
  }
  if (
    input.selectedActions.changeCurrentStep &&
    (parsedResult.suggestedCurrentStep === null || parsedResult.suggestedCurrentStep.trim().length === 0)
  ) {
    throw new ResponseImportError(
      'INVALID_CURRENT_STEP',
      'Für die ausgewählte Änderung des aktuellen Schritts wurde kein eindeutiger Wert erkannt.'
    )
  }
  if (
    input.selectedActions.changeNextAction &&
    (parsedResult.suggestedNextAction === null || parsedResult.suggestedNextAction.trim().length === 0)
  ) {
    throw new ResponseImportError(
      'INVALID_NEXT_ACTION',
      'Für die ausgewählte Änderung der nächsten Aktion wurde kein eindeutiger Wert erkannt.'
    )
  }

  // RC3-Korrektur (Abschnitt 2 der RC3-Vorgabe): eine ausgewaehlte
  // Metadaten-Aktion, deren erkannter Wert bereits dem aktuellen
  // Projektwert entspricht, ist wirkungslos und wird jetzt explizit
  // abgelehnt (statt ein unnoetiges PROJECT_UPDATED/RESPONSE_IMPORT_APPLIED
  // zu erzeugen). Der Vergleich fuer currentStep/nextAction nutzt dieselbe
  // trim()-Normalisierung wie projectsService.updateProject().
  if (input.selectedActions.changeStatus && parsedResult.suggestedStatus === project.status) {
    throw new ResponseImportError(
      'NO_EFFECTIVE_CHANGE',
      'Der erkannte Status entspricht bereits dem aktuellen Projektstatus.'
    )
  }
  if (input.selectedActions.changeNextActor && parsedResult.suggestedNextActor === project.nextActor) {
    throw new ResponseImportError(
      'NO_EFFECTIVE_CHANGE',
      'Der erkannte nächste Akteur entspricht bereits dem aktuellen Wert.'
    )
  }
  if (
    input.selectedActions.changeCurrentStep &&
    parsedResult.suggestedCurrentStep !== null &&
    parsedResult.suggestedCurrentStep.trim() === project.currentStep
  ) {
    throw new ResponseImportError(
      'NO_EFFECTIVE_CHANGE',
      'Der erkannte aktuelle Schritt entspricht bereits dem aktuellen Wert.'
    )
  }
  if (
    input.selectedActions.changeNextAction &&
    parsedResult.suggestedNextAction !== null &&
    parsedResult.suggestedNextAction.trim() === project.nextAction
  ) {
    throw new ResponseImportError(
      'NO_EFFECTIVE_CHANGE',
      'Die erkannte nächste Aktion entspricht bereits dem aktuellen Wert.'
    )
  }

  const contextPlan = planContextSelection(input.selectedActions, parsedResult)
  if (input.selectedActions.createContextVersion && !contextPlan.shouldCreate) {
    throw new ResponseImportError(
      'CONTEXT_SELECTION_EMPTY',
      'Es wurde "Neue Kontext-Version erstellen" ausgewählt, aber kein nicht-leerer Kontext-Bereich dafür ausgewählt.'
    )
  }

  // RC3-Korrektur (Abschnitt 3 der RC3-Vorgabe): die vollstaendige
  // resultierende Kontext-Markdown-Laenge wird bereits HIER, vor jeder
  // Datenbankaenderung, geprueft (CONTEXT_TOO_LARGE) - siehe
  // prepareContextMarkdown(). Der fertige String wird unten in der
  // Transaktion unveraendert wiederverwendet (keine doppelte, potenziell
  // abweichende Neuberechnung).
  const plannedContextMarkdown = contextPlan.shouldCreate
    ? prepareContextMarkdown(contextPlan.markdownAddition, baseContextVersion?.contentMarkdown ?? null, input.source)
    : null

  try {
    return db.transaction(() => {
      // 1) Projektmetadaten - nur tatsaechlich ausgewaehlte UND
      //    (bei Status/Akteur bereits oben validierte) Felder. Ein leeres
      //    Patch-Objekt fuehrt in updateProject() zu einem sicheren No-Op.
      const metadataPatch: {
        status?: ProjectStatus
        currentStep?: string
        nextAction?: string
        nextActor?: NextActor
      } = {}
      if (input.selectedActions.changeStatus && parsedResult.suggestedStatus !== null) {
        metadataPatch.status = parsedResult.suggestedStatus
      }
      if (
        input.selectedActions.changeCurrentStep &&
        parsedResult.suggestedCurrentStep !== null &&
        parsedResult.suggestedCurrentStep.trim().length > 0
      ) {
        metadataPatch.currentStep = parsedResult.suggestedCurrentStep
      }
      if (
        input.selectedActions.changeNextAction &&
        parsedResult.suggestedNextAction !== null &&
        parsedResult.suggestedNextAction.trim().length > 0
      ) {
        metadataPatch.nextAction = parsedResult.suggestedNextAction
      }
      if (input.selectedActions.changeNextActor && parsedResult.suggestedNextActor !== null) {
        metadataPatch.nextActor = parsedResult.suggestedNextActor
      }

      if (Object.keys(metadataPatch).length > 0) {
        // Wiederverwendet bewusst die bestehende projectsService.updateProject()
        // statt eigenem SQL (Punkt 34 der Vorgabe: bestehende
        // Architekturkonventionen respektieren) - das erledigt gleichzeitig
        // touch(updated_at) und das gewohnte PROJECT_UPDATED-Ereignis.
        // better-sqlite3 unterstuetzt verschachtelte db.transaction()-Aufrufe
        // automatisch ueber SAVEPOINTs; schlaegt hier etwas fehl, rollt die
        // AEUSSERE Transaktion dieser Funktion vollstaendig zurueck.
        updateProject(db, { id: input.projectId, ...metadataPatch })
      }

      // 2) Verlauf - unveraenderte Originalantwort, bestehender Chat-Service
      //    (RC2-Korrektur: addImportedChatMessage() statt addChatMessage() -
      //    speichert content OHNE trim(), siehe chatService.ts).
      let historyMessageId: number | null = null
      if (input.selectedActions.saveHistory) {
        const message = addImportedChatMessage(db, {
          projectId: input.projectId,
          author: input.source,
          content: input.rawResponse,
          sessionId: input.sessionId
        })
        historyMessageId = message.id
      }

      // 3) Kontext-Version - append-only, bestehender Context-Service. Der
      //    Markdown-Text wurde bereits VOR der Transaktion vollstaendig
      //    zusammengebaut und auf CONTEXT_MARKDOWN_MAX_LENGTH geprueft
      //    (prepareContextMarkdown() oben) - hier nur noch Wiederverwendung.
      let resultContextVersionId: number | null = null
      if (contextPlan.shouldCreate && plannedContextMarkdown !== null) {
        const newVersion = createContextVersion(db, {
          projectId: input.projectId,
          contentMarkdown: plannedContextMarkdown,
          note: `Import von ${sourceLabel(input.source)}`,
          createdBy: input.source
        })
        resultContextVersionId = newVersion.id
      }

      // 4) Importprotokoll - genau eine Zeile, ausschliesslich bei
      //    tatsaechlich bestaetigter Uebernahme (nie bei reiner Analyse,
      //    nie als Entwurf).
      const insertResult = db
        .prepare(
          `INSERT INTO response_imports
            (project_id, source, raw_response, parser_version, parsed_result_json,
             selected_actions_json, base_context_version_id, result_context_version_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.projectId,
          input.source,
          input.rawResponse,
          PARSER_VERSION,
          JSON.stringify(parsedResult),
          JSON.stringify(input.selectedActions),
          baseContextVersion?.id ?? null,
          resultContextVersionId
        )
      const importId = Number(insertResult.lastInsertRowid)

      // 5) Ereignisprotokoll - nur sichere Metadaten, NIE der Rohtext.
      const selectedActionTypes = (Object.keys(input.selectedActions) as Array<keyof ResponseImportSelectedActions>).filter(
        (key) => input.selectedActions[key]
      )
      logEvent(db, {
        projectId: input.projectId,
        type: 'RESPONSE_IMPORT_APPLIED',
        payload: {
          importId,
          source: input.source,
          selectedActionTypes,
          resultContextVersionId
        }
      })

      const refreshedProject = getProjectById(db, input.projectId)
      return {
        importId,
        project: refreshedProject,
        resultContextVersionId,
        historyMessageId
      }
    })()
  } catch (error) {
    if (error instanceof ResponseImportError) throw error
    // Jeder sonstige Fehler waehrend der Transaktion (z. B. eine
    // unerwartete Constraint-Verletzung) fuehrt zu einem vollstaendigen
    // Rollback durch better-sqlite3. RC2-Korrektur (Abschnitt 4 der
    // RC2-Vorgabe): die urspruengliche, moeglicherweise interne SQL-/Pfad-/
    // Constraint-Details enthaltende Fehlermeldung landet NIE in `message`
    // (das haette RC1 getan) - `message` ist immer der feste, sichere Text.
    // Der echte Fehler wird ausschliesslich als `cause` mitgegeben, die
    // registerIpc.ts.toIpcError() NUR lokal an den FileLogger weiterreicht,
    // niemals ueber IPC an den Renderer.
    throw new ResponseImportError(
      'IMPORT_APPLY_FAILED',
      'Die Übernahme ist fehlgeschlagen. Es wurden keine Änderungen gespeichert.',
      error
    )
  }
}

interface ResponseImportRow {
  id: number
  project_id: number
  source: string
  raw_response: string
  parser_version: number
  parsed_result_json: string
  selected_actions_json: string
  base_context_version_id: number | null
  result_context_version_id: number | null
  created_at: string
  applied_at: string
}

function mapRow(row: ResponseImportRow): ResponseImportRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    source: row.source as ResponseImportSource,
    rawResponse: row.raw_response,
    parserVersion: row.parser_version,
    parsedResult: JSON.parse(row.parsed_result_json) as ParsedResponse,
    selectedActions: JSON.parse(row.selected_actions_json) as ResponseImportSelectedActions,
    baseContextVersionId: row.base_context_version_id,
    resultContextVersionId: row.result_context_version_id,
    createdAt: row.created_at,
    appliedAt: row.applied_at
  }
}

/**
 * Nicht ueber IPC exponiert (siehe MILESTONE2-RC1-NOTES.md - kein
 * responseImport:list-Kanal in dieser UI). Wird ausschliesslich von Tests
 * genutzt, um das tatsaechlich gespeicherte Importprotokoll zu verifizieren.
 */
export function getResponseImportById(db: Database.Database, id: number): ResponseImportRecord | null {
  const row = db.prepare('SELECT * FROM response_imports WHERE id = ?').get(id) as ResponseImportRow | undefined
  return row ? mapRow(row) : null
}

export function listResponseImportsForProject(db: Database.Database, projectId: number): ResponseImportRecord[] {
  const rows = db
    .prepare('SELECT * FROM response_imports WHERE project_id = ? ORDER BY id ASC')
    .all(projectId) as ResponseImportRow[]
  return rows.map(mapRow)
}
