import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import path from 'node:path'
import { createConnection } from 'node:net'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { getNodeTarget, withDirectoryLock } from './ensure-official-node.mjs'
import { packagedDshCliCommand } from './runtime-closure.mjs'

const root = path.resolve(import.meta.dirname, '..')
const execFileAsync = promisify(execFile)
const MAX_HTML_BYTES = 64 * 1024
const WINDOWS_COMMAND_TIMEOUT_MS = 2_000
export const FIXED_HOST_ORIGIN = 'http://127.0.0.1:3080/'
export const DIRECT_DSH_WEB_ARGS = Object.freeze(['web', '--host', '127.0.0.1', '--port', '3080'])

/** 从命令行读取可选资源根与 runtime closure 根。 */
function readOptions(argumentsList) {
  const options = {
    resourceRoot: path.join(root, 'resources'),
    nodeModulesRoot: path.join(root, 'dist', 'node_modules')
  }
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--resource-root') options.resourceRoot = path.resolve(argumentsList[++index] ?? '')
    else if (argument === '--node-modules-root') options.nodeModulesRoot = path.resolve(argumentsList[++index] ?? '')
    else throw new Error(`Unknown dsh CLI smoke option: ${argument}`)
  }
  return options
}

/** 使用跨进程目录锁串行化所有固定 3080 端口探测。 */
export function withFixedPortProbeLock(action, options = {}) {
  const lockPath = options.lockPath ?? path.join(tmpdir(), 'dsh-desktop-fixed-port-3080.lock')
  return withDirectoryLock(lockPath, action, {
    retryMilliseconds: 50,
    staleMilliseconds: 5 * 60_000,
    timeoutMilliseconds: options.timeoutMilliseconds ?? 5 * 60_000,
    heartbeatMilliseconds: 1_000
  })
}

/** 等待子进程确认退出。 */
export function waitForChildExit(child, timeoutMilliseconds = 10_000) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      reject(new Error(`dsh CLI did not exit within ${timeoutMilliseconds}ms`))
    }, timeoutMilliseconds)
    /** 记录退出并清理计时器。 */
    function onExit() {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
  })
}

/** 查询 Windows 当前进程表，保留已退出 leader 的 ParentProcessId 关系。 */
async function windowsProcessTable(timeoutMilliseconds = WINDOWS_COMMAND_TIMEOUT_MS) {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: Math.max(1, timeoutMilliseconds),
    killSignal: 'SIGKILL'
  })
  const parsed = JSON.parse(stdout || '[]')
  return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({
    pid: Number(row.ProcessId),
    parentPid: Number(row.ParentProcessId),
    creationDate: String(row.CreationDate ?? '')
  })).filter(row => Number.isInteger(row.pid) && Number.isInteger(row.parentPid) && row.creationDate.length > 0)
}

/** 以 PID+CreationDate 身份解析 Windows 进程树，并拒绝复用的 root PID。 */
export function windowsOwnedProcessIds(rootPid, rootCreationDate, rows) {
  const root = rows.find(row => row.pid === rootPid && row.creationDate === rootCreationDate)
  if (!root) return []
  const owned = new Map([[rootPid, rootCreationDate]])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      const parentCreationDate = owned.get(row.parentPid)
      const parent = rows.find(candidate => candidate.pid === row.parentPid && candidate.creationDate === parentCreationDate)
      if (parent && !owned.has(row.pid)) {
        owned.set(row.pid, row.creationDate)
        changed = true
      }
    }
  }
  return [...owned.keys()]
}

/** 对任意 Windows 查询施加调用方剩余 deadline，测试 seam 也不得无限挂起。 */
async function queryWindowsProcessesWithin(ownership, timeoutMilliseconds) {
  let timer
  try {
    return await Promise.race([
      ownership.queryWindowsProcesses(timeoutMilliseconds),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Windows process query exceeded ${timeoutMilliseconds}ms`)), timeoutMilliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 刷新已确认的 Windows PID+CreationDate ownership；只从仍匹配身份的 parent 扩张。 */
function absorbWindowsRows(ownership, rows) {
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      const parentCreationDate = ownership.knownProcessIdentities.get(row.parentPid)
      const parentMatches = rows.some(candidate => candidate.pid === row.parentPid && candidate.creationDate === parentCreationDate)
      if (parentMatches && !ownership.knownProcessIdentities.has(row.pid)) {
        ownership.knownProcessIdentities.set(row.pid, row.creationDate)
        changed = true
      }
    }
  }
  return rows.filter(row => ownership.knownProcessIdentities.get(row.pid) === row.creationDate)
}

/** 在 deadline 内查询并吸收 Windows 进程身份。 */
async function refreshWindowsOwnership(ownership, timeoutMilliseconds) {
  return absorbWindowsRows(ownership, await queryWindowsProcessesWithin(ownership, timeoutMilliseconds))
}

/** 建立 PID+CreationDate 绑定的跨平台进程树 ownership。 */
export async function ownProcessTree(child, options = {}) {
  const ownership = {
    rootPid: Number.isInteger(child.pid) ? child.pid : undefined,
    platformName: options.platformName ?? platform(),
    queryWindowsProcesses: options.queryWindowsProcesses ?? windowsProcessTable,
    knownProcessIdentities: new Map()
  }
  if (ownership.platformName === 'win32' && Number.isInteger(ownership.rootPid)) {
    const deadline = Date.now() + (options.captureTimeoutMilliseconds ?? WINDOWS_COMMAND_TIMEOUT_MS)
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const rows = await queryWindowsProcessesWithin(ownership, remaining)
      const root = rows.find(row => row.pid === ownership.rootPid)
      if (root) {
        ownership.knownProcessIdentities.set(root.pid, root.creationDate)
        absorbWindowsRows(ownership, rows)
        break
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)))
    }
    if (!ownership.knownProcessIdentities.has(ownership.rootPid)) {
      throw new Error(`Windows process identity unavailable for PID ${ownership.rootPid}`)
    }
  }
  return ownership
}

/** 返回 owned process group 或 Windows descendant 集是否已经完全消失。 */
export async function processTreeHasExited(ownership, timeoutMilliseconds = WINDOWS_COMMAND_TIMEOUT_MS) {
  if (!Number.isInteger(ownership.rootPid)) return true
  if (ownership.platformName === 'win32') {
    return (await refreshWindowsOwnership(ownership, timeoutMilliseconds)).length === 0
  }
  try {
    process.kill(-ownership.rootPid, 0)
    return false
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true
    throw new Error(`Cannot inspect POSIX process group ${ownership.rootPid}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 等待 owned process tree，而不把 leader 退出误认为整棵树已回收。 */
export async function waitForProcessTreeExit(ownership, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    if (await processTreeHasExited(ownership, Math.min(WINDOWS_COMMAND_TIMEOUT_MS, remaining))) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`dsh CLI process tree did not exit within ${timeoutMilliseconds}ms`)
}

/** 强制终止 CLI 整棵进程树并验收 owned tree 消失。 */
export async function terminateProcessTree(child, timeoutMilliseconds = 10_000, ownership = ownProcessTree(child)) {
  ownership = await ownership
  if (child.pid === undefined) return
  const deadline = Date.now() + timeoutMilliseconds
  try {
    if (ownership.platformName === 'win32') {
      const owned = (await refreshWindowsOwnership(ownership, Math.max(1, deadline - Date.now()))).reverse()
      for (const processIdentity of owned) {
        const remaining = Math.max(1, deadline - Date.now())
        try {
          await execFileAsync('taskkill.exe', ['/PID', String(processIdentity.pid), '/T', '/F'], {
            windowsHide: true,
            timeout: remaining,
            killSignal: 'SIGKILL'
          })
        } catch {}
      }
    } else {
      try {
        process.kill(-ownership.rootPid, 'SIGKILL')
      } catch (error) {
        throw new Error(`Cannot force POSIX process group ${ownership.rootPid}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } catch (error) {
    const alreadyExited = await processTreeHasExited(ownership).catch(() => false)
      || (error instanceof Error && 'code' in error && error.code === 'ESRCH')
    if (!alreadyExited) throw error
  }
  await waitForChildExit(child, Math.max(1, deadline - Date.now()))
  await waitForProcessTreeExit(ownership, Math.max(1, deadline - Date.now()))
}

/** 尝试连接 loopback listener，并确保 socket 总能关闭。 */
function listenerAcceptsConnections(origin, timeoutMilliseconds = 300) {
  const url = new URL(origin)
  return new Promise(resolve => {
    let settled = false
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    /** 完成探测并销毁 socket。 */
    function finish(value) {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMilliseconds, () => finish(false))
  })
}

/** 等待固定 Harness listener 停止接受连接。 */
export async function waitForListenerClosed(origin = FIXED_HOST_ORIGIN, timeoutMilliseconds = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMilliseconds) {
    if (!(await listenerAcceptsConnections(origin))) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Harness listener still accepts connections: ${new URL(origin).origin}`)
}

/** 有界读取 HTML 响应，避免 artifact 验收被无限流或超大响应拖垮。 */
async function readBoundedBody(response, maximumBytes = MAX_HTML_BYTES) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`Packaged dsh web probe exceeded ${maximumBytes} byte HTML limit`)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) throw new Error(`Packaged dsh web probe exceeded ${maximumBytes} byte HTML limit`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total).toString('utf8')
}

/** 校验响应 origin、2xx、text/html，并有界读取非空 HTML。 */
async function requireHtmlResponse(response) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Packaged dsh web probe returned HTTP ${response.status}`)
  }
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'text/html') throw new Error('Packaged dsh web probe did not return exact text/html')
  if (new URL(response.url).origin !== new URL(FIXED_HOST_ORIGIN).origin) throw new Error('Packaged dsh web probe escaped the fixed loopback origin')
  const body = await readBoundedBody(response)
  if (!body.trim()) throw new Error('Packaged dsh web probe did not return non-empty HTML')
  return body
}

/** 轮询固定根页面，同时把 CLI 提前退出作为确定性失败。 */
export async function waitForHtmlReadiness(child, options = {}) {
  const origin = options.origin ?? FIXED_HOST_ORIGIN
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 90_000
  const started = Date.now()
  let lastError
  let spawnError
  /** 保存 spawn error，避免仅靠 exitCode 丢失启动失败。 */
  function observeSpawnError(error) { spawnError = error }
  child.once('error', observeSpawnError)
  try {
    while (Date.now() - started < timeoutMilliseconds) {
      if (spawnError) throw new Error(`Packaged dsh CLI spawn failed: ${spawnError.message}`)
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Packaged dsh CLI exited before HTML readiness with ${child.exitCode ?? child.signalCode ?? 'unknown'}`)
      }
      if (options.ownership?.platformName === 'win32') {
        await refreshWindowsOwnership(options.ownership, Math.min(WINDOWS_COMMAND_TIMEOUT_MS, Math.max(1, timeoutMilliseconds - (Date.now() - started))))
      }
      try {
        const response = await fetch(origin, { redirect: 'manual', signal: AbortSignal.timeout(1_000) })
        return await requireHtmlResponse(response)
      } catch (error) {
        if (error instanceof Error && /returned HTTP|exact text\/html|non-empty HTML|fixed loopback origin|byte HTML limit/.test(error.message)) throw error
        lastError = error
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } finally {
    child.removeListener('error', observeSpawnError)
  }
  throw new Error(`Packaged dsh CLI did not serve HTML within ${timeoutMilliseconds}ms${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

/** 先请求 direct CLI 正常关闭，超时后强制回收完整进程树。 */
async function stopCliProcess(child, ownership, timeoutMilliseconds = 8_000) {
  if (await processTreeHasExited(ownership)) return
  if (ownership.platformName === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(ownership.rootPid), '/T'], {
        windowsHide: true,
        timeout: Math.min(WINDOWS_COMMAND_TIMEOUT_MS, timeoutMilliseconds),
        killSignal: 'SIGKILL'
      })
    } catch {}
  } else {
    try {
      process.kill(child.pid, 'SIGTERM')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        throw new Error(`Cannot signal POSIX CLI leader ${child.pid}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  try {
    await Promise.all([waitForChildExit(child, timeoutMilliseconds), waitForProcessTreeExit(ownership, timeoutMilliseconds)])
  } catch {
    await terminateProcessTree(child, 10_000, ownership)
  }
}

/** 用指定随包 Node 与 CLI closure 执行固定 direct web 命令并验收清理。 */
export async function probeDirectDshWeb(options) {
  return withFixedPortProbeLock(async () => {
    await waitForListenerClosed(FIXED_HOST_ORIGIN, 1_000)
    const workDirectory = options.workDirectory ?? await mkdtemp(path.join(tmpdir(), 'dsh-direct-cli-probe-'))
    const ownsWorkDirectory = options.workDirectory === undefined
    const environment = {
      ...process.env,
      ...(options.environment ?? {}),
      DSH_HOME: path.join(workDirectory, 'harness-home')
    }
    delete environment.DSH_NODE_PATH
    for (const name of Object.keys(environment)) {
      if (name.toLowerCase() === 'node_path' || name.startsWith('DSH_TEST_')) delete environment[name]
    }
    const command = await packagedDshCliCommand({
      nodeExecutable: options.nodeExecutable,
      nodeModulesRoot: options.nodeModulesRoot,
      args: DIRECT_DSH_WEB_ARGS,
      environment
    })
    const child = spawn(command.executable, command.args, {
      cwd: workDirectory,
      env: command.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: platform() !== 'win32',
      windowsHide: true
    })
    const ownership = await ownProcessTree(child)
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000) })
    child.stdout.resume()
    let cleanupConfirmed = false
    try {
      const html = await waitForHtmlReadiness(child, { timeoutMilliseconds: options.timeoutMilliseconds, ownership })
      await stopCliProcess(child, ownership)
      await waitForListenerClosed()
      cleanupConfirmed = true
      return Object.freeze({ command, html })
    } catch (error) {
      let cleanupError
      try {
        await terminateProcessTree(child, 10_000, ownership)
        await waitForListenerClosed()
        cleanupConfirmed = true
      } catch (failure) {
        cleanupError = failure
      }
      const detail = stderr.trim()
      throw new Error([
        error instanceof Error ? error.message : String(error),
        detail,
        cleanupError ? `Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}` : ''
      ].filter(Boolean).join('\n'))
    } finally {
      if (ownsWorkDirectory && cleanupConfirmed) await rm(workDirectory, { recursive: true, force: true })
    }
  })
}

/** 用随项目下载的官方 Node 启动真实发布 CLI 并验证固定 Web 根。 */
async function runSmoke(options) {
  const target = getNodeTarget(platform(), arch())
  const nodeExecutable = path.join(options.resourceRoot, 'node', target.resourceName, target.relativeExecutable)
  const result = await probeDirectDshWeb({ nodeExecutable, nodeModulesRoot: options.nodeModulesRoot })
  console.log(`Official Node + published dsh web smoke passed for ${target.resourceName}: ${result.command.args.join(' ')}`)
}

/** 判断 smoke 脚本是否由 Node 直接执行。 */
function isDirectEntry() {
  return process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isDirectEntry()) await runSmoke(readOptions(process.argv.slice(2)))
