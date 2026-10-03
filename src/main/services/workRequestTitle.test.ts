import { describe, expect, it } from 'vitest'
import { WORK_REQUEST_TITLE_MAX_LENGTH } from '@shared/types'
import { deriveWorkRequestTitle } from './workRequestTitle'

describe('deriveWorkRequestTitle', () => {
  it('uses the first non-empty line', () => {
    expect(deriveWorkRequestTitle('Nutzer sollen Profilbilder hochladen koennen.\nWeitere Details folgen.')).toBe(
      'Nutzer sollen Profilbilder hochladen koennen.'
    )
  })

  it('trims surrounding whitespace and skips leading blank lines', () => {
    expect(deriveWorkRequestTitle('  \n\n  Idee mit Einrueckung  \nRest')).toBe('Idee mit Einrueckung')
  })

  it('collapses repeated internal whitespace in the derived title', () => {
    expect(deriveWorkRequestTitle('Zu    viele     Leerzeichen   hier')).toBe('Zu viele Leerzeichen hier')
  })

  it('collapses tabs and mixed whitespace', () => {
    expect(deriveWorkRequestTitle('Tab\t\tgetrennt\t hier')).toBe('Tab getrennt hier')
  })

  it('handles CRLF and CR line endings identically to LF', () => {
    expect(deriveWorkRequestTitle('Erste Zeile\r\nZweite Zeile')).toBe('Erste Zeile')
    expect(deriveWorkRequestTitle('Erste Zeile\rZweite Zeile')).toBe('Erste Zeile')
  })

  it('truncates at the shared maximum length', () => {
    const longLine = 'x'.repeat(WORK_REQUEST_TITLE_MAX_LENGTH + 50)
    const title = deriveWorkRequestTitle(longLine)
    expect(title).toHaveLength(WORK_REQUEST_TITLE_MAX_LENGTH)
    expect(title).toBe('x'.repeat(WORK_REQUEST_TITLE_MAX_LENGTH))
  })

  it('accepts the exact boundary length unchanged', () => {
    const line = 'x'.repeat(WORK_REQUEST_TITLE_MAX_LENGTH)
    expect(deriveWorkRequestTitle(line)).toBe(line)
  })

  it('is deterministic - the same input always yields the same title', () => {
    const intent = 'Etwas bauen, das nuetzlich ist.'
    expect(deriveWorkRequestTitle(intent)).toBe(deriveWorkRequestTitle(intent))
  })

  it('does not strip Markdown syntax from the first line', () => {
    expect(deriveWorkRequestTitle('# Heading as first line\nBody')).toBe('# Heading as first line')
  })
})
