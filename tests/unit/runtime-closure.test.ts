import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { requiredRuntimeAssets, runtimeTarget, verifyRuntimeClosure } from '../../scripts/runtime-closure.mjs'

/** 创建最小的 Harness 入口包清单，隔离闭包验证器自身的图遍历逻辑。 */
async function createEntryPackages(root: string): Promise<void> {
  for (const name of [
    '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-cmdline',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/dsh-web-app'
  ]) {
    const directory = path.join(root, name)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: 'test', dependencies: {} }))
  }
}

/** 创建包含平台原生文件清单的最小闭包夹具。 */
async function createCompleteFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-runtime-closure-test-'))
  const target = runtimeTarget('win32', 'x64')
  await createEntryPackages(root)
  for (const asset of requiredRuntimeAssets(target)) {
    const targetPath = path.join(root, asset.path)
    if (asset.kind === 'non-empty-directory') {
      await mkdir(targetPath, { recursive: true })
      await writeFile(path.join(targetPath, 'asset.js'), 'asset')
    } else {
      await mkdir(path.dirname(targetPath), { recursive: true })
      await writeFile(targetPath, 'asset')
      if (asset.executable) await chmod(targetPath, 0o755)
    }
  }
  return { root, target }
}

describe('runtime closure contract', () => {
  it('uses package-relative paths so the Tauri resource contains no pnpm prefix', () => {
    const assets = requiredRuntimeAssets(runtimeTarget('win32', 'x64'))
    expect(assets.some(asset => asset.path.startsWith('node_modules'))).toBe(false)
    expect(assets).toContainEqual(expect.objectContaining({
      path: path.join('@deepseek-ai', 'dsh-base', 'cordis.patch.yml')
    }))
  })

  it('keeps platform-specific workers and native runtime paths in the contract', () => {
    const expectations = [
      [runtimeTarget('win32', 'x64'), [
        path.join('@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs'),
        path.join('node-pty', 'build', 'Release', 'conpty', 'conpty.dll')
      ]],
      [runtimeTarget('darwin', 'arm64'), [
        path.join('node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
        path.join('@img', 'sharp-libvips-darwin-arm64', 'lib', 'libvips-cpp.8.18.3.dylib')
      ]],
      [runtimeTarget('linux', 'x64'), [
        path.join('node-pty', 'build', 'Release', 'spawn-helper'),
        path.join('@deepseek-ai', 'node-addon-landlock-run-linux-x64', 'bin', 'landlock-run')
      ]]
    ] as const
    for (const [target, paths] of expectations) {
      const assets = requiredRuntimeAssets(target).map(asset => asset.path)
      for (const expectedPath of paths) expect(assets).toContain(expectedPath)
    }
  })

  it('accepts a complete platform closure', async () => {
    const fixture = await createCompleteFixture()
    try {
      await expect(verifyRuntimeClosure(fixture.root, fixture.target)).resolves.toBe(true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('reports missing native assets instead of accepting a partial closure', async () => {
    const fixture = await createCompleteFixture()
    try {
      const missing = path.join(fixture.root, 'node-pty', 'prebuilds', 'win32-x64', 'pty.node')
      await rm(missing)
      await expect(verifyRuntimeClosure(fixture.root, fixture.target)).rejects.toThrow('pty.node')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a symlink that would escape the packaged resource tree', async () => {
    const fixture = await createCompleteFixture()
    try {
      const outside = path.join(fixture.root, '..', 'outside-runtime-asset')
      await writeFile(outside, 'outside')
      const link = path.join(fixture.root, 'escaped-link')
      try {
        await (await import('node:fs/promises')).symlink(outside, link)
      } catch {
        return
      }
      await expect(verifyRuntimeClosure(fixture.root, fixture.target)).rejects.toThrow('symlink is not portable')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
      await rm(path.join(fixture.root, '..', 'outside-runtime-asset'), { force: true })
    }
  })
})
