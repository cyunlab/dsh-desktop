import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/** 根据 CI 矩阵平台返回 Tauri 发布包目录和唯一扩展名。 */
function artifactContract(platformName) {
  const contracts = {
    win: { directory: path.join('src-tauri', 'target', 'release', 'bundle', 'nsis'), extension: '.exe', label: 'Windows NSIS' },
    mac: { directory: path.join('src-tauri', 'target', 'release', 'bundle', 'dmg'), extension: '.dmg', label: 'macOS DMG' },
    linux: { directory: path.join('src-tauri', 'target', 'release', 'bundle', 'appimage'), extension: '.AppImage', label: 'Linux AppImage' }
  }[platformName]
  if (!contracts) throw new Error(`Unknown Tauri artifact platform: ${platformName}`)
  return contracts
}

/** 验证目标目录中恰好有一个正确类型的 Tauri 产物且没有 MSI。 */
async function verifyArtifact(platformName) {
  const contract = artifactContract(platformName)
  const entries = await readdir(contract.directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = path.join(contract.directory, entry.name)
    if ((await stat(filePath)).size === 0) throw new Error(`Tauri artifact is empty: ${filePath}`)
    files.push(entry.name)
  }
  const expected = files.filter(file => file.endsWith(contract.extension))
  if (expected.length !== 1) throw new Error(`Expected exactly one ${contract.label} artifact, found: ${files.join(', ') || '(none)'}`)
  if (files.some(file => file.toLowerCase().endsWith('.msi'))) throw new Error('MSI output is forbidden; Windows release is NSIS-only')
  console.log(`Verified ${contract.label} artifact: ${path.join(contract.directory, expected[0])}`)
}

/** 直接执行产物验收脚本。 */
async function main() {
  const platformName = process.argv[2]
  if (!platformName) throw new Error('Artifact platform is required')
  await verifyArtifact(platformName)
}

await main()
