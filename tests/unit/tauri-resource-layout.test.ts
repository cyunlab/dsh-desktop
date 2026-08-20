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
})
