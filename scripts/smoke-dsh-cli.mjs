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

/** 强制终止 CLI 整棵进程树并等待 leader 退出。 */
export async function terminateProcessTree(child, timeoutMilliseconds = 10_000) {
  if (child.pid === undefined) return
  try {
    if (platform() === 'win32') {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch (error) {
    const alreadyExited = child.exitCode !== null || child.signalCode !== null
      || (error instanceof Error && 'code' in error && error.code === 'ESRCH')
    if (!alreadyExited) throw error
  }
  await waitForChildExit(child, timeoutMilliseconds)
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

/** 校验一次响应确实是 2xx、text/html 且完整读取后非空。 */
async function requireHtmlResponse(response) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Packaged dsh web probe returned HTTP ${response.status}`)
  }
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'text/html') throw new Error('Packaged dsh web probe did not return exact text/html')
  const body = await response.text()
  if (!body.trim()) throw new Error('Packaged dsh web probe did not return non-empty HTML')
  return body
}

/** 轮询固定根页面，同时把 CLI 提前退出作为确定性失败。 */
export async function waitForHtmlReadiness(child, options = {}) {
  const origin = options.origin ?? FIXED_HOST_ORIGIN
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 90_000
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMilliseconds) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Packaged dsh CLI exited before HTML readiness with ${child.exitCode ?? child.signalCode ?? 'unknown'}`)
    }
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1_000) })
      return await requireHtmlResponse(response)
    } catch (error) {
      if (error instanceof Error && /returned HTTP|exact text\/html|non-empty HTML/.test(error.message)) throw error
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Packaged dsh CLI did not serve HTML within ${timeoutMilliseconds}ms${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

/** 先请求 direct CLI 正常关闭，超时后强制回收完整进程树。 */
async function stopCliProcess(child, timeoutMilliseconds = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (platform() === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T'], { windowsHide: true })
    } catch {}
  } else {
    child.kill('SIGTERM')
  }
  try {
    await waitForChildExit(child, timeoutMilliseconds)
  } catch {
    await terminateProcessTree(child)
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
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000) })
    let cleanupConfirmed = false
    try {
      const html = await waitForHtmlReadiness(child, { timeoutMilliseconds: options.timeoutMilliseconds })
      await stopCliProcess(child)
      await waitForListenerClosed()
      cleanupConfirmed = true
      return Object.freeze({ command, html })
    } catch (error) {
      let cleanupError
      try {
        await terminateProcessTree(child)
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
