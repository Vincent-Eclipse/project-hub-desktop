import type { DiffLine } from '@shared/types'

const ROW_STYLES: Record<DiffLine['type'], React.CSSProperties> = {
  unchanged: {},
  added: { background: 'rgba(76, 175, 125, 0.15)' },
  removed: { background: 'rgba(217, 83, 79, 0.15)' }
}

const PREFIX: Record<DiffLine['type'], string> = {
  unchanged: ' ',
  added: '+',
  removed: '-'
}

export function DiffView({ lines }: { lines: DiffLine[] }): JSX.Element {
  if (lines.length === 0) {
    return <div className="text-muted text-sm">Kein Unterschied zwischen den beiden Versionen.</div>
  }
  return (
    <pre
      className="font-mono card"
      style={{
        margin: 0,
        fontSize: 13,
        padding: 0,
        overflow: 'auto',
        maxHeight: 480
      }}
    >
      {lines.map((line, idx) => (
        <div
          key={idx}
          style={{
            ...ROW_STYLES[line.type],
            display: 'flex',
            padding: '0 8px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          <span style={{ width: 60, flexShrink: 0, color: 'var(--color-text-muted)' }}>
            {line.oldLineNumber ?? ''}
          </span>
          <span style={{ width: 60, flexShrink: 0, color: 'var(--color-text-muted)' }}>
            {line.newLineNumber ?? ''}
          </span>
          <span style={{ width: 16, flexShrink: 0 }}>{PREFIX[line.type]}</span>
          <span>{line.text.length === 0 ? ' ' : line.text}</span>
        </div>
      ))}
    </pre>
  )
}
