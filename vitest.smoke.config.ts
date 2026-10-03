import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Meilenstein 4.7A (erweitert in 4.7B.2) - dediziertes Vitest-Projekt
// AUSSCHLIESSLICH fuer die opt-in echten Claude-Smoke-Tests
// (claudeCliAdapter.smoke.ts fuer das Planungsprofil,
// claudeCodeChange.smoke.ts fuer das Code-Change-Profil).
//
// M4.7A v2 review fix: jeder Smoke-Testdatei-Name endet bewusst auf
// `.smoke.ts` (NICHT `.smoke.test.ts`) - das matcht daher gar nicht erst das
// `include`-Muster von vitest.config.ts (`src/**/*.test.ts`) und wird von
// einem normalen `npm test`/`npm run verify`-Lauf technisch gar nicht
// entdeckt (nicht nur "uebersprungen" - es taucht dort ueberhaupt nicht auf).
// Diese Datei hier ist die EINZIGE Vitest-Konfiguration, die die Smoke-
// Dateien ueberhaupt kennt. Zusaetzlich ist jeder Test selbst intern per
// einem EIGENEN Env-Var geschuetzt (ECLIPSE_CLAUDE_SMOKE fuer das
// Planungsprofil, ECLIPSE_CLAUDE_CODE_CHANGE_SMOKE fuer das Code-Change-
// Profil - siehe jeweiliger Datei-Kommentar) - zwei unabhaengige
// Schutzschichten je Profil, und die beiden Profile lassen sich unabhaengig
// voneinander freigeben.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['src/main/services/claudeCliAdapter.smoke.ts', 'src/main/services/claudeCodeChange.smoke.ts'],
    reporters: ['default'],
    testTimeout: 200_000
  }
})
