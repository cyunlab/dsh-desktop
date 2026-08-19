import { describe, expect, it } from 'vitest'
import { serializeError } from '../../src/sidecar/test-seams.js'

describe('node sidecar seams', () => {
  it('serializes unknown errors safely', () => {
    expect(serializeError(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' })
    expect(serializeError('boom')).toEqual({ name: 'Error', message: 'boom' })
  })
})
