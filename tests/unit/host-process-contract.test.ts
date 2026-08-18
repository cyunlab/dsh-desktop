import { describe, expect, it } from 'vitest'
import {
  parseHostProcessCommand,
  parseHostProcessMessage,
  serializeHostProcessError,
  type HostProcessMessage
} from '../../src/shared/host-process-contract.js'

describe('Host process contract', () => {
  it('accepts only an exact loopback ready binding and matching origin', () => {
    const message = parseHostProcessMessage({
      type: 'ready',
      origin: 'http://127.0.0.1:43210',
      binding: { host: '127.0.0.1', port: 43210 }
    })

    expect(message).toEqual({
      type: 'ready',
      origin: 'http://127.0.0.1:43210',
      binding: { host: '127.0.0.1', port: 43210 }
    })
  })

  it.each([
    { type: 'ready', origin: 'http://localhost:43210', binding: { host: '127.0.0.1', port: 43210 } },
    { type: 'ready', origin: 'http://127.0.0.1:43211', binding: { host: '127.0.0.1', port: 43210 } },
    { type: 'ready', origin: 'http://127.0.0.1:43210/path', binding: { host: '127.0.0.1', port: 43210 } },
    { type: 'ready', origin: 'https://127.0.0.1:43210', binding: { host: '127.0.0.1', port: 43210 } },
    { type: 'ready', origin: 'http://127.0.0.1:0', binding: { host: '127.0.0.1', port: 0 } },
    { type: 'ready', origin: 'http://127.0.0.1:43210', binding: { host: '0.0.0.0', port: 43210 } }
  ])('rejects an unsafe ready message %#', value => {
    expect(() => parseHostProcessMessage(value)).toThrow()
  })

  it('accepts and validates the minimal stop command', () => {
    expect(parseHostProcessCommand({ type: 'stop' })).toEqual({ type: 'stop' })
    expect(() => parseHostProcessCommand({ type: 'stop', extra: true })).toThrow()
    expect(() => parseHostProcessCommand({ type: 'start' })).toThrow()
  })

  it('serializes only bounded safe error fields', () => {
    const error = Object.assign(new Error('do not leak this stack or cause'), {
      name: 'StartupError',
      code: 'E_STARTUP',
      stack: 'SECRET STACK',
      cause: { token: 'SECRET' }
    })
    const serialized = serializeHostProcessError(error)

    expect(serialized).toEqual({ name: 'StartupError', message: 'do not leak this stack or cause', code: 'E_STARTUP' })
    expect(serialized).not.toHaveProperty('stack')
    expect(serialized).not.toHaveProperty('cause')
    expect(parseHostProcessMessage({ type: 'startup-failed', error: serialized })).toEqual({
      type: 'startup-failed',
      error: serialized
    } satisfies HostProcessMessage)
    expect(parseHostProcessMessage({ type: 'startup-failed', error: { name: 'Error', message: 'plain failure' } }))
      .toEqual({ type: 'startup-failed', error: { name: 'Error', message: 'plain failure' } })
  })
})
