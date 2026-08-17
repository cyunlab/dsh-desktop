import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  requiredRuntimeAssets,
  shouldRunPackagedProbe,
  targetFromAfterPackContext,
  verifyRequiredRuntimeAssets
} from '../../scripts/runtime-assets.mjs'
import { runAfterPack } from '../../scripts/after-pack.mjs'

async function completeFixture(platform: 'darwin' | 'linux' | 'win32', arch: 'arm64' | 'x64') {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-assets-'))
  for (const asset of requiredRuntimeAssets({ platform, arch })) {
    const target = path.join(root, asset.path)
    if (asset.kind === 'non-empty-directory') {
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'asset.js'), 'asset')
    } else {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, 'asset')
      if (asset.executable) await chmod(target, 0o755)
    }
  }
  return root
}

describe('required packaged runtime assets', () => {
  it.each([
    ['bundle YAML', 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'],
    ['Web frontend', 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets'],
    ['native addon', 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node'],
    ['runtime-resolved carrier', 'node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node']
  ])('rejects missing %s', async (_category, omitted) => {
    const root = await completeFixture('darwin', 'arm64')
    await rm(path.join(root, omitted), { recursive: true })
    await expect(verifyRequiredRuntimeAssets(root, { platform: 'darwin', arch: 'arm64' }))
      .resolves.toContain(omitted)
  })
})

describe('electron-builder target context', () => {
  it('maps the Arch enum and does not use the arm64 host for an x64 target', () => {
    expect(targetFromAfterPackContext({ electronPlatformName: 'darwin', arch: 1 }))
      .toEqual({ platform: 'darwin', arch: 'x64' })
    expect(shouldRunPackagedProbe(
      { platform: 'darwin', arch: 'x64' },
      { platform: 'darwin', arch: 'arm64' }
    )).toBe(false)
  })

  it('runs the executable probe only for a native target', () => {
    expect(shouldRunPackagedProbe(
      { platform: 'darwin', arch: 'arm64' },
      { platform: 'darwin', arch: 'arm64' }
    )).toBe(true)
    expect(shouldRunPackagedProbe(
      { platform: 'win32', arch: 'x64' },
      { platform: 'darwin', arch: 'arm64' }
    )).toBe(false)
  })

  it('statically verifies, skips a non-native probe, and seals the macOS bundle', async () => {
    const calls: Array<{ command: string, args: string[] }> = []
    const messages: string[] = []
    await runAfterPack({
      appOutDir: '/packaged/x64',
      electronPlatformName: 'darwin',
      arch: 1,
      packager: { appInfo: { productFilename: 'DeepSeek Harness Desktop' } }
    }, {
      host: { platform: 'darwin', arch: 'arm64' },
      prepareAssets: async () => {},
      runCommand: async (command, args) => { calls.push({ command, args }); return 'closure verified' },
      log: message => messages.push(message)
    })

    expect(calls).toHaveLength(3)
    expect(calls[0].args).toContain('x64')
    expect(calls[1]).toEqual({
      command: '/usr/bin/codesign',
      args: [
        '--force', '--deep', '--sign', '-', '--timestamp=none',
        '/packaged/x64/DeepSeek Harness Desktop.app'
      ]
    })
    expect(calls[2]).toEqual({
      command: '/usr/bin/codesign',
      args: [
        '--verify', '--deep', '--strict', '--verbose=4',
        '/packaged/x64/DeepSeek Harness Desktop.app'
      ]
    })
    expect(messages[0]).toContain('packaged Host probe skipped')
  })
})
