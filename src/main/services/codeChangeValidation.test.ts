import { describe, expect, it } from 'vitest'
import {
  CODE_CHANGE_MAX_CONTENT_BYTES_PER_FILE,
  CODE_CHANGE_MAX_CREATE_ENTRIES,
  CODE_CHANGE_MAX_MODIFY_ENTRIES,
  CODE_CHANGE_MAX_TOTAL_CHANGES,
  CODE_CHANGE_MAX_TOTAL_CONTENT_BYTES,
  CODE_CHANGE_MAX_WARNINGS,
  type CodeChangeProposal
} from '@shared/codeChangeTypes'
import { InvalidCodeChangeProposalError, type TrustedCodeChangeScope, validateCodeChangeProposal } from './codeChangeValidation'

function scope(overrides: Partial<TrustedCodeChangeScope> = {}): TrustedCodeChangeScope {
  return { modifyPaths: ['src/main/example.ts'], createPaths: ['src/main/newFile.ts'], ...overrides }
}

function proposal(overrides: Partial<CodeChangeProposal> = {}): unknown {
  return {
    summary: 'Add a feature',
    changes: [{ type: 'MODIFY', path: 'src/main/example.ts', content: 'export const x = 1\n' }],
    warnings: [],
    ...overrides
  }
}

describe('validateCodeChangeProposal - valid proposals', () => {
  it('accepts a valid MODIFY change', () => {
    const result = validateCodeChangeProposal(proposal(), scope())
    expect(result).toEqual({
      summary: 'Add a feature',
      changes: [{ type: 'MODIFY', path: 'src/main/example.ts', content: 'export const x = 1\n' }],
      warnings: []
    })
  })

  it('accepts a valid CREATE change', () => {
    const result = validateCodeChangeProposal(
      proposal({ changes: [{ type: 'CREATE', path: 'src/main/newFile.ts', content: 'export const y = 2\n' }] }),
      scope()
    )
    expect(result.changes).toEqual([{ type: 'CREATE', path: 'src/main/newFile.ts', content: 'export const y = 2\n' }])
  })

  it('accepts a mix of MODIFY and CREATE within scope', () => {
    const result = validateCodeChangeProposal(
      proposal({
        changes: [
          { type: 'MODIFY', path: 'src/main/example.ts', content: 'a' },
          { type: 'CREATE', path: 'src/main/newFile.ts', content: 'b' }
        ]
      }),
      scope()
    )
    expect(result.changes.length).toBe(2)
  })

  it('accepts warnings within limits', () => {
    const result = validateCodeChangeProposal(proposal({ warnings: ['be careful', 'double-check tests'] }), scope())
    expect(result.warnings).toEqual(['be careful', 'double-check tests'])
  })
})

describe('validateCodeChangeProposal - exact shape', () => {
  it('rejects a non-object proposal', () => {
    expect(() => validateCodeChangeProposal(null, scope())).toThrow(InvalidCodeChangeProposalError)
    expect(() => validateCodeChangeProposal('x', scope())).toThrow(InvalidCodeChangeProposalError)
    expect(() => validateCodeChangeProposal([], scope())).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects an unknown top-level field', () => {
    expect(() => validateCodeChangeProposal(proposal({ extra: 'x' } as never), scope())).toThrow(InvalidCodeChangeProposalError)
  })

  it.each(['summary', 'changes', 'warnings'])('rejects a missing required field %s', (field) => {
    const raw = proposal() as Record<string, unknown>
    delete raw[field]
    expect(() => validateCodeChangeProposal(raw, scope())).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects an unknown field on a MODIFY change', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'MODIFY', path: 'src/main/example.ts', content: 'a', extra: 'x' } as never] }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects a missing field on a CREATE change', () => {
    expect(() =>
      validateCodeChangeProposal(proposal({ changes: [{ type: 'CREATE', path: 'src/main/newFile.ts' } as never] }), scope())
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects empty changes', () => {
    expect(() => validateCodeChangeProposal(proposal({ changes: [] }), scope())).toThrow(InvalidCodeChangeProposalError)
  })
})

describe('validateCodeChangeProposal - authority-smuggling fields reject', () => {
  it.each([
    { baseSha256: 'abc' },
    { approval: true },
    { approved: true },
    { permissions: ['filesystem.write'] },
    { capabilities: ['filesystem.write'] },
    { commands: ['npm test'] },
    { testsToRun: ['npm test'] },
    { provider: 'CLAUDE' },
    { model: 'claude-opus' },
    { agent: 'controller' },
    { projectRoot: 'C:\\Eclipse Projekte\\Project Hub M3 Work' },
    { executable: 'C:\\evil\\claude.exe' },
    { sessionId: 'abc' }
  ])('rejects proposal-level authority field %o', (extra) => {
    expect(() => validateCodeChangeProposal(proposal(extra as never), scope())).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects an "approved" field on an individual change', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'MODIFY', path: 'src/main/example.ts', content: 'a', approved: true } as never] }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects DELETE as a change type', () => {
    expect(() =>
      validateCodeChangeProposal(proposal({ changes: [{ type: 'DELETE', path: 'src/main/example.ts' } as never] }), scope())
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects RENAME as a change type', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'RENAME', path: 'src/main/example.ts', newPath: 'src/main/renamed.ts' } as never] }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })
})

describe('validateCodeChangeProposal - path authority', () => {
  it('rejects a MODIFY path outside the trusted modify scope', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'MODIFY', path: 'src/main/other.ts', content: 'a' }] }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects a CREATE path outside the trusted create scope', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'CREATE', path: 'src/main/other.ts', content: 'a' }] }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects a MODIFY on a path that is only in the CREATE scope', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'MODIFY', path: 'src/main/newFile.ts', content: 'a' }] }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects duplicate MODIFY changes on the same path', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({
          changes: [
            { type: 'MODIFY', path: 'src/main/example.ts', content: 'a' },
            { type: 'MODIFY', path: 'src/main/example.ts', content: 'b' }
          ]
        }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects a case-alias duplicate between two changes', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({
          changes: [
            { type: 'MODIFY', path: 'src/main/example.ts', content: 'a' },
            { type: 'MODIFY', path: 'SRC/MAIN/EXAMPLE.TS', content: 'b' }
          ]
        }),
        scope({ modifyPaths: ['src/main/example.ts', 'SRC/MAIN/EXAMPLE.TS'] })
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects a MODIFY + CREATE collision on the same path', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({
          changes: [
            { type: 'MODIFY', path: 'src/main/example.ts', content: 'a' },
            { type: 'CREATE', path: 'src/main/example.ts', content: 'b' }
          ]
        }),
        scope({ createPaths: ['src/main/example.ts'] })
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects an unsafe path (delegates to the strict access-path validator)', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'MODIFY', path: '../secret.txt', content: 'a' }] }),
        scope({ modifyPaths: ['../secret.txt'] })
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects a proposal to MODIFY .git/config even if a caller mistakenly trusted it', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'MODIFY', path: '.git/config', content: 'a' }] }),
        scope({ modifyPaths: ['.git/config'] })
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })
})

describe('validateCodeChangeProposal - content limits', () => {
  it('rejects an oversized generated file', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'MODIFY', path: 'src/main/example.ts', content: 'x'.repeat(CODE_CHANGE_MAX_CONTENT_BYTES_PER_FILE + 1) }] }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects an oversized total output across changes', () => {
    const modifyPaths = Array.from({ length: 8 }, (_, i) => `src/main/f${i}.ts`)
    const perFile = Math.ceil(CODE_CHANGE_MAX_TOTAL_CONTENT_BYTES / 8) + 100
    const changes = modifyPaths.map((path) => ({ type: 'MODIFY' as const, path, content: 'x'.repeat(perFile) }))
    expect(() => validateCodeChangeProposal(proposal({ changes }), scope({ modifyPaths }))).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects NUL/binary-like generated content', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'MODIFY', path: 'src/main/example.ts', content: 'a\u0000b' }] }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'MODIFY', path: 'src/main/example.ts', content: 'a\u0007b' }] }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects a lone (unpaired) high surrogate in generated content', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'MODIFY', path: 'src/main/example.ts', content: 'a\uD800b' }] }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects a lone (unpaired) low surrogate in generated content', () => {
    expect(() =>
      validateCodeChangeProposal(
        proposal({ changes: [{ type: 'MODIFY', path: 'src/main/example.ts', content: 'a\uDC00b' }] }),
        scope()
      )
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('accepts a correctly paired surrogate pair (emoji) in generated content', () => {
    const result = validateCodeChangeProposal(
      proposal({ changes: [{ type: 'MODIFY', path: 'src/main/example.ts', content: 'hello 😀' }] }),
      scope()
    )
    expect(result.changes[0].content).toBe('hello 😀')
  })

  it('rejects more than the max MODIFY entries', () => {
    const modifyPaths = Array.from({ length: CODE_CHANGE_MAX_MODIFY_ENTRIES + 1 }, (_, i) => `src/main/f${i}.ts`)
    const changes = modifyPaths.map((path) => ({ type: 'MODIFY' as const, path, content: 'a' }))
    expect(() => validateCodeChangeProposal(proposal({ changes }), scope({ modifyPaths }))).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects more than the max CREATE entries', () => {
    const createPaths = Array.from({ length: CODE_CHANGE_MAX_CREATE_ENTRIES + 1 }, (_, i) => `src/main/new${i}.ts`)
    const changes = createPaths.map((path) => ({ type: 'CREATE' as const, path, content: 'a' }))
    expect(() => validateCodeChangeProposal(proposal({ changes }), scope({ createPaths }))).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects more than the max total changes', () => {
    // 8 modify + 2 create = 10 (the max) - one more of anything should reject.
    const modifyPaths = Array.from({ length: CODE_CHANGE_MAX_MODIFY_ENTRIES }, (_, i) => `src/main/f${i}.ts`)
    const createPaths = Array.from({ length: CODE_CHANGE_MAX_CREATE_ENTRIES }, (_, i) => `src/main/new${i}.ts`)
    const extraCreatePath = 'src/main/extra.ts'
    const changes = [
      ...modifyPaths.map((path) => ({ type: 'MODIFY' as const, path, content: 'a' })),
      ...createPaths.map((path) => ({ type: 'CREATE' as const, path, content: 'a' })),
      { type: 'CREATE' as const, path: extraCreatePath, content: 'a' }
    ]
    expect(changes.length).toBeGreaterThan(CODE_CHANGE_MAX_TOTAL_CHANGES)
    expect(() =>
      validateCodeChangeProposal(proposal({ changes }), scope({ modifyPaths, createPaths: [...createPaths, extraCreatePath] }))
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects an oversized summary', () => {
    expect(() => validateCodeChangeProposal(proposal({ summary: 'x'.repeat(9000) }), scope())).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects too many warnings', () => {
    expect(() =>
      validateCodeChangeProposal(proposal({ warnings: Array.from({ length: CODE_CHANGE_MAX_WARNINGS + 1 }, () => 'w') }), scope())
    ).toThrow(InvalidCodeChangeProposalError)
  })

  it('rejects an oversized individual warning', () => {
    expect(() => validateCodeChangeProposal(proposal({ warnings: ['x'.repeat(5000)] }), scope())).toThrow(InvalidCodeChangeProposalError)
  })
})
