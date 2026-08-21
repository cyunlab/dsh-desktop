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
  /** 验证旧式 ICNS 回退图层不预裁圆角，避免与系统蒙版叠加。 */
  it('keeps the fallback macOS icon layer opaque and unmasked', async () => {
    const layer = await largestPngLayer(path.join(root, 'src-tauri/icons/icon.icns'))
    const { data, info } = await sharp(layer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    /** 返回指定像素的 alpha 通道。 */
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]
    expect([
      alphaAt(0, 0),
      alphaAt(info.width - 1, 0),
      alphaAt(0, info.height - 1),
      alphaAt(info.width - 1, info.height - 1)
    ]).toEqual([255, 255, 255, 255])
  })

  /** 验证 macOS 26 使用 Icon Composer 方形图层并交由系统生成最终圆角。 */
  it('ships an unmasked Icon Composer source for macOS 26', async () => {
    const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(path.join(root, 'src-tauri/icons/AppIcon.icon/icon.json'), 'utf8'))
    const artwork = await readFile(path.join(root, 'src-tauri/icons/AppIcon.icon/Assets/Artwork.svg'), 'utf8')
    expect(config.bundle.icon).toContain('icons/AppIcon.icon')
    expect(config.bundle.macOS.minimumSystemVersion).toBe('26.0')
    expect(manifest['supported-platforms'].squares).toContain('macOS')
    expect(artwork).toContain('<rect x="126" y="107" width="1001" height="1001" fill="url(#frame)"/>')
    expect(artwork).not.toContain('width="1042" height="1001" rx="240"')
  })
})
