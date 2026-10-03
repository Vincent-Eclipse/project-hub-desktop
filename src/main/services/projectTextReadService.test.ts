import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  PROJECT_TEXT_READ_MAX_AGGREGATE_BYTES,
  PROJECT_TEXT_READ_MAX_FILES,
  PROJECT_TEXT_READ_MAX_INDIVIDUAL_BYTES
} from '@shared/projectTextReadTypes'
import { __setTestHookAfterStatBefore, ProjectTextReadError, readProjectTextFiles } from './projectTextReadService'

let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-source-read-')))
})

afterEach(() => {
  __setTestHookAfterStatBefore(null)
  fs.rmSync(root, { recursive: true, force: true })
})

function write(relativePath: string, content: string | Buffer): void {
  const full = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ProjectTextReadError)
  expect((caught as ProjectTextReadError).code).toBe(code)
}

// Windows without Developer Mode/admin cannot create FILE symlinks (junctions for directories
// work without elevation, but file symlinks require SeCreateSymbolicLinkPrivilege). Detected
// once so the affected test explicitly skips with a clear reason instead of silently passing.
let canCreateFileSymlinks = false
beforeAll(() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-source-read-symlink-probe-'))
  try {
    fs.writeFileSync(path.join(probe, 'target.txt'), 'x')
    fs.symlinkSync(path.join(probe, 'target.txt'), path.join(probe, 'link.txt'), 'file')
    canCreateFileSymlinks = true
  } catch {
    canCreateFileSymlinks = false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
})

describe('readProjectTextFiles - happy path', () => {
  it('reads a single UTF-8 file with LF line endings', async () => {
    write('src/a.ts', 'line1\nline2\n')
    const [result] = await readProjectTextFiles(root, ['src/a.ts'])
    expect(result.path).toBe('src/a.ts')
    expect(result.content).toBe('line1\nline2\n')
    expect(result.format).toEqual({ utf8Bom: false, lineEnding: 'LF', finalNewline: true })
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads multiple files in one call', async () => {
    write('a.ts', 'a')
    write('b.ts', 'b')
    const results = await readProjectTextFiles(root, ['a.ts', 'b.ts'])
    expect(results.map((r) => r.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('never exposes an absolute filesystem path in the result', async () => {
    write('src/a.ts', 'x')
    const [result] = await readProjectTextFiles(root, ['src/a.ts'])
    expect(JSON.stringify(result)).not.toContain(root.replace(/\\/g, '\\\\'))
  })
})

describe('readProjectTextFiles - filesystem checks', () => {
  it('rejects a missing file', async () => {
    await expectCode(readProjectTextFiles(root, ['does/not/exist.ts']), 'NOT_FOUND')
  })

  it('rejects a directory target', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    await expectCode(readProjectTextFiles(root, ['src']), 'NOT_A_FILE')
  })

  it.skipIf(!canCreateFileSymlinks)(
    'rejects a symlink file (skipped when this environment cannot create file symlinks)',
    async () => {
      write('real.txt', 'x')
      fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'), 'file')
      await expectCode(readProjectTextFiles(root, ['link.txt']), 'UNSAFE_PATH')
    }
  )

  it('rejects a symlinked parent directory (directory junction - works without elevation on Windows)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-source-read-outside-'))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x')
    fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expectCode(readProjectTextFiles(root, ['linked/secret.txt']), 'UNSAFE_PATH')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects a hard-linked file (V1 conservative behavior)', async () => {
    write('original.txt', 'x')
    fs.linkSync(path.join(root, 'original.txt'), path.join(root, 'hardlinked.txt'))
    await expectCode(readProjectTextFiles(root, ['hardlinked.txt']), 'UNSAFE_PATH')
  })

  it('rejects a root that is itself a directory junction (root redirection)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-source-read-outside-root-'))
    fs.writeFileSync(path.join(outside, 'a.ts'), 'x')
    const linkedRoot = path.join(root, '..', 'hub-source-read-linked-root-' + path.basename(root))
    fs.symlinkSync(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expectCode(readProjectTextFiles(linkedRoot, ['a.ts']), 'ROOT_INVALID')
    } finally {
      fs.rmSync(linkedRoot, { force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects when the final resolved path would fall outside the root (containment check)', async () => {
    // A grandparent-level junction exercises the containment check via the same per-component
    // symlink rejection that also protects the immediate-parent case above.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-source-read-outside2-'))
    fs.mkdirSync(path.join(outside, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'nested', 'secret.txt'), 'x')
    fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expectCode(readProjectTextFiles(root, ['escape/nested/secret.txt']), 'UNSAFE_PATH')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('fails the whole batch and rejects when the source changes during read (deterministic via test hook)', async () => {
    write('a.ts', 'unchanged')
    write('b.ts', 'x'.repeat(100))
    __setTestHookAfterStatBefore(() => {
      // Mutate the second file's mtime/size between the pre-read and post-read fstat.
      fs.appendFileSync(path.join(root, 'b.ts'), 'more')
    })
    await expectCode(readProjectTextFiles(root, ['b.ts']), 'CHANGED_DURING_READ')
  })

  it('rejects the whole batch (no partial success) when a later file in the batch is invalid', async () => {
    write('a.ts', 'ok')
    await expectCode(readProjectTextFiles(root, ['a.ts', 'missing.ts']), 'NOT_FOUND')
  })
})

describe('readProjectTextFiles - limits', () => {
  it('rejects more than the max file count', async () => {
    const names = Array.from({ length: PROJECT_TEXT_READ_MAX_FILES + 1 }, (_, i) => `f${i}.ts`)
    for (const name of names) write(name, 'x')
    await expectCode(readProjectTextFiles(root, names), 'LIMIT_EXCEEDED')
  })

  it('rejects a file larger than the individual cap, enforced during read', async () => {
    write('big.ts', 'x'.repeat(PROJECT_TEXT_READ_MAX_INDIVIDUAL_BYTES + 1))
    await expectCode(readProjectTextFiles(root, ['big.ts']), 'LIMIT_EXCEEDED')
  })

  it('accepts a file exactly at the individual cap', async () => {
    write('exact.ts', 'x'.repeat(PROJECT_TEXT_READ_MAX_INDIVIDUAL_BYTES))
    const [result] = await readProjectTextFiles(root, ['exact.ts'])
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(PROJECT_TEXT_READ_MAX_INDIVIDUAL_BYTES)
  })

  it('rejects when the aggregate size across files exceeds the cap', async () => {
    const perFile = Math.floor(PROJECT_TEXT_READ_MAX_INDIVIDUAL_BYTES / 2)
    const names: string[] = []
    let total = 0
    let i = 0
    while (total < PROJECT_TEXT_READ_MAX_AGGREGATE_BYTES + perFile && names.length < PROJECT_TEXT_READ_MAX_FILES) {
      const name = `agg${i}.ts`
      write(name, 'x'.repeat(perFile))
      names.push(name)
      total += perFile
      i++
    }
    await expectCode(readProjectTextFiles(root, names), 'LIMIT_EXCEEDED')
  })

  it('counts raw bytes (including stripped UTF-8 BOM bytes) toward the aggregate cap, not decoded content length', async () => {
    // Each file's DECODED content sums to exactly the aggregate cap (would NOT exceed it if the
    // aggregate accounting used `content.length` after the BOM was stripped), but each file also
    // carries a 3-byte UTF-8 BOM - so the RAW bytes actually read exceed the cap by 8*3=24 bytes.
    const perFileContentBytes = Math.floor(PROJECT_TEXT_READ_MAX_AGGREGATE_BYTES / PROJECT_TEXT_READ_MAX_FILES)
    expect(perFileContentBytes * PROJECT_TEXT_READ_MAX_FILES).toBeLessThanOrEqual(PROJECT_TEXT_READ_MAX_AGGREGATE_BYTES)
    const names: string[] = []
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    for (let i = 0; i < PROJECT_TEXT_READ_MAX_FILES; i++) {
      const name = `bom${i}.ts`
      write(name, Buffer.concat([bom, Buffer.from('x'.repeat(perFileContentBytes), 'utf8')]))
      names.push(name)
    }
    await expectCode(readProjectTextFiles(root, names), 'LIMIT_EXCEEDED')
  })

  it('rejects an empty request', async () => {
    await expectCode(readProjectTextFiles(root, []), 'INVALID_REQUEST')
  })

  it('rejects an exact duplicate path (defense-in-depth for a direct internal call)', async () => {
    write('a.ts', 'x')
    await expectCode(readProjectTextFiles(root, ['a.ts', 'a.ts']), 'INVALID_REQUEST')
  })

  it('rejects a case-only alias path (defense-in-depth for a direct internal call)', async () => {
    write('a.ts', 'x')
    await expectCode(readProjectTextFiles(root, ['a.ts', 'A.ts']), 'INVALID_REQUEST')
  })

  it('accepts a list of normal, distinct paths', async () => {
    write('a.ts', 'x')
    write('b.ts', 'y')
    const results = await readProjectTextFiles(root, ['a.ts', 'b.ts'])
    expect(results.map((r) => r.path)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('readProjectTextFiles - text encoding', () => {
  it('reads plain UTF-8 without BOM', async () => {
    write('a.ts', Buffer.from('héllo 你好', 'utf8'))
    const [result] = await readProjectTextFiles(root, ['a.ts'])
    expect(result.content).toBe('héllo 你好')
    expect(result.format.utf8Bom).toBe(false)
  })

  it('reads UTF-8 with a standard BOM and strips it from content while flagging it', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')])
    write('a.ts', withBom)
    const [result] = await readProjectTextFiles(root, ['a.ts'])
    expect(result.content).toBe('hello')
    expect(result.format.utf8Bom).toBe(true)
  })

  it('rejects malformed UTF-8', async () => {
    write('a.ts', Buffer.from([0x41, 0xc0, 0x80, 0x42]))
    await expectCode(readProjectTextFiles(root, ['a.ts']), 'ENCODING_INVALID')
  })

  it('rejects UTF-16 LE (BOM-detected)', async () => {
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')])
    write('a.ts', withBom)
    await expectCode(readProjectTextFiles(root, ['a.ts']), 'ENCODING_INVALID')
  })

  it('rejects UTF-16 BE BOM', async () => {
    const withBom = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('h\0e\0l\0l\0o\0', 'binary')])
    write('a.ts', withBom)
    await expectCode(readProjectTextFiles(root, ['a.ts']), 'ENCODING_INVALID')
  })

  it('rejects a NUL byte in content', async () => {
    write('a.ts', Buffer.from([0x61, 0x00, 0x62]))
    await expectCode(readProjectTextFiles(root, ['a.ts']), 'CONTENT_REJECTED')
  })
})

describe('readProjectTextFiles - line endings', () => {
  it('detects CRLF', async () => {
    write('a.ts', 'line1\r\nline2\r\n')
    const [result] = await readProjectTextFiles(root, ['a.ts'])
    expect(result.format.lineEnding).toBe('CRLF')
    expect(result.format.finalNewline).toBe(true)
    expect(result.content).toBe('line1\r\nline2\r\n')
  })

  it('detects LF', async () => {
    write('a.ts', 'line1\nline2\n')
    const [result] = await readProjectTextFiles(root, ['a.ts'])
    expect(result.format.lineEnding).toBe('LF')
  })

  it('detects NONE for content with no newline', async () => {
    write('a.ts', 'no newline here')
    const [result] = await readProjectTextFiles(root, ['a.ts'])
    expect(result.format.lineEnding).toBe('NONE')
    expect(result.format.finalNewline).toBe(false)
  })

  it('detects NONE for an empty file', async () => {
    write('a.ts', '')
    const [result] = await readProjectTextFiles(root, ['a.ts'])
    expect(result.format.lineEnding).toBe('NONE')
    expect(result.format.finalNewline).toBe(false)
    expect(result.content).toBe('')
  })

  it('rejects mixed LF and CRLF line endings', async () => {
    write('a.ts', 'line1\r\nline2\nline3\r\n')
    await expectCode(readProjectTextFiles(root, ['a.ts']), 'CONTENT_REJECTED')
  })

  it('reports finalNewline false when the file does not end with a newline', async () => {
    write('a.ts', 'line1\nline2')
    const [result] = await readProjectTextFiles(root, ['a.ts'])
    expect(result.format.finalNewline).toBe(false)
  })
})

describe('readProjectTextFiles - secret content heuristics', () => {
  it('rejects private-key content even in a file whose name is not itself excluded', async () => {
    // Uses an ordinary .ts filename (not .pem/.key) so this test exercises the CONTENT-based
    // heuristic specifically, distinct from the path-exclusion check covered elsewhere.
    write('notes.ts', '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----\n')
    await expectCode(readProjectTextFiles(root, ['notes.ts']), 'CONTENT_REJECTED')
  })

  it('rejects an obvious API key assignment', async () => {
    write('a.ts', 'const key = "ANTHROPIC_API_KEY=sk-' + 'ant-abcdefghijklmnop"')
    await expectCode(readProjectTextFiles(root, ['a.ts']), 'CONTENT_REJECTED')
  })

  it('rejects the same named secret assignments regardless of letter case', async () => {
    write('a.ts', 'openai_api_key=sk-' + 'abcdefghijklmnop')
    await expectCode(readProjectTextFiles(root, ['a.ts']), 'CONTENT_REJECTED')
    write('b.ts', 'Anthropic_Api_Key=sk-' + 'ant-abcdefghijklmnop')
    await expectCode(readProjectTextFiles(root, ['b.ts']), 'CONTENT_REJECTED')
    write('c.ts', 'aws_secret_access_key=' + 'abcdefghijklmnopqrstuvwxyz1234567890')
    await expectCode(readProjectTextFiles(root, ['c.ts']), 'CONTENT_REJECTED')
  })

  it('rejects a generic high-confidence secret assignment', async () => {
    write('a.ts', 'api_' + 'key: "abcdefghijklmnopqrstuvwx"')
    await expectCode(readProjectTextFiles(root, ['a.ts']), 'CONTENT_REJECTED')
  })

  it('never includes the matched secret text in the thrown error', async () => {
    write('a.ts', 'AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz1234567890')
    let caught: unknown
    try {
      await readProjectTextFiles(root, ['a.ts'])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ProjectTextReadError)
    expect((caught as Error).message).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890')
    expect(JSON.stringify(caught)).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890')
  })
})

describe('readProjectTextFiles - path exclusions (defense in depth against the trusted-scope layer)', () => {
  it('rejects a request for a .env path even if somehow passed through', async () => {
    write('.env', 'SECRET=1')
    await expectCode(readProjectTextFiles(root, ['.env']), 'INVALID_REQUEST')
  })

  it('rejects a request for a .git path', async () => {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', 'config'), 'x')
    await expectCode(readProjectTextFiles(root, ['.git/config']), 'INVALID_REQUEST')
  })

  it('rejects a request for a .claude path', async () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), 'x')
    await expectCode(readProjectTextFiles(root, ['.claude/settings.json']), 'INVALID_REQUEST')
  })
})
