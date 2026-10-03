import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { PlanningResult, WorkRequestDetail, WorkRequestOption, WorkRequestSummary } from '@shared/types'
import { createTestDb } from '../testUtils/testDb'
import { openDatabase } from '../db/connection'
import { MIGRATIONS, MigrationIntegrityError, runMigrations } from '../db/migrations'
import { archiveProject, createProject, ProjectArchivedError, ProjectNotFoundError } from './projectsService'
import { createContextVersion, getCurrentContextVersion } from './contextService'
import { createRuleVersion, getCurrentProjectRules } from './rulesService'
import { createTask, getTaskForProject } from './taskService'
import { listEventLog } from './eventLogService'
import {
  applyPlanningResult,
  createWorkRequest,
  DecisionMismatchError,
  DecisionNotFoundError,
  DecisionResolutionConflictError,
  getWorkRequestForProject,
  InvalidDecisionError,
  InvalidWorkRequestError,
  InvalidWorkRequestStatusError,
  listWorkRequestsForProject,
  replaceTaskLinks,
  resolveDecision,
  setWorkRequestStatus,
  TaskAlreadyLinkedError,
  updateWorkRequestIntent,
  WorkRequestMismatchError,
  WorkRequestNotEditableError,
  WorkRequestNotFoundError
} from './workRequestService'

let db: ReturnType<typeof createTestDb>
let projectId: number
beforeEach(() => {
  db = createTestDb()
  projectId = createProject(db, { name: 'Work', projectType: 'Test', description: '' }).id
})
afterEach(() => db.close())

const input = (id: number, intentMarkdown = 'Ich moechte X bauen.') => ({
  projectId: id,
  intentMarkdown,
  createdBy: 'LEON' as const
})

const twoOptions: WorkRequestOption[] = [
  { key: 'opt-a', label: 'Option A' },
  { key: 'opt-b', label: 'Option B' }
]

function planningResult(overrides: Partial<PlanningResult> = {}): PlanningResult {
  return { planMarkdown: 'Plan', decisionRequests: [], ...overrides }
}

/**
 * listWorkRequestsForProject() returns the lightweight WorkRequestSummary
 * shape (ChatGPT re-review Fix 3) - no intentMarkdown, no planMarkdown, no
 * createdBy, no decisions/taskIds.
 */
function toListItem(detail: WorkRequestDetail): WorkRequestSummary {
  return {
    id: detail.id,
    projectId: detail.projectId,
    title: detail.title,
    status: detail.status,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt
  }
}

// Deterministic sentinel timestamp used to prove updated_at is actually
// bumped by a mutation - no reliance on real-clock ordering/sleeps.
const SENTINEL_UPDATED_AT = '2000-01-01T00:00:00.000Z'

function forceUpdatedAt(id: number, timestamp: string = SENTINEL_UPDATED_AT): void {
  db.prepare('UPDATE work_requests SET updated_at = ? WHERE id = ?').run(timestamp, id)
}

describe('creating and reading Work Requests', () => {
  it('creates a Work Request with derived title, IDEA status, exact intent preservation', () => {
    expect(listWorkRequestsForProject(db, projectId)).toEqual([])
    const wr = createWorkRequest(db, input(projectId, '  Nutzer sollen sich anmelden koennen.  \r\nDetails.'))
    expect(wr).toMatchObject({
      projectId,
      title: 'Nutzer sollen sich anmelden koennen.',
      intentMarkdown: '  Nutzer sollen sich anmelden koennen.  \r\nDetails.',
      planMarkdown: null,
      status: 'IDEA',
      createdBy: 'LEON',
      decisions: [],
      taskIds: []
    })
    expect(wr.createdAt).toMatch(/^\d{4}-/)
    expect(wr.updatedAt).toBe(wr.createdAt)
    expect(getWorkRequestForProject(db, projectId, wr.id)).toEqual(wr)
    // ChatGPT re-review Fix 3: the list is a lightweight summary - no
    // intentMarkdown, no planMarkdown, no createdBy, no decisions/taskIds.
    expect(listWorkRequestsForProject(db, projectId)).toEqual([toListItem(wr)])
    const [summary] = listWorkRequestsForProject(db, projectId)
    expect(summary).not.toHaveProperty('intentMarkdown')
    expect(summary).not.toHaveProperty('planMarkdown')
    expect(summary).not.toHaveProperty('createdBy')
    expect(summary).not.toHaveProperty('decisions')
    expect(summary).not.toHaveProperty('taskIds')
  })

  // Codex-Review (v5): SQLite guarantees no particular order for equal
  // updated_at values - workRequestStore.ts's local sortWorkRequestSummaries()
  // already breaks ties deterministically by id, so the service's own SQL
  // must do the same, or a fresh reload could theoretically disagree with
  // the renderer's local ordering.
  it('orders equal-timestamp entries by id ASC within each terminal/non-terminal group', () => {
    const a = createWorkRequest(db, input(projectId, 'A'))
    const b = createWorkRequest(db, input(projectId, 'B'))
    const c = createWorkRequest(db, input(projectId, 'C'))
    const d = createWorkRequest(db, input(projectId, 'D'))
    for (const wr of [a, b, c, d]) forceUpdatedAt(wr.id)
    // Two entries per group (non-terminal: a, b; terminal: c, d) so the
    // id-ASC tie-break is exercised within both groups, not just one.
    setWorkRequestStatus(db, { projectId, id: c.id, status: 'DONE' })
    setWorkRequestStatus(db, { projectId, id: d.id, status: 'CANCELLED' })
    forceUpdatedAt(c.id)
    forceUpdatedAt(d.id)

    const list = listWorkRequestsForProject(db, projectId)
    expect(list.map((wr) => wr.id)).toEqual([a.id, b.id, c.id, d.id])
    expect(list.every((wr) => wr.updatedAt === SENTINEL_UPDATED_AT)).toBe(true)
  })

  it('isolates Work Requests per project', () => {
    const otherId = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const a = createWorkRequest(db, input(projectId, 'A'))
    const b = createWorkRequest(db, input(otherId, 'B'))
    expect(listWorkRequestsForProject(db, projectId)).toEqual([toListItem(a)])
    expect(listWorkRequestsForProject(db, otherId)).toEqual([toListItem(b)])
    expect(() => getWorkRequestForProject(db, projectId, b.id)).toThrow(WorkRequestMismatchError)
    expect(() => getWorkRequestForProject(db, otherId, a.id)).toThrow(WorkRequestMismatchError)
  })

  it('rejects missing projects and missing Work Requests', () => {
    expect(() => listWorkRequestsForProject(db, 99999)).toThrow(ProjectNotFoundError)
    expect(() => createWorkRequest(db, input(99999))).toThrow(ProjectNotFoundError)
    expect(() => getWorkRequestForProject(db, 99999, 1)).toThrow(ProjectNotFoundError)
    expect(() => getWorkRequestForProject(db, projectId, 99999)).toThrow(WorkRequestNotFoundError)
  })

  it('rejects creation for archived projects but keeps reads working', () => {
    const wr = createWorkRequest(db, input(projectId))
    archiveProject(db, projectId)
    expect(() => createWorkRequest(db, input(projectId))).toThrow(ProjectArchivedError)
    expect(listWorkRequestsForProject(db, projectId)).toEqual([toListItem(wr)])
    expect(getWorkRequestForProject(db, projectId, wr.id)).toEqual(wr)
  })

  it('rejects empty, whitespace-only and oversize intent', () => {
    expect(() => createWorkRequest(db, input(projectId, ''))).toThrow(InvalidWorkRequestError)
    expect(() => createWorkRequest(db, input(projectId, '   '))).toThrow(InvalidWorkRequestError)
    expect(() => createWorkRequest(db, input(projectId, 'x'.repeat(50_001)))).toThrow(InvalidWorkRequestError)
    expect(createWorkRequest(db, input(projectId, 'x'.repeat(50_000)))).toBeTruthy()
  })

  it('rejects an invalid createdBy', () => {
    expect(() => createWorkRequest(db, { ...input(projectId), createdBy: 'ANONYMOUS' as never })).toThrow(
      InvalidWorkRequestError
    )
  })

  it('derives the title deterministically from the first meaningful line', () => {
    const wr = createWorkRequest(db, input(projectId, '\n\n  Mehrfache   Leerzeichen  \nRest der Beschreibung'))
    expect(wr.title).toBe('Mehrfache Leerzeichen')
  })

  it('logs only identifiers and metadata on create, never the intent text', () => {
    const wr = createWorkRequest(db, input(projectId, 'Streng vertraulicher Wortlaut'))
    const events = listEventLog(db, { projectId, type: 'WORK_REQUEST_CREATED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ workRequestId: wr.id, createdBy: 'LEON' })
    expect(JSON.stringify(events)).not.toContain('Streng vertraulicher Wortlaut')
  })

  it('rolls back Work Request creation if audit logging fails', () => {
    db.exec(
      "CREATE TRIGGER fail_wr_created BEFORE INSERT ON event_log_entries WHEN NEW.type = 'WORK_REQUEST_CREATED' BEGIN SELECT RAISE(ABORT, 'test failure'); END"
    )
    expect(() => createWorkRequest(db, input(projectId))).toThrow('test failure')
    expect(listWorkRequestsForProject(db, projectId)).toEqual([])
    db.exec('DROP TRIGGER fail_wr_created')
    expect(createWorkRequest(db, input(projectId)).status).toBe('IDEA')
  })
})

describe('updating Work Request intent', () => {
  it('updates intent and re-derives the title while status is IDEA', () => {
    const wr = createWorkRequest(db, input(projectId, 'Erste Fassung'))
    const updated = updateWorkRequestIntent(db, { projectId, id: wr.id, intentMarkdown: 'Zweite   Fassung\nmehr' })
    expect(updated.intentMarkdown).toBe('Zweite   Fassung\nmehr')
    expect(updated.title).toBe('Zweite Fassung')
    expect(updated.updatedAt >= wr.updatedAt).toBe(true)
    const events = listEventLog(db, { projectId, type: 'WORK_REQUEST_INTENT_UPDATED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ workRequestId: wr.id })
  })

  it('preserves exact Markdown including CRLF and trailing whitespace', () => {
    const wr = createWorkRequest(db, input(projectId))
    const updated = updateWorkRequestIntent(db, {
      projectId,
      id: wr.id,
      intentMarkdown: '  Line one\r\nLine two  \n'
    })
    expect(updated.intentMarkdown).toBe('  Line one\r\nLine two  \n')
  })

  it('is a no-op (no event, no updatedAt change) when the intent is resubmitted unchanged', () => {
    const wr = createWorkRequest(db, input(projectId, 'Unveraendert'))
    const result = updateWorkRequestIntent(db, { projectId, id: wr.id, intentMarkdown: 'Unveraendert' })
    expect(result).toEqual(wr)
    expect(listEventLog(db, { projectId, type: 'WORK_REQUEST_INTENT_UPDATED' })).toEqual([])
  })

  it('rejects editing once planning has been applied (status left IDEA)', () => {
    const wr = createWorkRequest(db, input(projectId))
    applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult() })
    expect(() => updateWorkRequestIntent(db, { projectId, id: wr.id, intentMarkdown: 'Neu' })).toThrow(
      WorkRequestNotEditableError
    )
  })

  // ChatGPT-Re-Review Fix 1 (v4): status ALONE is not the editability rule -
  // setWorkRequestStatus() is a raw Main/internal setter without transition
  // validation and can force a status back to IDEA after planning has
  // already run. Editing must independently stay locked once a plan and/or
  // decisions exist, regardless of what the current status value says.
  describe('permanently locks intent once planning history exists, independent of status (Fix 1, v4)', () => {
    it('A) rejects editing after a plan with no decisions, even once status is forced back to IDEA', () => {
      const wr = createWorkRequest(db, input(projectId, 'Original'))
      const planned = applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult({ planMarkdown: 'Der Plan' }) })
      expect(planned.status).toBe('READY')
      const forcedBack = setWorkRequestStatus(db, { projectId, id: wr.id, status: 'IDEA' })
      expect(forcedBack.status).toBe('IDEA')

      const eventsBefore = listEventLog(db, { projectId, type: 'WORK_REQUEST_INTENT_UPDATED' }).length
      expect(() => updateWorkRequestIntent(db, { projectId, id: wr.id, intentMarkdown: 'Neu' })).toThrow(
        WorkRequestNotEditableError
      )

      const unchanged = getWorkRequestForProject(db, projectId, wr.id)
      expect(unchanged.intentMarkdown).toBe('Original')
      expect(unchanged.title).toBe('Original')
      expect(unchanged.planMarkdown).toBe('Der Plan')
      // Compared against the state right BEFORE the rejected updateIntent
      // call (i.e. after the forced status change, which legitimately bumps
      // updated_at itself) - the rejected edit must not move it any further.
      expect(unchanged.updatedAt).toBe(forcedBack.updatedAt)
      expect(listEventLog(db, { projectId, type: 'WORK_REQUEST_INTENT_UPDATED' })).toHaveLength(eventsBefore)
    })

    it('B) rejects editing after a plan with decisions, even once status is forced back to IDEA', () => {
      const wr = createWorkRequest(db, input(projectId, 'Original'))
      const planned = applyPlanningResult(db, {
        projectId,
        id: wr.id,
        planningResult: planningResult({ decisionRequests: [{ questionMarkdown: 'Q?', options: twoOptions }] })
      })
      expect(planned.status).toBe('NEEDS_DECISION')
      const forcedBack = setWorkRequestStatus(db, { projectId, id: wr.id, status: 'IDEA' })
      expect(forcedBack.status).toBe('IDEA')

      const eventsBefore = listEventLog(db, { projectId, type: 'WORK_REQUEST_INTENT_UPDATED' }).length
      expect(() => updateWorkRequestIntent(db, { projectId, id: wr.id, intentMarkdown: 'Neu' })).toThrow(
        WorkRequestNotEditableError
      )

      const unchanged = getWorkRequestForProject(db, projectId, wr.id)
      expect(unchanged.intentMarkdown).toBe('Original')
      expect(unchanged.planMarkdown).toBe(planned.planMarkdown)
      expect(unchanged.decisions).toEqual(planned.decisions)
      expect(unchanged.updatedAt).toBe(forcedBack.updatedAt)
      expect(listEventLog(db, { projectId, type: 'WORK_REQUEST_INTENT_UPDATED' })).toHaveLength(eventsBefore)
    })

    it('history check runs BEFORE the no-op comparison - resubmitting the identical text still rejects once planned', () => {
      const wr = createWorkRequest(db, input(projectId, 'Identisch'))
      applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult({ planMarkdown: 'Plan' }) })
      setWorkRequestStatus(db, { projectId, id: wr.id, status: 'IDEA' })
      expect(() => updateWorkRequestIntent(db, { projectId, id: wr.id, intentMarkdown: 'Identisch' })).toThrow(
        WorkRequestNotEditableError
      )
    })

    it('D) a fresh IDEA request with no planning history at all remains editable', () => {
      const wr = createWorkRequest(db, input(projectId, 'Frisch'))
      expect(wr.planMarkdown).toBeNull()
      expect(wr.decisions).toEqual([])
      expect(() => updateWorkRequestIntent(db, { projectId, id: wr.id, intentMarkdown: 'Angepasst' })).not.toThrow()
    })
  })

  it('rejects editing for archived projects', () => {
    const wr = createWorkRequest(db, input(projectId))
    archiveProject(db, projectId)
    expect(() => updateWorkRequestIntent(db, { projectId, id: wr.id, intentMarkdown: 'Neu' })).toThrow(
      ProjectArchivedError
    )
  })

  it('rejects cross-project intent updates', () => {
    const otherId = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const wr = createWorkRequest(db, input(projectId))
    expect(() => updateWorkRequestIntent(db, { projectId: otherId, id: wr.id, intentMarkdown: 'Neu' })).toThrow(
      WorkRequestMismatchError
    )
  })

  it('rejects unknown Work Request ids', () => {
    expect(() => updateWorkRequestIntent(db, { projectId, id: 99999, intentMarkdown: 'X' })).toThrow(
      WorkRequestNotFoundError
    )
  })

  it('rolls back an intent update if audit logging fails, leaving it unchanged', () => {
    const wr = createWorkRequest(db, input(projectId, 'Original'))
    db.exec(
      "CREATE TRIGGER fail_wr_intent BEFORE INSERT ON event_log_entries WHEN NEW.type = 'WORK_REQUEST_INTENT_UPDATED' BEGIN SELECT RAISE(ABORT, 'intent failure'); END"
    )
    expect(() => updateWorkRequestIntent(db, { projectId, id: wr.id, intentMarkdown: 'Geaendert' })).toThrow(
      'intent failure'
    )
    db.exec('DROP TRIGGER fail_wr_intent')
    expect(getWorkRequestForProject(db, projectId, wr.id).intentMarkdown).toBe('Original')
  })
})

describe('applyPlanningResult (Main/internal only)', () => {
  it('sets status to READY when there are no decisions', () => {
    const wr = createWorkRequest(db, input(projectId))
    const result = applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult({ planMarkdown: 'Der Plan' }) })
    expect(result.status).toBe('READY')
    expect(result.planMarkdown).toBe('Der Plan')
    expect(result.decisions).toEqual([])
  })

  it('sets status to NEEDS_DECISION when at least one decision is created', () => {
    const wr = createWorkRequest(db, input(projectId))
    const result = applyPlanningResult(db, {
      projectId,
      id: wr.id,
      planningResult: planningResult({
        decisionRequests: [{ questionMarkdown: 'Welche Option?', options: twoOptions }]
      })
    })
    expect(result.status).toBe('NEEDS_DECISION')
    expect(result.decisions).toHaveLength(1)
    expect(result.decisions[0]).toMatchObject({
      questionMarkdown: 'Welche Option?',
      options: twoOptions,
      status: 'OPEN',
      recommendedOptionKey: null,
      recommendationMarkdown: ''
    })
  })

  it('accepts a recommendedOptionKey that matches an existing option', () => {
    const wr = createWorkRequest(db, input(projectId))
    const result = applyPlanningResult(db, {
      projectId,
      id: wr.id,
      planningResult: planningResult({
        decisionRequests: [
          { questionMarkdown: 'Q?', options: twoOptions, recommendedOptionKey: 'opt-b', recommendationMarkdown: 'Weil...' }
        ]
      })
    })
    expect(result.decisions[0].recommendedOptionKey).toBe('opt-b')
    expect(result.decisions[0].recommendationMarkdown).toBe('Weil...')
  })

  it('rejects a recommendedOptionKey that does not match any option', () => {
    const wr = createWorkRequest(db, input(projectId))
    expect(() =>
      applyPlanningResult(db, {
        projectId,
        id: wr.id,
        planningResult: planningResult({
          decisionRequests: [{ questionMarkdown: 'Q?', options: twoOptions, recommendedOptionKey: 'does-not-exist' }]
        })
      })
    ).toThrow(InvalidDecisionError)
  })

  it('rejects fewer than 2 options', () => {
    const wr = createWorkRequest(db, input(projectId))
    expect(() =>
      applyPlanningResult(db, {
        projectId,
        id: wr.id,
        planningResult: planningResult({ decisionRequests: [{ questionMarkdown: 'Q?', options: [twoOptions[0]] }] })
      })
    ).toThrow(InvalidDecisionError)
  })

  it('rejects more than the maximum number of options', () => {
    const wr = createWorkRequest(db, input(projectId))
    const tooMany = Array.from({ length: 11 }, (_, i) => ({ key: `opt-${i}`, label: `Option ${i}` }))
    expect(() =>
      applyPlanningResult(db, {
        projectId,
        id: wr.id,
        planningResult: planningResult({ decisionRequests: [{ questionMarkdown: 'Q?', options: tooMany }] })
      })
    ).toThrow(InvalidDecisionError)
  })

  it('rejects duplicate option keys within one decision', () => {
    const wr = createWorkRequest(db, input(projectId))
    expect(() =>
      applyPlanningResult(db, {
        projectId,
        id: wr.id,
        planningResult: planningResult({
          decisionRequests: [{ questionMarkdown: 'Q?', options: [{ key: 'x', label: 'A' }, { key: 'x', label: 'B' }] }]
        })
      })
    ).toThrow(InvalidDecisionError)
  })

  it('rejects an invalid option key format (not a stable slug)', () => {
    const wr = createWorkRequest(db, input(projectId))
    expect(() =>
      applyPlanningResult(db, {
        projectId,
        id: wr.id,
        planningResult: planningResult({
          decisionRequests: [{ questionMarkdown: 'Q?', options: [{ key: 'has space', label: 'A' }, twoOptions[1]] }]
        })
      })
    ).toThrow(InvalidDecisionError)
  })

  it('rejects an empty question', () => {
    const wr = createWorkRequest(db, input(projectId))
    expect(() =>
      applyPlanningResult(db, {
        projectId,
        id: wr.id,
        planningResult: planningResult({ decisionRequests: [{ questionMarkdown: '  ', options: twoOptions }] })
      })
    ).toThrow(InvalidDecisionError)
  })

  it('only permits application from IDEA/PLANNING, not from a later status', () => {
    const wr = createWorkRequest(db, input(projectId))
    applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult() })
    expect(getWorkRequestForProject(db, projectId, wr.id).status).toBe('READY')
    expect(() => applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult() })).toThrow(
      InvalidWorkRequestStatusError
    )
  })

  it('rejects application for archived projects', () => {
    const wr = createWorkRequest(db, input(projectId))
    archiveProject(db, projectId)
    expect(() => applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult() })).toThrow(
      ProjectArchivedError
    )
  })

  it('rejects cross-project application', () => {
    const otherId = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const wr = createWorkRequest(db, input(projectId))
    expect(() => applyPlanningResult(db, { projectId: otherId, id: wr.id, planningResult: planningResult() })).toThrow(
      WorkRequestMismatchError
    )
  })

  it('atomically rolls back plan + decisions if audit logging fails', () => {
    const wr = createWorkRequest(db, input(projectId))
    db.exec(
      "CREATE TRIGGER fail_wr_planned BEFORE INSERT ON event_log_entries WHEN NEW.type = 'WORK_REQUEST_PLANNED' BEGIN SELECT RAISE(ABORT, 'plan failure'); END"
    )
    expect(() =>
      applyPlanningResult(db, {
        projectId,
        id: wr.id,
        planningResult: planningResult({ decisionRequests: [{ questionMarkdown: 'Q?', options: twoOptions }] })
      })
    ).toThrow('plan failure')
    db.exec('DROP TRIGGER fail_wr_planned')
    const unchanged = getWorkRequestForProject(db, projectId, wr.id)
    expect(unchanged.status).toBe('IDEA')
    expect(unchanged.planMarkdown).toBeNull()
    expect(unchanged.decisions).toEqual([])
  })

  it('logs only identifiers/counts, never question/plan/recommendation Markdown', () => {
    const wr = createWorkRequest(db, input(projectId))
    applyPlanningResult(db, {
      projectId,
      id: wr.id,
      planningResult: planningResult({
        planMarkdown: 'Geheimer Plan',
        decisionRequests: [{ questionMarkdown: 'Geheime Frage?', options: twoOptions, recommendationMarkdown: 'Geheime Empfehlung' }]
      })
    })
    const events = listEventLog(db, { projectId })
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('Geheimer Plan')
    expect(serialized).not.toContain('Geheime Frage?')
    expect(serialized).not.toContain('Geheime Empfehlung')
    const planned = listEventLog(db, { projectId, type: 'WORK_REQUEST_PLANNED' })
    expect(planned[0].payload).toEqual({ workRequestId: wr.id, decisionCount: 1, newStatus: 'NEEDS_DECISION' })
  })

  // ChatGPT re-review Fix 2A - a PlanningResult must contain a meaningful,
  // non-empty plan. An empty/whitespace-only plan would set status=READY
  // while the UI simultaneously has to show "Plan wurde noch nicht
  // erstellt." - an inconsistent workflow state.
  describe('strict initial planning contract - plan Markdown (Fix 2A)', () => {
    it('rejects an empty plan', () => {
      const wr = createWorkRequest(db, input(projectId))
      expect(() =>
        applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult({ planMarkdown: '' }) })
      ).toThrow(InvalidWorkRequestError)
    })

    it('rejects a whitespace-only plan', () => {
      const wr = createWorkRequest(db, input(projectId))
      expect(() =>
        applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult({ planMarkdown: '   \n\t  ' }) })
      ).toThrow(InvalidWorkRequestError)
    })

    it('preserves exact plan Markdown including CRLF once validated', () => {
      const wr = createWorkRequest(db, input(projectId))
      const result = applyPlanningResult(db, {
        projectId,
        id: wr.id,
        planningResult: planningResult({ planMarkdown: '  # Plan\r\nSchritt 1\r\nSchritt 2  \n' })
      })
      expect(result.planMarkdown).toBe('  # Plan\r\nSchritt 1\r\nSchritt 2  \n')
    })

    it('accepts the exact 50,000-character boundary and rejects one character over', () => {
      const wrAtBoundary = createWorkRequest(db, input(projectId, 'A'))
      expect(
        applyPlanningResult(db, {
          projectId,
          id: wrAtBoundary.id,
          planningResult: planningResult({ planMarkdown: 'x'.repeat(50_000) })
        }).planMarkdown
      ).toHaveLength(50_000)

      const wrOverBoundary = createWorkRequest(db, input(projectId, 'B'))
      expect(() =>
        applyPlanningResult(db, {
          projectId,
          id: wrOverBoundary.id,
          planningResult: planningResult({ planMarkdown: 'x'.repeat(50_001) })
        })
      ).toThrow(InvalidWorkRequestError)
    })

    it('leaves status/plan/decisions/audit completely unchanged when the plan is rejected', () => {
      const wr = createWorkRequest(db, input(projectId))
      expect(() =>
        applyPlanningResult(db, {
          projectId,
          id: wr.id,
          planningResult: planningResult({
            planMarkdown: '   ',
            decisionRequests: [{ questionMarkdown: 'Q?', options: twoOptions }]
          })
        })
      ).toThrow(InvalidWorkRequestError)
      const unchanged = getWorkRequestForProject(db, projectId, wr.id)
      expect(unchanged.status).toBe('IDEA')
      expect(unchanged.planMarkdown).toBeNull()
      expect(unchanged.decisions).toEqual([])
      expect(listEventLog(db, { projectId, type: 'WORK_REQUEST_PLANNED' })).toEqual([])
      expect(listEventLog(db, { projectId, type: 'WORK_REQUEST_STATUS_CHANGED' })).toEqual([])
    })
  })

  // ChatGPT re-review Fix 2B - the IDEA/PLANNING status check alone is not
  // enough to prevent implicit replanning: setWorkRequestStatus is a raw
  // Main/internal setter with no transition validation, so it could force a
  // previously-planned Work Request back to PLANNING. applyPlanningResult
  // must independently refuse to run again once initial planning has
  // already persisted a plan or at least one Decision row - regardless of
  // the status value at the time of the second call.
  describe('rejects implicit replanning independent of status (Fix 2B)', () => {
    it('rejects a second applyPlanningResult after status was forced back to PLANNING (plan already set)', () => {
      const wr = createWorkRequest(db, input(projectId))
      const planned = applyPlanningResult(db, {
        projectId,
        id: wr.id,
        planningResult: planningResult({ planMarkdown: 'Originalplan' })
      })
      expect(planned.status).toBe('READY')

      setWorkRequestStatus(db, { projectId, id: wr.id, status: 'PLANNING' })

      const eventsBefore = listEventLog(db, { projectId, type: 'WORK_REQUEST_PLANNED' }).length
      const statusEventsBefore = listEventLog(db, { projectId, type: 'WORK_REQUEST_STATUS_CHANGED' }).length

      expect(() =>
        applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult({ planMarkdown: 'Zweiter Plan' }) })
      ).toThrow(InvalidWorkRequestStatusError)

      const unchanged = getWorkRequestForProject(db, projectId, wr.id)
      expect(unchanged.planMarkdown).toBe('Originalplan')
      expect(unchanged.decisions).toEqual([])
      expect(listEventLog(db, { projectId, type: 'WORK_REQUEST_PLANNED' })).toHaveLength(eventsBefore)
      // setWorkRequestStatus's own event is expected; the rejected replanning
      // attempt must not add a further status-changed event.
      expect(listEventLog(db, { projectId, type: 'WORK_REQUEST_STATUS_CHANGED' })).toHaveLength(statusEventsBefore)
    })

    it('rejects a second applyPlanningResult after status was forced back to PLANNING (decisions already exist)', () => {
      const wr = createWorkRequest(db, input(projectId))
      const planned = applyPlanningResult(db, {
        projectId,
        id: wr.id,
        planningResult: planningResult({ decisionRequests: [{ questionMarkdown: 'Erste Frage?', options: twoOptions }] })
      })
      expect(planned.status).toBe('NEEDS_DECISION')
      expect(planned.decisions).toHaveLength(1)

      setWorkRequestStatus(db, { projectId, id: wr.id, status: 'PLANNING' })

      expect(() =>
        applyPlanningResult(db, {
          projectId,
          id: wr.id,
          planningResult: planningResult({ decisionRequests: [{ questionMarkdown: 'Zweite Frage?', options: twoOptions }] })
        })
      ).toThrow(InvalidWorkRequestStatusError)

      const unchanged = getWorkRequestForProject(db, projectId, wr.id)
      expect(unchanged.decisions).toHaveLength(1)
      expect(unchanged.decisions[0].questionMarkdown).toBe('Erste Frage?')
    })

    it('still allows the very first applyPlanningResult from a freshly-set PLANNING status with no prior plan/decisions', () => {
      const wr = createWorkRequest(db, input(projectId))
      setWorkRequestStatus(db, { projectId, id: wr.id, status: 'PLANNING' })
      expect(() =>
        applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult({ planMarkdown: 'Plan' }) })
      ).not.toThrow()
    })
  })
})

describe('resolveDecision (renderer-facing)', () => {
  function createPlannedRequest(decisionCount: 1 | 2 = 1) {
    const wr = createWorkRequest(db, input(projectId))
    const decisionRequests = Array.from({ length: decisionCount }, (_, i) => ({
      questionMarkdown: `Frage ${i}?`,
      options: twoOptions
    }))
    const planned = applyPlanningResult(db, { projectId, id: wr.id, planningResult: planningResult({ decisionRequests }) })
    return planned
  }

  it('resolves a valid OPEN decision and logs metadata only', () => {
    const wr = createPlannedRequest()
    const decision = wr.decisions[0]
    const result = resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: decision.id, optionKey: 'opt-a' })
    expect(result.decisions[0]).toMatchObject({ status: 'RESOLVED', resolvedOptionKey: 'opt-a' })
    const events = listEventLog(db, { projectId, type: 'WORK_DECISION_RESOLVED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ workRequestId: wr.id, decisionId: decision.id, optionKey: 'opt-a' })
  })

  it('rejects an unknown option key', () => {
    const wr = createPlannedRequest()
    const decision = wr.decisions[0]
    expect(() =>
      resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: decision.id, optionKey: 'does-not-exist' })
    ).toThrow(InvalidDecisionError)
  })

  it('rejects resolving a decision that does not belong to the given Work Request', () => {
    const wrA = createPlannedRequest()
    const wrB = createPlannedRequest()
    expect(() =>
      resolveDecision(db, { projectId, workRequestId: wrA.id, decisionId: wrB.decisions[0].id, optionKey: 'opt-a' })
    ).toThrow(DecisionMismatchError)
  })

  it('rejects cross-project resolution', () => {
    const otherId = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const wr = createPlannedRequest()
    expect(() =>
      resolveDecision(db, { projectId: otherId, workRequestId: wr.id, decisionId: wr.decisions[0].id, optionKey: 'opt-a' })
    ).toThrow(WorkRequestMismatchError)
  })

  it('rejects resolution for archived projects', () => {
    const wr = createPlannedRequest()
    archiveProject(db, projectId)
    expect(() =>
      resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: wr.decisions[0].id, optionKey: 'opt-a' })
    ).toThrow(ProjectArchivedError)
  })

  it('treats resubmitting the SAME resolution as an idempotent no-op', () => {
    const wr = createPlannedRequest()
    const decision = wr.decisions[0]
    const first = resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: decision.id, optionKey: 'opt-a' })
    const second = resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: decision.id, optionKey: 'opt-a' })
    expect(second).toEqual(first)
    expect(listEventLog(db, { projectId, type: 'WORK_DECISION_RESOLVED' })).toHaveLength(1)
  })

  it('rejects resolving with a DIFFERENT option once already resolved (no silent overwrite)', () => {
    const wr = createPlannedRequest()
    const decision = wr.decisions[0]
    resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: decision.id, optionKey: 'opt-a' })
    expect(() =>
      resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: decision.id, optionKey: 'opt-b' })
    ).toThrow(DecisionResolutionConflictError)
    expect(getWorkRequestForProject(db, projectId, wr.id).decisions[0].resolvedOptionKey).toBe('opt-a')
  })

  it('rejects resolving an unknown decision id', () => {
    const wr = createPlannedRequest()
    expect(() =>
      resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: 99999, optionKey: 'opt-a' })
    ).toThrow(DecisionNotFoundError)
  })

  it('auto-transitions to READY when the final OPEN decision is resolved', () => {
    const wr = createPlannedRequest(2)
    expect(wr.status).toBe('NEEDS_DECISION')
    const afterFirst = resolveDecision(db, {
      projectId,
      workRequestId: wr.id,
      decisionId: wr.decisions[0].id,
      optionKey: 'opt-a'
    })
    expect(afterFirst.status).toBe('NEEDS_DECISION')
    const afterSecond = resolveDecision(db, {
      projectId,
      workRequestId: wr.id,
      decisionId: wr.decisions[1].id,
      optionKey: 'opt-b'
    })
    expect(afterSecond.status).toBe('READY')
    const statusEvents = listEventLog(db, { projectId, type: 'WORK_REQUEST_STATUS_CHANGED' })
    expect(statusEvents.at(-1)?.payload).toEqual({ workRequestId: wr.id, oldStatus: 'NEEDS_DECISION', newStatus: 'READY' })
  })

  it('does not call AI or change status after resolving a non-final decision', () => {
    const wr = createPlannedRequest(2)
    const afterFirst = resolveDecision(db, {
      projectId,
      workRequestId: wr.id,
      decisionId: wr.decisions[0].id,
      optionKey: 'opt-a'
    })
    expect(afterFirst.status).toBe('NEEDS_DECISION')
  })

  it('rolls back a resolution if audit logging fails', () => {
    const wr = createPlannedRequest()
    const decision = wr.decisions[0]
    db.exec(
      "CREATE TRIGGER fail_decision_resolved BEFORE INSERT ON event_log_entries WHEN NEW.type = 'WORK_DECISION_RESOLVED' BEGIN SELECT RAISE(ABORT, 'resolve failure'); END"
    )
    expect(() =>
      resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: decision.id, optionKey: 'opt-a' })
    ).toThrow('resolve failure')
    db.exec('DROP TRIGGER fail_decision_resolved')
    const unchanged = getWorkRequestForProject(db, projectId, wr.id)
    expect(unchanged.decisions[0].status).toBe('OPEN')
    expect(unchanged.status).toBe('NEEDS_DECISION')
  })

  it('accepts an optional resolutionNote and rejects an oversize one', () => {
    const wr = createPlannedRequest()
    const decision = wr.decisions[0]
    const resolved = resolveDecision(db, {
      projectId,
      workRequestId: wr.id,
      decisionId: decision.id,
      optionKey: 'opt-a',
      resolutionNote: 'Kurze Begruendung'
    })
    expect(resolved.decisions[0].resolutionNote).toBe('Kurze Begruendung')

    const other = createPlannedRequest()
    expect(() =>
      resolveDecision(db, {
        projectId,
        workRequestId: other.id,
        decisionId: other.decisions[0].id,
        optionKey: 'opt-a',
        resolutionNote: 'x'.repeat(2_001)
      })
    ).toThrow(InvalidDecisionError)
  })

  // ChatGPT-Re-Review Fix 4: resolving decision 1 of N changes meaningful
  // Work Request child state (a Decision row) but previously left
  // work_requests.updated_at stale until the FINAL decision also flipped
  // NEEDS_DECISION -> READY. Deterministic sentinel-timestamp tests, no sleeps.
  describe('Fix 4 - parent updatedAt reflects child (Decision) mutations', () => {
    it('A) bumps parent updatedAt when a NON-final OPEN decision is resolved, leaves the other OPEN', () => {
      const wr = createPlannedRequest(2)
      forceUpdatedAt(wr.id)
      const before = getWorkRequestForProject(db, projectId, wr.id)
      expect(before.updatedAt).toBe(SENTINEL_UPDATED_AT)
      const statusEventsBefore = listEventLog(db, { projectId, type: 'WORK_REQUEST_STATUS_CHANGED' }).length

      const result = resolveDecision(db, {
        projectId,
        workRequestId: wr.id,
        decisionId: wr.decisions[0].id,
        optionKey: 'opt-a'
      })

      expect(result.status).toBe('NEEDS_DECISION')
      expect(result.updatedAt).not.toBe(SENTINEL_UPDATED_AT)
      expect(result.decisions[1].status).toBe('OPEN')
      const events = listEventLog(db, { projectId, type: 'WORK_DECISION_RESOLVED' })
      expect(events).toHaveLength(1)
      // Only the WORK_DECISION_RESOLVED audit is new - no additional
      // status-changed event for a non-final decision resolution.
      expect(listEventLog(db, { projectId, type: 'WORK_REQUEST_STATUS_CHANGED' })).toHaveLength(statusEventsBefore)
    })

    it('B) rolls back the parent updatedAt bump together with the decision when audit logging fails', () => {
      const wr = createPlannedRequest(2)
      forceUpdatedAt(wr.id)
      db.exec(
        "CREATE TRIGGER fail_decision_resolved_ts BEFORE INSERT ON event_log_entries WHEN NEW.type = 'WORK_DECISION_RESOLVED' BEGIN SELECT RAISE(ABORT, 'resolve ts failure'); END"
      )
      expect(() =>
        resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: wr.decisions[0].id, optionKey: 'opt-a' })
      ).toThrow('resolve ts failure')
      db.exec('DROP TRIGGER fail_decision_resolved_ts')

      const unchanged = getWorkRequestForProject(db, projectId, wr.id)
      expect(unchanged.decisions[0].status).toBe('OPEN')
      expect(unchanged.updatedAt).toBe(SENTINEL_UPDATED_AT)
    })

    it('C) does not bump parent updatedAt on a true idempotent no-op (same option resubmitted)', () => {
      const wr = createPlannedRequest()
      const decision = wr.decisions[0]
      resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: decision.id, optionKey: 'opt-a' })
      forceUpdatedAt(wr.id)

      const second = resolveDecision(db, { projectId, workRequestId: wr.id, decisionId: decision.id, optionKey: 'opt-a' })

      expect(second.updatedAt).toBe(SENTINEL_UPDATED_AT)
      expect(listEventLog(db, { projectId, type: 'WORK_DECISION_RESOLVED' })).toHaveLength(1)
    })
  })
})

describe('replaceTaskLinks (Main/internal only)', () => {
  it('links Tasks from the same project in deterministic order', () => {
    const wr = createWorkRequest(db, input(projectId))
    const taskA = createTask(db, { projectId, title: 'A', createdBy: 'LEON' })
    const taskB = createTask(db, { projectId, title: 'B', createdBy: 'LEON' })
    const result = replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskB.id, taskA.id] })
    expect(result.taskIds).toEqual([taskB.id, taskA.id])
    const events = listEventLog(db, { projectId, type: 'WORK_REQUEST_TASKS_LINKED' })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ workRequestId: wr.id, taskCount: 2 })
  })

  it('rejects a Task from another project', () => {
    const otherId = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const wr = createWorkRequest(db, input(projectId))
    const foreignTask = createTask(db, { projectId: otherId, title: 'Foreign', createdBy: 'LEON' })
    expect(() => replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [foreignTask.id] })).toThrow()
    // The underlying ownership check is taskService.getTaskForProject's TaskMismatchError.
    expect(getWorkRequestForProject(db, projectId, wr.id).taskIds).toEqual([])
  })

  it('rejects a missing Task', () => {
    const wr = createWorkRequest(db, input(projectId))
    expect(() => replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [99999] })).toThrow()
  })

  it('rejects a Task already linked to a different Work Request', () => {
    const wrA = createWorkRequest(db, input(projectId, 'A'))
    const wrB = createWorkRequest(db, input(projectId, 'B'))
    const task = createTask(db, { projectId, title: 'Shared', createdBy: 'LEON' })
    replaceTaskLinks(db, { projectId, workRequestId: wrA.id, taskIds: [task.id] })
    expect(() => replaceTaskLinks(db, { projectId, workRequestId: wrB.id, taskIds: [task.id] })).toThrow(
      TaskAlreadyLinkedError
    )
  })

  it('allows re-linking a Task already linked to the SAME Work Request', () => {
    const wr = createWorkRequest(db, input(projectId))
    const taskA = createTask(db, { projectId, title: 'A', createdBy: 'LEON' })
    const taskB = createTask(db, { projectId, title: 'B', createdBy: 'LEON' })
    replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskA.id] })
    const result = replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskA.id, taskB.id] })
    expect(result.taskIds).toEqual([taskA.id, taskB.id])
  })

  it('deduplicates repeated Task ids, keeping the first occurrence order', () => {
    const wr = createWorkRequest(db, input(projectId))
    const taskA = createTask(db, { projectId, title: 'A', createdBy: 'LEON' })
    const taskB = createTask(db, { projectId, title: 'B', createdBy: 'LEON' })
    const result = replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskA.id, taskB.id, taskA.id] })
    expect(result.taskIds).toEqual([taskA.id, taskB.id])
  })

  it('is a no-op (no event) when resubmitting the identical ordered set', () => {
    const wr = createWorkRequest(db, input(projectId))
    const taskA = createTask(db, { projectId, title: 'A', createdBy: 'LEON' })
    replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskA.id] })
    replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskA.id] })
    expect(listEventLog(db, { projectId, type: 'WORK_REQUEST_TASKS_LINKED' })).toHaveLength(1)
  })

  it('rejects linking for archived projects', () => {
    const wr = createWorkRequest(db, input(projectId))
    const task = createTask(db, { projectId, title: 'A', createdBy: 'LEON' })
    archiveProject(db, projectId)
    expect(() => replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [task.id] })).toThrow(
      ProjectArchivedError
    )
  })

  it('rejects cross-project workRequestId/projectId combinations', () => {
    const otherId = createProject(db, { name: 'Other', projectType: 'Test', description: '' }).id
    const wr = createWorkRequest(db, input(projectId))
    expect(() => replaceTaskLinks(db, { projectId: otherId, workRequestId: wr.id, taskIds: [] })).toThrow(
      WorkRequestMismatchError
    )
  })

  it('rolls back the full replacement if audit logging fails, leaving the previous links intact', () => {
    const wr = createWorkRequest(db, input(projectId))
    const taskA = createTask(db, { projectId, title: 'A', createdBy: 'LEON' })
    const taskB = createTask(db, { projectId, title: 'B', createdBy: 'LEON' })
    replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskA.id] })
    db.exec(
      "CREATE TRIGGER fail_wr_tasks_linked BEFORE INSERT ON event_log_entries WHEN NEW.type = 'WORK_REQUEST_TASKS_LINKED' BEGIN SELECT RAISE(ABORT, 'link failure'); END"
    )
    expect(() => replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskB.id] })).toThrow(
      'link failure'
    )
    db.exec('DROP TRIGGER fail_wr_tasks_linked')
    expect(getWorkRequestForProject(db, projectId, wr.id).taskIds).toEqual([taskA.id])
  })

  it('does not change Task status when linking', () => {
    const wr = createWorkRequest(db, input(projectId))
    const task = createTask(db, { projectId, title: 'A', createdBy: 'LEON' })
    replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [task.id] })
    expect(getTaskForProject(db, projectId, task.id).status).toBe('BACKLOG')
  })

  // ChatGPT-Re-Review Fix 4: replacing the linked Task set changes meaningful
  // Work Request child state but previously never bumped work_requests.updated_at.
  // Deterministic sentinel-timestamp tests, no sleeps.
  describe('Fix 4 - parent updatedAt reflects child (Task link) mutations', () => {
    it('bumps parent updatedAt when the effective ordered Task link set genuinely changes', () => {
      const wr = createWorkRequest(db, input(projectId))
      const taskA = createTask(db, { projectId, title: 'A', createdBy: 'LEON' })
      forceUpdatedAt(wr.id)

      const result = replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskA.id] })

      expect(result.taskIds).toEqual([taskA.id])
      expect(result.updatedAt).not.toBe(SENTINEL_UPDATED_AT)
    })

    it('does not bump parent updatedAt on identical resubmit (true no-op)', () => {
      const wr = createWorkRequest(db, input(projectId))
      const taskA = createTask(db, { projectId, title: 'A', createdBy: 'LEON' })
      replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskA.id] })
      forceUpdatedAt(wr.id)

      const result = replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskA.id] })

      expect(result.updatedAt).toBe(SENTINEL_UPDATED_AT)
      expect(listEventLog(db, { projectId, type: 'WORK_REQUEST_TASKS_LINKED' })).toHaveLength(1)
    })

    it('rolls back the parent updatedAt bump together with the links when audit logging fails', () => {
      const wr = createWorkRequest(db, input(projectId))
      const taskA = createTask(db, { projectId, title: 'A', createdBy: 'LEON' })
      const taskB = createTask(db, { projectId, title: 'B', createdBy: 'LEON' })
      replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskA.id] })
      forceUpdatedAt(wr.id)
      db.exec(
        "CREATE TRIGGER fail_wr_tasks_linked_ts BEFORE INSERT ON event_log_entries WHEN NEW.type = 'WORK_REQUEST_TASKS_LINKED' BEGIN SELECT RAISE(ABORT, 'link ts failure'); END"
      )
      expect(() => replaceTaskLinks(db, { projectId, workRequestId: wr.id, taskIds: [taskB.id] })).toThrow(
        'link ts failure'
      )
      db.exec('DROP TRIGGER fail_wr_tasks_linked_ts')

      const unchanged = getWorkRequestForProject(db, projectId, wr.id)
      expect(unchanged.taskIds).toEqual([taskA.id])
      expect(unchanged.updatedAt).toBe(SENTINEL_UPDATED_AT)
    })
  })
})

describe('setWorkRequestStatus (Main/internal only)', () => {
  it('changes status and logs old/new value', () => {
    const wr = createWorkRequest(db, input(projectId))
    const result = setWorkRequestStatus(db, { projectId, id: wr.id, status: 'PAUSED' })
    expect(result.status).toBe('PAUSED')
    const events = listEventLog(db, { projectId, type: 'WORK_REQUEST_STATUS_CHANGED' })
    expect(events[0].payload).toEqual({ workRequestId: wr.id, oldStatus: 'IDEA', newStatus: 'PAUSED' })
  })

  it('is a no-op when the status is unchanged', () => {
    const wr = createWorkRequest(db, input(projectId))
    const result = setWorkRequestStatus(db, { projectId, id: wr.id, status: 'IDEA' })
    expect(result).toEqual(wr)
    expect(listEventLog(db, { projectId, type: 'WORK_REQUEST_STATUS_CHANGED' })).toEqual([])
  })

  it('rejects an invalid status value', () => {
    const wr = createWorkRequest(db, input(projectId))
    expect(() => setWorkRequestStatus(db, { projectId, id: wr.id, status: 'MADE_UP' as never })).toThrow(
      InvalidWorkRequestError
    )
  })

  it('rejects for archived projects', () => {
    const wr = createWorkRequest(db, input(projectId))
    archiveProject(db, projectId)
    expect(() => setWorkRequestStatus(db, { projectId, id: wr.id, status: 'PAUSED' })).toThrow(ProjectArchivedError)
  })
})

describe('Migration 006 upgrade and integrity', () => {
  it('upgrades the actual 001-005 schema while leaving existing Context, Rules and Tasks byte-for-byte intact', () => {
    const old = openDatabase(':memory:')
    try {
      old.exec('CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL)')
      for (const migration of MIGRATIONS.filter((m) => m.version < 6)) {
        old.exec(migration.sql)
        old
          .prepare('INSERT INTO _migrations VALUES (?, ?, ?)')
          .run(migration.version, migration.name, createHash('sha256').update(migration.sql).digest('hex'))
      }

      const p = createProject(old, { name: 'Existing', projectType: 'Test', description: '' })
      const context = createContextVersion(old, {
        projectId: p.id,
        contentMarkdown: '  # Current State\r\nExisting M4.1 context\n',
        note: 'Pre-upgrade note',
        createdBy: 'LEON'
      })
      const rules = createRuleVersion(old, {
        projectId: p.id,
        contentMarkdown: '# Security\nKeep verification required.',
        note: 'Pre-upgrade rules',
        createdBy: 'CHATGPT'
      })
      const task = createTask(old, { projectId: p.id, title: 'Existing Task', createdBy: 'LEON', goalMarkdown: 'Goal' })

      // This database has only migrations 1-5 recorded as applied, so the
      // next run also pulls in the now-existing Migration 7 (Apply Batches,
      // Meilenstein 4.8B.2B) alongside Migration 6.
      expect(runMigrations(old).applied).toEqual([6, 7])

      expect(getCurrentContextVersion(old, p.id)).toEqual(context)
      expect(getCurrentProjectRules(old, p.id)).toEqual(rules)
      expect(getTaskForProject(old, p.id, task.id)).toEqual(task)

      expect(listWorkRequestsForProject(old, p.id)).toEqual([])
      const wr = createWorkRequest(old, { projectId: p.id, intentMarkdown: 'Post-upgrade Idee', createdBy: 'LEON' })
      expect(wr.title).toBe('Post-upgrade Idee')

      expect(getCurrentContextVersion(old, p.id)).toEqual(context)
      expect(getCurrentProjectRules(old, p.id)).toEqual(rules)
      expect(getTaskForProject(old, p.id, task.id)).toEqual(task)

      expect(runMigrations(old).applied).toEqual([])
      old.prepare("UPDATE _migrations SET checksum = 'tampered' WHERE version = 6").run()
      expect(() => runMigrations(old)).toThrow(MigrationIntegrityError)
    } finally {
      old.close()
    }
  })
})
