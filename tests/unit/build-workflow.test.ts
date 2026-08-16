import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflow = await readFile(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')

describe('native build workflow contract', () => {
  it('only has manual and version-candidate tag entry points', () => {
    expect(workflow).toMatch(/^on:\n  workflow_dispatch:\n  push:\n    tags:/m)
    expect(workflow).not.toMatch(/^\s+pull_request:/m)
    expect(workflow).not.toMatch(/^\s+branches:/m)
    expect(workflow).toContain("- 'v*'")
  })

  it('pins the toolchain and frozen installation', () => {
    expect(workflow).toContain('version: 11.7.0')
    expect(workflow).toContain('node-version: 24')
    expect(workflow).toContain('pnpm install --frozen-lockfile')
  })

  it.each([
    ['windows-2025', 'win', 'x64', 'exe'],
    ['macos-15', 'mac', 'arm64', 'dmg'],
    ['macos-15-intel', 'mac', 'x64', 'dmg'],
    ['ubuntu-24.04', 'linux', 'x64', 'AppImage']
  ])('builds %s natively', (runner, platform, arch, extension) => {
    expect(workflow).toContain(`runner: ${runner}`)
    expect(workflow).toContain(`platform: ${platform}`)
    expect(workflow).toContain(`arch: ${arch}`)
    expect(workflow).toContain(`extension: ${extension}`)
  })

  it('gates a draft-only tag release on all build jobs', () => {
    expect(workflow).toMatch(/draft-release:[\s\S]*if: github\.event_name == 'push'[\s\S]*needs: build/)
    expect(workflow).toContain('node scripts/verify-release-version.mjs')
    expect(workflow).toContain('gh release create')
    expect(workflow).toContain('--draft --verify-tag')
    expect(workflow).not.toMatch(/gh release (?:edit|create)[^\n]*--draft=false/)
    expect(workflow).not.toContain('gh release publish')
  })

  it('validates every tag candidate before allowing native builds', () => {
    expect(workflow).toMatch(/validate-release-version:[\s\S]*if: github\.event_name == 'push'[\s\S]*node scripts\/verify-release-version\.mjs/)
    expect(workflow).toMatch(/build:[\s\S]*needs: validate-release-version/)
  })

  it('labels uploads and release notes as unsigned development builds', () => {
    expect(workflow).toContain('pattern: unsigned-dev-*')
    expect(workflow).toContain('not signed, notarized, or suitable for a public production release')
    expect(workflow).toContain('SmartScreen')
    expect(workflow).toContain('Gatekeeper')
    expect(workflow).toContain('chmod +x')
  })
})
