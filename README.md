# Project Hub Desktop

Project Hub is a local Electron application for keeping software projects, tasks, context and review notes in one place. It was built as a desktop-first workflow tool, with project data stored locally in SQLite.

This repository is a cleaned historical snapshot of the application code. It includes the Electron main/preload/renderer separation, React UI, SQLite migrations, IPC validation, tests and the Windows-safe file-apply work. Local databases, generated builds and development history are not included.

## Stack

- Electron, React and TypeScript
- Zustand for renderer state
- better-sqlite3 with versioned migrations
- Vitest and electron-vite
- a small Node-API/C++ module for guarded Windows file operations

## Run locally

Node.js 22 and npm 10 or newer are required. The native SQLite dependency is rebuilt for Electron during installation.

```bash
npm ci
npm run dev
```

The full verification command runs type checking, tests and a production build:

```bash
npm run verify
```

The project is a development snapshot, not a packaged desktop release. It does not include an installer or auto-updater.
