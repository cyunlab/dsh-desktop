import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflow = (await readFile(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')

describe('native build workflow contract', () => {
  it('pins every third-party action to a reviewed commit', () => {
    const actions = [...workflow.matchAll(/uses:\s+([^\s#]+)(?:\s+#\s+(v\S+))?/g)]
    expect(actions).toHaveLength(7)
    for (const [, action, version] of actions) {
      expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/)
      expect(version).toMatch(/^v\d+\.\d+\.\d+$/)
    }
  })

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

  it('builds the Tauri package through the public package command', () => {
    expect(workflow).toContain('pnpm package')
    expect(workflow).toContain('Build native Tauri package with the official Node sidecar')
    expect(workflow).toContain('Smoke test the official Node + Harness runtime')
    expect(workflow).toContain('pnpm smoke:node-sidecar')
    expect(workflow).toContain('verify-tauri-artifact.mjs')
    expect(workflow).not.toContain('electron-builder')
  })

  it('installs the Linux Tauri system dependencies before packaging', () => {
    expect(workflow).toContain('libwebkit2gtk-4.1-dev')
    expect(workflow).toContain('libayatana-appindicator3-dev')
    expect(workflow).toContain('patchelf')
  })

  it.each([
    ['windows-2025', 'win', 'x64', 'nsis/*.exe'],
    ['macos-15', 'mac', 'arm64', 'dmg/*.dmg'],
    ['macos-15-intel', 'mac', 'x64', 'dmg/*.dmg'],
    ['ubuntu-24.04', 'linux', 'x64', 'appimage/*.AppImage']
  ])('builds %s natively', (runner, platform, arch, artifactPath) => {
    expect(workflow).toContain(`runner: ${runner}`)
    expect(workflow).toContain(`platform: ${platform}`)
    expect(workflow).toContain(`arch: ${arch}`)
    expect(workflow).toContain(`bundle/${artifactPath}`)
  })

  it('gates a draft-only tag release on all build jobs', () => {
    expect(workflow).toMatch(/draft-release:[\s\S]*if: github\.event_name == 'push'[\s\S]*needs: build/)
    expect(workflow).toMatch(/draft-release:[\s\S]*actions\/checkout@[0-9a-f]{40}[\s\S]*node scripts\/reconcile-draft-release\.mjs/)
    expect(workflow).toContain('node scripts/verify-release-version.mjs')
    expect(workflow).toContain('node scripts/reconcile-draft-release.mjs')
    expect(workflow).not.toMatch(/gh release (?:edit|create)[^\n]*--draft=false/)
    expect(workflow).not.toContain('gh release publish')
  })

  it('validates every tag candidate before allowing native builds', () => {
    expect(workflow).toMatch(/validate-release-version:[\s\S]*if: github\.event_name == 'push'[\s\S]*node scripts\/verify-release-version\.mjs/)
    expect(workflow).toMatch(/build:[\s\S]*needs: validate-release-version/)
  })

  it('uses release-ready artifact and workflow labels', () => {
    for (const artifact of [
      'dsh-desktop-windows-x64',
      'dsh-desktop-macos-arm64',
      'dsh-desktop-macos-x64',
      'dsh-desktop-linux-x64'
    ]) {
      expect(workflow).toContain(`artifact: ${artifact}`)
    }
    expect(workflow).toContain('pattern: dsh-desktop-*')
    expect(workflow.toLowerCase()).not.toContain('unsigned')
    expect(workflow.toLowerCase()).not.toContain('development')
    expect(workflow).toContain('SmartScreen')
    expect(workflow).toContain('Gatekeeper')
    expect(workflow).toContain('chmod +x')
  })
})
