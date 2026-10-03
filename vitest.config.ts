import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Vitest 4 (verlangt Vite >=6, hier Vite 7 - passt) hat gegenueber Vitest 2
// u.a. den Pool-/Coverage-Optionsbaum umgebaut, Workspace zu "projects"
// umbenannt und veraltete Reporter-Hooks entfernt - keiner dieser Punkte
// betrifft diese minimale Konfiguration: kein Coverage-Setup, kein
// Workspace, kein benutzerdefinierter Reporter, kein Pool-Tuning, keine
// Browser-Provider. `environment: 'node'` und alias-basierte Aufloesung
// funktionieren unveraendert. `reporters` wird als Array angegeben (statt
// einem einzelnen String) - das ist die in Vitest 4 kanonische Form.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default']
    // Weder `ui: true` noch eine `api`-Server-Konfiguration ist gesetzt - es
    // gibt also keinen oeffentlich erreichbaren Testserver (Punkt 6 der
    // RC4-Korrektur). `npm run test` ruft explizit `vitest run` auf (ein
    // einzelner, nicht interaktiver Lauf); `npm run test:watch` ruft das
    // interaktive, aber weiterhin lokal-only `vitest` im Watch-Modus auf.
  }
})
