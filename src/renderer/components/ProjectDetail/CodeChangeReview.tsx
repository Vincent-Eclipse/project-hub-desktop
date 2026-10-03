import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import {
  CODE_CHANGE_REVIEW_FEEDBACK_MAX_BYTES,
  type CodeChangeReviewFile,
  type CodeChangeReviewFormatInfo,
  type CodeChangeReviewProjection,
  type CodeChangeReviewState
} from '@shared/codeChangeReviewTypes'
import { canApproveReview, canRequestChanges, createCodeChangeReviewStore } from '../../state/codeChangeReviewStore'
import { DiffView } from '../DiffView'

// Meilenstein 4.8A - Review-Panel, eingebettet in die bestehende Work-
// Ansicht (siehe WorkTab.tsx) statt eines neuen globalen Navigations-Tabs.
//
// WICHTIG (siehe M4.8A-Vorgabe Teil U): es gibt hier bewusst KEINEN Button,
// der eine Review ERSTELLT - Review-Erstellung ist Main-internal only (kein
// IPC-Kanal existiert dafuer), weil die produktive Herkunft von
// filesystem.read-Policy/RunTrustedScope/ClaudeDisclosureScope fuer eine
// echte Claude-Vorschlagsgenerierung noch nicht entschieden ist. Dieses
// Panel zeigt AUSSCHLIESSLICH bereits ueber einen Main-internen/Test-Pfad
// erstellte Reviews an. KEIN Apply-Button, KEIN "Tests ausfuehren"-Button,
// KEIN Git-Commit-Button, KEIN Policy-Editor.

const STATE_LABELS: Record<CodeChangeReviewState, string> = {
  PENDING: 'Ausstehend',
  APPROVED: 'Freigegeben',
  CHANGES_REQUESTED: 'Änderungen angefordert'
}

function formatInfo(format: CodeChangeReviewFormatInfo | null): string {
  if (!format) return 'nicht vorhanden (neue Datei)'
  const bom = format.utf8Bom ? 'mit BOM' : 'ohne BOM'
  const newline = format.finalNewline ? 'mit Endzeile' : 'ohne Endzeile'
  return `${format.lineEnding} · ${bom} · ${newline} · ${format.byteLength.toLocaleString('de-DE')} Bytes`
}

function CodeChangeReviewFileView({ file }: { file: CodeChangeReviewFile }): JSX.Element {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row wrap" style={{ justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <strong style={{ overflowWrap: 'anywhere' }}>
          {file.type === 'MODIFY' ? 'Geändert' : 'Neu erstellt'}: {file.path}
        </strong>
        <span className="chip chip-outline">{file.type}</span>
      </div>
      <div className="text-sm text-muted" style={{ marginTop: 4 }}>
        Vorher: {formatInfo(file.beforeFormat)}
        <br />
        Nachher: {formatInfo(file.afterFormat)}
      </div>
      {file.whitespaceOnlyChangedLines.length > 0 && (
        <div className="banner banner-warning text-sm" style={{ marginTop: 8 }}>
          Nur Leerzeichen-Änderung in Zeile(n): {file.whitespaceOnlyChangedLines.join(', ')}
        </div>
      )}
      {file.invisibleAnnotations.length > 0 && (
        <div className="banner banner-warning text-sm" style={{ marginTop: 8 }}>
          Unsichtbare/bidirektionale Unicode-Zeichen gefunden:{' '}
          {file.invisibleAnnotations
            .map((a) => `${a.codePoint} (Zeile ${a.line}, ${a.side === 'before' ? 'vorher' : 'nachher'})`)
            .join(', ')}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <DiffView lines={file.diff} />
      </div>
    </div>
  )
}

function CodeChangeReviewDetail({
  review,
  readOnly,
  deciding,
  feedbackDraft,
  onFeedbackChange,
  onApprove,
  onRequestChanges
}: {
  review: CodeChangeReviewProjection
  readOnly: boolean
  deciding: boolean
  feedbackDraft: string
  onFeedbackChange: (value: string) => void
  onApprove: () => Promise<void>
  onRequestChanges: () => Promise<void>
}): JSX.Element {
  const canApprove = canApproveReview(review, readOnly)
  const canReqChanges = canRequestChanges(review, readOnly)

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <strong>{review.summary}</strong>
        <span className="chip chip-outline">{STATE_LABELS[review.state]}</span>
      </div>

      {review.warnings.length > 0 && (
        <div className="banner banner-info">
          {review.warnings.map((warning, index) => (
            <div key={index}>{warning}</div>
          ))}
        </div>
      )}

      {review.feedback !== null && (
        <div className="text-sm">
          <strong>Rückmeldung:</strong> {review.feedback}
        </div>
      )}

      <div className="stack" style={{ gap: 12 }}>
        {review.files.map((file) => (
          <CodeChangeReviewFileView key={file.path} file={file} />
        ))}
      </div>

      {(canApprove || canReqChanges) && (
        <div className="stack" style={{ gap: 8 }}>
          {canReqChanges && (
            <textarea
              className="work-field"
              value={feedbackDraft}
              onChange={(e) => onFeedbackChange(e.target.value)}
              maxLength={CODE_CHANGE_REVIEW_FEEDBACK_MAX_BYTES}
              rows={3}
              placeholder="Was soll an diesem Vorschlag geändert werden?"
              disabled={deciding}
            />
          )}
          <div className="row" style={{ gap: 8 }}>
            {canApprove && (
              <button className="btn btn-primary btn-sm" disabled={deciding} onClick={() => void onApprove()}>
                {deciding ? 'Wird gespeichert…' : 'Freigeben'}
              </button>
            )}
            {canReqChanges && (
              <button
                className="btn btn-secondary btn-sm"
                disabled={deciding || feedbackDraft.trim().length === 0}
                onClick={() => void onRequestChanges()}
              >
                Änderungen anfordern
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function CodeChangeReviewPanel({
  projectId,
  workRequestId,
  readOnly
}: {
  projectId: number
  workRequestId: number
  readOnly: boolean
}): JSX.Element | null {
  const [store] = useState(() => createCodeChangeReviewStore(projectId, readOnly))
  const { reviews, selected, selectedId, loadingList, loadingSelected, deciding, error, loadList, select, approve, requestChanges, dispose } =
    useStore(store)
  const [feedbackDraft, setFeedbackDraft] = useState('')

  useEffect(() => {
    void loadList()
    return () => dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadList, dispose])

  useEffect(() => {
    setFeedbackDraft('')
  }, [selectedId])

  // Nur Reviews DIESES Work Requests sind hier relevant - eine Review ist
  // permanent an projectId/taskId/workRequestId gebunden (siehe
  // codeChangeReviewService.ts Teil Q), dieses Panel filtert zusaetzlich auf
  // den aktuell angezeigten Work Request.
  const relevantReviews = reviews.filter((review) => review.workRequestId === workRequestId)

  if (loadingList) return <div className="text-muted text-sm">Lädt Reviews…</div>
  if (relevantReviews.length === 0) return null

  async function handleApprove(): Promise<void> {
    await approve()
  }

  async function handleRequestChanges(): Promise<void> {
    const text = feedbackDraft.trim()
    if (text.length === 0) return
    const result = await requestChanges(feedbackDraft)
    if (result) setFeedbackDraft('')
  }

  return (
    <section className="stack" style={{ gap: 12 }}>
      <h4 style={{ margin: 0 }}>Code-Änderungen zur Prüfung</h4>
      {error && <div className="banner banner-danger">{error}</div>}
      <div className="stack" style={{ gap: 6 }}>
        {relevantReviews.map((review) => (
          <button
            key={review.reviewId}
            className={`card card-interactive${selectedId === review.reviewId ? ' card-active' : ''}`}
            onClick={() => void select(review.reviewId)}
            style={{ padding: 10, textAlign: 'left' }}
          >
            <strong style={{ overflowWrap: 'anywhere' }}>{review.summary}</strong>
            <div className="text-sm text-muted" style={{ marginTop: 4 }}>
              {STATE_LABELS[review.state]} · {review.fileCount} Datei(en)
            </div>
          </button>
        ))}
      </div>
      {loadingSelected && <div className="text-muted text-sm">Lädt…</div>}
      {!loadingSelected && selected && (
        <CodeChangeReviewDetail
          review={selected}
          readOnly={readOnly}
          deciding={deciding}
          feedbackDraft={feedbackDraft}
          onFeedbackChange={setFeedbackDraft}
          onApprove={handleApprove}
          onRequestChanges={handleRequestChanges}
        />
      )}
    </section>
  )
}
