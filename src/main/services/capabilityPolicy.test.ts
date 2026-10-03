import { describe, expect, it } from 'vitest'
import { CAPABILITY_IDS, type CapabilityPolicyContext, type CapabilityRequest } from '@shared/permissionTypes'
import {
  InvalidCapabilityInputError,
  resolveCapabilityRequest,
  validateCapabilityPolicyContext,
  validateCapabilityRequest
} from './capabilityPolicy'

function request(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return { projectId: 1, capabilities: [], ...overrides }
}

function context(overrides: Partial<CapabilityPolicyContext> = {}): CapabilityPolicyContext {
  return {
    projectId: 1,
    isArchived: false,
    supportedCapabilities: [...CAPABILITY_IDS],
    policy: {},
    ruleDeniedCapabilities: [],
    ...overrides
  }
}

describe('validateCapabilityRequest', () => {
  it('accepts a valid request, including an empty capabilities list', () => {
    expect(validateCapabilityRequest(request())).toEqual(request())
    expect(validateCapabilityRequest(request({ capabilities: ['filesystem.read'] }))).toEqual(
      request({ capabilities: ['filesystem.read'] })
    )
  })

  it('enforces the exact request shape - no extra field, known or unknown', () => {
    expect(() => validateCapabilityRequest({ ...request(), notes: 'internal' })).toThrow(InvalidCapabilityInputError)
  })

  it('rejects an unknown capability', () => {
    expect(() => validateCapabilityRequest(request({ capabilities: ['filesystem.delete'] as never }))).toThrow(
      InvalidCapabilityInputError
    )
  })

  it('rejects a duplicate requested capability rather than silently deduping', () => {
    expect(() => validateCapabilityRequest(request({ capabilities: ['filesystem.read', 'filesystem.read'] }))).toThrow(
      InvalidCapabilityInputError
    )
  })

  it('rejects an invalid projectId', () => {
    for (const projectId of [0, -1, 1.5, '1', null, undefined] as never[]) {
      expect(() => validateCapabilityRequest(request({ projectId }))).toThrow(InvalidCapabilityInputError)
    }
  })

  it('rejects a non-object raw value', () => {
    expect(() => validateCapabilityRequest(null)).toThrow(InvalidCapabilityInputError)
    expect(() => validateCapabilityRequest([])).toThrow(InvalidCapabilityInputError)
    expect(() => validateCapabilityRequest('x')).toThrow(InvalidCapabilityInputError)
  })

  it('rejects a capabilities value that is not an array', () => {
    expect(() => validateCapabilityRequest(request({ capabilities: 'filesystem.read' as never }))).toThrow(
      InvalidCapabilityInputError
    )
  })

  // Authority smuggling: none of these fields exist on the contract - a raw
  // object claiming them must be rejected outright, never silently ignored.
  it('rejects authority-smuggling fields (approved/permissions/supportedCapabilities/autonomy/agentId/provider)', () => {
    for (const field of ['approved', 'permissions', 'supportedCapabilities', 'autonomy', 'agentId', 'provider', 'projectRoot']) {
      expect(() => validateCapabilityRequest({ ...request(), [field]: 'x' })).toThrow(InvalidCapabilityInputError)
    }
  })

  it('returns an independent snapshot - mutating the original capabilities array afterward does not change the validated result', () => {
    const original: string[] = ['filesystem.read']
    const validated = validateCapabilityRequest(request({ capabilities: original as never }))
    original.length = 0
    expect(validated.capabilities).toEqual(['filesystem.read'])
  })
})

describe('validateCapabilityPolicyContext', () => {
  it('accepts a valid context', () => {
    expect(validateCapabilityPolicyContext(context())).toEqual(context())
  })

  it('enforces the exact context shape', () => {
    expect(() => validateCapabilityPolicyContext({ ...context(), notes: 'internal' })).toThrow(InvalidCapabilityInputError)
  })

  for (const field of ['projectId', 'isArchived', 'supportedCapabilities', 'policy', 'ruleDeniedCapabilities'] as const) {
    it(`rejects a missing "${field}" field`, () => {
      const raw: Record<string, unknown> = { ...context() }
      delete raw[field]
      expect(() => validateCapabilityPolicyContext(raw)).toThrow(InvalidCapabilityInputError)
    })
  }

  it('rejects an invalid isArchived value', () => {
    for (const isArchived of ['true', 1, null, undefined] as never[]) {
      expect(() => validateCapabilityPolicyContext(context({ isArchived }))).toThrow(InvalidCapabilityInputError)
    }
  })

  it('rejects an unknown supported capability', () => {
    expect(() => validateCapabilityPolicyContext(context({ supportedCapabilities: ['network.access'] as never }))).toThrow(
      InvalidCapabilityInputError
    )
  })

  it('rejects a duplicate supported capability', () => {
    expect(() =>
      validateCapabilityPolicyContext(context({ supportedCapabilities: ['filesystem.read', 'filesystem.read'] }))
    ).toThrow(InvalidCapabilityInputError)
  })

  it('rejects an unknown ruleDenied capability', () => {
    expect(() => validateCapabilityPolicyContext(context({ ruleDeniedCapabilities: ['git.commit'] as never }))).toThrow(
      InvalidCapabilityInputError
    )
  })

  it('rejects a duplicate ruleDenied capability', () => {
    expect(() =>
      validateCapabilityPolicyContext(context({ ruleDeniedCapabilities: ['git.write', 'git.write'] }))
    ).toThrow(InvalidCapabilityInputError)
  })

  it('rejects an unknown policy key', () => {
    expect(() => validateCapabilityPolicyContext(context({ policy: { 'shell.execute': 'ALLOW' } as never }))).toThrow(
      InvalidCapabilityInputError
    )
  })

  it('rejects an invalid policy mode value', () => {
    expect(() => validateCapabilityPolicyContext(context({ policy: { 'filesystem.read': 'MAYBE' } as never }))).toThrow(
      InvalidCapabilityInputError
    )
  })

  it('rejects a policy value that is an array, a class instance, or otherwise not a plain object', () => {
    expect(() => validateCapabilityPolicyContext(context({ policy: [] as never }))).toThrow(InvalidCapabilityInputError)
    expect(() => validateCapabilityPolicyContext(context({ policy: new Map() as never }))).toThrow(
      InvalidCapabilityInputError
    )
    class FakePolicy {}
    expect(() => validateCapabilityPolicyContext(context({ policy: new FakePolicy() as never }))).toThrow(
      InvalidCapabilityInputError
    )
  })

  it('allows a missing policy entry for a known capability (means DENY, validated separately by the resolver)', () => {
    expect(validateCapabilityPolicyContext(context({ policy: { 'filesystem.read': 'ALLOW' } })).policy).toEqual({
      'filesystem.read': 'ALLOW'
    })
  })

  it('returns an independent policy object - mutating the original policy object afterward does not change the validated result', () => {
    const original: Record<string, string> = { 'filesystem.read': 'ALLOW' }
    const validated = validateCapabilityPolicyContext(context({ policy: original as never }))
    original['filesystem.read'] = 'DENY'
    expect(validated.policy).toEqual({ 'filesystem.read': 'ALLOW' })
  })

  it('returns an independent snapshot - mutating the original supportedCapabilities array afterward does not change the validated result', () => {
    const original: string[] = ['filesystem.read', 'git.read']
    const validated = validateCapabilityPolicyContext(context({ supportedCapabilities: original as never }))
    original.length = 0
    expect(validated.supportedCapabilities).toEqual(['filesystem.read', 'git.read'])
  })

  it('returns an independent snapshot - mutating the original ruleDeniedCapabilities array afterward does not change the validated result', () => {
    const original: string[] = ['git.write']
    const validated = validateCapabilityPolicyContext(context({ ruleDeniedCapabilities: original as never }))
    original.length = 0
    expect(validated.ruleDeniedCapabilities).toEqual(['git.write'])
  })
})

describe('resolveCapabilityRequest - default deny', () => {
  it('denies with POLICY_UNSET when no policy entry exists for a supported, non-archived, non-rule-denied capability', () => {
    const result = resolveCapabilityRequest(request({ capabilities: ['filesystem.read'] }), context())
    expect(result).toEqual([{ projectId: 1, capability: 'filesystem.read', decision: 'DENY', reason: 'POLICY_UNSET' }])
  })
})

describe('resolveCapabilityRequest - supported', () => {
  it('denies an unsupported capability with UNSUPPORTED', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['command.execute'] }),
      context({ supportedCapabilities: [], policy: { 'command.execute': 'ALLOW' } })
    )
    expect(result).toEqual([{ projectId: 1, capability: 'command.execute', decision: 'DENY', reason: 'UNSUPPORTED' }])
  })

  it('UNSUPPORTED beats an ALLOW policy', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['git.read'] }),
      context({ supportedCapabilities: [], policy: { 'git.read': 'ALLOW' } })
    )
    expect(result[0]).toMatchObject({ decision: 'DENY', reason: 'UNSUPPORTED' })
  })

  it('UNSUPPORTED beats REQUIRES_APPROVAL', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['git.read'] }),
      context({ supportedCapabilities: [], policy: { 'git.read': 'REQUIRES_APPROVAL' } })
    )
    expect(result[0]).toMatchObject({ decision: 'DENY', reason: 'UNSUPPORTED' })
  })
})

describe('resolveCapabilityRequest - project id', () => {
  it('denies with PROJECT_MISMATCH when request.projectId differs from context.projectId', () => {
    const result = resolveCapabilityRequest(
      request({ projectId: 1, capabilities: ['filesystem.read'] }),
      context({ projectId: 2, policy: { 'filesystem.read': 'ALLOW' } })
    )
    expect(result).toEqual([{ projectId: 1, capability: 'filesystem.read', decision: 'DENY', reason: 'PROJECT_MISMATCH' }])
  })

  it('PROJECT_MISMATCH beats unsupported/archived/policy - the highest-precedence reason wins even when every other check would also fail', () => {
    const result = resolveCapabilityRequest(
      request({ projectId: 1, capabilities: ['filesystem.write'] }),
      context({
        projectId: 2,
        isArchived: true,
        supportedCapabilities: [],
        ruleDeniedCapabilities: ['filesystem.write'],
        policy: { 'filesystem.write': 'ALLOW' }
      })
    )
    expect(result[0]).toMatchObject({ decision: 'DENY', reason: 'PROJECT_MISMATCH' })
  })
})

describe('resolveCapabilityRequest - archived projects', () => {
  it('denies filesystem.write, git.write and command.execute for an archived project regardless of policy', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['filesystem.write', 'git.write', 'command.execute'] }),
      context({
        isArchived: true,
        policy: { 'filesystem.write': 'ALLOW', 'git.write': 'ALLOW', 'command.execute': 'ALLOW' }
      })
    )
    expect(result).toEqual([
      { projectId: 1, capability: 'filesystem.write', decision: 'DENY', reason: 'PROJECT_ARCHIVED' },
      { projectId: 1, capability: 'git.write', decision: 'DENY', reason: 'PROJECT_ARCHIVED' },
      { projectId: 1, capability: 'command.execute', decision: 'DENY', reason: 'PROJECT_ARCHIVED' }
    ])
  })

  it('archive denial beats an ALLOW policy', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['git.write'] }),
      context({ isArchived: true, policy: { 'git.write': 'ALLOW' } })
    )
    expect(result[0]).toMatchObject({ decision: 'DENY', reason: 'PROJECT_ARCHIVED' })
  })

  it('archive denial beats REQUIRES_APPROVAL', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['command.execute'] }),
      context({ isArchived: true, policy: { 'command.execute': 'REQUIRES_APPROVAL' } })
    )
    expect(result[0]).toMatchObject({ decision: 'DENY', reason: 'PROJECT_ARCHIVED' })
  })

  it('archived filesystem.read still follows policy (read inspection remains available)', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['filesystem.read'] }),
      context({ isArchived: true, policy: { 'filesystem.read': 'ALLOW' } })
    )
    expect(result).toEqual([{ projectId: 1, capability: 'filesystem.read', decision: 'ALLOW', reason: 'POLICY_ALLOWED' }])
  })

  it('archived git.read still follows policy', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['git.read'] }),
      context({ isArchived: true, policy: { 'git.read': 'REQUIRES_APPROVAL' } })
    )
    expect(result).toEqual([{ projectId: 1, capability: 'git.read', decision: 'REQUIRES_APPROVAL', reason: 'APPROVAL_REQUIRED' }])
  })
})

describe('resolveCapabilityRequest - trusted rule denial', () => {
  it('denies a capability present in ruleDeniedCapabilities', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['filesystem.write'] }),
      context({ ruleDeniedCapabilities: ['filesystem.write'], policy: { 'filesystem.write': 'ALLOW' } })
    )
    expect(result).toEqual([{ projectId: 1, capability: 'filesystem.write', decision: 'DENY', reason: 'RULE_RESTRICTION' }])
  })

  it('rule denial beats an ALLOW policy', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['git.write'] }),
      context({ ruleDeniedCapabilities: ['git.write'], policy: { 'git.write': 'ALLOW' } })
    )
    expect(result[0]).toMatchObject({ decision: 'DENY', reason: 'RULE_RESTRICTION' })
  })

  it('rule denial beats REQUIRES_APPROVAL', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['git.write'] }),
      context({ ruleDeniedCapabilities: ['git.write'], policy: { 'git.write': 'REQUIRES_APPROVAL' } })
    )
    expect(result[0]).toMatchObject({ decision: 'DENY', reason: 'RULE_RESTRICTION' })
  })
})

describe('resolveCapabilityRequest - explicit policy', () => {
  it('DENY policy => DENY / POLICY_DENIED', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['filesystem.read'] }),
      context({ policy: { 'filesystem.read': 'DENY' } })
    )
    expect(result).toEqual([{ projectId: 1, capability: 'filesystem.read', decision: 'DENY', reason: 'POLICY_DENIED' }])
  })

  it('REQUIRES_APPROVAL policy => REQUIRES_APPROVAL / APPROVAL_REQUIRED', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['git.write'] }),
      context({ policy: { 'git.write': 'REQUIRES_APPROVAL' } })
    )
    expect(result).toEqual([{ projectId: 1, capability: 'git.write', decision: 'REQUIRES_APPROVAL', reason: 'APPROVAL_REQUIRED' }])
  })

  it('ALLOW policy => ALLOW / POLICY_ALLOWED', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['command.execute'] }),
      context({ policy: { 'command.execute': 'ALLOW' } })
    )
    expect(result).toEqual([{ projectId: 1, capability: 'command.execute', decision: 'ALLOW', reason: 'POLICY_ALLOWED' }])
  })
})

describe('resolveCapabilityRequest - order and purity', () => {
  it('returns requested capabilities in canonical CAPABILITY_IDS order regardless of input order', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['git.write', 'filesystem.read'] }),
      context({ policy: { 'git.write': 'ALLOW', 'filesystem.read': 'ALLOW' } })
    )
    expect(result.map((r) => r.capability)).toEqual(['filesystem.read', 'git.write'])
  })

  it('an empty capability request returns an empty evaluation array', () => {
    expect(resolveCapabilityRequest(request({ capabilities: [] }), context())).toEqual([])
  })

  it('output contains only the requested capabilities, never the full taxonomy', () => {
    const result = resolveCapabilityRequest(request({ capabilities: ['git.read'] }), context())
    expect(result.map((r) => r.capability)).toEqual(['git.read'])
  })

  it('does not mutate the request or context objects', () => {
    const req = request({ capabilities: ['filesystem.read', 'git.write'] })
    const ctx = context({ policy: { 'filesystem.read': 'ALLOW' } })
    const reqSnapshot = JSON.parse(JSON.stringify(req))
    const ctxSnapshot = JSON.parse(JSON.stringify(ctx))
    resolveCapabilityRequest(req, ctx)
    expect(req).toEqual(reqSnapshot)
    expect(ctx).toEqual(ctxSnapshot)
  })

  // The resolver's signature accepts only (request, context) - there is no
  // agent/task/Work-Request parameter it could read, by construction.
  it('has exactly two parameters (request, context) - no room for agent/task/Work-Request input', () => {
    expect(resolveCapabilityRequest.length).toBe(2)
  })
})

describe('resolveCapabilityRequest - no capability inheritance', () => {
  it('filesystem.write ALLOW does not implicitly evaluate filesystem.read', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['filesystem.write'] }),
      context({ policy: { 'filesystem.write': 'ALLOW', 'filesystem.read': 'DENY' } })
    )
    expect(result).toEqual([{ projectId: 1, capability: 'filesystem.write', decision: 'ALLOW', reason: 'POLICY_ALLOWED' }])
  })

  it('git.write ALLOW does not implicitly evaluate git.read', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['git.write'] }),
      context({ policy: { 'git.write': 'ALLOW', 'git.read': 'DENY' } })
    )
    expect(result).toEqual([{ projectId: 1, capability: 'git.write', decision: 'ALLOW', reason: 'POLICY_ALLOWED' }])
  })

  it('command.execute ALLOW does not imply any other capability', () => {
    const result = resolveCapabilityRequest(
      request({ capabilities: ['command.execute'] }),
      context({
        policy: {
          'command.execute': 'ALLOW',
          'filesystem.read': 'DENY',
          'filesystem.write': 'DENY',
          'git.read': 'DENY',
          'git.write': 'DENY'
        }
      })
    )
    expect(result).toEqual([{ projectId: 1, capability: 'command.execute', decision: 'ALLOW', reason: 'POLICY_ALLOWED' }])
  })
})
