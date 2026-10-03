#!/usr/bin/env node
// Meilenstein 4.8B.0 V2 - Windows-aware `pretest` step that makes the
// mandatory windows-safe-apply native suites reproducible from a fresh
// checkout, instead of depending on a manually-issued node-gyp command run
// earlier in some prior session.
//
// On any non-Windows platform this exits successfully immediately, WITHOUT
// touching anything - there is no native module to build there at all (see
// native/windows-safe-apply/binding.gyp's OS=='win' condition).
//
// On Windows, this builds BOTH binding.gyp targets (windows_safe_apply, with
// test hooks; windows_safe_apply_production, without them - see
// napi_entry.cc's WSA_ENABLE_TEST_HOOKS gate) for BOTH ABIs actually needed:
//   - the plain Node ABI (what `vitest run` itself uses) -> left in place at
//     native/windows-safe-apply/build/Release/*.node
//   - the Electron ABI (what electron-acceptance-harness.js needs) -> copied
//     to native/windows-safe-apply/electron-build/*.node
// IMPORTANT: `node-gyp rebuild` always runs a full `clean` first, which
// rimraf's the ENTIRE build/ directory - so the Electron-ABI snapshot is
// deliberately copied to a location OUTSIDE build/ (electron-build/,
// ignored via native/windows-safe-apply/.gitignore) BEFORE the final
// plain-Node rebuild runs; otherwise that last rebuild's own clean step
// would delete the snapshot it just made. build/Release/ itself is covered
// by this repo's top-level `build/` .gitignore pattern - nothing generated
// by this script is ever committed.
//
// This script invokes ONLY fixed local executables (this same Node binary,
// running node-gyp's own bin/node-gyp.js entry point directly) with fixed,
// hardcoded argument lists - never shell:true, never a cmd.exe/PowerShell
// command string, never a caller-controlled argument.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..')
const NATIVE_DIR = path.join(REPO_ROOT, 'native', 'windows-safe-apply')
const NODE_GYP_JS = path.join(REPO_ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
const RELEASE_DIR = path.join(NATIVE_DIR, 'build', 'Release')
const ELECTRON_SNAPSHOT_DIR = path.join(NATIVE_DIR, 'electron-build')

const TARGET_FILES = ['windows_safe_apply.node', 'windows_safe_apply_production.node']

function log(message) {
  console.log(`[prepare-windows-safe-apply-tests] ${message}`)
}

function runNodeGyp(args) {
  log(`node-gyp ${args.join(' ')}`)
  const result = spawnSync(process.execPath, [NODE_GYP_JS, ...args], {
    cwd: NATIVE_DIR,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    throw new Error(`node-gyp ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

function readInstalledElectronVersion() {
  // Read directly from the installed package's own package.json rather than
  // duplicating/hardcoding a version string anywhere in this script -
  // whatever `electron` devDependency version is actually installed is what
  // gets built against.
  const pkgPath = path.join(REPO_ROOT, 'node_modules', 'electron', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  return pkg.version
}

function main() {
  if (process.platform !== 'win32') {
    log('non-Windows platform detected - nothing to build, exiting successfully.')
    return
  }

  if (!existsSync(NODE_GYP_JS)) {
    console.error('[prepare-windows-safe-apply-tests] BLOCKED - node-gyp not found at ' + NODE_GYP_JS)
    process.exit(1)
  }

  const electronVersion = readInstalledElectronVersion()
  log(`installed Electron version (read from node_modules/electron/package.json): ${electronVersion}`)

  // 1. Plain Node ABI - both targets land in build/Release/, exactly where
  //    the Vitest suites and windowsSafeApply.ts's default addon path expect
  //    them.
  runNodeGyp(['rebuild'])

  // 2. Electron ABI - temporarily overwrites build/Release/ with
  //    Electron-ABI binaries; immediately snapshot them to build/electron/
  //    before restoring the plain-Node build in step 3.
  runNodeGyp(['rebuild', `--target=${electronVersion}`, '--arch=x64', '--dist-url=https://electronjs.org/headers'])

  mkdirSync(ELECTRON_SNAPSHOT_DIR, { recursive: true })
  for (const file of TARGET_FILES) {
    const from = path.join(RELEASE_DIR, file)
    const to = path.join(ELECTRON_SNAPSHOT_DIR, file)
    if (!existsSync(from)) {
      throw new Error(`expected Electron-ABI build output missing: ${from}`)
    }
    copyFileSync(from, to)
    log(`snapshotted Electron-ABI build: ${to}`)
  }

  // 3. Restore the plain Node ABI in build/Release/ so `vitest run` (which
  //    runs under plain Node, not Electron) loads the correct ABI.
  runNodeGyp(['rebuild'])

  log('done - build/Release/*.node is plain-Node ABI, electron-build/*.node is Electron ABI.')
}

main()
