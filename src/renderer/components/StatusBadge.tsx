import type { Actor, NextActor, ProjectStatus } from '@shared/types'

const STATUS_LABELS: Record<ProjectStatus, string> = {
  PLANNING: 'Planung',
  ACTIVE: 'Aktiv',
  WAITING_ON_HUMAN: 'Wartet auf Mensch',
  TESTING: 'Test',
  PAUSED: 'Pausiert',
  COMPLETED: 'Abgeschlossen',
  ERROR: 'Fehler'
}

const STATUS_VARS: Record<ProjectStatus, string> = {
  PLANNING: 'var(--status-planning)',
  ACTIVE: 'var(--status-active)',
  WAITING_ON_HUMAN: 'var(--status-waiting)',
  TESTING: 'var(--status-testing)',
  PAUSED: 'var(--status-paused)',
  COMPLETED: 'var(--status-completed)',
  ERROR: 'var(--status-error)'
}

// Gemeinsame Beschriftung fuer Akteure - verwendet sowohl fuer
// "naechster Akteur" als auch fuer Chat-Autoren/Kontext-Ersteller.
const ACTOR_LABELS: Record<Actor, string> = {
  LEON: 'Leon',
  CHATGPT: 'ChatGPT',
  CLAUDE: 'Claude',
  SYSTEM: 'System'
}

const NEXT_ACTOR_LABELS: Record<NextActor, string> = {
  ...ACTOR_LABELS,
  NONE: '-'
}

export function StatusBadge({ status }: { status: ProjectStatus }): JSX.Element {
  return (
    <span className="chip" style={{ color: '#0e0f12', background: STATUS_VARS[status] }}>
      {STATUS_LABELS[status]}
    </span>
  )
}

export function NextActorBadge({ nextActor }: { nextActor: NextActor }): JSX.Element {
  return <span className="chip chip-outline">Nächster Akteur: {NEXT_ACTOR_LABELS[nextActor]}</span>
}

export { STATUS_LABELS, NEXT_ACTOR_LABELS, ACTOR_LABELS }
