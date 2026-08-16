import { describe, expect, it } from 'vitest'
import { assertSupportedNodeVersion } from '../../src/main/version-guard.js'

describe('Node version guard', () => {
  it('accepts Node 24', () => expect(() => assertSupportedNodeVersion('24.13.0')).not.toThrow())
  it.each(['23.11.0', '25.0.0', 'unknown'])('rejects %s', version => {
    expect(() => assertSupportedNodeVersion(version)).toThrow(/requires Node 24/)
  })
})
