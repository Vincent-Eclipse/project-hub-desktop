import { useRef, useState } from 'react'
import {
  PROJECT_SHORT_FIELD_MAX_LENGTH,
  RESPONSE_IMPORT_MAX_LENGTH,
  type Project,
  type ResponseImportAnalyzeResult,
  type ResponseImportProjectSnapshot,
  type ResponseImportSelectedActions,
  type ResponseImportSource
} from '@shared/types'
import { errorDetail, unwrap, ApiError } from '../../api/client'
import { useAppStore } from '../../state/store'
import { NEXT_ACTOR_LABELS, STATUS_LABELS } from '../StatusBadge'
import { canApplySelection, createEmptySelection, hasContextCategorySelected, isAnalysisResultRelevant, isPreviewStale } from '../../utils/responseImportGuard'
import { buildSuccessMessage } from '../../utils/responseImportMessages'
import { LatestRequestGuard } from '../../utils/requestGuard'

const SOURCE_LABELS: Record<ResponseImportSource, string> = { CHATGPT: 'ChatGPT', CLAUDE: 'Claude' }

interface CategoryDef {
  key: keyof ResponseImportAnalyzeResult['parsedResult'] &
    ('completedWork' | 'changedFiles' | 'testResults' | 'openItems' | 'blockers' | 'nextStep')
  flag: keyof ResponseImportSelectedActions
  title: string
}

const CONTEXT_CATEGORIES: CategoryDef[] = [
  { key: 'completedWork', flag: 'contextIncludeCompletedWork', title: 'Erledigte Arbeiten' },
  { key: 'changedFiles', flag: 'contextIncludeChangedFiles', title: 'Geänderte Dateien' },
  { key: 'testResults', flag: 'contextIncludeTestResults', title: 'Testergebnisse' },
  { key: 'openItems', flag: 'contextIncludeOpenItems', title: 'Offene Punkte' },
  { key: 'blockers', flag: 'contextIncludeBlockers', title: 'Blocker' },
  { key: 'nextStep', flag: 'contextIncludeNextStep', title: 'Nächster Schritt' }
]

export function ImportTab({ project }: { project: Project }): JSX.Element {
  const { loadProjects } = useAppStore()
  const [source, setSource] = useState<ResponseImportSource>('CHATGPT')
  const [rawResponse, setRawResponse] = useState('')
  const [analysis, setAnalysis] = useState<ResponseImportAnalyzeResult | null>(null)
  const [analyzedRawResponse, setAnalyzedRawResponse] = useState<string | null>(null)
  // RC2-Korrektur (Abschnitt 6 der RC2-Vorgabe): die Quelle, mit der zuletzt
  // ANALYSIERT wurde - wird zusammen mit dem Rohtext fuer die
  // Veraltet-Erkennung verglichen (isPreviewStale()).
  const [analyzedSource, setAnalyzedSource] = useState<ResponseImportSource | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ResponseImportSelectedActions>(createEmptySelection())
  const [successNotice, setSuccessNotice] = useState<string | null>(null)

  // RC4-Korrektur (Abschnitt 5 der RC4-Vorgabe): schuetzt gegen eine
  // veraltete, asynchron noch laufende Analyse, die nach einem
  // Quellenwechsel oder einer Rohtextaenderung verspaetet zurueckkommt und
  // sich sonst faelschlich ueber den bereits zurueckgesetzten Zustand
  // schreiben wuerde. Ein reiner isPreviewStale()-Vergleich reicht dafuer
  // NICHT aus, da er erst NACH dem (fehlerhaften) Zuruecksetzen von
  // analysis/analyzedRawResponse/analyzedSource greifen wuerde - das
  // Ergebnis darf gar nicht erst uebernommen werden. Dieselbe Guard-Klasse
  // wie in ProjectDetailShell.tsx (Projektwechsel-Schutz).
  const analyzeGuardRef = useRef<LatestRequestGuard | null>(null)
  if (analyzeGuardRef.current === null) analyzeGuardRef.current = new LatestRequestGuard()
  // Spiegeln source/rawResponse als Ref, damit ein spaeter aufgeloestes
  // Promise den WIRKLICH aktuellen Stand vergleichen kann (ein im Promise-
  // Callback erfasster `source`/`rawResponse`-Wert waere sonst der Stand
  // zum Startzeitpunkt der Analyse, nicht der aktuelle - klassische
  // React-Closure-Falle).
  const sourceRef = useRef(source)
  sourceRef.current = source
  const rawResponseRef = useRef(rawResponse)
  rawResponseRef.current = rawResponse
  // RC5-Korrektur (Abschnitt 3 der RC5-Vorgabe): zusaetzliche, von der
  // key-basierten Remount-Absicherung in ProjectDetailShell.tsx
  // UNABHAENGIGE Verteidigungsebene direkt in der Relevanzpruefung selbst.
  const projectIdRef = useRef(project.id)
  projectIdRef.current = project.id

  if (project.isArchived) {
    return (
      <div style={{ maxWidth: 720 }}>
        <div className="banner banner-info">
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Dieses Projekt ist archiviert</div>
            <div className="text-muted">
              Der Import-Tab ist bei archivierten Projekten schreibgeschützt. Es kann keine neue Antwort
              analysiert oder übernommen werden. Stelle das Projekt in der Übersicht wieder her, um
              strukturierte Antworten zu importieren.
            </div>
          </div>
        </div>
      </div>
    )
  }

  const charCount = rawResponse.length
  const overLimit = charCount > RESPONSE_IMPORT_MAX_LENGTH
  const stale = isPreviewStale(analyzedRawResponse, rawResponse, analyzedSource, source)
  const parsed = analysis?.parsedResult ?? null
  // RC2-Korrektur (Abschnitt 6 der RC2-Vorgabe): Vorher-Werte fuer die
  // Metadaten-Vorschau kommen aus der Momentaufnahme, die analyze() zum
  // Analysezeitpunkt zurueckgegeben hat - NICHT aus dem live `project`-Prop,
  // das sich waehrend einer offenen Vorschau (z. B. durch einen parallelen
  // Store-Refresh) bereits weiterentwickelt haben koennte.
  const before: ResponseImportProjectSnapshot = analysis?.projectSnapshot ?? {
    status: project.status,
    currentStep: project.currentStep,
    nextAction: project.nextAction,
    nextActor: project.nextActor
  }

  function resetAnalysisState(): void {
    setAnalysis(null)
    setAnalyzedRawResponse(null)
    setAnalyzedSource(null)
    setSelected(createEmptySelection())
  }

  function handleSourceChange(next: ResponseImportSource): void {
    if (next === source) return
    // RC5-Korrektur (Abschnitt 2 der RC5-Vorgabe): die vorherige RC4-
    // Absicherung aktualisierte sourceRef/rawResponseRef erst waehrend des
    // naechsten React-Renders - das liess ein enges Race-Fenster offen
    // (setState aufgerufen, aber React hat noch nicht neu gerendert, eine
    // laufende Analyse kommt in genau diesem Moment zurueck und sieht noch
    // die alten Ref-Werte). Ref-Aktualisierung UND Ticket-Invalidierung
    // laufen deshalb jetzt SOFORT und SYNCHRON, noch vor jedem
    // React-State-Update:
    sourceRef.current = next
    analyzeGuardRef.current!.invalidate()
    setIsAnalyzing(false)
    // Erst DANACH der eigentliche React-State - unveraendert wie bisher:
    // ein Quellenwechsel verwirft die bestehende Analyse/Auswahl sofort
    // und sichtbar, der Rohtext selbst bleibt bewusst erhalten.
    // isPreviewStale() vergleicht zusaetzlich analysierte und aktuelle
    // Quelle als weitere Absicherung.
    setSource(next)
    resetAnalysisState()
    setError(null)
    setSuccessNotice(null)
  }

  function handleRawResponseChange(value: string): void {
    // RC5-Korrektur (Abschnitt 2 der RC5-Vorgabe): dieselbe sofortige,
    // synchrone Invalidierung wie bei handleSourceChange oben - eine
    // laufende Analyse fuer den ALTEN Text darf nach einer Aenderung nie
    // mehr zurueckgeschrieben werden. Im Unterschied zum Quellenwechsel
    // wird `analysis`/`analyzedRawResponse`/`analyzedSource` hier NICHT
    // zurueckgesetzt - eine bereits ABGESCHLOSSENE Analyse bleibt als
    // (durch isPreviewStale() erkennbar veraltete) Vorschau sichtbar
    // erhalten, nur eine noch LAUFENDE Analyse wird verworfen.
    rawResponseRef.current = value
    analyzeGuardRef.current!.invalidate()
    setIsAnalyzing(false)
    setRawResponse(value)
    setSuccessNotice(null)
  }

  async function handleAnalyze(): Promise<void> {
    setError(null)
    setSuccessNotice(null)
    if (rawResponse.trim().length === 0) {
      setError('Bitte zuerst eine Antwort einfügen, bevor analysiert werden kann.')
      return
    }
    if (overLimit) {
      setError(`Die Antwort ist zu lang (max. ${RESPONSE_IMPORT_MAX_LENGTH.toLocaleString('de-DE')} Zeichen).`)
      return
    }

    const requestedProjectId = project.id
    const requestedSource = source
    const requestedRawResponse = rawResponse
    const ticket = analyzeGuardRef.current!.start()

    // Ist eine Antwort noch relevant? Nur wenn sie (a) das zuletzt
    // vergebene, nicht zwischenzeitlich invalidierte Ticket traegt UND
    // (b) Projekt-ID/Quelle/Rohtext seit dem Start dieser Analyse
    // unveraendert geblieben sind - das deckt sowohl "waehrenddessen
    // erneut analysiert" als auch "waehrenddessen Quelle/Text/Projekt
    // gewechselt, aber noch nicht neu analysiert" ab. isCurrentTicket
    // allein steuert zusaetzlich separat isAnalyzing: aendert sich nur
    // Quelle/Text (ohne dass eine NEUE Analyse gestartet wird), bleibt das
    // Ticket ab RC5 durch invalidate() bereits ungueltig - der Ladezustand
    // wird zusaetzlich bereits synchron in handleSourceChange()/
    // handleRawResponseChange() beendet, diese Pruefung hier ist die
    // zweite, unabhaengige Absicherung fuer den Fall, dass die Antwort
    // dennoch schon unterwegs war.
    function isCurrentTicket(): boolean {
      return analyzeGuardRef.current!.isCurrent(ticket)
    }
    function isStillRelevant(): boolean {
      return isAnalysisResultRelevant({
        isCurrentTicket: isCurrentTicket(),
        requestedProjectId,
        currentProjectId: projectIdRef.current,
        requestedSource,
        currentSource: sourceRef.current,
        requestedRawResponse,
        currentRawResponse: rawResponseRef.current
      })
    }

    setIsAnalyzing(true)
    try {
      const result = await unwrap(
        window.eclipseHub.responseImport.analyze({ projectId: project.id, source: requestedSource, rawResponse: requestedRawResponse })
      )
      if (!isStillRelevant()) return
      setAnalysis(result)
      setAnalyzedRawResponse(requestedRawResponse)
      setAnalyzedSource(requestedSource)
      setSelected(createEmptySelection())
    } catch (err) {
      if (!isStillRelevant()) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (isCurrentTicket()) setIsAnalyzing(false)
    }
  }

  function toggle(flag: keyof ResponseImportSelectedActions): void {
    setSelected((current) => {
      const next = { ...current, [flag]: !current[flag] }
      // RC3-Korrektur (Abschnitt 5 der RC3-Vorgabe): wird die Hauptoption
      // "Neue Kontext-Version erstellen" deaktiviert, muessen alle
      // Kontext-Unterauswahlen SOFORT mit zurueckgesetzt werden - sonst
      // blieben sie intern aktiv, aber unsichtbar (die Unteroptionen werden
      // nur angezeigt, solange createContextVersion aktiv ist).
      if (flag === 'createContextVersion' && !next.createContextVersion) {
        next.contextIncludeCompletedWork = false
        next.contextIncludeChangedFiles = false
        next.contextIncludeTestResults = false
        next.contextIncludeOpenItems = false
        next.contextIncludeBlockers = false
        next.contextIncludeNextStep = false
      }
      return next
    })
  }

  async function handleApply(): Promise<void> {
    if (!analysis || stale) return
    setError(null)
    setIsApplying(true)
    try {
      const result = await unwrap(
        window.eclipseHub.responseImport.apply({
          projectId: project.id,
          source,
          rawResponse,
          fingerprint: analysis.fingerprint,
          selectedActions: selected
        })
      )
      await loadProjects()
      setSuccessNotice(buildSuccessMessage(selected, result.resultContextVersionId !== null))
      setRawResponse('')
      resetAnalysisState()
    } catch (err) {
      // RC3-Korrektur (Abschnitt 8 der RC3-Vorgabe): eine ApiError-Meldung
      // kommt bereits sicher und vollstaendig formuliert aus dem
      // Main-Prozess (z. B. "Die Übernahme ist fehlgeschlagen. Es wurden
      // keine Änderungen gespeichert." oder "Ein interner Fehler ist
      // aufgetreten.") - sie wird UNVERAENDERT angezeigt, nicht mit einem
      // zusaetzlichen Renderer-Praefix verdoppelt. Nur ein echter,
      // unbekannter Renderer-/Netzwerkfehler (keine ApiError-Instanz)
      // bekommt die generische Fallback-Meldung.
      if (err instanceof ApiError) {
        if (err.code === 'STALE_PREVIEW') resetAnalysisState()
        setError(err.message)
      } else {
        setError('Die Übernahme ist fehlgeschlagen.' + errorDetail(err))
      }
    } finally {
      setIsApplying(false)
    }
  }

  const canApply =
    analysis !== null &&
    canApplySelection({
      hasAnalysis: analysis !== null,
      isStale: stale,
      isProjectArchived: project.isArchived,
      selected
    })

  return (
    <div style={{ maxWidth: 880 }}>
      {successNotice && (
        <div className="banner banner-info" style={{ marginBottom: 16 }}>
          {successNotice}
        </div>
      )}

      {/* Schritt 1: Quelle auswählen */}
      <StepLabel n={1} title="Quelle auswählen" />
      <div
        role="radiogroup"
        aria-label="Antwortquelle"
        className="row"
        style={{
          gap: 8,
          marginBottom: 20,
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          padding: 4,
          width: 'fit-content'
        }}
      >
        {(['CHATGPT', 'CLAUDE'] as ResponseImportSource[]).map((s) => (
          <button
            key={s}
            role="radio"
            aria-checked={source === s}
            onClick={() => handleSourceChange(s)}
            className="btn"
            style={{
              border: 'none',
              background: source === s ? 'var(--color-accent)' : 'transparent',
              color: source === s ? '#fff' : 'var(--color-text-muted)'
            }}
          >
            {SOURCE_LABELS[s]}
          </button>
        ))}
      </div>

      {/* Schritt 2: Antwort einfügen und analysieren */}
      <StepLabel n={2} title="Antwort einfügen und analysieren" />
      <label className="field">
        <textarea
          value={rawResponse}
          onChange={(e) => handleRawResponseChange(e.target.value)}
          placeholder="Vollständige Antwort von ChatGPT oder Claude hier einfügen…"
          rows={10}
        />
      </label>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <span
          className={overLimit ? 'text-sm' : 'text-sm text-muted'}
          style={overLimit ? { color: 'var(--color-danger)' } : undefined}
        >
          {charCount.toLocaleString('de-DE')} / {RESPONSE_IMPORT_MAX_LENGTH.toLocaleString('de-DE')} Zeichen
          {overLimit ? ' – Limit überschritten' : ''}
        </span>
        <button
          className="btn btn-primary"
          onClick={handleAnalyze}
          disabled={isAnalyzing || rawResponse.trim().length === 0 || overLimit}
        >
          {isAnalyzing ? 'Analysiert…' : 'Inhalt analysieren'}
        </button>
      </div>

      {error && (
        <div className="banner banner-danger" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {!parsed && !error && (
        <div className="empty-state" style={{ marginBottom: 16 }}>
          <div className="empty-state-icon" aria-hidden="true">
            📥
          </div>
          <div className="empty-state-title">Noch keine Analyse</div>
          <div className="empty-state-text">
            Füge oben eine Antwort ein und klicke auf „Inhalt analysieren“. Die Analyse läuft
            vollständig lokal - es wird nichts gespeichert oder verändert, bevor du die gewünschten
            Änderungen unten ausdrücklich bestätigst.
          </div>
        </div>
      )}

      {parsed && stale && (
        <div className="banner banner-warning" style={{ marginBottom: 16 }}>
          {analyzedSource !== null && analyzedSource !== source
            ? 'Die Quelle wurde nach der letzten Analyse gewechselt.'
            : 'Der Text wurde nach der letzten Analyse verändert.'}{' '}
          Bitte erneut analysieren, bevor du Änderungen übernimmst.
        </div>
      )}

      {parsed && (
        <>
          {/* Schritt 3: Erkannte Inhalte prüfen (reine Anzeige) */}
          <StepLabel n={3} title="Erkannte Inhalte prüfen" />
          <div className="two-column" style={{ marginBottom: 20 }}>
            <div style={{ flex: 1, minWidth: 0, gap: 8 }} className="stack">
              {CONTEXT_CATEGORIES.map((cat) => (
                <CategoryCard key={cat.key} title={cat.title} lines={parsed[cat.key]} />
              ))}
              {parsed.summary.length > 0 && <CategoryCard title="Zusammenfassung" lines={parsed.summary} />}
              <CategoryCard title="Nicht zugeordnet" lines={parsed.unassigned} muted />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="text-xs text-faint"
                style={{ textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}
              >
                Originalantwort
              </div>
              <textarea readOnly value={rawResponse} rows={16} className="textarea-code" />
            </div>
          </div>

          {/* Schritt 4: Änderungen auswählen */}
          <StepLabel n={4} title="Änderungen auswählen" />

          <div className="field" style={{ marginBottom: 20 }}>
            <label className="row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={selected.saveHistory}
                onChange={() => toggle('saveHistory')}
                disabled={stale}
                style={{ width: 'auto' }}
              />
              <span>Originalantwort im Verlauf speichern (unverändert)</span>
            </label>
          </div>

          <MetadataSuggestion
            label="Status"
            before={STATUS_LABELS[before.status] ?? before.status}
            after={parsed.suggestedStatus ? STATUS_LABELS[parsed.suggestedStatus] : null}
            rawFallback={parsed.suggestedStatusRaw}
            ambiguous={parsed.suggestedStatusAmbiguous}
            tooLong={false}
            candidates={parsed.suggestedStatusCandidates}
            isNoOp={parsed.suggestedStatus !== null && parsed.suggestedStatus === before.status}
            checked={selected.changeStatus}
            disabled={
              stale || parsed.suggestedStatus === null || (parsed.suggestedStatus !== null && parsed.suggestedStatus === before.status)
            }
            onToggle={() => toggle('changeStatus')}
          />
          <MetadataSuggestion
            label="Aktueller Schritt"
            before={before.currentStep || '–'}
            after={parsed.suggestedCurrentStep}
            rawFallback={null}
            ambiguous={parsed.suggestedCurrentStepAmbiguous}
            tooLong={parsed.suggestedCurrentStepTooLong}
            candidates={parsed.suggestedCurrentStepCandidates}
            isNoOp={parsed.suggestedCurrentStep !== null && parsed.suggestedCurrentStep === before.currentStep}
            checked={selected.changeCurrentStep}
            disabled={
              stale ||
              !parsed.suggestedCurrentStep ||
              (parsed.suggestedCurrentStep !== null && parsed.suggestedCurrentStep === before.currentStep)
            }
            onToggle={() => toggle('changeCurrentStep')}
          />
          <MetadataSuggestion
            label="Nächste Aktion"
            before={before.nextAction || '–'}
            after={parsed.suggestedNextAction}
            rawFallback={null}
            ambiguous={parsed.suggestedNextActionAmbiguous}
            tooLong={parsed.suggestedNextActionTooLong}
            candidates={parsed.suggestedNextActionCandidates}
            isNoOp={parsed.suggestedNextAction !== null && parsed.suggestedNextAction === before.nextAction}
            checked={selected.changeNextAction}
            disabled={
              stale ||
              !parsed.suggestedNextAction ||
              (parsed.suggestedNextAction !== null && parsed.suggestedNextAction === before.nextAction)
            }
            onToggle={() => toggle('changeNextAction')}
          />
          <MetadataSuggestion
            label="Nächster Akteur"
            before={NEXT_ACTOR_LABELS[before.nextActor]}
            after={parsed.suggestedNextActor ? NEXT_ACTOR_LABELS[parsed.suggestedNextActor] : null}
            rawFallback={parsed.suggestedNextActorRaw}
            ambiguous={parsed.suggestedNextActorAmbiguous}
            tooLong={false}
            candidates={parsed.suggestedNextActorCandidates}
            isNoOp={parsed.suggestedNextActor !== null && parsed.suggestedNextActor === before.nextActor}
            checked={selected.changeNextActor}
            disabled={
              stale ||
              parsed.suggestedNextActor === null ||
              (parsed.suggestedNextActor !== null && parsed.suggestedNextActor === before.nextActor)
            }
            onToggle={() => toggle('changeNextActor')}
          />

          <div className="card" style={{ marginTop: 20, marginBottom: 20 }}>
            <label className="row" style={{ gap: 8, marginBottom: selected.createContextVersion ? 12 : 0 }}>
              <input
                type="checkbox"
                checked={selected.createContextVersion}
                onChange={() => toggle('createContextVersion')}
                disabled={stale}
                style={{ width: 'auto' }}
              />
              <span style={{ fontWeight: 600 }}>Neue Kontext-Version erstellen</span>
            </label>
            {selected.createContextVersion && (
              <div className="stack" style={{ gap: 8, paddingLeft: 26 }}>
                {CONTEXT_CATEGORIES.map((cat) => {
                  const lines = parsed[cat.key]
                  return (
                    <label key={cat.key} className="row" style={{ gap: 8, opacity: lines.length === 0 ? 0.5 : 1 }}>
                      <input
                        type="checkbox"
                        checked={selected[cat.flag]}
                        onChange={() => toggle(cat.flag)}
                        disabled={stale || lines.length === 0}
                        style={{ width: 'auto' }}
                      />
                      <span>
                        {cat.title} ({lines.length})
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          {/* Schritt 5: Auswirkungen bestätigen und übernehmen */}
          <StepLabel n={5} title="Auswirkungen bestätigen und übernehmen" />
          <ApplySummary before={before} parsed={parsed} selected={selected} source={source} />

          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" onClick={handleApply} disabled={!canApply || isApplying}>
              {isApplying ? 'Übernimmt…' : 'Ausgewählte Änderungen übernehmen'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function StepLabel({ n, title }: { n: number; title: string }): JSX.Element {
  return (
    <div className="text-xs text-faint" style={{ textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
      Schritt {n}: {title}
    </div>
  )
}

function CategoryCard({ title, lines, muted }: { title: string; lines: string[]; muted?: boolean }): JSX.Element | null {
  if (lines.length === 0) return null
  return (
    <div className="card text-break" style={{ padding: '10px 14px' }}>
      <div className={muted ? 'text-sm text-muted' : 'text-sm'} style={{ fontWeight: 600, marginBottom: 6 }}>
        {title}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {lines.map((line, idx) => (
          <li key={idx} className="text-sm">
            {line}
          </li>
        ))}
      </ul>
    </div>
  )
}

function MetadataSuggestion({
  label,
  before,
  after,
  rawFallback,
  ambiguous,
  tooLong,
  candidates,
  isNoOp,
  checked,
  disabled,
  onToggle
}: {
  label: string
  before: string
  after: string | null
  rawFallback: string | null
  ambiguous: boolean
  tooLong: boolean
  candidates: string[]
  isNoOp: boolean
  checked: boolean
  disabled: boolean
  onToggle: () => void
}): JSX.Element | null {
  if (after === null && rawFallback === null && !ambiguous && !tooLong) return null
  return (
    <div className="field" style={{ marginBottom: 10 }}>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} style={{ width: 'auto' }} />
        <span className="text-break">
          <strong>{label}:</strong>{' '}
          {isNoOp ? (
            <span className="text-muted">Dieser Wert ist bereits gesetzt.</span>
          ) : tooLong ? (
            <span className="text-muted">
              „{candidates[0]}“ ist zu lang (max. {PROJECT_SHORT_FIELD_MAX_LENGTH} Zeichen) - kann nicht als
              Änderung übernommen werden
            </span>
          ) : ambiguous ? (
            <span className="text-muted">
              mehrdeutig ({candidates.map((c) => `„${c}“`).join(' vs. ')}) - kann nicht als Änderung
              übernommen werden
            </span>
          ) : after !== null ? (
            <>
              {before} <span aria-hidden="true">→</span> {after}
            </>
          ) : (
            <span className="text-muted">
              „{rawFallback}“ nicht eindeutig erkannt - kann nicht als Änderung übernommen werden
            </span>
          )}
        </span>
      </label>
    </div>
  )
}

function ApplySummary({
  before,
  parsed,
  selected,
  source
}: {
  before: ResponseImportProjectSnapshot
  parsed: ResponseImportAnalyzeResult['parsedResult']
  selected: ResponseImportSelectedActions
  source: ResponseImportSource
}): JSX.Element {
  const lines: string[] = []
  if (selected.saveHistory) {
    lines.push(`Originalantwort von ${SOURCE_LABELS[source]} wird unverändert im Verlauf gespeichert.`)
  }
  if (selected.changeStatus && parsed.suggestedStatus) {
    lines.push(`Status: ${STATUS_LABELS[before.status]} → ${STATUS_LABELS[parsed.suggestedStatus]}`)
  }
  if (selected.changeCurrentStep && parsed.suggestedCurrentStep) {
    lines.push(`Aktueller Schritt: ${before.currentStep || '–'} → ${parsed.suggestedCurrentStep}`)
  }
  if (selected.changeNextAction && parsed.suggestedNextAction) {
    lines.push(`Nächste Aktion: ${before.nextAction || '–'} → ${parsed.suggestedNextAction}`)
  }
  if (selected.changeNextActor && parsed.suggestedNextActor) {
    lines.push(`Nächster Akteur: ${NEXT_ACTOR_LABELS[before.nextActor]} → ${NEXT_ACTOR_LABELS[parsed.suggestedNextActor]}`)
  }
  if (selected.createContextVersion && hasContextCategorySelected(selected)) {
    const included = CONTEXT_CATEGORIES.filter((c) => selected[c.flag] && parsed[c.key].length > 0).map((c) => c.title)
    lines.push(`Neue Kontext-Version wird erstellt (${included.join(', ')}).`)
  }

  if (lines.length === 0) {
    return <div className="text-sm text-muted">Noch keine Aktion ausgewählt - es würde nichts übernommen.</div>
  }

  return (
    <div className="card text-break" style={{ padding: '10px 14px' }}>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {lines.map((line, idx) => (
          <li key={idx} className="text-sm">
            {line}
          </li>
        ))}
      </ul>
    </div>
  )
}
