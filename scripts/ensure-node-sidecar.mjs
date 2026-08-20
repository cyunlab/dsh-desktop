import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { arch as hostArch, homedir, platform as hostPlatform, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 构建和本地开发共同使用的固定官方 Node 版本。运行时覆盖只由 DSH_NODE_PATH 提供。 */
export const NODE_VERSION = '24.19.0'

const projectRoot = path.resolve(import.meta.dirname, '..')

/** 返回当前支持平台的官方 Node 归档和资源布局。 */
export function getNodeTarget(runtimePlatform = hostPlatform(), runtimeArch = hostArch()) {
  const targets = {
    'win32-x64': {
      resourceName: 'windows-x86_64',
      archiveName: `node-v${NODE_VERSION}-win-x64.zip`,
      archiveRoot: `node-v${NODE_VERSION}-win-x64`,
      relativeExecutable: 'node.exe',
      archiveExecutable: 'node.exe',
      archiveKind: 'zip'
    },
    'darwin-arm64': {
      resourceName: 'macos-aarch64',
      archiveName: `node-v${NODE_VERSION}-darwin-arm64.tar.xz`,
      archiveRoot: `node-v${NODE_VERSION}-darwin-arm64`,
      relativeExecutable: 'node',
      archiveExecutable: 'bin/node',
      archiveKind: 'tar'
    },
    'darwin-x64': {
      resourceName: 'macos-x86_64',
      archiveName: `node-v${NODE_VERSION}-darwin-x64.tar.xz`,
      archiveRoot: `node-v${NODE_VERSION}-darwin-x64`,
      relativeExecutable: 'node',
      archiveExecutable: 'bin/node',
      archiveKind: 'tar'
    },
    'linux-x64': {
      resourceName: 'linux-x86_64',
      archiveName: `node-v${NODE_VERSION}-linux-x64.tar.xz`,
      archiveRoot: `node-v${NODE_VERSION}-linux-x64`,
      relativeExecutable: 'node',
      archiveExecutable: 'bin/node',
      archiveKind: 'tar'
    }
  }[`${runtimePlatform}-${runtimeArch}`]
  if (!targets) throw new Error(`Unsupported Node sidecar target: ${runtimePlatform}-${runtimeArch}`)
  return Object.freeze({ ...targets, runtimePlatform, runtimeArch })
}

/** 返回跨平台用户缓存目录，避免把下载中的归档提交到仓库。 */
export function getNodeCacheRoot(environment = process.env, home = homedir(), runtimePlatform = hostPlatform()) {
  const base = environment.DSH_NODE_CACHE_DIR
    ?? (runtimePlatform === 'win32'
      ? environment.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
      : environment.XDG_CACHE_HOME ?? path.join(home, '.cache'))
  return path.join(base, 'dsh-desktop', 'node')
}

/** 下载归档到调用方提供的临时路径，防止半成品进入共享缓存。 */
export async function download(url, destination, fetchImpl = fetch) {
  const response = await fetchImpl(url)
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`)
  await pipeline(response.body, createWriteStream(destination))
}

/** 从 Node 官方 SHASUMS 文件中读取目标归档的 SHA-256。 */
export async function expectedHash(version, archiveName, fetchImpl = fetch) {
  const response = await fetchImpl(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)
  if (!response.ok) throw new Error(`Unable to download Node checksums (${response.status})`)
  const text = await response.text()
  const line = text.split(/\r?\n/).find(value => value.trimEnd().endsWith(`  ${archiveName}`))
  if (!line) throw new Error(`Node checksum not found for ${archiveName}`)
  return line.trim().split(/\s+/)[0].toLowerCase()
}

/** 计算归档内容的 SHA-256，用于校验缓存和新下载。 */
export async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** 判断路径是否是一个已经存在的可执行文件。 */
async function isFile(file) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** 递归查找归档展开后的目标可执行文件。 */
export async function findExecutable(directory, relativeExecutable) {
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

/** 在 Windows 优先使用 tar，缺失时回退到系统 PowerShell 展开 ZIP。 */
async function extractArchive(archivePath, destination, target) {
  await mkdir(destination, { recursive: true })
  try {
    await execFileAsync('tar', ['-xf', archivePath, '-C', destination], { windowsHide: true })
    return
  } catch (error) {
    if (target.archiveKind !== 'zip' || target.runtimePlatform !== 'win32') throw error
  }
  /** 将路径安全地嵌入 PowerShell 单引号字符串。 */
  const quotePowerShell = value => `'${value.replaceAll("'", "''")}'`
  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Expand-Archive -LiteralPath ${quotePowerShell(archivePath)} -DestinationPath ${quotePowerShell(destination)} -Force`
  ], { windowsHide: true })
}

/** 为 POSIX 平台补齐 Node 可执行权限；Windows 不需要 chmod。 */
async function ensureExecutablePermission(file, runtimePlatform) {
  if (runtimePlatform !== 'win32') await chmod(file, 0o755)
}

/** 下载并校验当前平台归档，校验失败的缓存会被删除后重新下载。 */
async function ensureCachedArchive(target, cacheRoot, fetchImpl) {
  const cacheDirectory = path.join(cacheRoot, NODE_VERSION, target.resourceName)
  const archivePath = path.join(cacheDirectory, target.archiveName)
  await mkdir(cacheDirectory, { recursive: true })
  const expected = await expectedHash(NODE_VERSION, target.archiveName, fetchImpl)
  if (await isFile(archivePath)) {
    if ((await sha256(archivePath)).toLowerCase() === expected) return archivePath
    await rm(archivePath, { force: true })
  }
  const temporary = path.join(cacheDirectory, `${target.archiveName}.${process.pid}.${randomUUID()}.part`)
  try {
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/${target.archiveName}`, temporary, fetchImpl)
    const actual = (await sha256(temporary)).toLowerCase()
    if (actual !== expected) throw new Error(`Node checksum mismatch for ${target.archiveName}`)
    await rename(temporary, archivePath)
    return archivePath
  } finally {
    await rm(temporary, { force: true })
  }
}

/** 将官方归档以原子方式安装到 resources/node/<platform-arch>。 */
async function installArchive(archivePath, destination, target) {
  const stagingRoot = await mkdtemp(path.join(tmpdir(), 'dsh-node-extract-'))
  const extractionRoot = path.join(stagingRoot, 'extract')
  const destinationParent = path.dirname(destination)
  await mkdir(extractionRoot, { recursive: true })
  try {
    await extractArchive(archivePath, extractionRoot, target)
    const sourceRoot = path.join(extractionRoot, target.archiveRoot)
    const sourceExecutable = path.join(sourceRoot, target.archiveExecutable)
    if (!(await isFile(sourceExecutable))) {
      const discovered = await findExecutable(extractionRoot, target.archiveExecutable)
      if (!discovered) throw new Error(`Node executable missing after extraction: ${target.archiveExecutable}`)
      throw new Error(`Node archive layout changed; expected ${sourceExecutable}, found ${discovered}`)
    }
    await ensureExecutablePermission(sourceExecutable, target.runtimePlatform)
    await mkdir(destinationParent, { recursive: true })
    const stagingInstall = await mkdtemp(path.join(destinationParent, '.dsh-node-install-'))
    try {
      const stagedExecutable = path.join(stagingInstall, target.relativeExecutable)
      await cp(sourceExecutable, stagedExecutable)
      await ensureExecutablePermission(stagedExecutable, target.runtimePlatform)
      await rm(destination, { recursive: true, force: true })
      await rename(stagingInstall, destination)
    } finally {
      await rm(stagingInstall, { recursive: true, force: true })
    }
    const installed = path.join(destination, target.relativeExecutable)
    if (!(await isFile(installed))) throw new Error(`Node executable missing after install: ${installed}`)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

/** 确保固定版本官方 Node sidecar 已存在；已存在时绝不重复下载。 */
export async function ensureNodeSidecar(options = {}) {
  const runtimePlatform = options.runtimePlatform ?? hostPlatform()
  const runtimeArch = options.runtimeArch ?? hostArch()
  const target = getNodeTarget(runtimePlatform, runtimeArch)
  const root = options.projectRoot ?? projectRoot
  const resourceRoot = path.join(root, 'resources', 'node')
  const destination = path.join(resourceRoot, target.resourceName)
  const executable = path.join(destination, target.relativeExecutable)
  if (await isFile(executable)) {
    await ensureExecutablePermission(executable, runtimePlatform)
    console.log(`Node sidecar already present: ${executable}`)
    return executable
  }
  const cacheRoot = options.cacheRoot ?? getNodeCacheRoot(process.env, homedir(), runtimePlatform)
  const archivePath = await ensureCachedArchive(target, cacheRoot, options.fetchImpl ?? fetch)
  await installArchive(archivePath, destination, target)
  console.log(`Installed Node ${NODE_VERSION} sidecar: ${executable}`)
  return executable
}

/** 判断脚本是否由 Node 直接执行，避免单元测试导入时触发网络下载。 */
function isDirectEntry() {
  return process.argv[1] !== undefined
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isDirectEntry()) {
  await ensureNodeSidecar()
}
