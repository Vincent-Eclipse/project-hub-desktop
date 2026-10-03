// Meilenstein 4.8B.0 - plattformuebergreifender Vertragstest (laeuft auf
// JEDER Plattform, nicht nur Windows): stellt sicher, dass der TS-Wrapper
// auf einer nicht unterstuetzten Plattform sauber und ehrlich fehlschlaegt,
// statt eine Fallback-Mutation zu versuchen - es gibt bewusst KEINEN
// Nicht-Windows-Mutationspfad irgendeiner Art.
import { describe, it, expect } from 'vitest'
import { isWindowsSafeApplySupported, prepareLease, WindowsSafeApplyUnavailableError } from './windowsSafeApply'

describe('windowsSafeApply - cross-platform contract', () => {
  it('on a non-Windows platform, reports unsupported and throws WindowsSafeApplyUnavailableError rather than attempting any mutation', () => {
    if (process.platform === 'win32') return // covered by the Windows-only suites instead
    expect(isWindowsSafeApplySupported()).toBe(false)
    expect(() => prepareLease({ root: 'C:\\does-not-matter' })).toThrow(WindowsSafeApplyUnavailableError)
  })

  it('on Windows (with the native module built), reports supported', () => {
    if (process.platform !== 'win32') return // covered by the non-Windows branch above
    expect(isWindowsSafeApplySupported()).toBe(true)
  })
})
