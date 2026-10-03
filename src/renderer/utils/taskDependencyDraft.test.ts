import { describe, expect, it } from 'vitest'
import {
  initialTaskDependencyDraftState,
  nextTaskDependencyDraftState,
  sameDependencySet
} from './taskDependencyDraft'

describe('sameDependencySet', () => {
  it('treats identical order as equal', () => {
    expect(sameDependencySet([1, 2, 3], [1, 2, 3])).toBe(true)
  })

  it('treats reordered ids as equal', () => {
    expect(sameDependencySet([3, 1, 2], [1, 2, 3])).toBe(true)
  })

  it('treats duplicate entries as equal to their deduplicated set', () => {
    expect(sameDependencySet([1, 1, 2], [2, 1])).toBe(true)
  })

  it('treats two empty lists as equal', () => {
    expect(sameDependencySet([], [])).toBe(true)
  })

  it('detects an added id', () => {
    expect(sameDependencySet([1, 2], [1, 2, 3])).toBe(false)
  })

  it('detects a removed id', () => {
    expect(sameDependencySet([1, 2, 3], [1, 2])).toBe(false)
  })

  it('detects a different id of the same size', () => {
    expect(sameDependencySet([1, 2], [1, 3])).toBe(false)
  })
})

describe('nextTaskDependencyDraftState', () => {
  // Scenario C: selecting a different Task resets dependency state to that Task's persisted dependencies.
  it('resets to the new Task’s persisted dependencies when the Task id changes', () => {
    const previous = { taskId: 1, persistedDependsOnTaskIds: [2], draftDependsOnTaskIds: [3, 4] }
    const next = nextTaskDependencyDraftState(previous, { id: 2, dependsOnTaskIds: [9] })
    expect(next).toEqual({ taskId: 2, persistedDependsOnTaskIds: [9], draftDependsOnTaskIds: [9] })
  })

  // Scenario A: an unrelated update for the SAME Task (persisted dependencies unchanged) must not discard unsaved edits.
  it('preserves an unsaved local draft when the same Task’s persisted dependencies are unchanged', () => {
    const previous = { taskId: 1, persistedDependsOnTaskIds: [2, 3], draftDependsOnTaskIds: [5, 6] }
    const next = nextTaskDependencyDraftState(previous, { id: 1, dependsOnTaskIds: [2, 3] })
    expect(next).toBe(previous)
    expect(next.draftDependsOnTaskIds).toEqual([5, 6])
  })

  it('preserves an unsaved local draft even when the persisted dependencies arrive reordered or with duplicates', () => {
    const previous = { taskId: 1, persistedDependsOnTaskIds: [2, 3], draftDependsOnTaskIds: [5, 6] }
    const next = nextTaskDependencyDraftState(previous, { id: 1, dependsOnTaskIds: [3, 3, 2] })
    expect(next).toBe(previous)
  })

  // Scenario B: a successful dependency save persists Y - the local draft then treats Y as the persisted state.
  it('resynchronizes the draft to the newly persisted set after a successful save', () => {
    const previous = { taskId: 1, persistedDependsOnTaskIds: [2], draftDependsOnTaskIds: [2, 7] }
    const next = nextTaskDependencyDraftState(previous, { id: 1, dependsOnTaskIds: [2, 7] })
    expect(next).toEqual({ taskId: 1, persistedDependsOnTaskIds: [2, 7], draftDependsOnTaskIds: [2, 7] })
  })

  it('resynchronizes the draft when the persisted set changes for a reason other than the local save (e.g. external change)', () => {
    const previous = { taskId: 1, persistedDependsOnTaskIds: [2], draftDependsOnTaskIds: [2, 99] }
    const next = nextTaskDependencyDraftState(previous, { id: 1, dependsOnTaskIds: [4] })
    expect(next).toEqual({ taskId: 1, persistedDependsOnTaskIds: [4], draftDependsOnTaskIds: [4] })
  })
})

describe('initialTaskDependencyDraftState', () => {
  it('seeds both persisted and draft from the Task’s current dependencies', () => {
    expect(initialTaskDependencyDraftState({ id: 5, dependsOnTaskIds: [1, 2] })).toEqual({
      taskId: 5,
      persistedDependsOnTaskIds: [1, 2],
      draftDependsOnTaskIds: [1, 2]
    })
  })
})
