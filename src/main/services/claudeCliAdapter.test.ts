import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControllerPlan } from '@shared/types'
import type { CodeChangeProposal } from '@shared/codeChangeTypes'
import type { TrustedCodeChangeScope } from './codeChangeValidation'
import {
  buildAllowedEnvironment,
  CLAUDE_CODE_CHANGE_SYSTEM_PROMPT,
  CLAUDE_PLANNING_SYSTEM_PROMPT,
  CODE_CHANGE_PROPOSAL_JSON_SCHEMA,
  CONTROLLER_PLAN_JSON_SCHEMA,
  type ClaudeCliAdapterDeps,
  type ClaudeChildProcess,
  type ClaudeProcessLauncher,
  __resetActiveInvocationForTests,
  invokeClaudeCodeChange,
  invokeClaudePlanning,
  parseClaudeVersion,
  preflight,
  resolveClaudeExecutablePath
} from './claudeCliAdapter'

function validPlan(): ControllerPlan {
  return { planningResult: { planMarkdown: 'Plan', decisionRequests: [] }, taskDrafts: [] }
}

// Matches the ACTUAL Claude Code 2.1.266 envelope shape observed by the first real smoke test:
// the ControllerPlan proposal is the `structured_output` object, never JSON text inside `result`
// (see claudeOutputValidation.ts). `result` deliberately holds unrelated text here to prove the
// adapter never uses it as the proposal source.
function successEnvelope(plan: ControllerPlan = validPlan()): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'synthetic discarded result text',
    session_id: 'fake-session',
    structured_output: plan
  })
}

/** A fully controllable fake stdin - a real EventEmitter so tests can simulate an
 * asynchronous pipe error (e.g. EPIPE) via `.emit('error', ...)`, not just a synchronous throw. */
class FakeStdin extends EventEmitter {
  write = vi.fn()
  end = vi.fn()
}

/** A fully controllable fake ChildProcess - never spawns a real process. */
class FakeChildProcess extends EventEmitter implements ClaudeChildProcess {
  pid = 4242
  stdin = new FakeStdin()
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

interface FakeLauncherRecorder {
  launcher: ClaudeProcessLauncher
  calls: Array<{ executable: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } }>
  lastChild: FakeChildProcess | null
  nextChild: () => FakeChildProcess
}

// preflight() issues its own separate `--version` launcher call before the real,
// tool-disabled invocation call. Auto-answer that first call with a supported
// version so every invokeClaudePlanning-level test only has to reason about the
// real invocation call (recorded in `calls`/`lastChild` below) - the dedicated
// `preflight` describe block below exercises the `--version` call directly.
function respondToVersionCheck(version = '2.1.266'): FakeChildProcess {
  const child = new FakeChildProcess()
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(version, 'utf8'))
    child.emit('close', 0, null)
  })
  return child
}

function createFakeLauncher(makeChild: () => FakeChildProcess = () => new FakeChildProcess()): FakeLauncherRecorder {
  const calls: FakeLauncherRecorder['calls'] = []
  let lastChild: FakeChildProcess | null = null
  const launcher: ClaudeProcessLauncher = (executable, args, options) => {
    if (args.includes('--version')) return respondToVersionCheck()
    calls.push({ executable, args, options })
    const child = makeChild()
    lastChild = child
    return child
  }
  return {
    launcher,
    calls,
    get lastChild() {
      return lastChild
    },
    nextChild: makeChild
  } as FakeLauncherRecorder
}

function fakeKillProcessTree(): { fn: (pid: number) => Promise<void>; calledWith: number[] } {
  const calledWith: number[] = []
  const fn = vi.fn(async (pid: number) => {
    calledWith.push(pid)
  })
  return { fn, calledWith }
}

let executablePath: string

beforeEach(() => {
  __resetActiveInvocationForTests()
  executablePath = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-fake-exe-')) + path.sep + 'claude.exe'
  fs.writeFileSync(executablePath, '')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  try {
    fs.rmSync(path.dirname(executablePath), { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
  __resetActiveInvocationForTests()
})

function succeedImmediately(child: FakeChildProcess, envelope: string = successEnvelope()): void {
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(envelope, 'utf8'))
    child.emit('close', 0, null)
  })
}

describe('resolveClaudeExecutablePath', () => {
  it('resolves under the current user home, never a hardcoded path', () => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\someone-else')
    const resolved = resolveClaudeExecutablePath()
    expect(resolved).toBe(path.join('C:\\Users\\someone-else', '.local', 'bin', 'claude.exe'))
    expect(resolved).not.toContain('leong')
  })
})

describe('parseClaudeVersion', () => {
  it('extracts a semantic version from arbitrary surrounding text', () => {
    expect(parseClaudeVersion('Claude Code 2.1.266 (Claude Code)')).toBe('2.1.266')
    expect(parseClaudeVersion('2.1.266')).toBe('2.1.266')
    expect(parseClaudeVersion('not a version')).toBeNull()
  })
})

describe('preflight', () => {
  it('reports CLI_NOT_FOUND-equivalent state when the executable does not exist', async () => {
    const { fn: killProcessTree } = fakeKillProcessTree()
    const { launcher } = createFakeLauncher()
    const result = await preflight({ launcher, killProcessTree, executablePath: path.join(os.tmpdir(), 'does-not-exist.exe') })
    expect(result.executableFound).toBe(false)
    expect(result.versionSupported).toBe(false)
  })

  it('reports an unsupported version when the tested version set does not contain it', async () => {
    const { fn: killProcessTree } = fakeKillProcessTree()
    const launcher: ClaudeProcessLauncher = () => {
      const child = new FakeChildProcess()
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('Claude Code 9.9.9', 'utf8'))
        child.emit('close', 0, null)
      })
      return child
    }
    const result = await preflight({ launcher, killProcessTree, executablePath })
    expect(result.executableFound).toBe(true)
    expect(result.version).toBe('9.9.9')
    expect(result.versionSupported).toBe(false)
  })

  it('reports the tested version as supported', async () => {
    const { fn: killProcessTree } = fakeKillProcessTree()
    const launcher: ClaudeProcessLauncher = () => {
      const child = new FakeChildProcess()
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('Claude Code 2.1.266', 'utf8'))
        child.emit('close', 0, null)
      })
      return child
    }
    const result = await preflight({ launcher, killProcessTree, executablePath })
    expect(result.versionSupported).toBe(true)
  })

  it('fails closed instead of retaining unbounded --version output', async () => {
    const { fn: killProcessTree } = fakeKillProcessTree()
    const launcher: ClaudeProcessLauncher = () => {
      const child = new FakeChildProcess()
      queueMicrotask(() => {
        // Oversized, otherwise well-formed version output - must not be parsed/retained.
        child.stdout.emit('data', Buffer.from(`Claude Code 2.1.266 ${'x'.repeat(16 * 1024 + 1)}`, 'utf8'))
        child.emit('close', 0, null)
      })
      return child
    }
    const result = await preflight({ launcher, killProcessTree, executablePath })
    expect(result.version).toBeNull()
    expect(result.versionSupported).toBe(false)
  })
})

describe('buildAllowedEnvironment', () => {
  it('never inherits arbitrary process.env values', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-should-not-appear')
    vi.stubEnv('HTTP_PROXY', 'http://evil:8080')
    vi.stubEnv('HTTPS_PROXY', 'http://evil:8080')
    vi.stubEnv('ALL_PROXY', 'http://evil:8080')
    vi.stubEnv('NODE_OPTIONS', '--inspect')
    vi.stubEnv('CLAUDE_CODE_SOMETHING', 'x')
    vi.stubEnv('GIT_SSH_COMMAND', 'x')
    vi.stubEnv('SECRET_TOKEN', 'x')
    const env = buildAllowedEnvironment()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.ALL_PROXY).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.CLAUDE_CODE_SOMETHING).toBeUndefined()
    expect(env.GIT_SSH_COMMAND).toBeUndefined()
    expect(env.SECRET_TOKEN).toBeUndefined()
    expect(env.PATH).toBeUndefined()
    expect(Object.keys(env).every((key) => ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR'].includes(key))).toBe(true)
  })
})

function deps(overrides: Partial<ClaudeCliAdapterDeps> = {}): { deps: ClaudeCliAdapterDeps; recorder: FakeLauncherRecorder; killProcessTree: ReturnType<typeof fakeKillProcessTree> } {
  const recorder = createFakeLauncher()
  const killProcessTree = fakeKillProcessTree()
  return {
    recorder,
    killProcessTree,
    deps: { launcher: recorder.launcher, killProcessTree: killProcessTree.fn, executablePath, ...overrides }
  }
}

describe('invokeClaudePlanning - CLI profile', () => {
  it('uses the fixed executable, no shell, an empty --tools argument, and no caller-configurable flags', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedImmediately(recorder.lastChild as FakeChildProcess)
    const outcome = await outcomePromise
    expect(outcome.status).toBe('SUCCEEDED')

    const call = recorder.calls[0]
    expect(call.executable).toBe(executablePath)
    expect(call.args).toContain('--print')
    expect(call.args).toContain('--tools')
    const toolsIndex = call.args.indexOf('--tools')
    expect(call.args[toolsIndex + 1]).toBe('')
    expect(call.args).toContain('--permission-mode')
    expect(call.args[call.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(call.args).toContain('--permission-prompts')
    expect(call.args[call.args.indexOf('--permission-prompts') + 1]).toBe('none')
    expect(call.args).toContain('--safe-mode')
    expect(call.args).toContain('--restricted')
    expect(call.args).toContain('--strict-mcp-config')
    expect(call.args).toContain('--disable-slash-commands')
    expect(call.args).toContain('--no-chrome')
    expect(call.args).toContain('--no-session-persistence')
    expect(call.args).toContain('--system-prompt')
    expect(call.args[call.args.indexOf('--system-prompt') + 1]).toBe(CLAUDE_PLANNING_SYSTEM_PROMPT)
    expect(call.args).toContain('--json-schema')
    expect(JSON.parse(call.args[call.args.indexOf('--json-schema') + 1])).toEqual(CONTROLLER_PLAN_JSON_SCHEMA)
    expect(call.args).not.toContain('--bare')
    expect(call.args.join(' ')).not.toMatch(/bypassPermissions|dangerously-skip-permissions|acceptEdits|--resume|--continue/)

    expect(call.options.cwd).not.toBe(process.cwd())
    expect(path.isAbsolute(call.options.cwd)).toBe(true)
  })

  it('runs in a neutral temporary cwd, never the real project directory, and cleans it up afterward', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const usedCwd = recorder.calls[0].options.cwd
    succeedImmediately(recorder.lastChild as FakeChildProcess)
    await outcomePromise
    expect(fs.existsSync(usedCwd)).toBe(false)
  })

  it('writes the Context Pack through stdin and never inline in argv', async () => {
    const { deps: d, recorder } = deps()
    const payload = JSON.stringify({ secretLookingButNotSensitive: 'work request intent text' })
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: payload })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    succeedImmediately(child)
    await outcomePromise
    expect(child.stdin.write).toHaveBeenCalledWith(payload)
    expect(child.stdin.end).toHaveBeenCalled()
    expect(recorder.calls[0].args.join(' ')).not.toContain('work request intent text')
  })
})

describe('invokeClaudePlanning - output handling', () => {
  it('returns SUCCEEDED with the validated proposal on a clean success envelope', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedImmediately(recorder.lastChild as FakeChildProcess)
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'SUCCEEDED', proposal: validPlan() })
  })

  it('waits for "close" (not "exit") before parsing stdout, so a valid response split across the boundary still succeeds', async () => {
    // Node's 'exit' event can fire before all buffered stdout has actually been delivered
    // through the pipe - a valid JSON response must not be misclassified as INVALID_OUTPUT just
    // because more stdout arrives (and the process fully closes) after 'exit' fires.
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess

    const envelope = successEnvelope()
    const splitPoint = Math.floor(envelope.length / 2)
    const firstHalf = envelope.slice(0, splitPoint)
    const secondHalf = envelope.slice(splitPoint)

    queueMicrotask(() => {
      // 1. Only the first part of stdout has arrived so far.
      child.stdout.emit('data', Buffer.from(firstHalf, 'utf8'))
      // 2. 'exit' fires - the adapter must NOT treat this as the final output boundary.
      child.emit('exit', 0, null)
    })
    // Give the (incorrect) old "parse on exit" implementation a chance to have already settled
    // before the rest of stdout and 'close' arrive.
    await new Promise((resolve) => setImmediate(resolve))
    queueMicrotask(() => {
      // 3. The remaining stdout bytes arrive after 'exit'.
      child.stdout.emit('data', Buffer.from(secondHalf, 'utf8'))
      // 4. Only now does the process fully close.
      child.emit('close', 0, null)
    })

    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'SUCCEEDED', proposal: validPlan() })
  })

  it('never treats a nonzero exit code as success even with a well-formed envelope', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(successEnvelope(), 'utf8'))
      child.emit('close', 1, null)
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'PROCESS_FAILED' })
  })

  it('rejects malformed JSON stdout as INVALID_OUTPUT', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('not json at all', 'utf8'))
      child.emit('close', 0, null)
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects prose surrounding JSON as INVALID_OUTPUT', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(`Sure!\n${successEnvelope()}`, 'utf8'))
      child.emit('close', 0, null)
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects Markdown fences around the envelope as INVALID_OUTPUT', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('```json\n' + successEnvelope() + '\n```', 'utf8'))
      child.emit('close', 0, null)
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects invalid UTF-8 stdout as INVALID_OUTPUT', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from([0xff, 0xfe, 0x00, 0x41]))
      child.emit('close', 0, null)
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects a leading BOM as INVALID_OUTPUT', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(successEnvelope(), 'utf8')]))
      child.emit('close', 0, null)
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects an invalid ControllerPlan (Claude-supplied authority field) via the existing validator', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    const tampered = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'synthetic discarded result text',
      session_id: 'x',
      structured_output: { ...validPlan(), approved: true }
    })
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(tampered, 'utf8'))
      child.emit('close', 0, null)
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('treats a structured is_error envelope as PROCESS_FAILED, never SUCCEEDED', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    const errored = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'synthetic discarded result text',
      session_id: 'x',
      structured_output: {}
    })
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(errored, 'utf8'))
      child.emit('close', 0, null)
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'PROCESS_FAILED' })
  })

  it('succeeds regardless of the exact subtype value, since it has not been deliberately confirmed by a smoke run', async () => {
    // Terminal success is established from what real smoke evidence DID confirm: a zero process
    // close code, a structurally valid envelope, is_error === false, and a validated
    // structured_output - never from a specific, unconfirmed subtype string value.
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'some_other_observed_subtype',
      is_error: false,
      result: 'synthetic discarded result text',
      session_id: 'x',
      structured_output: validPlan()
    })
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(envelope, 'utf8'))
      child.emit('close', 0, null)
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'SUCCEEDED', proposal: validPlan() })
  })

  it('terminates and reports OUTPUT_LIMIT when stdout exceeds the cap, discarding partial output', async () => {
    const { deps: d, recorder, killProcessTree } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.alloc(512 * 1024 + 1, 'a'))
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'OUTPUT_LIMIT' })
    expect(killProcessTree.calledWith).toContain(4242)
  })

  it('terminates and reports OUTPUT_LIMIT when stderr exceeds the cap', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.alloc(64 * 1024 + 1, 'e'))
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'OUTPUT_LIMIT' })
  })

  it('never returns raw stderr content anywhere in the outcome', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('super-secret-stack-trace', 'utf8'))
      child.emit('close', 1, null)
    })
    const outcome = await outcomePromise
    expect(JSON.stringify(outcome)).not.toContain('super-secret-stack-trace')
  })
})

describe('invokeClaudePlanning - stdin/stdio errors', () => {
  it('maps an asynchronous stdin pipe error (e.g. EPIPE) to PROCESS_FAILED', async () => {
    // A real Writable can fail an in-flight write ASYNCHRONOUSLY via an 'error' event - a
    // try/catch around write()/end() alone would never observe this.
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'PROCESS_FAILED' })
  })

  it('never exposes raw stdin error message/errno text anywhere in the outcome', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdin.emit('error', Object.assign(new Error('write EPIPE super-secret-stdin-detail'), { code: 'EPIPE' }))
    })
    const outcome = await outcomePromise
    const serialized = JSON.stringify(outcome)
    expect(serialized).not.toContain('super-secret-stdin-detail')
    expect(serialized).not.toContain('EPIPE')
  })

  it('ignores a stdin error that arrives after another terminal cause has already won', async () => {
    const { deps: d, recorder, killProcessTree } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.alloc(512 * 1024 + 1, 'a'))
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'OUTPUT_LIMIT' })

    const killCallsBeforeLateError = killProcessTree.calledWith.length
    expect(() => child.stdin.emit('error', new Error('too late'))).not.toThrow()
    await new Promise((resolve) => setImmediate(resolve))
    // A late stdin error must not trigger a second cleanup/termination attempt.
    expect(killProcessTree.calledWith.length).toBe(killCallsBeforeLateError)
  })
})

describe('invokeClaudePlanning - input limit', () => {
  it('fails INPUT_LIMIT before spawning when the stdin payload exceeds 64 KiB', async () => {
    const { deps: d, recorder } = deps()
    const outcome = await invokeClaudePlanning(d, { stdinPayload: 'x'.repeat(64 * 1024 + 1) })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_LIMIT' })
    expect(recorder.calls.length).toBe(0)
  })
})

describe('invokeClaudePlanning - preflight gating', () => {
  it('fails CLI_NOT_FOUND without spawning when the executable is missing', async () => {
    const { deps: d, recorder } = deps({ executablePath: path.join(os.tmpdir(), 'nope', 'claude.exe') })
    const outcome = await invokeClaudePlanning(d, { stdinPayload: '{}' })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'CLI_NOT_FOUND' })
    expect(recorder.calls.length).toBe(0)
  })

  it('fails UNSUPPORTED_VERSION without invoking the model when the version is not in the tested set', async () => {
    const calls: string[][] = []
    const launcher: ClaudeProcessLauncher = (_executable, args) => {
      calls.push(args)
      const child = new FakeChildProcess()
      if (args.includes('--version')) {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('9.9.9', 'utf8'))
          child.emit('close', 0, null)
        })
      }
      return child
    }
    const { fn: killProcessTree } = fakeKillProcessTree()
    const outcome = await invokeClaudePlanning({ launcher, killProcessTree, executablePath }, { stdinPayload: '{}' })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'UNSUPPORTED_VERSION' })
    expect(calls.some((args) => args.includes('--print'))).toBe(false)
  })
})

describe('invokeClaudePlanning - process termination discipline (taskkill only when needed)', () => {
  it('never calls killProcessTree for a process that already closed normally (success)', async () => {
    const { deps: d, recorder, killProcessTree } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedImmediately(recorder.lastChild as FakeChildProcess)
    await outcomePromise
    // Neither the --version preflight check nor the real invocation may taskkill an
    // already-closed PID - both are known-closed via their own 'close' event.
    expect(killProcessTree.calledWith).toEqual([])
  })

  it('never calls killProcessTree for a process that closed with a nonzero exit code', async () => {
    const { deps: d, recorder, killProcessTree } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => child.emit('close', 1, null))
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'PROCESS_FAILED' })
    expect(killProcessTree.calledWith).toEqual([])
  })

  it('never calls killProcessTree for a process that closed normally but produced INVALID_OUTPUT', async () => {
    const { deps: d, recorder, killProcessTree } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('not json', 'utf8'))
      child.emit('close', 0, null)
    })
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
    expect(killProcessTree.calledWith).toEqual([])
  })

  it('DOES call and await killProcessTree when the process may still be running (timeout)', async () => {
    vi.useFakeTimers()
    const { deps: d, recorder, killProcessTree } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1), { timeout: 5000 })
    await vi.advanceTimersByTimeAsync(180_001)
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'TIMEOUT' })
    expect(killProcessTree.calledWith).toEqual([4242])
    vi.useRealTimers()
  })
})

describe('invokeClaudePlanning - lifecycle', () => {
  it('times out and terminates the process after the fixed deadline', async () => {
    vi.useFakeTimers()
    const { deps: d, recorder, killProcessTree } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1), { timeout: 5000 })
    await vi.advanceTimersByTimeAsync(180_001)
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'TIMEOUT' })
    expect(killProcessTree.calledWith).toContain(4242)
    vi.useRealTimers()
  })

  it('does not spawn when the signal is already aborted', async () => {
    const { deps: d, recorder } = deps()
    const controller = new AbortController()
    controller.abort()
    const outcome = await invokeClaudePlanning(d, { stdinPayload: '{}', signal: controller.signal })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'CANCELLED' })
    expect(recorder.calls.length).toBe(0)
  })

  it('cancels and terminates the process when aborted mid-run', async () => {
    const { deps: d, recorder, killProcessTree } = deps()
    const controller = new AbortController()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}', signal: controller.signal })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    controller.abort()
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'CANCELLED' })
    expect(killProcessTree.calledWith).toContain(4242)
  })

  it('rejects a second concurrent invocation with BUSY and releases the slot after completion', async () => {
    const { deps: d, recorder } = deps()
    const first = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))

    const second = await invokeClaudePlanning(deps().deps, { stdinPayload: '{}' })
    expect(second).toEqual({ status: 'FAILED', failureCode: 'BUSY' })

    succeedImmediately(recorder.lastChild as FakeChildProcess)
    await first

    const { deps: d2, recorder: recorder2 } = deps()
    const third = invokeClaudePlanning(d2, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder2.calls.length).toBe(1))
    succeedImmediately(recorder2.lastChild as FakeChildProcess)
    expect((await third).status).toBe('SUCCEEDED')
  })

  it('releases the concurrency slot even when the invocation fails', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => child.emit('close', 1, null))
    await outcomePromise

    const { deps: d2, recorder: recorder2 } = deps()
    const second = invokeClaudePlanning(d2, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder2.calls.length).toBe(1))
    succeedImmediately(recorder2.lastChild as FakeChildProcess)
    expect((await second).status).toBe('SUCCEEDED')
  })

  it('maps a spawn ENOENT error to CLI_NOT_FOUND and settles once', async () => {
    const launcher: ClaudeProcessLauncher = (_executable, args) => {
      if (args.includes('--version')) return respondToVersionCheck()
      const child = new FakeChildProcess()
      queueMicrotask(() => {
        const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
        child.emit('error', error)
      })
      return child
    }
    const { fn: killProcessTree } = fakeKillProcessTree()
    const outcome = await invokeClaudePlanning({ launcher, killProcessTree, executablePath }, { stdinPayload: '{}' })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'CLI_NOT_FOUND' })
  })

  it('the first terminal cause wins even when its cleanup is still pending when a later event fires', async () => {
    // killProcessTree deliberately does not resolve until the test resolves it - this exercises
    // the exact race described in the M4.7A v2 review: OUTPUT_LIMIT settles first and starts its
    // (async) cleanup, then the child emits a nonzero exit before that cleanup completes. The
    // final outcome must still be OUTPUT_LIMIT, never PROCESS_FAILED, and the outer promise must
    // not resolve before the original cleanup actually finishes.
    let releaseKillProcessTree: (() => void) | null = null
    const killProcessTreeCalls: number[] = []
    const delayedKillProcessTree = vi.fn((pid: number) => {
      killProcessTreeCalls.push(pid)
      return new Promise<void>((resolve) => {
        releaseKillProcessTree = resolve
      })
    })

    const { deps: d, recorder } = deps({ killProcessTree: delayedKillProcessTree })
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    let resolved = false
    void outcomePromise.then(() => {
      resolved = true
    })

    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    // preflight's own `--version` check also cleans up (fire-and-forget) through this same
    // injected killProcessTree - capture that baseline so the assertions below only reason
    // about the real invocation's own cleanup call.
    const baselineKillCalls = killProcessTreeCalls.length

    // 1. stdout exceeds the cap -> OUTPUT_LIMIT settles first and starts its (still-pending) cleanup.
    child.stdout.emit('data', Buffer.alloc(512 * 1024 + 1, 'a'))
    await vi.waitFor(() => expect(killProcessTreeCalls.length).toBe(baselineKillCalls + 1))

    // 2. A later terminal event (nonzero exit) must be ignored - not replace the outcome.
    child.emit('close', 1, null)
    await new Promise((resolve) => setImmediate(resolve))
    expect(resolved).toBe(false)
    expect(killProcessTreeCalls.length).toBe(baselineKillCalls + 1)

    // 3. Only once the original cleanup actually completes does the outer promise resolve.
    expect(releaseKillProcessTree).not.toBeNull()
    ;(releaseKillProcessTree as unknown as () => void)()

    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'OUTPUT_LIMIT' })
    expect(killProcessTreeCalls.length).toBe(baselineKillCalls + 1)

    // 4. The concurrency slot is released only after cleanup completes.
    const { deps: d2, recorder: recorder2 } = deps()
    const second = invokeClaudePlanning(d2, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder2.calls.length).toBe(1))
    succeedImmediately(recorder2.lastChild as FakeChildProcess)
    expect((await second).status).toBe('SUCCEEDED')
  })
})

describe('invokeClaudePlanning - environment', () => {
  it('spawns with only the allow-listed environment, never process.env spread', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-should-not-appear')
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedImmediately(recorder.lastChild as FakeChildProcess)
    await outcomePromise
    expect(recorder.calls[0].options.env.ANTHROPIC_API_KEY).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// M4.7B.2 - Code-Change-Profil. Diese Tests beweisen, dass invokeClaudeCodeChange
// denselben sicheren Transport (Launcher/Umgebung/Nebenlaeufigkeitssperre/
// Aufraeumdisziplin) wie invokeClaudePlanning nutzt, aber sein EIGENES festes
// Argv/Schema/System-Prompt/stdin-Limit und die STRENGEREN, bestaetigten
// Terminal-Erfolgs-Pruefungen hat.
// ---------------------------------------------------------------------------

function validProposal(): CodeChangeProposal {
  return { summary: 'Change a function', changes: [{ type: 'MODIFY', path: 'src/math.ts', content: 'x' }], warnings: [] }
}

function defaultScope(): TrustedCodeChangeScope {
  return { modifyPaths: ['src/math.ts'], createPaths: [] }
}

// Matches the CONFIRMED 2.1.266 terminal profile - confirmed by the earlier real Claude Code
// 2.1.266 acceptance smoke that validated the shared transport profile (M4.7A/M4.7B.1 era; no
// M4.7B.2-specific real smoke has been run - see claudeCodeChange.smoke.ts, prepared but not run):
// type=result, subtype=success, is_error=false, api_error_status=null, terminal_reason=completed.
// `stop_reason` is deliberately included with the actually-observed "tool_use" value to prove the
// adapter does NOT treat it as authorization/rejection (see isTerminalSuccess in claudeCliAdapter.ts).
function codeChangeSuccessEnvelope(proposal: CodeChangeProposal = validProposal(), overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    terminal_reason: 'completed',
    stop_reason: 'tool_use',
    result: 'synthetic discarded result text',
    session_id: 'fake-session',
    structured_output: proposal,
    ...overrides
  })
}

function succeedCodeChangeImmediately(child: FakeChildProcess, envelope: string = codeChangeSuccessEnvelope()): void {
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(envelope, 'utf8'))
    child.emit('close', 0, null)
  })
}

describe('invokeClaudeCodeChange - shares the safe M4.7A transport', () => {
  it('uses the same fixed executable resolution, no shell, tools remain "", neutral cwd, and no session persistence', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess)
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'SUCCEEDED', proposal: validProposal() })

    const call = recorder.calls[0]
    expect(call.executable).toBe(executablePath)
    expect(call.args).toContain('--print')
    const toolsIndex = call.args.indexOf('--tools')
    expect(call.args[toolsIndex + 1]).toBe('')
    expect(call.args).toContain('--permission-mode')
    expect(call.args[call.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(call.args).toContain('--safe-mode')
    expect(call.args).toContain('--restricted')
    expect(call.args).toContain('--strict-mcp-config')
    expect(call.args).toContain('--disable-slash-commands')
    expect(call.args).toContain('--no-chrome')
    expect(call.args).toContain('--no-session-persistence')
    expect(call.args).toContain('--system-prompt')
    expect(call.args[call.args.indexOf('--system-prompt') + 1]).toBe(CLAUDE_CODE_CHANGE_SYSTEM_PROMPT)
    expect(call.args).toContain('--json-schema')
    expect(JSON.parse(call.args[call.args.indexOf('--json-schema') + 1])).toEqual(CODE_CHANGE_PROPOSAL_JSON_SCHEMA)
    // The code-change profile's argv/prompt/schema must never be confused with the planning profile's.
    expect(call.args).not.toContain(CLAUDE_PLANNING_SYSTEM_PROMPT)
    expect(JSON.parse(call.args[call.args.indexOf('--json-schema') + 1])).not.toEqual(CONTROLLER_PLAN_JSON_SCHEMA)

    expect(path.isAbsolute(call.options.cwd)).toBe(true)
    expect(call.options.cwd).not.toBe(process.cwd())
  })

  it('never inherits arbitrary process.env values (same allow-list as planning)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-should-not-appear')
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess)
    await outcomePromise
    expect(recorder.calls[0].options.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('shares the SAME concurrency guard as invokeClaudePlanning - a code-change call blocks an active planning call and vice versa', async () => {
    const { deps: d1, recorder: r1 } = deps()
    const planningPromise = invokeClaudePlanning(d1, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(r1.calls.length).toBe(1))

    const { deps: d2 } = deps()
    const codeChangeOutcome = await invokeClaudeCodeChange(d2, { stdinPayload: '{}', scope: defaultScope() })
    expect(codeChangeOutcome).toEqual({ status: 'FAILED', failureCode: 'BUSY' })

    succeedImmediately(r1.lastChild as FakeChildProcess)
    await planningPromise

    const { deps: d3, recorder: r3 } = deps()
    const codeChangePromise = invokeClaudeCodeChange(d3, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(r3.calls.length).toBe(1))

    const { deps: d4 } = deps()
    const planningOutcome = await invokeClaudePlanning(d4, { stdinPayload: '{}' })
    expect(planningOutcome).toEqual({ status: 'FAILED', failureCode: 'BUSY' })

    succeedCodeChangeImmediately(r3.lastChild as FakeChildProcess)
    expect((await codeChangePromise).status).toBe('SUCCEEDED')
  })

  it('planning behavior remains completely unchanged by the shared-transport refactor', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudePlanning(d, { stdinPayload: '{}' })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedImmediately(recorder.lastChild as FakeChildProcess)
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'SUCCEEDED', proposal: { planningResult: { planMarkdown: 'Plan', decisionRequests: [] }, taskDrafts: [] } })
    expect(recorder.calls[0].args[recorder.calls[0].args.indexOf('--system-prompt') + 1]).toBe(CLAUDE_PLANNING_SYSTEM_PROMPT)
  })

  it('rejects a stdin payload larger than the code-change 128 KiB cap before spawning', async () => {
    const { deps: d, recorder } = deps()
    const outcome = await invokeClaudeCodeChange(d, { stdinPayload: 'x'.repeat(128 * 1024 + 1), scope: defaultScope() })
    expect(outcome).toEqual({ status: 'FAILED', failureCode: 'INPUT_LIMIT' })
    expect(recorder.calls.length).toBe(0)
  })

  it('accepts a stdin payload up to (but not exceeding) the 128 KiB code-change cap', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: 'x'.repeat(128 * 1024), scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess)
    expect((await outcomePromise).status).toBe('SUCCEEDED')
  })
})

describe('invokeClaudeCodeChange - confirmed terminal success checks', () => {
  it('succeeds on the exact confirmed terminal profile, including the observed stop_reason="tool_use"', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess)
    expect(await outcomePromise).toEqual({ status: 'SUCCEEDED', proposal: validProposal() })
  })

  it('rejects when subtype is not "success", even though is_error is false', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess, codeChangeSuccessEnvelope(validProposal(), { subtype: 'error_during_execution' }))
    expect(await outcomePromise).toEqual({ status: 'FAILED', failureCode: 'PROCESS_FAILED' })
  })

  it('rejects when api_error_status is not null', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess, codeChangeSuccessEnvelope(validProposal(), { api_error_status: 'rate_limited' }))
    expect(await outcomePromise).toEqual({ status: 'FAILED', failureCode: 'PROCESS_FAILED' })
  })

  it('rejects when terminal_reason is not "completed"', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess, codeChangeSuccessEnvelope(validProposal(), { terminal_reason: 'max_turns' }))
    expect(await outcomePromise).toEqual({ status: 'FAILED', failureCode: 'PROCESS_FAILED' })
  })

  it('rejects when is_error is true even with every other confirmed field correct', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess, codeChangeSuccessEnvelope(validProposal(), { is_error: true }))
    expect(await outcomePromise).toEqual({ status: 'FAILED', failureCode: 'PROCESS_FAILED' })
  })

  it('never treats a nonzero exit code as success even with a confirmed-terminal envelope', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const child = recorder.lastChild as FakeChildProcess
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(codeChangeSuccessEnvelope(), 'utf8'))
      child.emit('close', 1, null)
    })
    expect(await outcomePromise).toEqual({ status: 'FAILED', failureCode: 'PROCESS_FAILED' })
  })
})

describe('invokeClaudeCodeChange - structured_output is the only proposal source', () => {
  it('ignores the result field entirely, even when it contains different valid-looking JSON', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const decoy = { summary: 'DECOY', changes: [{ type: 'MODIFY', path: 'src/other.ts', content: 'decoy' }], warnings: [] }
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess, codeChangeSuccessEnvelope(validProposal(), { result: JSON.stringify(decoy) }))
    const outcome = await outcomePromise
    expect(outcome).toEqual({ status: 'SUCCEEDED', proposal: validProposal() })
    expect(JSON.stringify(outcome)).not.toContain('DECOY')
  })

  it('rejects a structurally invalid structured_output (delegates to validateCodeChangeProposal)', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess, codeChangeSuccessEnvelope({ summary: 'x' } as never))
    expect(await outcomePromise).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects an authority-smuggling field on the proposal (e.g. approved) via the exact-shape validator', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: defaultScope() })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    const tampered = { ...validProposal(), approved: true }
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess, codeChangeSuccessEnvelope(tampered as never))
    expect(await outcomePromise).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })

  it('rejects a MODIFY path outside the trusted scope (Main-owned scope enforcement happens here)', async () => {
    const { deps: d, recorder } = deps()
    const outcomePromise = invokeClaudeCodeChange(d, { stdinPayload: '{}', scope: { modifyPaths: ['src/other.ts'], createPaths: [] } })
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1))
    succeedCodeChangeImmediately(recorder.lastChild as FakeChildProcess)
    expect(await outcomePromise).toEqual({ status: 'FAILED', failureCode: 'INVALID_OUTPUT' })
  })
})
