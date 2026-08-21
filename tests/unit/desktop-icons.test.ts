import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'

const root = path.resolve(import.meta.dirname, '../..')

/** 从 ICNS 容器中提取面积最大的 PNG 图层。 */
async function largestPngLayer(icnsPath: string) {
  const container = await readFile(icnsPath)
  const layers: Array<{ area: number, data: Buffer }> = []
  for (let offset = 8; offset < container.length;) {
    const length = container.readUInt32BE(offset + 4)
    const data = container.subarray(offset + 8, offset + length)
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      const metadata = await sharp(data).metadata()
      layers.push({ area: (metadata.width ?? 0) * (metadata.height ?? 0), data })
    }
    offset += length
  }
  layers.sort((left, right) => right.area - left.area)
  if (!layers[0]) throw new Error('ICNS 中没有可验证的 PNG 图层')
  return layers[0].data
}

describe('Desktop icon assets', () => {
  /** 验证 Dock 使用的 ICNS 保留透明四角，不会显示为不透明方块。 */
  it('keeps transparent corners in the largest macOS icon layer', async () => {
    const layer = await largestPngLayer(path.join(root, 'src-tauri/icons/icon.icns'))
    const { data, info } = await sharp(layer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    /** 返回指定像素的 alpha 通道。 */
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]
    expect([
      alphaAt(0, 0),
      alphaAt(info.width - 1, 0),
      alphaAt(0, info.height - 1),
      alphaAt(info.width - 1, info.height - 1)
    ]).toEqual([0, 0, 0, 0])
  })
})
