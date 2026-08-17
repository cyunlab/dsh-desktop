import { describe, expect, it } from 'vitest'
import { userFacingStartupError } from '../../../src/main/lifecycle/startup-failure.js'

describe('user-facing startup errors', () => {
  it.each([
    new Error('failed at /Users/alice/Secret Project/.env'),
    new Error('GET http://127.0.0.1:3210/?token=secret-value'),
    new Error('Authorization: Bearer very-secret credential api_key=hidden'),
    { password: 'do-not-render' }
  ])('never exposes launcher exception content: %o', error => {
    const message = userFacingStartupError('host-startup', error)
    expect(message).toBe('The local Host could not start. Retry or copy diagnostics for help.')
    expect(message.length).toBeLessThanOrEqual(100)
    expect(message).not.toMatch(/alice|Secret|token|Bearer|api_key|password|hidden/i)
  })

  it('uses controlled copy for navigation failures', () => {
    expect(userFacingStartupError('host-navigation', new Error('file:///private/path?key=secret')))
      .toBe('The local Web Client could not be opened. Retry or copy diagnostics for help.')
  })
})
