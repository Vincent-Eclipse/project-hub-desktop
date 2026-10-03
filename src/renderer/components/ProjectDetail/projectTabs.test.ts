import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_TAB, PROJECT_TABS } from './projectTabs'

describe('project tab configuration (M4.3 - Work becomes the default surface)', () => {
  it('lists Work first', () => {
    expect(PROJECT_TABS[0].key).toBe('work')
    expect(PROJECT_TABS[0].label).toBe('Work')
  })

  it('defaults to the Work tab', () => {
    expect(DEFAULT_PROJECT_TAB).toBe('work')
  })

  it('keeps every existing technical tab available - no removal, no Advanced-navigation rewrite', () => {
    const keys = PROJECT_TABS.map((t) => t.key)
    expect(keys).toEqual([
      'work',
      'repository',
      'overview',
      'context',
      'tasks',
      'rules',
      'chat',
      'sessions',
      'import',
      'handoff'
    ])
  })
})
