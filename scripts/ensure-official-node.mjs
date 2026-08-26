import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { arch as hostArch, homedir, platform as hostPlatform, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const LOCK_RETRY_MILLISECONDS = 100
const LOCK_STALE_MILLISECONDS = 30 * 60 * 1_000
const LOCK_TIMEOUT_MILLISECONDS = 35 * 60 * 1_000

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
      archiveKind: 'zip',
      archiveSha256: '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
    },
    'darwin-arm64': {
      resourceName: 'macos-aarch64',
      archiveName: `node-v${NODE_VERSION}-darwin-arm64.tar.xz`,
      archiveRoot: `node-v${NODE_VERSION}-darwin-arm64`,
      relativeExecutable: 'node',
      archiveExecutable: 'bin/node',
      archiveKind: 'tar',
      archiveSha256: '3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94'
    },
    'darwin-x64': {
      resourceName: 'macos-x86_64',
      archiveName: `node-v${NODE_VERSION}-darwin-x64.tar.xz`,
      archiveRoot: `node-v${NODE_VERSION}-darwin-x64`,
      relativeExecutable: 'node',
      archiveExecutable: 'bin/node',
      archiveKind: 'tar',
      archiveSha256: 'd35e95230f46f6f0751df497c56622c6735e05d5e1fb1630996a005b9d328fe4'
    },
    'linux-x64': {
      resourceName: 'linux-x86_64',
      archiveName: `node-v${NODE_VERSION}-linux-x64.tar.xz`,
      archiveRoot: `node-v${NODE_VERSION}-linux-x64`,
      relativeExecutable: 'node',
      archiveExecutable: 'bin/node',
      archiveKind: 'tar',
      archiveSha256: '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647'
    }
  }[`${runtimePlatform}-${runtimeArch}`]
  if (!targets) throw new Error(`Unsupported official Node target: ${runtimePlatform}-${runtimeArch}`)
  return Object.freeze({ ...targets, runtimePlatform, runtimeArch })
}

/** 返回跨平台用户缓存目录，避免把下载中的归档提交到仓库。 */
export function getNodeCacheRoot(environment = process.env, home = homedir(), runtimePlatform = hostPlatform()) {
  const base = runtimePlatform === 'win32'
    ? environment.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    : environment.XDG_CACHE_HOME ?? path.join(home, '.cache')
  return path.join(base, 'dsh-desktop', 'node')
}

/** 下载归档到调用方提供的临时路径，防止半成品进入共享缓存。 */
export async function download(url, destination, fetchImpl = fetch) {
  const response = await fetchImpl(url)
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`)
  await pipeline(response.body, createWriteStream(destination))
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

/** 判断任意文件系统路径是否存在。 */
async function pathExists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** 判断文件系统错误是否属于并发创建冲突。 */
function isExistenceConflict(error) {
  return error instanceof Error && 'code' in error
    && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code))
}

/** 等待锁持有者释放目标，避免忙轮询。 */
function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** 判断锁文件记录的持有进程是否仍存活，避免调度暂停时误抢有效锁。 */
async function lockOwnerProcessIsAlive(lockPath) {
  const owner = await readFile(path.join(lockPath, 'owner'), 'utf8').catch(() => '')
  const match = /^(\d+)-/.exec(owner)
  if (!match) return false
  const ownerPid = Number(match[1])
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false
  try {
    process.kill(ownerPid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/** 只释放仍由当前调用者拥有的锁，避免误删后来者的锁。 */
async function releaseDirectoryLock(lockPath, ownerToken) {
  const ownerPath = path.join(lockPath, 'owner')
  const currentOwner = await readFile(ownerPath, 'utf8').catch(() => undefined)
  if (currentOwner !== ownerToken) return
  const releasedPath = `${lockPath}.released-${process.pid}-${randomUUID()}`
  try {
    await rename(lockPath, releasedPath)
    await rm(releasedPath, { recursive: true, force: true })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}

/** 定期刷新仍属于当前调用者的锁目录，避免长时间下载被误判为陈旧锁。 */
function startDirectoryLockHeartbeat(lockPath, ownerToken, heartbeatMilliseconds) {
  let pending = Promise.resolve()
  let heartbeatError
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      const currentOwner = await readFile(path.join(lockPath, 'owner'), 'utf8').catch(() => undefined)
      if (currentOwner !== ownerToken) return
      const now = new Date()
      await utimes(lockPath, now, now)
    }).catch(error => {
      heartbeatError ??= error
    })
  }, heartbeatMilliseconds)
  timer.unref?.()
  return async () => {
    clearInterval(timer)
    await pending
    if (heartbeatError) throw heartbeatError
  }
}

/** 使用原子目录锁串行化同一目标，并回收超过安全时限的陈旧锁。 */
export async function withDirectoryLock(lockPath, action, options = {}) {
  const retryMilliseconds = options.retryMilliseconds ?? LOCK_RETRY_MILLISECONDS
  const staleMilliseconds = options.staleMilliseconds ?? LOCK_STALE_MILLISECONDS
  const timeoutMilliseconds = options.timeoutMilliseconds ?? LOCK_TIMEOUT_MILLISECONDS
  const heartbeatMilliseconds = options.heartbeatMilliseconds ?? Math.max(1, Math.min(10_000, Math.floor(staleMilliseconds / 3)))
  const started = Date.now()
  const ownerToken = `${process.pid}-${randomUUID()}`
  await mkdir(path.dirname(lockPath), { recursive: true })
  while (true) {
    try {
      await mkdir(lockPath)
      try {
        await writeFile(path.join(lockPath, 'owner'), ownerToken, { flag: 'wx' })
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true })
        throw error
      }
      break
    } catch (error) {
      if (!isExistenceConflict(error)) throw error
      let lockInformation
      try {
        lockInformation = await stat(lockPath)
      } catch {
        if (Date.now() - started >= timeoutMilliseconds) throw new Error(`Timed out waiting for official Node lock: ${lockPath}`)
        await delay(retryMilliseconds)
        continue
      }
      if (Date.now() - lockInformation.mtimeMs >= staleMilliseconds) {
        if (await lockOwnerProcessIsAlive(lockPath)) {
          if (Date.now() - started >= timeoutMilliseconds) throw new Error(`Timed out waiting for official Node lock: ${lockPath}`)
          await delay(retryMilliseconds)
          continue
        }
        const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`
        try {
          await rename(lockPath, stalePath)
          await rm(stalePath, { recursive: true, force: true })
          continue
        } catch (staleError) {
          if (!isExistenceConflict(staleError) && !(staleError instanceof Error && 'code' in staleError && staleError.code === 'ENOENT')) throw staleError
        }
      }
      if (Date.now() - started >= timeoutMilliseconds) throw new Error(`Timed out waiting for official Node lock: ${lockPath}`)
      await delay(retryMilliseconds)
    }
  }
  const stopHeartbeat = startDirectoryLockHeartbeat(lockPath, ownerToken, heartbeatMilliseconds)
  let actionResult
  let actionError
  try {
    actionResult = await action()
  } catch (error) {
    actionError = error
  }
  try {
    await stopHeartbeat()
  } finally {
    await releaseDirectoryLock(lockPath, ownerToken)
  }
  if (actionError) throw actionError
  return actionResult
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
  const expected = target.archiveSha256
  if (await isFile(archivePath) && (await sha256(archivePath)).toLowerCase() === expected) return archivePath
  await rm(archivePath, { force: true })
  const temporary = path.join(cacheDirectory, `${target.archiveName}.${process.pid}.${randomUUID()}.part`)
  try {
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/${target.archiveName}`, temporary, fetchImpl)
    const actual = (await sha256(temporary)).toLowerCase()
    if (actual !== expected) throw new Error(`Node checksum mismatch for ${target.archiveName}`)
    try {
      await rename(temporary, archivePath)
    } catch (error) {
      if (!isExistenceConflict(error)) throw error
      if (!(await isFile(archivePath)) || (await sha256(archivePath)).toLowerCase() !== expected) {
        throw new Error(`Concurrent Node cache winner was invalid: ${archivePath}`, { cause: error })
      }
    }
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
      const replacedDestination = `${destination}.replaced-${process.pid}-${randomUUID()}`
      let movedExisting = false
      if (await pathExists(destination)) {
        await rename(destination, replacedDestination)
        movedExisting = true
      }
      try {
        await rename(stagingInstall, destination)
      } catch (error) {
        if (isExistenceConflict(error) && await isFile(path.join(destination, target.relativeExecutable))) return
        if (movedExisting && !(await pathExists(destination))) await rename(replacedDestination, destination)
        throw error
      } finally {
        if (movedExisting) await rm(replacedDestination, { recursive: true, force: true })
      }
    } finally {
      await rm(stagingInstall, { recursive: true, force: true })
    }
    const installed = path.join(destination, target.relativeExecutable)
    if (!(await isFile(installed))) throw new Error(`Node executable missing after install: ${installed}`)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

/** 确保固定版本官方 Node executable 已存在；已存在时绝不重复下载。 */
export async function ensureOfficialNode(options = {}) {
  const runtimePlatform = options.runtimePlatform ?? hostPlatform()
  const runtimeArch = options.runtimeArch ?? hostArch()
  const target = getNodeTarget(runtimePlatform, runtimeArch)
  const root = options.projectRoot ?? projectRoot
  const resourceRoot = path.join(root, 'resources', 'node')
  const destination = path.join(resourceRoot, target.resourceName)
  const executable = path.join(destination, target.relativeExecutable)
  if (await isFile(executable)) {
    await ensureExecutablePermission(executable, runtimePlatform)
    console.log(`Official Node executable already present: ${executable}`)
    return executable
  }
  const cacheRoot = options.cacheRoot ?? getNodeCacheRoot(process.env, homedir(), runtimePlatform)
  const lockPath = path.join(cacheRoot, NODE_VERSION, `${target.resourceName}.lock`)
  return withDirectoryLock(lockPath, async () => {
    if (await isFile(executable)) {
      await ensureExecutablePermission(executable, runtimePlatform)
      console.log(`Official Node executable already present: ${executable}`)
      return executable
    }
    const archivePath = await ensureCachedArchive(target, cacheRoot, options.fetchImpl ?? fetch)
    await installArchive(archivePath, destination, target)
    console.log(`Installed official Node ${NODE_VERSION}: ${executable}`)
    return executable
  }, options.lockOptions)
}

/** 判断脚本是否由 Node 直接执行，避免单元测试导入时触发网络下载。 */
function isDirectEntry() {
  return process.argv[1] !== undefined
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isDirectEntry()) {
  await ensureOfficialNode()
}
