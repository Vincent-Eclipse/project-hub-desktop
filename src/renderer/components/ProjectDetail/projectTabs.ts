// Meilenstein 4.3 - reine Tab-Konfiguration, ausgelagert aus
// ProjectDetailShell.tsx, damit die einzige M4.3-Navigationsaenderung ("Work
// zuerst, Work als Standard") deterministisch testbar ist, ohne einen
// React-Render-Test-Rahmen einzufuehren (die bestehende Vitest-Konfiguration
// deckt nur `src/**/*.test.ts` ab, kein jsdom/@testing-library). Alle
// bestehenden technischen Tabs bleiben unveraendert erhalten - keine
// Advanced-Navigation, kein Entfernen, keine Umsortierung ausser "Work"
// an Position 0.
export const PROJECT_TABS = [
  { key: 'work', label: 'Work' },
  { key: 'repository', label: 'Repository' },
  { key: 'overview', label: 'Überblick' },
  { key: 'context', label: 'Projekt-Kontext' },
  { key: 'tasks', label: 'Aufgaben' },
  { key: 'rules', label: 'Projekt-Regeln' },
  { key: 'chat', label: 'Verlauf' },
  { key: 'sessions', label: 'Sitzungen' },
  { key: 'import', label: 'Import' },
  { key: 'handoff', label: 'Übergabe' }
] as const

export type ProjectTabKey = (typeof PROJECT_TABS)[number]['key']

export const DEFAULT_PROJECT_TAB: ProjectTabKey = 'work'
