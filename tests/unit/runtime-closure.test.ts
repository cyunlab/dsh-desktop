import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { packagedDshCliCommand, probePackagedDshCli, requiredRuntimeAssets, resolveDshCliEntry, runtimeTarget, verifyRuntimeClosure } from '../../scripts/runtime-closure.mjs'

const desktopManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const pinnedDshVersion = desktopManifest.dependencies['@deepseek-ai/dsh'] as string

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
  const cliDirectory = path.join(root, '@deepseek-ai/dsh')
  await mkdir(path.join(cliDirectory, 'lib'), { recursive: true })
  await mkdir(path.join(cliDirectory, 'config', 'agent-presets', 'standard'), { recursive: true })
  await writeFile(path.join(cliDirectory, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: pinnedDshVersion,
    bin: { dsh: 'lib/published-cli.js' },
    dependencies: {}
  }))
  await writeFile(path.join(cliDirectory, 'lib', 'published-cli.js'), 'console.log("fixture")')
  await writeFile(path.join(cliDirectory, 'config', 'agent-presets', 'standard', 'preset.yml'), 'name: standard')
}

/** 返回夹具中模拟 pnpm 安装的动态 sharp 原生资产路径。 */
function fixtureAssetPath(assetPath: string, target: ReturnType<typeof runtimeTarget>, dynamicVersion = false): string {
  if (!dynamicVersion || !['win32', 'linux'].includes(target.platform)) return assetPath
  if (target.platform === 'win32') {
    if (assetPath.endsWith('sharp-win32-x64-0.35.3.node')) return assetPath.replace('0.35.3.node', '0.35.9.node')
    if (assetPath.endsWith('libvips-42.dll')) return assetPath.replace('42.dll', '43.dll')
    if (assetPath.endsWith('libvips-cpp-8.18.3.dll')) return assetPath.replace('8.18.3', '8.19.0')
    return assetPath
  }
  const sharpAddon = path.join('@img', `sharp-${target.platform}-${target.arch}`, 'lib', `sharp-${target.platform}-${target.arch}-0.35.3.node`)
  if (assetPath === sharpAddon) return sharpAddon.replace('0.35.3.node', '0.35.9.node')
  const libvipsRuntime = path.join('@img', `sharp-libvips-${target.platform}-${target.arch}`, 'lib', 'libvips-cpp.so.8.18.3')
  if (assetPath === libvipsRuntime) return libvipsRuntime.replace('8.18.3', '8.19.0')
  return assetPath
}

/** 创建包含平台原生文件清单的最小闭包夹具。 */
async function createCompleteFixture(target = runtimeTarget('win32', 'x64'), dynamicVersion = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-runtime-closure-test-'))
  await createEntryPackages(root)
  for (const asset of requiredRuntimeAssets(target)) {
    const targetPath = path.join(root, fixtureAssetPath(asset.path, target, dynamicVersion))
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
    expect(assets).toContainEqual(expect.objectContaining({
      path: path.join('@deepseek-ai', 'dsh', 'config', 'agent-presets')
    }))
  })

  it('resolves the published CLI entry only through package.json#bin.dsh', async () => {
    const fixture = await createCompleteFixture()
    try {
      await expect(resolveDshCliEntry(fixture.root)).resolves.toBe(
        path.join(fixture.root, '@deepseek-ai', 'dsh', 'lib', 'published-cli.js')
      )
      const command = await packagedDshCliCommand({
        nodeExecutable: path.join(fixture.root, 'node-runtime', 'node'),
        nodeModulesRoot: fixture.root,
        args: ['web', '--host', '127.0.0.1', '--port', '3080'],
        environment: { PATH: '/system/bin', NODE_PATH: '/repository/node_modules' }
      })
      expect(command.args).toEqual([
        path.join(fixture.root, '@deepseek-ai', 'dsh', 'lib', 'published-cli.js'),
        'web', '--host', '127.0.0.1', '--port', '3080'
      ])
      expect(command.environment.PATH?.split(path.delimiter)[0]).toBe(path.join(fixture.root, 'node-runtime'))
      expect(command.environment.NODE_PATH).toBeUndefined()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a published package without the dsh bin contract or its declared entry', async () => {
    const fixture = await createCompleteFixture()
    const manifestPath = path.join(fixture.root, '@deepseek-ai', 'dsh', 'package.json')
    try {
      await writeFile(manifestPath, JSON.stringify({ name: '@deepseek-ai/dsh', version: pinnedDshVersion, dependencies: {} }))
      await expect(verifyRuntimeClosure(fixture.root, fixture.target)).rejects.toThrow('package.json#bin.dsh')

      await writeFile(manifestPath, JSON.stringify({
        name: '@deepseek-ai/dsh',
        version: pinnedDshVersion,
        bin: { dsh: 'lib/missing-cli.js' },
        dependencies: {}
      }))
      await expect(verifyRuntimeClosure(fixture.root, fixture.target)).rejects.toThrow('lib/missing-cli.js')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a runtime CLI package that does not match the exact Desktop pin', async () => {
    const fixture = await createCompleteFixture()
    const manifestPath = path.join(fixture.root, '@deepseek-ai', 'dsh', 'package.json')
    try {
      await writeFile(manifestPath, JSON.stringify({
        name: '@deepseek-ai/dsh',
        version: '999.0.0',
        bin: { dsh: 'lib/published-cli.js' },
        dependencies: {}
      }))
      await expect(verifyRuntimeClosure(fixture.root, fixture.target)).rejects.toThrow(
        `runtime version mismatch: expected ${pinnedDshVersion}, found 999.0.0`
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a closure without the published CLI configuration assets', async () => {
    const fixture = await createCompleteFixture()
    try {
      await rm(path.join(fixture.root, '@deepseek-ai', 'dsh', 'config'), { recursive: true, force: true })
      await expect(verifyRuntimeClosure(fixture.root, fixture.target)).rejects.toThrow('published CLI configuration')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('runs the CLI probe through the explicitly supplied packaged Node executable', async () => {
    const fixture = await createCompleteFixture()
    const nodeExecutable = path.join(fixture.root, 'packaged-node', 'node')
    const capture = path.join(fixture.root, 'probe-argv.txt')
    try {
      await mkdir(path.dirname(nodeExecutable), { recursive: true })
      await writeFile(nodeExecutable, `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`)
      await chmod(nodeExecutable, 0o755)
      await expect(probePackagedDshCli({
        nodeExecutable,
        nodeModulesRoot: fixture.root,
        args: ['--version']
      })).resolves.toEqual(expect.objectContaining({ code: 0 }))
      expect((await readFile(capture, 'utf8')).trim().split('\n')).toEqual([
        path.join(fixture.root, '@deepseek-ai', 'dsh', 'lib', 'published-cli.js'),
        '--version'
      ])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
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
        path.join('node-pty', 'build', 'Release', 'pty.node'),
        path.join('@deepseek-ai', 'node-addon-landlock-run-linux-x64', 'bin', 'landlock-run'),
        path.join('@img', 'sharp-libvips-linux-x64', 'lib', 'libvips-cpp.so.8.18.3')
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

  it('resolves dynamic sharp native version names on Windows too', async () => {
    const target = runtimeTarget('win32', 'x64')
    const fixture = await createCompleteFixture(target, true)
    try {
      await expect(verifyRuntimeClosure(fixture.root, target)).resolves.toBe(true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a sharp native file without a semantic version', async () => {
    const target = runtimeTarget('win32', 'x64')
    const fixture = await createCompleteFixture(target, true)
    const packageRoot = path.join(fixture.root, '@img', 'sharp-win32-x64', 'lib')
    try {
      await rename(path.join(packageRoot, 'sharp-win32-x64-0.35.9.node'), path.join(packageRoot, 'sharp-win32-x64-arbitrary.node'))
      await expect(verifyRuntimeClosure(fixture.root, target)).rejects.toThrow('sharp-win32-x64')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  // Windows 无法为模拟 Linux 文件设置 POSIX executable mode，Linux/macOS CI 会执行该夹具。
  it.skipIf(process.platform === 'win32')('accepts the Linux pnpm sharp layout with dynamic native version names', async () => {
    const target = runtimeTarget('linux', 'x64')
    const fixture = await createCompleteFixture(target, true)
    try {
      await expect(verifyRuntimeClosure(fixture.root, target)).resolves.toBe(true)
      expect(requiredRuntimeAssets(target).map(asset => asset.path)).not.toContain(path.join('node-pty', 'build', 'Release', 'spawn-helper'))
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('keeps the macOS node-pty spawn helper mandatory', async () => {
    const target = runtimeTarget('darwin', 'arm64')
    const fixture = await createCompleteFixture(target)
    try {
      await rm(path.join(fixture.root, 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'))
      await expect(verifyRuntimeClosure(fixture.root, target)).rejects.toThrow('spawn-helper')
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
