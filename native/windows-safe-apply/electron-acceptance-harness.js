// M4.8B.0 - narrow, controlled Electron-Main-process acceptance harness.
// NEVER the real Project Hub UI: no BrowserWindow, no provider, no
// production project, no repository mutation, no arbitrary command
// execution. Loads the native windows-safe-apply module under the actual
// installed Electron runtime, records the real process.versions, and runs
// one MODIFY + one CREATE cycle against a synthetic temp fixture only. Writes
// a small JSON result file (path given as argv[2]) and exits. Invoked only
// from windowsSafeApply.electron.test.ts via `electron <this file>` - never
// wired into src/main/index.ts or any production entry point.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const outPath = process.argv[2];
if (!outPath) {
  console.error('missing output path argv');
  process.exit(2);
}

function writeResultAndExit(result) {
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
}

function runCycle(addon) {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wsa-electron-'));
  try {
    const modifyPath = path.join(root, 'existing.txt');
    const original = Buffer.from('electron acceptance original\n', 'utf8');
    fs.writeFileSync(modifyPath, original);
    const proposed = Buffer.from('electron acceptance mutated\n', 'utf8');

    const plan = {
      root,
      sources: [],
      modifies: [
        {
          path: 'existing.txt',
          expectedSha256Hex: crypto.createHash('sha256').update(original).digest('hex'),
          expectedLength: original.length,
          proposedBytes: proposed
        }
      ],
      creates: [{ path: 'created.txt', proposedBytes: Buffer.from('electron created\n', 'utf8') }]
    };

    const prep = addon.prepareLease(plan);
    const modifyResult = addon.applyModify(prep.lease, 0);
    const createResult = addon.createFile(prep.lease, 0);
    addon.closeLease(prep.lease);

    const onDiskModify = fs.readFileSync(modifyPath);
    const onDiskCreate = fs.readFileSync(path.join(root, 'created.txt'));

    const ok =
      modifyResult.code === 'OK' &&
      createResult.code === 'OK' &&
      onDiskModify.equals(proposed) &&
      onDiskCreate.equals(Buffer.from('electron created\n', 'utf8'));

    return { ok, modifyResult, createResult };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

app.whenReady().then(() => {
  const result = { ok: false, versions: process.versions };
  try {
    // Both snapshots below are dedicated Electron-ABI rebuilds under
    // electron-build/ (a sibling of build/, ignored via this directory's own
    // .gitignore - deliberately NOT inside build/, since `node-gyp rebuild`
    // always cleans that whole directory first) - NEVER the same file the
    // plain-Node Vitest suites use (build/Release/windows_safe_apply*.node,
    // which stays built for the plain Node ABI so `npm test` keeps
    // working). See scripts/prepare-windows-safe-apply-tests.mjs for the
    // exact rebuild sequence that produces these.
    const testAddon = require(path.join(__dirname, 'electron-build', 'windows_safe_apply.node'));
    const productionAddon = require(path.join(__dirname, 'electron-build', 'windows_safe_apply_production.node'));

    result.platformSupported = testAddon.platformSupported;
    result.testBuildHasFaultHook = typeof testAddon.setFaultPoint === 'function';
    result.productionBuildOmitsFaultHook = typeof productionAddon.setFaultPoint === 'undefined';

    const testCycle = runCycle(testAddon);
    const productionCycle = runCycle(productionAddon);

    result.modifyResult = testCycle.modifyResult;
    result.createResult = testCycle.createResult;
    result.productionModifyResult = productionCycle.modifyResult;
    result.productionCreateResult = productionCycle.createResult;

    result.ok =
      testCycle.ok && productionCycle.ok && result.testBuildHasFaultHook && result.productionBuildOmitsFaultHook;
  } catch (err) {
    result.error = err && err.stack ? err.stack : String(err);
  }
  writeResultAndExit(result);
});
