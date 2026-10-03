import { describe, expect, it } from 'vitest'
import type { AgentDescriptor, ControllerPlan, ControllerTaskDraft } from '@shared/types'
import {
  ControllerTaskDraftDependencyError,
  DuplicateControllerTaskDraftKeyError,
  InvalidAgentDescriptorError,
  InvalidControllerPlanError,
  InvalidControllerTaskDraftError,
  validateAgentDescriptor,
  validateControllerPlan,
  validateControllerTaskDraft
} from './controllerPlanValidation'

function taskDraft(overrides: Partial<ControllerTaskDraft> = {}): ControllerTaskDraft {
  return {
    key: 'setup-api',
    title: 'API einrichten',
    goalMarkdown: '',
    descriptionMarkdown: '',
    acceptanceCriteriaMarkdown: '',
    verificationRequirementsMarkdown: '',
    relevantFiles: [],
    dependsOnKeys: [],
    ...overrides
  }
}

function controllerPlan(overrides: Partial<ControllerPlan> = {}): ControllerPlan {
  return {
    planningResult: { planMarkdown: 'Plan', decisionRequests: [] },
    taskDrafts: [],
    ...overrides
  }
}

describe('validateControllerTaskDraft', () => {
  it('accepts a minimal valid ControllerTaskDraft', () => {
    expect(validateControllerTaskDraft(taskDraft())).toEqual(taskDraft())
  })

  it('preserves valid Markdown exactly (CRLF, trailing whitespace) without trimming/rewriting', () => {
    const md = '  # Ziel\r\nSchritt 1\r\nSchritt 2  \n'
    const result = validateControllerTaskDraft(taskDraft({ goalMarkdown: md, descriptionMarkdown: md }))
    expect(result.goalMarkdown).toBe(md)
    expect(result.descriptionMarkdown).toBe(md)
  })

  it('rejects an invalid key (empty, too long, bad characters)', () => {
    expect(() => validateControllerTaskDraft(taskDraft({ key: '' }))).toThrow(InvalidControllerTaskDraftError)
    expect(() => validateControllerTaskDraft(taskDraft({ key: 'x'.repeat(65) }))).toThrow(InvalidControllerTaskDraftError)
    expect(() => validateControllerTaskDraft(taskDraft({ key: 'has space' }))).toThrow(InvalidControllerTaskDraftError)
    expect(() => validateControllerTaskDraft(taskDraft({ key: '-leading-dash' }))).toThrow(InvalidControllerTaskDraftError)
    expect(() => validateControllerTaskDraft(taskDraft({ key: 'valid-Key_1' }))).not.toThrow()
  })

  it('rejects an empty or oversize title', () => {
    expect(() => validateControllerTaskDraft(taskDraft({ title: '' }))).toThrow(InvalidControllerTaskDraftError)
    expect(() => validateControllerTaskDraft(taskDraft({ title: '   ' }))).toThrow(InvalidControllerTaskDraftError)
    expect(() => validateControllerTaskDraft(taskDraft({ title: 'x'.repeat(201) }))).toThrow(InvalidControllerTaskDraftError)
  })

  it('reuses the M4.2 Relevant Files validation correctly', () => {
    expect(validateControllerTaskDraft(taskDraft({ relevantFiles: ['src/a.ts', 'src/b.ts'] })).relevantFiles).toEqual([
      'src/a.ts',
      'src/b.ts'
    ])
    expect(() => validateControllerTaskDraft(taskDraft({ relevantFiles: ['/absolute/path'] }))).toThrow(InvalidControllerTaskDraftError)
    expect(() => validateControllerTaskDraft(taskDraft({ relevantFiles: ['../escape'] }))).toThrow(InvalidControllerTaskDraftError)
    expect(() => validateControllerTaskDraft(taskDraft({ relevantFiles: ['C:\\Windows\\path'] }))).toThrow(InvalidControllerTaskDraftError)
  })

  it('rejects duplicate dependsOnKeys entries within the same ControllerTaskDraft', () => {
    expect(() => validateControllerTaskDraft(taskDraft({ dependsOnKeys: ['a', 'a'] }))).toThrow(InvalidControllerTaskDraftError)
  })

  it('rejects a malformed dependsOnKeys entry', () => {
    expect(() => validateControllerTaskDraft(taskDraft({ dependsOnKeys: ['has space'] }))).toThrow(InvalidControllerTaskDraftError)
  })

  it('rejects a non-object raw value', () => {
    expect(() => validateControllerTaskDraft(null)).toThrow(InvalidControllerTaskDraftError)
    expect(() => validateControllerTaskDraft('x')).toThrow(InvalidControllerTaskDraftError)
    expect(() => validateControllerTaskDraft([])).toThrow(InvalidControllerTaskDraftError)
  })

  // M4.4-Vorgabe Abschnitt 4 + 8: TaskDraft beschreibt Arbeit, niemals WER sie
  // ausfuehrt oder MIT WELCHEN Faehigkeiten - diese Felder duerfen NIE
  // stillschweigend zu Autoritaets-Metadaten werden, sie muessen abgelehnt
  // werden.
  it('rejects provider/model/agent/capability/permission fields - they never become authority metadata', () => {
    for (const field of ['priority', 'agentId', 'agent', 'provider', 'model', 'executionAdapter', 'capabilities', 'permissions', 'tools', 'commands', 'usageRemaining', 'contextRemaining']) {
      expect(() => validateControllerTaskDraft({ ...taskDraft(), [field]: 'x' })).toThrow(InvalidControllerTaskDraftError)
    }
  })

  // ChatGPT-Re-Review (v2) Fix 1B - exact-key fail-closed: ANY unrecognized
  // field is rejected, not just the known authority-field blacklist. A typo
  // must never silently vanish.
  describe('fail-closed on unknown fields / typos (Fix 1B, v2)', () => {
    it('rejects a typo\'d dependsOnKeys field name instead of silently defaulting dependsOnKeys to []', () => {
      const raw = { ...taskDraft(), dependOnKeys: ['core'] }
      delete (raw as Record<string, unknown>).dependsOnKeys
      expect(() => validateControllerTaskDraft(raw)).toThrow(InvalidControllerTaskDraftError)
    })

    it('rejects a typo\'d relevantFiles field name instead of silently defaulting relevantFiles to []', () => {
      const raw = { ...taskDraft(), relevantFile: ['src/a.ts'] }
      delete (raw as Record<string, unknown>).relevantFiles
      expect(() => validateControllerTaskDraft(raw)).toThrow(InvalidControllerTaskDraftError)
    })

    it('rejects a completely unrecognized extra field even if all real fields are present and valid', () => {
      expect(() => validateControllerTaskDraft({ ...taskDraft(), notes: 'internal note' })).toThrow(InvalidControllerTaskDraftError)
    })
  })

  // ChatGPT-Re-Review (v2) Fix 1C - all eight fields are required; absence is
  // an error, but an empty string/array (once actually present) stays valid.
  describe('all eight fields are required - no silent defaulting (Fix 1C, v2)', () => {
    it('accepts all required fields present with empty optional-content values', () => {
      expect(validateControllerTaskDraft(taskDraft())).toEqual(taskDraft())
    })

    for (const field of [
      'key',
      'title',
      'goalMarkdown',
      'descriptionMarkdown',
      'acceptanceCriteriaMarkdown',
      'verificationRequirementsMarkdown',
      'relevantFiles',
      'dependsOnKeys'
    ] as const) {
      it(`rejects a missing "${field}" field instead of defaulting it`, () => {
        const raw: Record<string, unknown> = { ...taskDraft() }
        delete raw[field]
        expect(() => validateControllerTaskDraft(raw)).toThrow(InvalidControllerTaskDraftError)
      })
    }
  })
})

describe('validateControllerPlan', () => {
  it('accepts a valid ControllerPlan with empty taskDrafts', () => {
    expect(validateControllerPlan(controllerPlan())).toEqual(controllerPlan())
  })

  it('accepts a valid DAG of ControllerTaskDrafts', () => {
    const plan = controllerPlan({
      taskDrafts: [
        taskDraft({ key: 'a', dependsOnKeys: [] }),
        taskDraft({ key: 'b', dependsOnKeys: ['a'] }),
        taskDraft({ key: 'c', dependsOnKeys: ['a', 'b'] })
      ]
    })
    expect(validateControllerPlan(plan).taskDrafts.map((d) => d.key)).toEqual(['a', 'b', 'c'])
  })

  it('preserves the planMarkdown exactly, including CRLF and trailing whitespace', () => {
    const md = '  # Plan\r\nSchritt 1\r\nSchritt 2  \n'
    const result = validateControllerPlan(controllerPlan({ planningResult: { planMarkdown: md, decisionRequests: [] } }))
    expect(result.planningResult.planMarkdown).toBe(md)
  })

  it('rejects a non-object container, and a non-object planningResult', () => {
    expect(() => validateControllerPlan(null)).toThrow(InvalidControllerPlanError)
    expect(() => validateControllerPlan({ ...controllerPlan(), planningResult: 'x' })).toThrow(InvalidControllerPlanError)
  })

  it('rejects taskDrafts that is not an array', () => {
    expect(() => validateControllerPlan({ ...controllerPlan(), taskDrafts: {} })).toThrow(InvalidControllerPlanError)
  })

  it('rejects a duplicate ControllerTaskDraft key', () => {
    const plan = controllerPlan({
      taskDrafts: [taskDraft({ key: 'dup' }), taskDraft({ key: 'dup' })]
    })
    expect(() => validateControllerPlan(plan)).toThrow(DuplicateControllerTaskDraftKeyError)
  })

  it('rejects a missing dependency key reference', () => {
    const plan = controllerPlan({ taskDrafts: [taskDraft({ key: 'a', dependsOnKeys: ['does-not-exist'] })] })
    expect(() => validateControllerPlan(plan)).toThrow(ControllerTaskDraftDependencyError)
  })

  it('rejects a self-dependency', () => {
    const plan = controllerPlan({ taskDrafts: [taskDraft({ key: 'a', dependsOnKeys: ['a'] })] })
    expect(() => validateControllerPlan(plan)).toThrow(ControllerTaskDraftDependencyError)
  })

  it('rejects a direct two-node cycle', () => {
    const plan = controllerPlan({
      taskDrafts: [taskDraft({ key: 'a', dependsOnKeys: ['b'] }), taskDraft({ key: 'b', dependsOnKeys: ['a'] })]
    })
    expect(() => validateControllerPlan(plan)).toThrow(ControllerTaskDraftDependencyError)
  })

  it('rejects a multi-node (three-way) cycle', () => {
    const plan = controllerPlan({
      taskDrafts: [
        taskDraft({ key: 'a', dependsOnKeys: ['c'] }),
        taskDraft({ key: 'b', dependsOnKeys: ['a'] }),
        taskDraft({ key: 'c', dependsOnKeys: ['b'] })
      ]
    })
    expect(() => validateControllerPlan(plan)).toThrow(ControllerTaskDraftDependencyError)
  })

  // M4.4-Vorgabe: ControllerPlan ist trotz des Namens ein VORSCHLAG - die
  // Validierung darf niemals Provider/Modell/Agent/Faehigkeiten-Felder als
  // Autoritaet durchlassen, auch nicht am Container selbst.
  it('rejects provider/model/agent/capability fields at the ControllerPlan container level', () => {
    for (const field of ['agentId', 'provider', 'model', 'capabilities', 'permissions', 'commands', 'tools']) {
      expect(() => validateControllerPlan({ ...controllerPlan(), [field]: 'x' })).toThrow(InvalidControllerPlanError)
    }
  })

  it('does not imply approval/READY/execution - the type has no workflow status field, and a raw "status" field is rejected', () => {
    const result = validateControllerPlan(controllerPlan())
    expect(result).not.toHaveProperty('status')
    expect(result).not.toHaveProperty('approved')
    expect(result).not.toHaveProperty('ready')
    expect(() => validateControllerPlan({ ...controllerPlan(), status: 'READY' })).toThrow(InvalidControllerPlanError)
  })

  // ChatGPT-Re-Review (v2) Fix 1B - exact-key fail-closed at the container
  // level too.
  it('rejects any unrecognized top-level field on the ControllerPlan container', () => {
    expect(() => validateControllerPlan({ ...controllerPlan(), notes: 'internal note' })).toThrow(InvalidControllerPlanError)
  })

  // ChatGPT-Re-Review (v2) Fix 1A - PlanningResult structural honesty: the
  // returned value must actually be safe to treat as a PlanningResult, even
  // though the deep M4.3 business rules (option count/key uniqueness/
  // recommendation membership) remain exclusively authoritative in
  // workRequestService.ts and are NOT duplicated here.
  describe('planningResult structural honesty (Fix 1A, v2)', () => {
    it('rejects an empty plan', () => {
      expect(() =>
        validateControllerPlan(controllerPlan({ planningResult: { planMarkdown: '', decisionRequests: [] } }))
      ).toThrow(InvalidControllerPlanError)
    })

    it('rejects a whitespace-only plan', () => {
      expect(() =>
        validateControllerPlan(controllerPlan({ planningResult: { planMarkdown: '   \n\t  ', decisionRequests: [] } }))
      ).toThrow(InvalidControllerPlanError)
    })

    it('rejects decisionRequests: [null]', () => {
      const plan = { ...controllerPlan(), planningResult: { planMarkdown: 'Plan', decisionRequests: [null] } }
      expect(() => validateControllerPlan(plan)).toThrow(InvalidControllerPlanError)
    })

    it('rejects a primitive decision entry', () => {
      const plan = { ...controllerPlan(), planningResult: { planMarkdown: 'Plan', decisionRequests: ['not-an-object'] } }
      expect(() => validateControllerPlan(plan)).toThrow(InvalidControllerPlanError)
    })

    it('rejects a decision request missing questionMarkdown', () => {
      const plan = {
        ...controllerPlan(),
        planningResult: { planMarkdown: 'Plan', decisionRequests: [{ options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }] }
      }
      expect(() => validateControllerPlan(plan)).toThrow(InvalidControllerPlanError)
    })

    it('rejects a decision request whose options is not an array', () => {
      const plan = {
        ...controllerPlan(),
        planningResult: { planMarkdown: 'Plan', decisionRequests: [{ questionMarkdown: 'Q?', options: 'not-an-array' }] }
      }
      expect(() => validateControllerPlan(plan)).toThrow(InvalidControllerPlanError)
    })

    it('rejects a malformed option entry (missing label)', () => {
      const plan = {
        ...controllerPlan(),
        planningResult: { planMarkdown: 'Plan', decisionRequests: [{ questionMarkdown: 'Q?', options: [{ key: 'a' }] }] }
      }
      expect(() => validateControllerPlan(plan)).toThrow(InvalidControllerPlanError)
    })

    it('rejects an invalid optional field primitive (recommendedOptionKey as a number)', () => {
      const plan = {
        ...controllerPlan(),
        planningResult: {
          planMarkdown: 'Plan',
          decisionRequests: [
            { questionMarkdown: 'Q?', options: [{ key: 'a', label: 'A' }], recommendedOptionKey: 42 }
          ]
        }
      }
      expect(() => validateControllerPlan(plan)).toThrow(InvalidControllerPlanError)
    })

    it('rejects an unrecognized field on a decision request or option (fail-closed)', () => {
      const withExtraOnRequest = {
        ...controllerPlan(),
        planningResult: {
          planMarkdown: 'Plan',
          decisionRequests: [{ questionMarkdown: 'Q?', options: [{ key: 'a', label: 'A' }], agentId: 'x' }]
        }
      }
      expect(() => validateControllerPlan(withExtraOnRequest)).toThrow(InvalidControllerPlanError)

      const withExtraOnOption = {
        ...controllerPlan(),
        planningResult: {
          planMarkdown: 'Plan',
          decisionRequests: [{ questionMarkdown: 'Q?', options: [{ key: 'a', label: 'A', provider: 'x' }] }]
        }
      }
      expect(() => validateControllerPlan(withExtraOnOption)).toThrow(InvalidControllerPlanError)
    })

    it('accepts a structurally valid decision request with recommendedOptionKey/recommendationMarkdown', () => {
      const plan = controllerPlan({
        planningResult: {
          planMarkdown: 'Plan',
          decisionRequests: [
            {
              questionMarkdown: 'Welche Option?',
              options: [
                { key: 'a', label: 'Option A' },
                { key: 'b', label: 'Option B', descriptionMarkdown: 'Details zu B' }
              ],
              recommendedOptionKey: 'b',
              recommendationMarkdown: 'B ist einfacher.'
            }
          ]
        }
      })
      const result = validateControllerPlan(plan)
      expect(result.planningResult.decisionRequests).toEqual([
        {
          questionMarkdown: 'Welche Option?',
          options: [
            { key: 'a', label: 'Option A' },
            { key: 'b', label: 'Option B', descriptionMarkdown: 'Details zu B' }
          ],
          recommendedOptionKey: 'b',
          recommendationMarkdown: 'B ist einfacher.'
        }
      ])
    })

    it('accepts recommendedOptionKey: null explicitly', () => {
      const plan = controllerPlan({
        planningResult: {
          planMarkdown: 'Plan',
          decisionRequests: [{ questionMarkdown: 'Q?', options: [{ key: 'a', label: 'A' }], recommendedOptionKey: null }]
        }
      })
      expect(() => validateControllerPlan(plan)).not.toThrow()
    })
  })
})

function agentDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return { id: 'reviewer-1', displayName: 'Reviewer', roles: ['REVIEWER'], ...overrides }
}

describe('validateAgentDescriptor', () => {
  it('accepts a valid AgentDescriptor with a single role', () => {
    expect(validateAgentDescriptor(agentDescriptor())).toEqual(agentDescriptor())
  })

  it('accepts multiple distinct valid roles', () => {
    const result = validateAgentDescriptor(agentDescriptor({ roles: ['CONTROLLER', 'IMPLEMENTER', 'REVIEWER', 'ANALYST'] }))
    expect(result.roles).toEqual(['CONTROLLER', 'IMPLEMENTER', 'REVIEWER', 'ANALYST'])
  })

  it('rejects an empty roles array', () => {
    expect(() => validateAgentDescriptor(agentDescriptor({ roles: [] }))).toThrow(InvalidAgentDescriptorError)
  })

  it('rejects an unknown role value', () => {
    expect(() => validateAgentDescriptor(agentDescriptor({ roles: ['CONTROLLER', 'MADE_UP'] as never }))).toThrow(
      InvalidAgentDescriptorError
    )
  })

  it('rejects duplicate roles', () => {
    expect(() => validateAgentDescriptor(agentDescriptor({ roles: ['REVIEWER', 'REVIEWER'] }))).toThrow(
      InvalidAgentDescriptorError
    )
  })

  it('rejects an invalid id or displayName', () => {
    expect(() => validateAgentDescriptor(agentDescriptor({ id: 'has space' }))).toThrow(InvalidAgentDescriptorError)
    expect(() => validateAgentDescriptor(agentDescriptor({ displayName: '' }))).toThrow(InvalidAgentDescriptorError)
  })

  it('rejects a missing required field instead of defaulting it', () => {
    const raw: Record<string, unknown> = { ...agentDescriptor() }
    delete raw.displayName
    expect(() => validateAgentDescriptor(raw)).toThrow(InvalidAgentDescriptorError)
  })

  // M4.4-Vorgabe Abschnitt 5: AgentDescriptor ist reine Rollen-Identitaet,
  // NIE Laufzeitzustand/Provider/Modell/Faehigkeiten.
  it('rejects runtime/provider/capability fields - AgentDescriptor never acquires runtime concerns', () => {
    for (const field of ['usage', 'contextBudget', 'provider', 'model', 'cliPath', 'apiKey', 'command', 'availability', 'currentWorkload', 'permission', 'capability']) {
      expect(() => validateAgentDescriptor({ ...agentDescriptor(), [field]: 'x' })).toThrow(InvalidAgentDescriptorError)
    }
  })

  // ChatGPT-Re-Review (v2) Fix 1B - exact-key fail-closed.
  it('rejects any unrecognized field on AgentDescriptor', () => {
    expect(() => validateAgentDescriptor({ ...agentDescriptor(), notes: 'internal note' })).toThrow(InvalidAgentDescriptorError)
  })
})
