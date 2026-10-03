import { describe, expect, it } from 'vitest'
import { diffLines } from './diff'

describe('diffLines', () => {
  it('liefert nur unveraenderte Zeilen bei identischem Text', () => {
    const result = diffLines('Zeile 1\nZeile 2', 'Zeile 1\nZeile 2')
    expect(result.every((l) => l.type === 'unchanged')).toBe(true)
    expect(result).toHaveLength(2)
  })

  it('erkennt eine hinzugefuegte Zeile', () => {
    const result = diffLines('Zeile 1', 'Zeile 1\nZeile 2')
    expect(result).toEqual([
      { type: 'unchanged', text: 'Zeile 1', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'added', text: 'Zeile 2', oldLineNumber: null, newLineNumber: 2 }
    ])
  })

  it('erkennt eine entfernte Zeile', () => {
    const result = diffLines('Zeile 1\nZeile 2', 'Zeile 1')
    expect(result).toEqual([
      { type: 'unchanged', text: 'Zeile 1', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'removed', text: 'Zeile 2', oldLineNumber: 2, newLineNumber: null }
    ])
  })

  it('erkennt eine geaenderte Zeile als Entfernen + Hinzufuegen', () => {
    const result = diffLines('Alter Text', 'Neuer Text')
    expect(result).toEqual([
      { type: 'removed', text: 'Alter Text', oldLineNumber: 1, newLineNumber: null },
      { type: 'added', text: 'Neuer Text', oldLineNumber: null, newLineNumber: 1 }
    ])
  })

  it('behandelt leeren Ausgangstext korrekt', () => {
    const result = diffLines('', 'Neue Zeile')
    expect(result).toEqual([{ type: 'added', text: 'Neue Zeile', oldLineNumber: null, newLineNumber: 1 }])
  })

  it('liefert eine leere Liste fuer zwei leere Texte', () => {
    expect(diffLines('', '')).toEqual([])
  })
})
