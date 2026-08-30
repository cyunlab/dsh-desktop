import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')

describe('Tauri resource layout', () => {
  /** 验证 Startup logo 位于 frontendDist 内，开发服务器和打包协议都能解析同一路径。 */
  it('keeps the Startup logo inside the frontend resource root', async () => {
    const html = await readFile(path.join(root, 'src/startup/index.html'), 'utf8')
    const buildScript = await readFile(path.join(root, 'scripts/build.mjs'), 'utf8')
    expect(html).toContain('href="./assets/dsh-desktop-logo.svg"')
    expect(html).toContain('src="./assets/dsh-desktop-logo.svg"')
    expect(buildScript).toContain("dist/startup/assets/${desktopLogoFileName}")
  })

  /** 验证目录映射保留 runtime closure 和平台目录层级，避免 glob 将文件扁平化。 */
  it('maps resource directories without glob flattening', async () => {
    const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
    expect(config.plugins?.updater).toEqual({ pubkey: '' })
    expect(config.bundle.resources).toEqual({
      '../dist': 'dist',
      '../resources/node': 'node'
    })
    expect(config.bundle.icon).toEqual([
      'icons/32x32.png',
      'icons/64x64.png',
      'icons/128x128.png',
      'icons/128x128@2x.png',
      'icons/icon.png',
      'icons/icon.icns',
      'icons/icon.ico'
    ])
    expect(config.bundle.targets).toEqual(['nsis', 'dmg', 'appimage'])
    expect(config.bundle.createUpdaterArtifacts).toBe(true)
  })

  /** 验证平台配置不会把发布矩阵声明的安装包类型覆盖回其他格式。 */
  it('keeps platform-specific bundle targets aligned with release artifacts', async () => {
    const [linux, macos, windows] = await Promise.all([
      readFile(path.join(root, 'src-tauri/tauri.linux.conf.json'), 'utf8'),
      readFile(path.join(root, 'src-tauri/tauri.macos.conf.json'), 'utf8'),
      readFile(path.join(root, 'src-tauri/tauri.windows.conf.json'), 'utf8')
    ]).then(configs => configs.map(config => JSON.parse(config)))
    expect(linux.bundle.targets).toEqual(['appimage'])
    expect(macos.bundle.targets).toEqual(['dmg'])
    expect(windows.bundle.targets).toEqual(['nsis'])
    expect(windows.bundle.windows.nsis.installMode).toBe('currentUser')
  })

  /** 验证 dev hook 会准备完整资源并等待结束，避免 Cargo 在 dist 重建期间扫描资源。 */
  it('waits for the complete development resource build before starting Cargo', async () => {
    const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    expect(config.build).toMatchObject({
      beforeDevCommand: {
        script: 'pnpm ensure:official-node && pnpm build',
        wait: true
      },
      beforeBuildCommand: 'pnpm build'
    })
    expect(manifest.scripts['tauri:dev']).toBe('pnpm ensure:official-node && node scripts/run-tauri.mjs dev')
    expect(manifest.scripts['tauri:build']).toBe('pnpm ensure:official-node && node scripts/run-tauri.mjs build')
  })

  /** 验证 Rust 生产模块只声明外置测试模块，不再内嵌测试实现。 */
  it('keeps Rust unit and integration tests outside production files', async () => {
    const productionModules = ['main.rs', 'lifecycle.rs', 'cli_supervisor.rs']
    for (const moduleName of productionModules) {
      const source = await readFile(path.join(root, 'src-tauri/src', moduleName), 'utf8')
      expect(source).toContain('#[cfg(test)]\nmod tests;')
      expect(source).not.toContain('mod tests {')
      const productionOnly = source.replace('#[cfg(test)]\nmod tests;', '')
      expect(productionOnly).not.toMatch(/#\[cfg\([^\]]*\btest\b[^\]]*\)\]/)
    }
    await Promise.all([
      readFile(path.join(root, 'src-tauri/src/tests/mod.rs'), 'utf8'),
      readFile(path.join(root, 'src-tauri/src/lifecycle/tests/mod.rs'), 'utf8'),
      readFile(path.join(root, 'src-tauri/src/cli_supervisor/tests/mod.rs'), 'utf8'),
      readFile(path.join(root, 'src-tauri/tests/README.md'), 'utf8')
    ])
  })
})
