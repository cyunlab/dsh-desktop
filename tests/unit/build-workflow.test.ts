import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = (await readFile(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
const behaviorWorkflow = (await readFile(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
const projectRoot = path.resolve(import.meta.dirname, '../..')

describe('native build workflow contract', () => {
  /** 根构建必须先生成 Desktop Client package，再物化 Runtime closure。 */
  it('builds the private Desktop client before the Runtime closure', async () => {
    const [manifest, buildScript] = await Promise.all([
      readFile(path.join(projectRoot, 'package.json'), 'utf8'),
      readFile(path.join(projectRoot, 'scripts', 'build.mjs'), 'utf8')
    ])
    const scripts = JSON.parse(manifest).scripts as Record<string, string>
    expect(scripts.build).toContain('pnpm --filter @cyunlab/dsh-desktop-update-client build')
    expect(buildScript).toContain('prepareRuntimeClosure')
  })

  /** 干净 checkout 的类型检查必须先生成 capability package 的声明文件。 */
  it('builds Desktop capability declarations before checking the update client', async () => {
    const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
    const typecheck = manifest.scripts.typecheck as string
    expect(typecheck.indexOf('@cyunlab/dsh-desktop-capabilities build')).toBeGreaterThanOrEqual(0)
    expect(typecheck.indexOf('@cyunlab/dsh-desktop-capabilities build')).toBeLessThan(typecheck.indexOf('@cyunlab/dsh-desktop-update-client typecheck'))
  })
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

  /** 打包 CLI 必须与 Rust Tauri 保持同一 minor，避免生成不可更新的 AppImage。 */
  it('aligns the packaging CLI with the resolved Rust Tauri minor', async () => {
    const [manifestSource, cargoLock] = await Promise.all([
      readFile(path.join(projectRoot, 'package.json'), 'utf8'),
      readFile(path.join(projectRoot, 'src-tauri', 'Cargo.lock'), 'utf8')
    ])
    const cliVersion = JSON.parse(manifestSource).devDependencies['@tauri-apps/cli'] as string
    const tauriVersion = cargoLock.match(/\[\[package\]\]\nname = "tauri"\nversion = "([^"]+)"/)?.[1]
    expect(tauriVersion).toBeDefined()
    expect(cliVersion.split('.').slice(0, 2)).toEqual(tauriVersion!.split('.').slice(0, 2))
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

  /** Linux 桌面 E2E 必须安装 WebKit 的 WebDriver 可执行文件。 */
  it('installs the Linux WebKit WebDriver for desktop E2E', () => {
    expect(behaviorWorkflow).toMatch(/Install Linux Tauri and WebView test dependencies[\s\S]*webkit2gtk-driver/)
  })

  it('builds an AppImage in extraction mode for hosted runners', () => {
    expect(workflow).not.toContain('NO_STRIP')
    expect(workflow).toContain('APPIMAGE_EXTRACT_AND_RUN: 1')
  })

  /** 确保所有原生构建都用生产 updater 密钥生成强制签名。 */
  it('signs updater artifacts for every native target', () => {
    expect(workflow).toMatch(/build:[\s\S]*runs-on: \$\{\{ matrix\.runner \}\}\n    environment: production/)
    expect(workflow).not.toContain('id-token: write')
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}')
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}')
    for (const updaterPath of [
      'nsis/*.exe.sig',
      'macos/*.app.tar.gz',
      'macos/*.app.tar.gz.sig',
      'appimage/*.AppImage',
      'appimage/*.AppImage.sig'
    ]) expect(workflow).toContain(`bundle/${updaterPath}`)
  })

  /** 确保两种 macOS 架构都绕过 Finder，并在封装 DMG 前递归签署原生资源。 */
  it('builds and recursively signs each macOS app before creating its DMG', () => {
    expect(workflow).toContain('Build and recursively sign macOS application')
    expect(workflow).toContain('env -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH')
    expect(workflow).toContain('pnpm tauri:build --bundles app --verbose')
    expect(workflow.indexOf('env -u APPLE_API_ISSUER')).toBeLessThan(workflow.indexOf('while IFS= read -r -d'))
    expect(workflow).toContain("file -b \"$candidate\" | grep -q 'Mach-O'")
    expect(workflow).toContain('--options runtime')
    expect(workflow).toContain('codesign --verify --deep --strict --verbose=2 "$app_path"')
    expect(workflow).toContain('xcrun notarytool submit "$app_notary_zip"')
    expect(workflow).toContain('xcrun stapler validate "$app_path"')
    expect(workflow).toContain('tar -czf "$updater_archive"')
    expect(workflow).toContain('pnpm tauri signer sign "$updater_archive"')
    expect(workflow.indexOf('codesign --verify --deep --strict --verbose=2 "$app_path"')).toBeLessThan(workflow.indexOf('tar -czf "$updater_archive"'))
    expect(workflow.indexOf('xcrun stapler validate "$app_path"')).toBeLessThan(workflow.indexOf('tar -czf "$updater_archive"'))
    expect(workflow).toContain('hdiutil create -volname "DeepSeek Harness Desktop"')
    expect(workflow).toContain('-format UDZO "$dmg_path"')
    expect(workflow).toContain("if: matrix.platform != 'mac'")
    expect(workflow).not.toContain('pnpm package -- --verbose || pnpm package -- --verbose')
  })

  /** 确保四目标正式二进制编译进受信 Stable endpoint 与同一 updater 公钥。 */
  it('embeds the production Stable endpoint and promotion public key in every native build', () => {
    expect(workflow.match(/DSH_UPDATER_ENDPOINT: https:\/\/updates\.cyunlab\.com\/dsh-desktop\/channels\/stable\/latest\.json/g)).toHaveLength(2)
    expect(workflow.match(/DSH_UPDATER_PUBLIC_KEY: \$\{\{ vars\.TAURI_SIGNING_PUBLIC_KEY \}\}/g)).toHaveLength(2)
    expect(workflow).not.toMatch(/DSH_UPDATER_ENDPOINT:\s*\$\{\{\s*inputs\./)
  })

  /** 确保两个 macOS 架构都经过 Developer ID 签名、Apple 公证和装订。 */
  it('signs and notarizes every macOS release artifact', () => {
    expect(workflow).toContain("if: matrix.platform == 'mac'")
    expect(workflow).toContain('APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}')
    expect(workflow).toContain('APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}')
    expect(workflow).toContain('APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}')
    expect(workflow).toContain('APPLE_API_PRIVATE_KEY: ${{ secrets.APPLE_API_PRIVATE_KEY }}')
    expect(workflow).toContain('security import "$certificate"')
    expect(workflow).toContain('codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$dmg"')
    expect(workflow).toContain('xcrun notarytool submit "$dmg"')
    expect(workflow).toContain('xcrun stapler validate "$dmg"')
    expect(workflow).toContain('spctl --assess --type open')
  })

  it('allows the Windows Job controller enough time to initialize', () => {
    expect(workflow).toContain("DSH_WINDOWS_CONTROLLER_START_TIMEOUT_MS: ${{ runner.os == 'Windows' && '60000' || '' }}")
  })

  it.each([
    ['windows-2025', 'win', 'x64', 'nsis/*.exe'],
    ['macos-15', 'mac', 'arm64', 'dmg/*.dmg'],
    ['macos-15-intel', 'mac', 'x64', 'dmg/*.dmg'],
    ['ubuntu-22.04', 'linux', 'x64', 'appimage/*.AppImage']
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
    expect(workflow).not.toContain('promote-stable-release.mjs')
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
