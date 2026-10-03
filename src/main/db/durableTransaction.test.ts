import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openDatabase } from './connection'
import { runMigrations } from './migrations'
import { withFullDurability } from './durableTransaction'

// SQLite's `synchronous` pragma reads back as a plain integer:
// 0 = OFF, 1 = NORMAL, 2 = FULL, 3 = EXTRA.
const SYNCHRONOUS_NORMAL = 1
const SYNCHRONOUS_FULL = 2

describe('withFullDurability', () => {
  it('leaves synchronous=NORMAL as the ambient setting before any call', () => {
    const db = openDatabase(':memory:')
    expect(db.pragma('synchronous', { simple: true })).toBe(SYNCHRONOUS_NORMAL)
  })

  it('sets synchronous=FULL for the duration of the wrapped transaction', () => {
    const db = openDatabase(':memory:')
    let observedDuring: number | undefined
    withFullDurability(db, () => {
      observedDuring = db.pragma('synchronous', { simple: true }) as number
    })
    expect(observedDuring).toBe(SYNCHRONOUS_FULL)
  })

  it('restores synchronous=NORMAL after a successful call', () => {
    const db = openDatabase(':memory:')
    withFullDurability(db, () => {
      db.exec('CREATE TABLE t (x INTEGER)')
    })
    expect(db.pragma('synchronous', { simple: true })).toBe(SYNCHRONOUS_NORMAL)
  })

  it('restores synchronous=NORMAL even when the wrapped function throws, and propagates the original error', () => {
    const db = openDatabase(':memory:')
    expect(() =>
      withFullDurability(db, () => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(db.pragma('synchronous', { simple: true })).toBe(SYNCHRONOUS_NORMAL)
  })

  it('rolls back any partial write when the wrapped function throws after some statements already ran', () => {
    const db = openDatabase(':memory:')
    db.exec('CREATE TABLE t (x INTEGER)')
    expect(() =>
      withFullDurability(db, () => {
        db.prepare('INSERT INTO t (x) VALUES (1)').run()
        throw new Error('boom after partial write')
      })
    ).toThrow('boom after partial write')
    const count = db.prepare('SELECT COUNT(*) as c FROM t').get() as { c: number }
    expect(count.c).toBe(0)
    expect(db.pragma('synchronous', { simple: true })).toBe(SYNCHRONOUS_NORMAL)
  })

  it('propagates the wrapped function return value', () => {
    const db = openDatabase(':memory:')
    const result = withFullDurability(db, () => 42)
    expect(result).toBe(42)
  })

  it('data written inside withFullDurability survives a real file-backed connection close + reopen', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-durable-tx-test-'))
    try {
      const dbPath = path.join(tmpDir, 'db.sqlite3')
      const db = openDatabase(dbPath)
      try {
        runMigrations(db)
        withFullDurability(db, () => {
          db.prepare('INSERT INTO projects (name, slug, project_type) VALUES (?, ?, ?)').run(
            'Durable',
            'durable',
            'Test'
          )
        })
      } finally {
        db.close()
      }

      const reopened = openDatabase(dbPath)
      try {
        const row = reopened.prepare('SELECT name FROM projects').get() as { name: string } | undefined
        expect(row?.name).toBe('Durable')
      } finally {
        reopened.close()
      }
    } finally {
      // See backup.test.ts's identical convention - both connections above are
      // already closed before this runs, so removal cannot hit Windows EBUSY.
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
