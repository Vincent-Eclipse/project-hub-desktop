import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createTestDb } from '../testUtils/testDb'
import { createProject } from './projectsService'
import { createWorkRequest, replaceTaskLinks } from './workRequestService'
import { createTask } from './taskService'
import { realClaudeProcessLauncher, realKillProcessTree } from './claudeCliAdapter'
import { proposeCodeChange } from './claudeCodeChangeService'
import type { RunPolicySnapshot, RunTrustedScope } from './runService'

// Meilenstein 4.7B.2 (V3 - Smoke Acceptance Fix) - EINZIGER opt-in Pfad, der
// einen echten, tool-losen Claude-Code-Change-Aufruf tatsaechlich startet.
//
// V3: die synthetische Aufgabe verlangt jetzt EXPLIZIT BEIDE echten
// Aenderungsarten (MODIFY src/math.ts UND CREATE src/math.test.ts) statt nur
// "irgendeinen Test hinzufuegen" - eine Claude-Antwort, die nur CREATEt und
// das MODIFY auslaesst, muss diesen Smoke durchfallen lassen, nicht
// stillschweigend bestehen. Die Pruefung verlangt entsprechend GENAU 2
// Aenderungen (eine MODIFY auf src/math.ts, eine CREATE auf
// src/math.test.ts) statt nur "jeder Pfad ist erlaubt". Der
// Originaldatei-Vergleich ist jetzt ein echter Buffer-Byte-Vergleich, nicht
// nur ein dekodierter UTF-8-String-Vergleich.
//
// NIEMALS Teil von `npm test`/`npm run verify`/CI/App-Start - ZWEI
// unabhaengige Schutzschichten, genau wie claudeCliAdapter.smoke.ts:
//   1. Dieser Dateiname endet auf `.smoke.ts`, NICHT auf `.test.ts` - er
//      matcht daher NICHT das `include`-Muster von vitest.config.ts
//      (`src/**/*.test.ts`) und wird von einem normalen `npm test`/
//      `npm run verify`-Lauf gar nicht erst entdeckt. Die einzige
//      Konfiguration, die diese Datei ueberhaupt kennt, ist die separate
//      `vitest.smoke.config.ts`.
//   2. Selbst unter `vitest.smoke.config.ts` schaltet sich dieser Test
//      zusaetzlich selbst ab, wenn ECLIPSE_CLAUDE_CODE_CHANGE_SMOKE nicht
//      exakt '1' ist - ein EIGENES, von ECLIPSE_CLAUDE_SMOKE (Planungsprofil)
//      unabhaengiges Gate, damit ein Aufrufer, der nur den Planungs-Smoke
//      freigeben wollte, niemals versehentlich auch diesen startet.
//
// Ausfuehren (NUR nach expliziter Freigabe):
//   $env:ECLIPSE_CLAUDE_CODE_CHANGE_SMOKE = '1'
//   npx vitest run --config vitest.smoke.config.ts
//
// Verwendet AUSSCHLIESSLICH ein synthetisches, temporaeres Projekt/DB/
// Dateisystem-Fixture - NIEMALS das echte Eclipse-Repository, echten
// Projekt-Quellcode, Secrets oder persoenliche Dateien. Main-owned Policy/
// Scope/Disclosure werden hier explizit und vollstaendig HARDCODIERT (kein
// Renderer/IPC/Agent-Pfad existiert - siehe claudeCodeChangeService.ts's
// Datei-Kommentar).
const SMOKE_ENABLED = process.env.ECLIPSE_CLAUDE_CODE_CHANGE_SMOKE === '1'

function syntheticMathSource(): string {
  return ['export function add(a, b) {', '  return a + b', '}', ''].join('\n')
}

function syntheticMathBuffer(): Buffer {
  return Buffer.from(syntheticMathSource(), 'utf8')
}

const cleanupDirs: string[] = []
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe.skipIf(!SMOKE_ENABLED)('Claude Code Change real smoke (opt-in, ECLIPSE_CLAUDE_CODE_CHANGE_SMOKE=1)', () => {
  it(
    'requires BOTH a real MODIFY of src/math.ts and a real CREATE of src/math.test.ts via a single real, tool-disabled Claude invocation',
    async () => {
      const root = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'eclipse-claude-code-change-smoke-')))
      cleanupDirs.push(root)
      await fsp.mkdir(path.join(root, 'src'), { recursive: true })
      await fsp.writeFile(path.join(root, 'src', 'math.ts'), syntheticMathBuffer())
      // Read back the exact on-disk bytes (not just the in-memory buffer we wrote) as the
      // ground truth for the later byte-identity check - catches any accidental encoding/EOL
      // transformation the filesystem/OS might otherwise introduce, not just a tautology.
      const originalBytes = await fsp.readFile(path.join(root, 'src', 'math.ts'))

      const db = createTestDb()
      try {
        const project = createProject(db, {
          name: 'Synthetic Code Change Smoke Project',
          projectType: 'Demo',
          description: 'A fictional project used only to smoke-test the Claude Code change adapter.',
          folderPath: root
        })
        const workRequest = createWorkRequest(db, {
          projectId: project.id,
          intentMarkdown:
            'Add explicit TypeScript types to the existing add() helper AND add a small test file for it. ' +
            'Both changes are required, not just one of them.',
          createdBy: 'LEON'
        })
        const task = createTask(db, {
          projectId: project.id,
          title: 'Type add() and add a test for it',
          goalMarkdown:
            'Two required changes to this fictional demo project:\n' +
            '1. MODIFY src/math.ts: add explicit "number" parameter types to both parameters of ' +
            'add(a, b), and add an explicit "number" return type to the function - do not change its ' +
            'behavior.\n' +
            '2. CREATE src/math.test.ts: add a small test file that calls add() and checks the ' +
            'result.\n' +
            'Both the MODIFY and the CREATE are required - do not submit only one of them. Do not run ' +
            'any test or command; only propose the file changes.',
          createdBy: 'LEON'
        })
        replaceTaskLinks(db, { projectId: project.id, workRequestId: workRequest.id, taskIds: [task.id] })

        // Main-owned, explicit authorities - never derived from each other (see M4.7B.2-V2 "FIX 1"
        // and the frozen "disclosure is separate from filesystem.read" rule).
        const sourceReadPolicy: RunPolicySnapshot = { policy: { 'filesystem.read': 'ALLOW' }, ruleDeniedCapabilities: [] }
        const sourceReadTrustedScope: RunTrustedScope = { operationId: 'project.readTextFiles', allowedRelativePaths: ['src/math.ts'] }
        const disclosureScope = { disclosedRelativePaths: ['src/math.ts'] }
        const request = {
          projectId: project.id,
          workRequestId: workRequest.id,
          taskId: task.id,
          sourcePaths: ['src/math.ts'],
          modifyPaths: ['src/math.ts'],
          createPaths: ['src/math.test.ts']
        }

        const outcome = await proposeCodeChange(
          db,
          { launcher: realClaudeProcessLauncher, killProcessTree: realKillProcessTree },
          request,
          disclosureScope,
          sourceReadPolicy,
          sourceReadTrustedScope
        )

        // eslint-disable-next-line no-console
        console.log(`[smoke] outcome status: ${outcome.status}`)
        if (outcome.status === 'FAILED') {
          // eslint-disable-next-line no-console
          console.log(`[smoke] failureCode: ${outcome.failureCode}`)
        } else {
          // eslint-disable-next-line no-console
          console.log(`[smoke] change count: ${outcome.result.proposal.changes.length}`)
          // eslint-disable-next-line no-console
          console.log(
            `[smoke] changes (synthetic relative paths only): ${JSON.stringify(outcome.result.proposal.changes.map((c) => ({ type: c.type, path: c.path })))}`
          )
        }
        expect(outcome.status).toBe('SUCCEEDED')
        if (outcome.status !== 'SUCCEEDED') return

        // The smoke must exercise BOTH real change types - a Claude response that only ever
        // CREATEs the test file (skipping the MODIFY) must fail this smoke, not pass it silently.
        // Never inspect/print the actual generated content - path/type only.
        const { changes } = outcome.result.proposal
        expect(changes.length).toBe(2)
        const modifyChange = changes.find((change) => change.type === 'MODIFY')
        const createChange = changes.find((change) => change.type === 'CREATE')
        expect(modifyChange).toBeDefined()
        expect(createChange).toBeDefined()
        expect(modifyChange?.path).toBe('src/math.ts')
        expect(createChange?.path).toBe('src/math.test.ts')

        // No apply/write ever occurred - original bytes remain byte-identical (raw Buffer
        // comparison, not just decoded UTF-8 text), and the proposed CREATE target still does not
        // exist on disk (M4.7B.2 mutates nothing).
        const bytesAfter = await fsp.readFile(path.join(root, 'src', 'math.ts'))
        expect(bytesAfter).toEqual(originalBytes)
        expect(fs.existsSync(path.join(root, 'src', 'math.test.ts'))).toBe(false)
      } finally {
        db.close()
      }
    },
    190_000
  )
})

describe.skipIf(SMOKE_ENABLED)('Claude Code Change real smoke (disabled)', () => {
  it('is skipped unless ECLIPSE_CLAUDE_CODE_CHANGE_SMOKE=1 is set - see file header for the exact command', () => {
    expect(SMOKE_ENABLED).toBe(false)
  })
})
