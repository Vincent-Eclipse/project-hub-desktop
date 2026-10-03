import { describe, expect, it } from 'vitest'
import { formatWorkTimestamp } from './timestampFormat'

// formatWorkTimestamp() deliberately renders the LOCAL time zone of the
// machine it runs on (see timestampFormat.ts) - which timezone that is
// varies across dev/CI machines. Rather than forcing a specific zone (an
// already-constructed Intl.DateTimeFormat singleton ignores a later
// process.env.TZ change anyway), the expected day/month/year/hour/minute
// values are derived from the SAME local Date getters the implementation
// implicitly relies on - so the test is deterministic on any machine.
function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function expectedLocalParts(iso: string): { datePart: string; timePart: string } {
  const date = new Date(iso)
  return {
    datePart: `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`,
    timePart: `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
}

describe('formatWorkTimestamp', () => {
  it('formats an ISO timestamp using the local day/month/year and 24h hour/minute', () => {
    const iso = '2026-03-05T14:30:00.000Z'
    const { datePart, timePart } = expectedLocalParts(iso)
    const formatted = formatWorkTimestamp(iso)
    expect(formatted).toContain(datePart)
    expect(formatted).toContain(timePart)
  })

  it('pads single-digit day/month/hour/minute values', () => {
    const iso = '2026-01-02T03:04:00.000Z'
    const { datePart, timePart } = expectedLocalParts(iso)
    const formatted = formatWorkTimestamp(iso)
    expect(formatted).toContain(datePart)
    expect(formatted).toContain(timePart)
  })

  it('returns the raw input unchanged for an unparseable value - never throws, never blank', () => {
    expect(formatWorkTimestamp('not-a-date')).toBe('not-a-date')
    expect(formatWorkTimestamp('')).toBe('')
  })
})
