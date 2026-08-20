import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import path from 'node:path'
import { createConnection } from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { getNodeTarget } from './ensure-node-sidecar.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const execFileAsync = promisify(execFile)

/** 从命令行读取可选的资源根目录和 sidecar 入口。 */
function readOptions(argumentsList) {
  const options = {
    resourceRoot: path.join(root, 'resources'),
    sidecar: path.join(root, 'dist', 'sidecar', 'index.js')
  }
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--resource-root') options.resourceRoot = path.resolve(argumentsList[++index] ?? '')
    else if (argument === '--sidecar') options.sidecar = path.resolve(argumentsList[++index] ?? '')
    else throw new Error(`Unknown smoke option: ${argument}`)
  }
  return options
}

/** 在限定时间内等待 sidecar 生命周期消息或进程错误。 */
function waitForReady(child, lines, timeoutMilliseconds = 60_000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finishReject(new Error(`Node sidecar did not become ready within ${timeoutMilliseconds}ms`)), timeoutMilliseconds)
    const finishResolve = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const finishReject = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    lines.on('line', line => {
      console.log(`[sidecar] ${line}`)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.type === 'ready') finishResolve(message)
      if (message.type === 'startup-failed') finishReject(new Error(`Harness startup failed: ${message.error?.message ?? 'unknown error'}`))
    })
    child.once('error', finishReject)
    child.once('exit', code => {
      if (!settled) finishReject(new Error(`Node sidecar exited before ready with code ${code ?? 'unknown'}`))
    })
  })
}

/** 等待 sidecar 发出 stopped 消息并退出，防止 smoke 留下 Harness 进程。 */
function stopSidecar(child, lines, timeoutMilliseconds = 15_000) {
  return new Promise((resolve, reject) => {
    let stopped = false
    let exited = false
    let settled = false
    const timer = setTimeout(() => finishReject(new Error(`Node sidecar did not stop within ${timeoutMilliseconds}ms`)), timeoutMilliseconds)
    const finishResolve = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const finishReject = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const maybeResolve = () => {
      if (stopped && exited) finishResolve()
    }
    lines.on('line', line => {
      console.log(`[sidecar] ${line}`)
      try {
        if (JSON.parse(line).type === 'stopped') stopped = true
      } catch {}
      maybeResolve()
    })
    child.once('error', finishReject)
    child.once('exit', code => {
      exited = true
      if (code !== 0 && code !== null) finishReject(new Error(`Node sidecar exited while stopping with code ${code}`))
      else maybeResolve()
    })
  })
}

/** 等待子进程确认退出，超时视为清理失败。 */
export function waitForChildExit(child, timeoutMilliseconds = 10_000) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      reject(new Error(`Node sidecar did not exit within ${timeoutMilliseconds}ms`))
    }, timeoutMilliseconds)
    /** 记录退出并清理计时器。 */
    function onExit() {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
  })
}

/** 强制终止 sidecar 整棵进程树并等待父进程确认退出。 */
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

/** 等待 Harness listener 确认停止接受连接。 */
export async function waitForListenerClosed(origin, timeoutMilliseconds = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMilliseconds) {
    if (!(await listenerAcceptsConnections(origin))) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Harness listener still accepts connections: ${new URL(origin).origin}`)
}

/** 用随项目下载的官方 Node 启动真实 Harness，并验证 loopback Web 响应。 */
async function runSmoke(options) {
  const target = getNodeTarget(platform(), arch())
  const nodePath = path.join(options.resourceRoot, 'node', target.resourceName, target.relativeExecutable)
  const workDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-node-smoke-'))
  const environment = { ...process.env }
  delete environment.DSH_NODE_PATH
  environment.DSH_HOME = path.join(workDirectory, 'harness-home')
  const child = spawn(nodePath, [options.sidecar], {
    cwd: workDirectory,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: platform() !== 'win32',
    windowsHide: true
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let stderr = ''
  let readyOrigin
  let cleanupConfirmed = false
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
  })
  try {
    const ready = await waitForReady(child, lines)
    if (typeof ready.origin !== 'string') throw new Error('Node sidecar ready message did not include an origin')
    readyOrigin = ready.origin
    const response = await fetch(ready.origin)
    if (!response.ok) throw new Error(`Harness smoke request returned HTTP ${response.status}`)
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Harness smoke response was not HTML')
    child.stdin.write('{"type":"stop"}\n')
    await stopSidecar(child, lines)
    await waitForListenerClosed(ready.origin)
    cleanupConfirmed = true
    console.log(`Official Node + Harness smoke passed for ${target.resourceName}`)
  } catch (error) {
    let cleanupError
    try {
      await terminateProcessTree(child)
      if (readyOrigin) await waitForListenerClosed(readyOrigin)
      cleanupConfirmed = true
    } catch (failure) {
      cleanupError = failure
    }
    const detail = stderr.trim()
    const cleanupDetail = cleanupError ? `\nCleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}` : ''
    throw new Error((error instanceof Error ? error.message : String(error)) + (detail ? '\n' + detail : '') + cleanupDetail)
  } finally {
    lines.close()
    if (cleanupConfirmed) await rm(workDirectory, { recursive: true, force: true })
  }
}

/** 直接执行 smoke 脚本并将失败交给 CI。 */
async function main() {
  await runSmoke(readOptions(process.argv.slice(2)))
}

/** 判断 smoke 脚本是否由 Node 直接执行。 */
function isDirectEntry() {
  return process.argv[1] !== undefined
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isDirectEntry()) await main()
