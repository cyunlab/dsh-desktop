import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brandSourcePath = path.join(repositoryRoot, 'assets', 'dsh-desktop-logo.svg')
const iconOutputPath = path.join(repositoryRoot, 'src-tauri', 'icons')
const tauriCliPath = path.join(repositoryRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const sourceViewBox = 'viewBox="0 0 1254 1254"'
const desktopViewBox = 'viewBox="126 107 1001 1001"'
const macosPlatform = 'macos'
const windowsLinuxPlatform = 'windows-linux'
const windowsLinuxAssetNames = [
  '32x32.png',
  '64x64.png',
  '128x128.png',
  '128x128@2x.png',
  'icon.png',
  'icon.ico'
]

/** 只替换一次预期的品牌 SVG 片段，避免静默生成错误构图。 */
function replaceRequired(source, expected, replacement) {
  const firstMatch = source.indexOf(expected)
  if (firstMatch === -1 || source.indexOf(expected, firstMatch + expected.length) !== -1) {
    throw new Error(`品牌 SVG 中必须恰好包含一个预期片段：${expected}`)
  }
  return source.replace(expected, replacement)
}

/** 从唯一品牌源派生平台构图，不维护第二套鲸鱼或窗口素材。 */
function createPlatformSvg(brandSource, platform) {
  const croppedSource = replaceRequired(brandSource, sourceViewBox, desktopViewBox)
  if (platform === macosPlatform || platform === windowsLinuxPlatform) {
    return croppedSource
  }
  throw new Error(`不支持的桌面图标平台：${platform}`)
}

/** 使用相同缩放与压缩参数渲染保留透明圆角的平台源图。 */
async function renderPlatformSource(brandSource, platform, outputPath) {
  await sharp(Buffer.from(createPlatformSvg(brandSource, platform)))
    .resize(1024, 1024)
    .png({ compressionLevel: 9 })
    .toFile(outputPath)
}

/** 将两种平台构图渲染为供固定版 Tauri CLI 消费的统一 1024 像素源图。 */
async function renderPlatformSources(brandSource, temporaryRoot) {
  const windowsLinuxSourcePath = path.join(temporaryRoot, 'windows-linux.png')
  const macosSourcePath = path.join(temporaryRoot, 'macos.png')

  await Promise.all([
    renderPlatformSource(brandSource, windowsLinuxPlatform, windowsLinuxSourcePath),
    renderPlatformSource(brandSource, macosPlatform, macosSourcePath)
  ])

  return { macosSourcePath, windowsLinuxSourcePath }
}

/** 使用项目锁定的 Tauri CLI 生成跨平台容器和统一缩放的标准尺寸。 */
async function runTauriIconGeneration(sourcePath, outputPath) {
  await mkdir(outputPath, { recursive: true })
  await execFileAsync(process.execPath, [tauriCliPath, 'icon', sourcePath, '--output', outputPath], {
    cwd: repositoryRoot,
    maxBuffer: 10 * 1024 * 1024
  })
}

/** 按 ICNS 四字节类型码稳定排列容器块。 */
function compareIcnsChunks(left, right) {
  return left.subarray(0, 4).compare(right.subarray(0, 4))
}

/** 规范化 Tauri CLI 随机排列的 ICNS 块，使重复生成得到相同字节。 */
async function copyCanonicalIcns(sourcePath, destinationPath) {
  const source = await readFile(sourcePath)
  if (source.subarray(0, 4).toString('ascii') !== 'icns' || source.readUInt32BE(4) !== source.length) {
    throw new Error('Tauri CLI 生成了无效的 ICNS 容器')
  }

  const chunks = []
  for (let offset = 8; offset < source.length; ) {
    const chunkLength = source.readUInt32BE(offset + 4)
    if (chunkLength < 8 || offset + chunkLength > source.length) {
      throw new Error('Tauri CLI 生成了无效的 ICNS 块')
    }
    chunks.push(source.subarray(offset, offset + chunkLength))
    offset += chunkLength
  }
  chunks.sort(compareIcnsChunks)
  await writeFile(destinationPath, Buffer.concat([source.subarray(0, 8), ...chunks]))
}

/** 仅复制最终桌面产物；移动端和商店模板只存在于临时目录。 */
async function copyDesktopAssets(windowsLinuxOutputPath, macosOutputPath) {
  await mkdir(iconOutputPath, { recursive: true })
  const copyOperations = []
  for (const assetName of windowsLinuxAssetNames) {
    copyOperations.push(copyFile(path.join(windowsLinuxOutputPath, assetName), path.join(iconOutputPath, assetName)))
  }
  copyOperations.push(copyCanonicalIcns(path.join(macosOutputPath, 'icon.icns'), path.join(iconOutputPath, 'icon.icns')))
  await Promise.all(copyOperations)
}

/** 从品牌 SVG 生成并提交使用的七个 Desktop 图标产物。 */
async function generateDesktopIcons() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-icons-'))
  try {
    const brandSource = await readFile(brandSourcePath, 'utf8')
    const { macosSourcePath, windowsLinuxSourcePath } = await renderPlatformSources(brandSource, temporaryRoot)
    const windowsLinuxOutputPath = path.join(temporaryRoot, 'windows-linux')
    const macosOutputPath = path.join(temporaryRoot, 'macos')

    await Promise.all([
      runTauriIconGeneration(windowsLinuxSourcePath, windowsLinuxOutputPath),
      runTauriIconGeneration(macosSourcePath, macosOutputPath)
    ])
    await copyDesktopAssets(windowsLinuxOutputPath, macosOutputPath)
    console.log(`Generated Desktop icons in ${path.relative(repositoryRoot, iconOutputPath)}`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await generateDesktopIcons()
