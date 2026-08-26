import { describe, expect, it } from 'vitest'
import { readCargoPackageVersion, verifyDesktopVersions, verifyReleaseVersion } from '../../scripts/verify-release-version.mjs'

describe('release version verification', () => {
  it.each(['0.1.0', '1.2.3-beta.1', '1.2.3+build.4', '2.0.0-rc.6+build.4'])(
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

  it('requires every Desktop manifest and lock entry to match', () => {
    expect(verifyDesktopVersions('v1.2.3', {
      'package.json': '1.2.3', 'src-tauri/tauri.conf.json': '1.2.3',
      'src-tauri/Cargo.toml': '1.2.3', 'src-tauri/Cargo.lock': '1.2.3'
    })).toBe('1.2.3')
    expect(() => verifyDesktopVersions('v1.2.3', { 'src-tauri/Cargo.toml': '1.2.2' })).toThrow(/Cargo\.toml/)
  })

  it('selects the named Cargo package', () => {
    const contents = '[[package]]\nname = "dependency"\nversion = "9.0.0"\n\n[[package]]\nname = "deepseek-harness-desktop"\nversion = "1.2.3"\n'
    expect(readCargoPackageVersion(contents, 'deepseek-harness-desktop')).toBe('1.2.3')
  })
})
