import { describe, expect, it } from 'vitest'
import { compareSemanticVersions, updateCargoPackageVersion } from '../../scripts/tag-release.mjs'

describe('release tagging helpers', () => {
  it.each([
    ['1.2.0', '1.1.9'], ['1.2.0', '1.2.0-rc.2'],
    ['1.2.0-rc.2', '1.2.0-rc.1'], ['2.0.0-beta.1', '2.0.0-alpha.9']
  ])('orders %s after %s', (next, current) => {
    expect(compareSemanticVersions(next, current)).toBeGreaterThan(0)
  })

  it('updates only the named Cargo package', () => {
    const contents = '[[package]]\nname = "dependency"\nversion = "1.1.1"\n\n[[package]]\nname = "deepseek-harness-desktop"\nversion = "1.1.1"\n'
    const updated = updateCargoPackageVersion(contents, 'deepseek-harness-desktop', '1.2.0')
    expect(updated).toContain('name = "dependency"\nversion = "1.1.1"')
    expect(updated).toContain('name = "deepseek-harness-desktop"\nversion = "1.2.0"')
  })
})
