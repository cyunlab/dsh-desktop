import { describe, expect, it } from 'vitest'
import { verifyReleaseVersion } from '../../scripts/verify-release-version.mjs'

describe('release version verification', () => {
  it.each(['0.1.0', '1.2.3-beta.1', '2.0.0-rc.6+build.4'])(
    'accepts an exact semantic version %s',
    version => expect(verifyReleaseVersion(`v${version}`, version)).toBe(version)
  )

  it.each([
    ['1.2.3', '1.2.3'],
    ['v01.2.3', '01.2.3'],
    ['v1.2', '1.2'],
    ['v1.2.3-', '1.2.3-']
  ])('rejects invalid tag %s', (tag, version) => {
    expect(() => verifyReleaseVersion(tag, version)).toThrow()
  })

  it('rejects a tag/package mismatch', () => {
    expect(() => verifyReleaseVersion('v1.2.3', '1.2.4')).toThrow(/does not exactly match/)
  })
})
