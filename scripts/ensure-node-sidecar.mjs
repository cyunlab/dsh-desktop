import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir, platform, arch, tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const NODE_VERSION = process.env.DSH_NODE_VERSION ?? '24.19.0'
const root = path.resolve(import.meta.dirname, '..')
const cacheRoot = path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), '.cache'), 'dsh-desktop', 'node')
const resourceRoot = path.join(root, 'resources', 'node')

/** 将运行平台映射为 Node 官方发行包命名和项目资源目录。 */
function target() {
  const key = `${platform()}-${arch()}`
  const targets = {
    'win32-x64': ['windows-x86_64', `node-v${NODE_VERSION}-win-x64.zip`, 'node.exe'],
    'win32-arm64': ['windows-aarch64', `node-v${NODE_VERSION}-win-arm64.zip`, 'node.exe'],
    'darwin-x64': ['macos-x86_64', `node-v${NODE_VERSION}-darwin-x64.tar.xz`, 'bin/node'],
    'darwin-arm64': ['macos-aarch64', `node-v${NODE_VERSION}-darwin-arm64.tar.xz`, 'bin/node'],
    'linux-x64': ['linux-x86_64', `node-v${NODE_VERSION}-linux-x64.tar.xz`, 'bin/node'],
    'linux-arm64': ['linux-aarch64', `node-v${NODE_VERSION}-linux-arm64.tar.xz`, 'bin/node']
  }[key]
  if (!targets) throw new Error(`Unsupported Node sidecar target: ${key}`)
  return { resourceName: targets[0], archiveName: targets[1], relativeExecutable: targets[2] }
}

/** 下载文件并写入临时路径，避免半成品进入缓存。 */
async function download(url, destination) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`)
  await pipeline(response.body, createWriteStream(destination))
}

/** 读取 Node 官方 SHASUMS 文件中的目标归档哈希。 */
async function expectedHash(version, archiveName) {
  const response = await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)
  if (!response.ok) throw new Error(`Unable to download Node checksums (${response.status})`)
  const text = await response.text()
  const line = text.split(/\r?\n/).find(value => value.endsWith(`  ${archiveName}`))
  if (!line) throw new Error(`Node checksum not found for ${archiveName}`)
  return line.split(/\s+/)[0]
}

/** 校验下载归档，防止缓存或网络内容被错误使用。 */
async function sha256(file) {
  const bytes = await readFile(file)
  return createHash('sha256').update(bytes).digest('hex')
}

/** 递归查找解压后的 Node 可执行文件。 */
async function findExecutable(directory, relativeExecutable) {
  const expected = path.basename(relativeExecutable)
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const result = await findExecutable(full, relativeExecutable)
      if (result) return result
    } else if (entry.name === expected) {
      return full
    }
  }
  return undefined
}

/** 确保当前目标的官方 Node sidecar 已下载并展开到 Tauri 资源目录。 */
async function ensure() {
  const selected = target()
  const destination = path.join(resourceRoot, selected.resourceName)
  const executable = path.join(destination, selected.relativeExecutable)
  try {
    await access(executable)
    console.log(`Node sidecar already present: ${executable}`)
    return
  } catch {}
  const archiveUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${selected.archiveName}`
  const cacheDir = path.join(cacheRoot, NODE_VERSION, selected.resourceName)
  const archivePath = path.join(cacheDir, selected.archiveName)
  await mkdir(cacheDir, { recursive: true })
  try { await access(archivePath) } catch { await download(archiveUrl, `${archivePath}.tmp`); await rename(`${archivePath}.tmp`, archivePath) }
  const actual = await sha256(archivePath)
  const expected = await expectedHash(NODE_VERSION, selected.archiveName)
  if (actual !== expected) throw new Error(`Node checksum mismatch for ${selected.archiveName}`)
  const extraction = await mkdtemp(path.join(tmpdir(), 'dsh-node-'))
  try {
    await execFileAsync('tar', ['-xf', archivePath, '-C', extraction], { windowsHide: true })
    const extracted = await findExecutable(extraction, selected.relativeExecutable)
    if (!extracted) throw new Error(`Node executable missing after extraction: ${selected.relativeExecutable}`)
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    await execFileAsync('tar', ['-xf', archivePath, '-C', destination, '--strip-components=1'], { windowsHide: true })
    await stat(executable)
    console.log(`Installed Node ${NODE_VERSION} sidecar: ${executable}`)
  } finally {
    await rm(extraction, { recursive: true, force: true })
  }
}

await ensure()
