import { describe, expect, it } from 'vitest'
import { createTestDb } from '../testUtils/testDb'
import { generateUniqueSlug, slugify } from './slugService'

describe('slugify', () => {
  it('wandelt Leerzeichen in Bindestriche um und alles in Kleinbuchstaben', () => {
    expect(slugify('Airport Career')).toBe('airport-career')
  })

  it('transliteriert deutsche Umlaute sinnvoll statt sie zu entfernen', () => {
    expect(slugify('Flughafen Übergabe')).toBe('flughafen-uebergabe')
    expect(slugify('Straße')).toBe('strasse')
    expect(slugify('Größe')).toBe('groesse')
  })

  it('fasst mehrere Sonderzeichen zu einem einzigen Bindestrich zusammen', () => {
    expect(slugify('Atlas -- Test!!  Projekt')).toBe('atlas-test-projekt')
  })

  it('entfernt fuehrende und abschliessende Bindestriche', () => {
    expect(slugify('  !!Test!!  ')).toBe('test')
  })
})

describe('generateUniqueSlug', () => {
  it('erzeugt beim ersten Mal den einfachen Slug', () => {
    const db = createTestDb()
    expect(generateUniqueSlug(db, 'Airport Career')).toBe('airport-career')
  })

  it('haengt bei Kollision fortlaufende Zahlen an', () => {
    const db = createTestDb()
    db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run(
      'Airport Career',
      'airport-career',
      'Roblox'
    )
    expect(generateUniqueSlug(db, 'Airport Career')).toBe('airport-career-2')

    db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run(
      'Airport Career',
      'airport-career-2',
      'Roblox'
    )
    expect(generateUniqueSlug(db, 'Airport Career')).toBe('airport-career-3')
  })
})
