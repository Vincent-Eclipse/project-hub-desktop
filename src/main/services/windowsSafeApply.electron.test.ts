// Meilenstein 4.8B.0 - schmale, kontrollierte Electron-Main-Prozess-
// Akzeptanz (NIEMALS die echte Project Hub UI): startet den tatsaechlich
// installierten Electron-Build headless (kein BrowserWindow) mit
// native/windows-safe-apply/electron-acceptance-harness.js, welches das
// native Modul (eine dedizierte, fuer Electrons eigene ABI neu gebaute
// Kopie - siehe electron-acceptance-harness.js's Kommentar) laedt, die
// echten process.versions aufzeichnet und GENAU einen MODIFY- + einen
// CREATE-Zyklus gegen ein synthetisches Temp-Fixture ausfuehrt. Diese Datei
// selbst laeuft unter dem normalen Vitest/Node-Prozess - sie startet nur
// einen Kindprozess und liest dessen Ergebnisdatei.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { describe, it, expect } from 'vitest'

const IS_WINDOWS = process.platform === 'win32'
const REPO_ROOT = path.join(__dirname, '..', '..', '..')
const HARNESS_PATH = path.join(REPO_ROOT, 'native', 'windows-safe-apply', 'electron-acceptance-harness.js')

// The `electron` package's main export is the absolute path to the actual
// electron.exe binary (never a .cmd shim, so this never needs shell:true).
function resolveElectronBinary(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(REPO_ROOT, 'node_modules', 'electron')) as string
  } catch {
    return null
  }
}

interface HarnessResult {
  ok: boolean
  versions: NodeJS.ProcessVersions
  platformSupported?: boolean
  testBuildHasFaultHook?: boolean
  productionBuildOmitsFaultHook?: boolean
  modifyResult?: { code: string }
  createResult?: { code: string }
  productionModifyResult?: { code: string }
  productionCreateResult?: { code: string }
  error?: string
}

function runElectronHarness(electronBin: string): Promise<HarnessResult> {
  return new Promise((resolve, reject) => {
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-electron-vitest-')), 'result.json')
    const child = spawn(electronBin, [HARNESS_PATH, outPath], { cwd: REPO_ROOT })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', () => {
      if (!fs.existsSync(outPath)) {
        reject(new Error(`electron harness produced no result file. stderr: ${stderr}`))
        return
      }
      resolve(JSON.parse(fs.readFileSync(outPath, 'utf8')) as HarnessResult)
    })
  })
}

describe.skipIf(!IS_WINDOWS)('windowsSafeApply - Electron runtime synthetic acceptance', () => {
  it('loads the native module inside the ACTUAL installed Electron Main process and completes a real MODIFY+CREATE cycle', async () => {
    const electronBin = resolveElectronBinary()
    if (!electronBin || !fs.existsSync(electronBin)) {
      throw new Error(`electron binary not found (resolved: ${electronBin}) - cannot run the mandatory Electron acceptance gate`)
    }
    const result = await runElectronHarness(electronBin)

    // Record (never hardcode/assume) the actual observed Electron runtime.
    // eslint-disable-next-line no-console
    console.log('[M4.8B.0 Electron runtime acceptance] process.versions:', result.versions)

    expect(result.error).toBeUndefined()
    expect(result.versions.electron).toBeTruthy()
    expect(result.versions.node).toBeTruthy()
    expect(result.versions.modules).toBeTruthy()
    expect(result.platformSupported).toBe(true)
    expect(result.modifyResult?.code).toBe('OK')
    expect(result.createResult?.code).toBe('OK')

    // V2: the harness ALSO loads a dedicated Electron-ABI rebuild of the
    // production-shaped target and proves it (a) still runs the exact same
    // real mutation code correctly, and (b) genuinely omits the fault-
    // injection test hook - both under the actual Electron runtime, not just
    // under plain Node (see windowsSafeApply.productionShape.windows.test.ts
    // for the plain-Node equivalent).
    expect(result.testBuildHasFaultHook).toBe(true)
    expect(result.productionBuildOmitsFaultHook).toBe(true)
    expect(result.productionModifyResult?.code).toBe('OK')
    expect(result.productionCreateResult?.code).toBe('OK')

    expect(result.ok).toBe(true)
  }, 30000)
})
