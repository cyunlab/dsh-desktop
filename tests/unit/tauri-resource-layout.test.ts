import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')

describe('Tauri resource layout', () => {
  /** 验证目录映射保留 sidecar 和平台目录层级，避免 glob 将文件扁平化。 */
  it('maps resource directories without glob flattening', async () => {
    const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
    expect(config.bundle.resources).toEqual({
      '../dist': 'dist',
      '../resources/node': 'node'
    })
  })

  /** 验证 Tauri hook 是唯一构建入口，避免运行命令在资源扫描前重复删除 dist。 */
  it('runs the frontend build exactly once through Tauri hooks', async () => {
    const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    expect(config.build).toMatchObject({ beforeDevCommand: 'pnpm build', beforeBuildCommand: 'pnpm build' })
    expect(manifest.scripts['tauri:dev']).toBe('pnpm ensure:node-sidecar && node scripts/run-tauri.mjs dev')
    expect(manifest.scripts['tauri:build']).toBe('pnpm ensure:node-sidecar && node scripts/run-tauri.mjs build')
  })
})
