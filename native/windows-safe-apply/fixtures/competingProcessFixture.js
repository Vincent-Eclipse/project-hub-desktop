// M4.8B.0 - a small, FIXED-behavior competing-process fixture used only by
// windowsSafeApply.competingProcess.windows.test.ts. This is deliberately
// NOT a generic command bridge: it accepts exactly one of a small, fixed set
// of named modes (below) plus already-trusted, test-owned file paths - never
// an arbitrary shell command, never a caller-chosen program to run.
//
// Protocol (line-based over stdout, deterministic - no sleeps on either
// side):
//   hold-read <path>   / hold-write <path>
//     Attempts to open `path` with an ordinary Node fs handle (Node's
//     default sharing, which is permissive - see report). Prints exactly one
//     of:
//       READY               (handle acquired, now holding - waits for a
//                             stdin line before releasing)
//       OPEN_FAILED:<code>  (open failed immediately, e.g. sharing
//                             violation - exits immediately, nothing held)
//   attempt-read <path> / attempt-write <path> / attempt-delete <path>
//     One-shot attempt. Prints "OK" or "FAILED:<code>" and exits immediately.
//   attempt-rename <path> <newPath>
//     One-shot rename attempt. Prints "OK" or "FAILED:<code>".
//   attempt-write-file <path> <content>
//     One-shot EXCLUSIVE create (flag 'wx') with the given content. Prints
//     "OK" or "FAILED:<code>".
//   attempt-hardlink <existingPath> <newLinkPath>
//     One-shot hardlink creation attempt. Prints "OK" or "FAILED:<code>".
//   editor-safe-save <path> <content>
//     Simulates a common "safe save" editor pattern: writes `${path}.tmp`
//     then renames it over `path`. Prints "OK" or "FAILED:<code>" for the
//     rename step specifically.
const fs = require('fs');
const readline = require('readline');

const [, , mode, arg1, arg2] = process.argv;

function report(line) {
  process.stdout.write(line + '\n');
}

function errCode(err) {
  return err && err.code ? err.code : String(err);
}

switch (mode) {
  case 'hold-read':
  case 'hold-write': {
    let fd;
    try {
      fd = fs.openSync(arg1, mode === 'hold-read' ? 'r' : 'r+');
    } catch (err) {
      report('OPEN_FAILED:' + errCode(err));
      process.exit(0);
    }
    report('READY');
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', () => {
      fs.closeSync(fd);
      report('DONE');
      process.exit(0);
    });
    break;
  }
  case 'attempt-read': {
    try {
      fs.readFileSync(arg1);
      report('OK');
    } catch (err) {
      report('FAILED:' + errCode(err));
    }
    process.exit(0);
    break;
  }
  case 'attempt-write': {
    try {
      const fd = fs.openSync(arg1, 'r+');
      fs.writeSync(fd, Buffer.from('x'));
      fs.closeSync(fd);
      report('OK');
    } catch (err) {
      report('FAILED:' + errCode(err));
    }
    process.exit(0);
    break;
  }
  case 'attempt-delete': {
    try {
      fs.unlinkSync(arg1);
      report('OK');
    } catch (err) {
      report('FAILED:' + errCode(err));
    }
    process.exit(0);
    break;
  }
  case 'attempt-rename': {
    try {
      fs.renameSync(arg1, arg2);
      report('OK');
    } catch (err) {
      report('FAILED:' + errCode(err));
    }
    process.exit(0);
    break;
  }
  case 'attempt-write-file': {
    try {
      fs.writeFileSync(arg1, arg2 ?? '', { flag: 'wx' });
      report('OK');
    } catch (err) {
      report('FAILED:' + errCode(err));
    }
    process.exit(0);
    break;
  }
  case 'attempt-hardlink': {
    try {
      fs.linkSync(arg1, arg2);
      report('OK');
    } catch (err) {
      report('FAILED:' + errCode(err));
    }
    process.exit(0);
    break;
  }
  case 'editor-safe-save': {
    const tmpPath = arg1 + '.tmp';
    try {
      fs.writeFileSync(tmpPath, arg2 ?? '');
      fs.renameSync(tmpPath, arg1);
      report('OK');
    } catch (err) {
      report('FAILED:' + errCode(err));
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup only
      }
    }
    process.exit(0);
    break;
  }
  default: {
    process.stderr.write('unknown fixture mode: ' + mode + '\n');
    process.exit(2);
  }
}
