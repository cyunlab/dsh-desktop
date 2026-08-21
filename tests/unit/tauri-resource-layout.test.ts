import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')

describe('Tauri resource layout', () => {
  /** 验证目录映射保留 runtime closure 和平台目录层级，避免 glob 将文件扁平化。 */
  it('maps resource directories without glob flattening', async () => {
    const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
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
})
