import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflow = (await readFile(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')

describe('native build workflow contract', () => {
  it('pins every third-party action to a reviewed commit', () => {
    const actions = [...workflow.matchAll(/uses:\s+([^\s#]+@[^\s#]+)(?:\s+#\s+(v\S+))?/g)]
    expect(actions).toHaveLength(7)
    for (const [, action, version] of actions) {
      expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/)
      expect(version).toMatch(/^v\d+\.\d+\.\d+$/)
    }
  })

  it('only accepts version-candidate tags', () => {
    expect(workflow).toMatch(/^on:\n  push:\n    tags:/m)
    expect(workflow).toMatch(/workflow_dispatch:\n    inputs:\n      release_tag:/)
    expect(workflow).not.toMatch(/^\s+pull_request:/m)
    expect(workflow).not.toMatch(/^\s+branches:/m)
    expect(workflow).toContain("- 'v*'")
  })

  it('rebuilds only an explicit existing release tag when manually dispatched', () => {
    expect(workflow).toContain('ref: ${{ inputs.release_tag || github.ref_name }}')
    expect(workflow).toContain('refs/tags/${RELEASE_TAG}^{}')
    expect(workflow).toContain('release_ref: ${{ inputs.release_tag || github.ref_name }}')
  })

  it('pins the toolchain and frozen installation', () => {
    expect(workflow).toContain('version: 11.7.0')
    expect(workflow).toContain('node-version: 24')
    expect(workflow).toContain('pnpm install --frozen-lockfile')
  })

  it('builds the Tauri package through the public package command', () => {
    expect(workflow).toContain('pnpm package -- --verbose')
    expect(workflow).toContain('Build native Tauri package with official Node and published CLI')
    expect(workflow).toContain('Smoke test official Node plus published dsh web')
    expect(workflow).toContain('pnpm smoke:dsh-cli')
    expect(workflow).toContain('verify-tauri-artifact.mjs')
    expect(workflow).not.toContain('electron-builder')
  })

  it('installs the Linux Tauri system dependencies before packaging', () => {
    expect(workflow).toContain("sudo find /etc/apt/sources.list.d -maxdepth 1 -type f ! -name 'ubuntu.sources' -delete")
    expect(workflow).toContain('libwebkit2gtk-4.1-dev')
    expect(workflow).toContain('libayatana-appindicator3-dev')
    expect(workflow).toContain('patchelf')
  })

  it('builds a Debian package without the unreliable linuxdeploy path', () => {
    expect(workflow).not.toContain('NO_STRIP')
    expect(workflow).not.toContain('APPIMAGE_EXTRACT_AND_RUN')
  })

  it('builds the Intel app and creates its DMG without Finder automation', () => {
    expect(workflow).toContain('Build Intel macOS package without Finder DMG automation')
    expect(workflow).toContain('pnpm tauri:build --bundles app --verbose')
    expect(workflow).toContain('hdiutil create -volname "DeepSeek Harness Desktop"')
    expect(workflow).toContain('-format UDZO "$dmg_path"')
    expect(workflow).not.toContain('pnpm package -- --verbose || pnpm package -- --verbose')
  })

  it('allows the Windows Job controller enough time to initialize', () => {
    expect(workflow).toContain("DSH_WINDOWS_CONTROLLER_START_TIMEOUT_MS: ${{ runner.os == 'Windows' && '60000' || '' }}")
  })

  it.each([
    ['windows-2025', 'win', 'x64', 'nsis/*.exe'],
    ['macos-15', 'mac', 'arm64', 'dmg/*.dmg'],
    ['macos-15-intel', 'mac', 'x64', 'dmg/*.dmg'],
    ['ubuntu-22.04', 'linux', 'x64', 'deb/*.deb']
  ])('builds %s natively', (runner, platform, arch, artifactPath) => {
    expect(workflow).toContain(`runner: ${runner}`)
    expect(workflow).toContain(`platform: ${platform}`)
    expect(workflow).toContain(`arch: ${arch}`)
    expect(workflow).toContain(`bundle/${artifactPath}`)
  })

  it('gates a draft-only tag release on all build jobs', () => {
    expect(workflow).toMatch(/draft-release:[\s\S]*needs: build/)
    expect(workflow).toMatch(/draft-release:[\s\S]*actions\/checkout@[0-9a-f]{40}[\s\S]*node scripts\/reconcile-draft-release\.mjs/)
    expect(workflow).toContain('node scripts/verify-release-version.mjs')
    expect(workflow).toContain('node scripts/reconcile-draft-release.mjs')
    expect(workflow).toContain('node scripts/generate-release-notes.mjs')
    expect(workflow).toContain('fetch-depth: 0')
    expect(workflow).not.toMatch(/gh release (?:edit|create)[^\n]*--draft=false/)
    expect(workflow).not.toContain('gh release publish')
  })

  it('validates every tag candidate before allowing native builds', () => {
    expect(workflow).toMatch(/validate-release-version:[\s\S]*git merge-base --is-ancestor[\s\S]*node scripts\/verify-release-version\.mjs/)
    expect(workflow).toMatch(/behavior-tests:[\s\S]*needs: validate-release-version[\s\S]*uses: \.\/\.github\/workflows\/test\.yml/)
    expect(workflow).toMatch(/build:[\s\S]*needs: behavior-tests/)
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
    expect(workflow).toContain('generate-release-notes.mjs')
  })
})
