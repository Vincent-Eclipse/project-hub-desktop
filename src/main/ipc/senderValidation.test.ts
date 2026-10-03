import { describe, expect, it } from 'vitest'
import { isTrustedTopLevelSender, type TrustedSenderCheck } from './senderValidation'

function check(overrides: Partial<TrustedSenderCheck> = {}): TrustedSenderCheck {
  return { senderId: 1, senderFrameIsMainFrame: true, senderIsDestroyed: false, expectedWebContentsId: 1, ...overrides }
}

describe('isTrustedTopLevelSender', () => {
  it('accepts the registered top-level main-window sender', () => {
    expect(isTrustedTopLevelSender(check())).toBe(true)
  })

  it('rejects when no window is registered yet', () => {
    expect(isTrustedTopLevelSender(check({ expectedWebContentsId: null }))).toBe(false)
  })

  it('rejects a sender with a different WebContents ID (a forged/unregistered window)', () => {
    expect(isTrustedTopLevelSender(check({ senderId: 999 }))).toBe(false)
  })

  it('rejects a destroyed sender', () => {
    expect(isTrustedTopLevelSender(check({ senderIsDestroyed: true }))).toBe(false)
  })

  it('rejects a call originating from a subframe/iframe, even of the registered window', () => {
    expect(isTrustedTopLevelSender(check({ senderFrameIsMainFrame: false }))).toBe(false)
  })

  it('rejects when both the sender ID mismatches and the frame is not top-level', () => {
    expect(isTrustedTopLevelSender(check({ senderId: 42, senderFrameIsMainFrame: false }))).toBe(false)
  })
})
