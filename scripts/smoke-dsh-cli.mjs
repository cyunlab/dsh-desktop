import { spawn } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import path from 'node:path'
import { createConnection } from 'node:net'
import { pathToFileURL } from 'node:url'
import { getNodeTarget, withDirectoryLock } from './ensure-official-node.mjs'
import { packagedDshCliCommand } from './runtime-closure.mjs'

const root = path.resolve(import.meta.dirname, '..')
const MAX_HTML_BYTES = 64 * 1024
const WINDOWS_COMMAND_TIMEOUT_MS = 2_000
const DEFAULT_WINDOWS_CONTROLLER_START_TIMEOUT_MS = 60_000
const MAX_WINDOWS_CONTROLLER_ERROR_BYTES = 4 * 1024
const WINDOWS_JOB_CONTROLLER = path.join(root, 'scripts', 'windows-job-controller.ps1')
export const FIXED_HOST_ORIGIN = 'http://127.0.0.1:3080/'
const DESKTOP_UPDATE_PACKAGE = '@cyunlab/dsh-desktop-update-client'
const DESKTOP_UPDATE_PATCH = path.join(DESKTOP_UPDATE_PACKAGE, 'cordis.patch.yml')
const DESKTOP_UPDATE_ENTRY = path.join(DESKTOP_UPDATE_PACKAGE, 'lib', 'index.js')
const MATERIALIZED_PATCH_DIRECTORY = path.join('.dsh-desktop', 'runtime')
const EXPECTED_DESKTOP_UPDATE_PATCH = "# Desktop-owned overlay mounted by the native shell through `dsh web --patch`.\n- insert:\n    - id: dsh-desktop-update-client\n      name: '@cyunlab/dsh-desktop-update-client'\n"

/** 解析 verified runtime closure 内不经过 symlink 的普通文件。 */
function resolveClosureFile(nodeModulesRoot, relativePath, label) {
  const closureRoot = realpathSync(nodeModulesRoot)
  let cursor = closureRoot
  for (const component of relativePath.split(/[\\/]+/)) {
    cursor = path.join(cursor, component)
    const metadata = lstatSync(cursor)
    if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
  }
  const resolved = realpathSync(cursor)
  if (resolved !== closureRoot && !resolved.startsWith(closureRoot + path.sep)) throw new Error(`${label} escapes the runtime closure`)
  if (!lstatSync(resolved).isFile()) throw new Error(`${label} must be a regular file`)
  return resolved
}

/** 在 isolated Harness Home 中创建并验证 Desktop 私有物化目录。 */
function resolveMaterializedPatchDirectory(harnessHome) {
  if (existsSync(harnessHome) && lstatSync(harnessHome).isSymbolicLink()) throw new Error('Harness Home must not be a symbolic link')
  mkdirSync(harnessHome, { recursive: true })
  const home = realpathSync(harnessHome)
  let cursor = home
  for (const component of MATERIALIZED_PATCH_DIRECTORY.split(path.sep)) {
    cursor = path.join(cursor, component)
    if (existsSync(cursor)) {
      const metadata = lstatSync(cursor)
      if (metadata.isSymbolicLink()) throw new Error('Desktop materialized patch directory must not be a symbolic link')
      if (!metadata.isDirectory()) throw new Error('Desktop materialized patch directory must be a directory')
    } else mkdirSync(cursor, { mode: 0o700 })
  }
  const resolved = realpathSync(cursor)
  if (!resolved.startsWith(home + path.sep)) throw new Error('Desktop materialized patch directory escapes Harness Home')
  return resolved
}

/** 只替换 package-owned patch 中唯一精确的 Desktop Client bare specifier。 */
function materializeDesktopUpdatePatch(nodeModulesRoot, harnessHome) {
  const sourcePatch = resolveClosureFile(nodeModulesRoot, DESKTOP_UPDATE_PATCH, 'Desktop update patch')
  const clientEntry = resolveClosureFile(nodeModulesRoot, DESKTOP_UPDATE_ENTRY, 'Desktop update client entry')
  const source = readFileSync(sourcePatch, 'utf8')
  if (source !== EXPECTED_DESKTOP_UPDATE_PATCH) {
    throw new Error('Desktop update patch must match the trusted package-owned composition contract')
  }
  const outputDirectory = resolveMaterializedPatchDirectory(harnessHome)
  const output = path.join(outputDirectory, 'cordis.patch.yml')
  if (existsSync(output)) {
    const metadata = lstatSync(output)
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('Desktop materialized patch output must be a regular file')
    rmSync(output)
  }
  const temporary = path.join(outputDirectory, `.desktop-update-client.${process.pid}.${Date.now()}.tmp`)
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    const clientUrl = pathToFileURL(clientEntry).href
    const materialized = source.replace(`'${DESKTOP_UPDATE_PACKAGE}'`, `'${clientUrl}'`)
    writeFileSync(descriptor, materialized, 'utf8')
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, output)
  return output
}

/** 构造带 Desktop 私有 composition patch 的正式 direct Web 参数。 */
export function directDshWebArgs(nodeModulesRoot, harnessHome) {
  return Object.freeze([
    'web',
    '--patch',
    materializeDesktopUpdatePatch(nodeModulesRoot, harnessHome),
    '--host', '127.0.0.1', '--port', '3080'
  ])
}

/** 从环境变量读取正整数毫秒值，无效配置立即失败。 */
export function readPositiveMilliseconds(value, fallback, variableName) {
  if (value === undefined || value === '') return fallback
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(`${variableName} must be a positive integer`)
  }
  return milliseconds
}

/** 将 controller 退出状态与有界 stderr 合并为可诊断错误。 */
export function formatWindowsControllerExitError(code, signal, stderr) {
  const status = code ?? signal ?? 'unknown'
  const detail = stderr.trim().replace(/[\r\n\t]+/g, ' ').slice(-MAX_WINDOWS_CONTROLLER_ERROR_BYTES)
  return `Windows Job controller exited with ${status}${detail ? `: ${detail}` : ''}`
}

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

/** 为 Job controller 的单次命令施加 deadline，controller 卡死不得拖住验收。 */
async function requestWindowsController(ownership, command, timeoutMilliseconds = WINDOWS_COMMAND_TIMEOUT_MS) {
  if (!ownership.windowsController) throw new Error('Windows Job controller is unavailable')
  let timer
  try {
    return await Promise.race([
      ownership.windowsController.request(command, timeoutMilliseconds),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Windows Job controller ${command} exceeded ${timeoutMilliseconds}ms`)), timeoutMilliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 建立由原生 Job handle 持有的 Windows ownership，或 POSIX detached PGID ownership。 */
export function ownProcessTree(child, options = {}) {
  return Object.freeze({
    rootPid: options.rootPid ?? (Number.isInteger(child.pid) ? child.pid : undefined),
    platformName: options.platformName ?? platform(),
    windowsController: options.windowsController,
    controllerProcess: options.controllerProcess
  })
}

/** 构造 Windows Job controller 参数，并保持 packaged executable、argv 与 cwd 原样可验证。 */
export function windowsJobControllerArguments(command, workDirectory) {
  return Object.freeze([
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    WINDOWS_JOB_CONTROLLER,
    '-Executable',
    command.executable,
    '-ArgumentsBase64',
    Buffer.from(JSON.stringify(command.args), 'utf8').toString('base64'),
    '-WorkingDirectory',
    workDirectory
  ])
}

/** 将 Windows Job controller stdout 封装成带 request id 与 deadline 的行协议。 */
function createWindowsControllerTransport(child) {
  let buffer = ''
  let stderr = ''
  let nextRequestId = 1
  let readySettled = false
  let resolveReady
  let rejectReady
  const pending = new Map()
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  /** 拒绝所有未完成请求，controller failure 必须显式进入 cleanup。 */
  function rejectAll(error) {
    if (!readySettled) {
      readySettled = true
      rejectReady(error)
    }
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  /** 解析 controller 的 READY 或带 request id 的响应行。 */
  function consumeLine(line) {
    const readyMatch = /^READY (\d+)$/.exec(line)
    if (readyMatch && !readySettled) {
      readySettled = true
      resolveReady(Number(readyMatch[1]))
      return
    }
    const response = /^(\d+) (OK|ERROR)(?: (.*))?$/.exec(line)
    if (!response) return
    const request = pending.get(Number(response[1]))
    if (!request) return
    pending.delete(Number(response[1]))
    clearTimeout(request.timer)
    if (response[2] === 'ERROR') request.reject(new Error(response[3] || 'Windows Job controller failed'))
    else request.resolve(Number(response[3] ?? 0))
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) consumeLine(line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk}`.slice(-MAX_WINDOWS_CONTROLLER_ERROR_BYTES)
  })
  child.once('error', error => rejectAll(new Error(`Windows Job controller spawn failed: ${error.message}`)))
  child.once('exit', (code, signal) => rejectAll(new Error(formatWindowsControllerExitError(code, signal, stderr))))
  return Object.freeze({
    /** 等待 suspended root 已成功加入 Job 后才允许 verifier 继续。 */
    async ready(timeoutMilliseconds) {
      let timer
      try {
        return await Promise.race([
          ready,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Windows Job controller readiness timed out')), timeoutMilliseconds) })
        ])
      } finally {
        clearTimeout(timer)
      }
    },
    /** 向 controller 发一条命令并等待同 request id 的有界响应。 */
    request(command, timeoutMilliseconds) {
      return new Promise((resolve, reject) => {
        const id = nextRequestId++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Windows Job controller ${command} exceeded ${timeoutMilliseconds}ms`))
        }, timeoutMilliseconds)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(`${id} ${command}\n`, error => {
          if (!error) return
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        })
      })
    }
  })
}

/** 直接启动 POSIX CLI，或让 Windows controller 在 suspended 状态下先绑定 Job。 */
async function spawnOwnedCli(command, workDirectory) {
  if (platform() !== 'win32') {
    const child = spawn(command.executable, command.args, {
      cwd: workDirectory,
      env: command.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true
    })
    return { child, ownership: ownProcessTree(child) }
  }
  const controller = spawn('powershell.exe', windowsJobControllerArguments(command, workDirectory), {
    cwd: workDirectory,
    env: command.environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const transport = createWindowsControllerTransport(controller)
  try {
    const startTimeoutMilliseconds = readPositiveMilliseconds(
      process.env.DSH_WINDOWS_CONTROLLER_START_TIMEOUT_MS,
      DEFAULT_WINDOWS_CONTROLLER_START_TIMEOUT_MS,
      'DSH_WINDOWS_CONTROLLER_START_TIMEOUT_MS'
    )
    const rootPid = await transport.ready(startTimeoutMilliseconds)
    return {
      child: controller,
      ownership: ownProcessTree(controller, {
        rootPid,
        platformName: 'win32',
        windowsController: transport,
        controllerProcess: controller
      })
    }
  } catch (error) {
    controller.kill('SIGKILL')
    await waitForChildExit(controller, WINDOWS_COMMAND_TIMEOUT_MS).catch(() => {})
    throw error
  }
}

/** 返回 owned process group 或 Windows descendant 集是否已经完全消失。 */
export async function processTreeHasExited(ownership, timeoutMilliseconds = WINDOWS_COMMAND_TIMEOUT_MS) {
  if (!Number.isInteger(ownership.rootPid)) return true
  if (ownership.platformName === 'win32') {
    if (ownership.controllerProcess?.exitCode != null || ownership.controllerProcess?.signalCode != null) return true
    return await requestWindowsController(ownership, 'STATUS', timeoutMilliseconds) === 0
  }
  try {
    process.kill(-ownership.rootPid, 0)
    return false
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return false
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
  if (child.pid === undefined) return
  const deadline = Date.now() + timeoutMilliseconds
  try {
    if (ownership.platformName === 'win32') {
      await requestWindowsController(ownership, 'FORCE', Math.max(1, deadline - Date.now()))
    } else {
      try {
        process.kill(-ownership.rootPid, 'SIGKILL')
      } catch (error) {
        throw new Error(`Cannot force POSIX process group ${ownership.rootPid}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } catch (error) {
    if (ownership.platformName === 'win32') {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await waitForChildExit(child, Math.max(1, deadline - Date.now()))
      return
    }
    const expectedTransition = error instanceof Error && 'code' in error
      && (error.code === 'ESRCH' || error.code === 'EPERM')
    const alreadyExited = await processTreeHasExited(ownership).catch(() => false)
    if (!alreadyExited && !expectedTransition) throw error
  }
  await waitForProcessTreeExit(ownership, Math.max(1, deadline - Date.now()))
  if (ownership.platformName === 'win32' && child.exitCode === null && child.signalCode === null) {
    await requestWindowsController(ownership, 'EXIT', Math.max(1, deadline - Date.now()))
  }
  await waitForChildExit(child, Math.max(1, deadline - Date.now()))
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
      if (options.ownership?.platformName === 'win32' && await processTreeHasExited(
        options.ownership,
        Math.min(WINDOWS_COMMAND_TIMEOUT_MS, Math.max(1, timeoutMilliseconds - (Date.now() - started)))
      )) {
        throw new Error('Packaged dsh CLI exited before HTML readiness with Windows Job active count 0')
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
export async function stopCliProcess(child, ownership, timeoutMilliseconds = 8_000) {
  if (await processTreeHasExited(ownership)) return
  if (ownership.platformName !== 'win32') {
    try {
      process.kill(child.pid, 'SIGTERM')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        throw new Error(`Cannot signal POSIX CLI leader ${child.pid}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  try {
    if (ownership.platformName === 'win32') {
      await requestWindowsController(ownership, 'STOP', Math.min(WINDOWS_COMMAND_TIMEOUT_MS, timeoutMilliseconds))
    }
    await waitForProcessTreeExit(ownership, timeoutMilliseconds)
    if (ownership.platformName === 'win32' && child.exitCode === null && child.signalCode === null) {
      await requestWindowsController(ownership, 'EXIT', WINDOWS_COMMAND_TIMEOUT_MS)
      await waitForChildExit(child, WINDOWS_COMMAND_TIMEOUT_MS)
    } else {
      await waitForChildExit(child, timeoutMilliseconds)
    }
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
      args: directDshWebArgs(options.nodeModulesRoot, environment.DSH_HOME),
      environment
    })
    const { child, ownership } = await spawnOwnedCli(command, workDirectory)
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000) })
    if (ownership.platformName !== 'win32') child.stdout.resume()
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
