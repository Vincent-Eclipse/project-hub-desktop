import { describe, expect, it } from 'vitest'
import type { ControllerPlan } from '@shared/types'
import {
  CONTROLLER_PLAN_MAX_SERIALIZED_BYTES,
  ClaudeOutputValidationError,
  decodeStrictUtf8,
  extractControllerPlanProposal,
  parseClaudeCliEnvelope
} from './claudeOutputValidation'

function validPlan(): ControllerPlan {
  return {
    planningResult: { planMarkdown: 'Plan', decisionRequests: [] },
    taskDrafts: []
  }
}

// Sanitized fixture matching the ACTUAL Claude Code 2.1.266 envelope shape observed by the
// first real smoke test - synthetic values only (never real session IDs/UUIDs/usage/cost/model
// content). `result` is deliberately different text from `structured_output` in these fixtures
// to prove the two are independent - the ControllerPlan proposal comes from `structured_output`,
// never from parsing `result`.
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'synthetic discarded result text',
    session_id: 'synthetic-session',
    structured_output: validPlan(),
    ...overrides
  }
}

function utf8(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

describe('decodeStrictUtf8', () => {
  it('decodes valid UTF-8 including multi-byte characters', () => {
    expect(decodeStrictUtf8(utf8('héllo wörld 你好'))).toBe('héllo wörld 你好')
  })

  it('rejects invalid UTF-8 byte sequences instead of replacing them', () => {
    const malformed = Buffer.from([0xff, 0xfe, 0x00, 0x41])
    expect(() => decodeStrictUtf8(malformed)).toThrow(ClaudeOutputValidationError)
    try {
      decodeStrictUtf8(malformed)
    } catch (error) {
      expect((error as ClaudeOutputValidationError).code).toBe('INVALID_OUTPUT')
    }
  })

  it('rejects a leading byte-order mark', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('{}')])
    expect(() => decodeStrictUtf8(withBom)).toThrow(ClaudeOutputValidationError)
  })
})

describe('parseClaudeCliEnvelope', () => {
  it('accepts the reviewed 2.1.266 envelope shape and extracts structured_output, not result', () => {
    const parsed = parseClaudeCliEnvelope(utf8(JSON.stringify(envelope())))
    expect(parsed).toEqual({
      type: 'result',
      subtype: 'success',
      isError: false,
      structuredOutput: validPlan()
    })
  })

  it('never uses result text as the structured_output source, even if result also looks like a plan', () => {
    const parsed = parseClaudeCliEnvelope(
      utf8(JSON.stringify(envelope({ result: JSON.stringify({ planningResult: { planMarkdown: 'DIFFERENT', decisionRequests: [] }, taskDrafts: [] }) })))
    )
    expect(parsed.structuredOutput).toEqual(validPlan())
  })

  it('tolerates every observed optional metadata field, forwarding only apiErrorStatus/terminalReason (used by the M4.7B.2 code-change terminal profile)', () => {
    const parsed = parseClaudeCliEnvelope(
      utf8(
        JSON.stringify(
          envelope({
            api_error_status: null,
            duration_api_ms: 900,
            duration_ms: 1000,
            fast_mode_disabled_reason: 'x',
            fast_mode_state: 'x',
            first_content_frame_ms: 100,
            modelUsage: { some: 'object' },
            num_turns: 1,
            permission_denials: [],
            queued_turn_count: 0,
            stop_reason: 'x',
            subagent_stats: { some: 'object' },
            terminal_reason: 'completed',
            time_to_request_ms: 10,
            total_cost_usd: 0.01,
            ttft_ms: 5,
            ttft_stream_ms: 5,
            usage: { in: 1 },
            uuid: 'synthetic-uuid'
          })
        )
      )
    )
    expect(Object.keys(parsed).sort()).toEqual(['apiErrorStatus', 'isError', 'structuredOutput', 'subtype', 'terminalReason', 'type'])
    expect(parsed.apiErrorStatus).toBeNull()
    expect(parsed.terminalReason).toBe('completed')
  })

  it('leaves apiErrorStatus/terminalReason undefined when the optional envelope fields are absent', () => {
    const parsed = parseClaudeCliEnvelope(utf8(JSON.stringify(envelope())))
    expect(parsed.apiErrorStatus).toBeUndefined()
    expect(parsed.terminalReason).toBeUndefined()
  })

  it('never returns session_id, uuid, or any telemetry field in the parsed envelope', () => {
    const parsed = parseClaudeCliEnvelope(
      utf8(JSON.stringify(envelope({ uuid: 'synthetic-uuid', usage: { tokens: 123 }, modelUsage: { model: 'x' } })))
    )
    const serialized = JSON.stringify(parsed)
    expect(serialized).not.toContain('synthetic-session')
    expect(serialized).not.toContain('synthetic-uuid')
    expect(serialized).not.toContain('tokens')
    expect(serialized).not.toContain('"model"')
  })

  it('rejects malformed JSON', () => {
    expect(() => parseClaudeCliEnvelope(utf8('{not valid json'))).toThrow(ClaudeOutputValidationError)
  })

  it('rejects leading prose before the JSON value', () => {
    expect(() => parseClaudeCliEnvelope(utf8(`Sure, here is the result:\n${JSON.stringify(envelope())}`))).toThrow(
      ClaudeOutputValidationError
    )
  })

  it('rejects trailing prose after the JSON value', () => {
    expect(() => parseClaudeCliEnvelope(utf8(`${JSON.stringify(envelope())}\nThanks!`))).toThrow(ClaudeOutputValidationError)
  })

  it('rejects Markdown code fences around the JSON value', () => {
    expect(() => parseClaudeCliEnvelope(utf8('```json\n' + JSON.stringify(envelope()) + '\n```'))).toThrow(
      ClaudeOutputValidationError
    )
  })

  it('rejects truncated/partial JSON', () => {
    const text = JSON.stringify(envelope())
    expect(() => parseClaudeCliEnvelope(utf8(text.slice(0, text.length - 5)))).toThrow(ClaudeOutputValidationError)
  })

  it('rejects a non-object top-level JSON value', () => {
    expect(() => parseClaudeCliEnvelope(utf8('"just a string"'))).toThrow(ClaudeOutputValidationError)
    expect(() => parseClaudeCliEnvelope(utf8('42'))).toThrow(ClaudeOutputValidationError)
    expect(() => parseClaudeCliEnvelope(utf8('[]'))).toThrow(ClaudeOutputValidationError)
  })

  it('rejects an unknown top-level field (envelope drift / injected authority field / future CLI version)', () => {
    expect(() => parseClaudeCliEnvelope(utf8(JSON.stringify(envelope({ approved: true }))))).toThrow(ClaudeOutputValidationError)
    expect(() => parseClaudeCliEnvelope(utf8(JSON.stringify(envelope({ requiredCapabilities: [] }))))).toThrow(
      ClaudeOutputValidationError
    )
    expect(() => parseClaudeCliEnvelope(utf8(JSON.stringify(envelope({ some_future_field: 'x' }))))).toThrow(
      ClaudeOutputValidationError
    )
  })

  it.each(['type', 'subtype', 'is_error', 'result', 'session_id', 'structured_output'])(
    'rejects a missing required field %s',
    (field) => {
      const raw = envelope()
      delete raw[field]
      expect(() => parseClaudeCliEnvelope(utf8(JSON.stringify(raw)))).toThrow(ClaudeOutputValidationError)
    }
  )

  it('rejects an unexpected type value', () => {
    expect(() => parseClaudeCliEnvelope(utf8(JSON.stringify(envelope({ type: 'stream_event' }))))).toThrow(
      ClaudeOutputValidationError
    )
  })

  it('rejects a non-boolean is_error', () => {
    expect(() => parseClaudeCliEnvelope(utf8(JSON.stringify(envelope({ is_error: 'false' }))))).toThrow(
      ClaudeOutputValidationError
    )
  })

  it('does not matter if result is malformed/non-JSON text, as long as structured_output is valid', () => {
    const parsed = parseClaudeCliEnvelope(utf8(JSON.stringify(envelope({ result: '{not even valid json at all' }))))
    expect(parsed.structuredOutput).toEqual(validPlan())
    expect(extractControllerPlanProposal(parsed.structuredOutput)).toEqual(validPlan())
  })

  it('rejects a non-string result even though its content is discarded (transport form is still checked)', () => {
    expect(() => parseClaudeCliEnvelope(utf8(JSON.stringify(envelope({ result: 123 }))))).toThrow(ClaudeOutputValidationError)
  })

  it('rejects a non-string session_id even though it is never returned (transport form is still checked)', () => {
    expect(() => parseClaudeCliEnvelope(utf8(JSON.stringify(envelope({ session_id: 123 }))))).toThrow(
      ClaudeOutputValidationError
    )
  })
})

describe('extractControllerPlanProposal', () => {
  it('validates a well-formed ControllerPlan object directly (no stringify/parse round-trip)', () => {
    expect(extractControllerPlanProposal(validPlan())).toEqual(validPlan())
  })

  it('rejects a structurally invalid ControllerPlan (delegates to validateControllerPlan)', () => {
    expect(() => extractControllerPlanProposal({ planningResult: {} })).toThrow(ClaudeOutputValidationError)
  })

  it('rejects Claude-supplied authority fields via the underlying ControllerPlan validation', () => {
    const withAuthority = { ...validPlan(), approved: true }
    expect(() => extractControllerPlanProposal(withAuthority)).toThrow(ClaudeOutputValidationError)
  })

  it.each([
    ['a string', 'not an object'],
    ['a number', 42],
    ['null', null],
    ['an array', []],
    ['undefined', undefined]
  ])('rejects the wrong structured_output type/shape (%s)', (_label, value) => {
    expect(() => extractControllerPlanProposal(value)).toThrow(ClaudeOutputValidationError)
  })

  it('rejects an oversized validated ControllerPlan with OUTPUT_LIMIT', () => {
    // A single planMarkdown long enough to cross the byte cap would already exceed
    // WORK_REQUEST_PLAN_MAX_LENGTH and fail structural validation first - use many small,
    // individually-valid task drafts instead to cross the byte cap only after passing
    // validateControllerPlan.
    const manyDrafts: ControllerPlan = {
      planningResult: { planMarkdown: 'Plan', decisionRequests: [] },
      taskDrafts: Array.from({ length: 200 }, (_, index) => ({
        key: `task-${index}`,
        title: 'x'.repeat(200),
        goalMarkdown: 'x'.repeat(2000),
        descriptionMarkdown: 'x'.repeat(2000),
        acceptanceCriteriaMarkdown: '',
        verificationRequirementsMarkdown: '',
        relevantFiles: [],
        dependsOnKeys: []
      }))
    }
    expect(Buffer.byteLength(JSON.stringify(manyDrafts), 'utf8')).toBeGreaterThan(CONTROLLER_PLAN_MAX_SERIALIZED_BYTES)
    let caught: unknown
    try {
      extractControllerPlanProposal(manyDrafts)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ClaudeOutputValidationError)
    expect((caught as ClaudeOutputValidationError).code).toBe('OUTPUT_LIMIT')
  })
})
