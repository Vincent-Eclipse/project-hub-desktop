import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FileLogger } from './logger'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-hub-log-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('FileLogger', () => {
  it('schreibt Log-Zeilen mit Zeitstempel und Level in die Datei', () => {
    const logger = new FileLogger(tmpDir)
    logger.info('Testnachricht')
    const content = fs.readFileSync(path.join(tmpDir, 'main.log'), 'utf-8')
    expect(content).toContain('[INFO]')
    expect(content).toContain('Testnachricht')
  })

  it('serialisiert Error-Objekte inklusive Stacktrace', () => {
    const logger = new FileLogger(tmpDir)
    logger.error('Fehler aufgetreten', new Error('Kaputt'))
    const content = fs.readFileSync(path.join(tmpDir, 'main.log'), 'utf-8')
    expect(content).toContain('[ERROR]')
    expect(content).toContain('Kaputt')
  })

  it('legt das Log-Verzeichnis an, falls es noch nicht existiert', () => {
    const nested = path.join(tmpDir, 'nested', 'logs')
    expect(fs.existsSync(nested)).toBe(false)
    // eslint-disable-next-line no-new
    new FileLogger(nested)
    expect(fs.existsSync(nested)).toBe(true)
  })
})
