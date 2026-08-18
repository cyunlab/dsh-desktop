import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { DesktopPaths } from '../paths.js'
import {
  deserializeHostProcessError,
  parseHostProcessMessage,
  type HostProcessBinding,
  type HostProcessMessage
} from '../../shared/host-process-contract.js'
import type { HostClosedEvent, HostHandle, HostLauncher } from './launcher.js'
import { waitForHttpReady, type ReadinessOptions } from './readiness.js'
import { terminateChildProcess, type ProcessTreeTerminationOptions } from './process-tree.js'

/** 生产 Host 进程 adapter 的可替换依赖和超时配置。 */
export interface ProcessHostLauncherOptions {
  readonly readiness?: ReadinessOptions
  readonly startupTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly hostEntry?: string
  readonly spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  readonly maxDiagnosticBytes?: number
  readonly onDiagnosticOutput?: (stream: 'stdout' | 'stderr', output: string) => void
  readonly processTree?: ProcessTreeTerminationOptions
}

/** 通过独立 Electron-as-Node child 启动真实 Harness Host。 */
export class ProcessHostLauncher implements HostLauncher {
  readonly #options: ProcessHostLauncherOptions

  /** 创建带有可配置 readiness/shutdown 边界的生产 launcher。 */
  constructor(options: ProcessHostLauncherOptions = {}) {
    this.#options = options
  }

  /** 创建隔离 child，等待受控 ready IPC 和 HTTP readiness 后返回句柄。 */
  async launch(paths: DesktopPaths): Promise<HostHandle> {
    const hostEntry = this.#options.hostEntry ?? resolveHostEntry()
    const child = (this.#options.spawnProcess ?? spawn)(process.execPath, [hostEntry], {
      cwd: paths.defaultWorkingDirectory,
      env: {
        ...process.env,
        DSH_HOME: paths.harnessHome,
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32'
    })
    const outputCleanup = consumeOutput(child, this.#options)
    const controller = new ProcessHostController(child, this.#options, outputCleanup)
    try {
      await controller.waitUntilReady(paths)
      return controller
    } catch (error) {
      await controller.abortStartup().catch(() => undefined)
      throw error
    }
  }
}

/** 解析 dist/main/index.js 相邻的 host-process/index.js，兼容源码和打包路径。 */
export function resolveHostEntry(moduleUrl = import.meta.url): string {
  const source = fileURLToPath(moduleUrl)
  const directory = path.dirname(source)
  if (source.endsWith(`${path.sep}src${path.sep}main${path.sep}host${path.sep}process-launcher.ts`)) {
    const developmentEntry = path.resolve(directory, '..', '..', '..', 'dist', 'host-process', 'index.js')
    if (existsSync(developmentEntry)) return developmentEntry
  }
  const entry = path.basename(directory) === 'main'
    ? path.resolve(directory, '..', 'host-process', 'index.js')
    : path.resolve(directory, '..', '..', 'host-process', 'index.js')
  return mapAsarToUnpacked(entry)
}

/** 将已解包的 Host entry 从 ASAR 逻辑路径映射到实际文件。 */
function mapAsarToUnpacked(value: string): string {
  const marker = `${path.sep}app.asar${path.sep}`
  return value.includes(marker) ? value.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`) : value
}

/** 绑定有界 stdout/stderr 诊断监听并返回可重复调用的清理函数。 */
function consumeOutput(child: ChildProcess, options: ProcessHostLauncherOptions): () => void {
  const maxBytes = options.maxDiagnosticBytes ?? 8 * 1024
  const cleanups: Array<() => void> = []
  for (const [streamName, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
    if (!stream) continue
    let bytes = 0
    let notified = false
    stream.setEncoding('utf8')
    const onData = (chunk: string): void => {
      const remaining = Math.max(0, maxBytes - bytes)
      const text = Buffer.from(chunk).subarray(0, remaining).toString('utf8')
      bytes += Buffer.byteLength(text)
      if (text && options.onDiagnosticOutput) options.onDiagnosticOutput(streamName, text)
      if (bytes >= maxBytes && !notified) {
        notified = true
        options.onDiagnosticOutput?.(streamName, '[diagnostic output truncated]')
      }
    }
    stream.on('data', onData)
    cleanups.push(() => stream.off('data', onData))
  }
  let cleaned = false
  return () => {
    if (cleaned) return
    cleaned = true
    for (const cleanup of cleanups) cleanup()
  }
}

/** 独立 Host child 生命周期的内部状态机。 */
class ProcessHostController implements HostHandle {
  readonly #child: ChildProcess
  readonly #options: ProcessHostLauncherOptions
  readonly #cleanupOutput: () => void
  readonly #ready = deferred<ReadyMessage>()
  readonly #failed = deferred<never>()
  readonly #stopped = deferred<void>()
  readonly #closed = deferred<HostClosedEvent>()
  readonly #readinessAbort = new AbortController()
  #phase: 'starting' | 'ready' | 'closed' = 'starting'
  #intentional = false
  #disposePromise?: Promise<void>
  #closeEvent?: HostClosedEvent
  #treeTermination?: Promise<void>
  #binding?: HostProcessBinding
  #origin?: string

  /** 绑定 IPC 与 ChildProcess 事件，尚未向调用者暴露句柄。 */
  constructor(child: ChildProcess, options: ProcessHostLauncherOptions, cleanupOutput: () => void) {
    this.#child = child
    this.#options = options
    this.#cleanupOutput = cleanupOutput
    child.on('message', this.#onMessage)
    child.once('exit', this.#onExit)
    child.once('error', this.#onError)
  }

  get origin(): string {
    if (!this.#origin) throw new Error('Host is not ready')
    return this.#origin
  }

  get binding(): HostProcessBinding | undefined { return this.#binding }

  /** ready 后的关闭结果；intentional=false 表示 Host 意外失效。 */
  readonly closed = this.#closed.promise

  /** 等待 child ready 和 HTTP readiness，超时只影响本次启动尝试。 */
  async waitUntilReady(paths: DesktopPaths): Promise<void> {
    const timeoutMs = this.#options.startupTimeoutMs ?? this.#options.readiness?.timeoutMs ?? 120_000
    const ready = await withTimeout(
      Promise.race([this.#ready.promise, this.#failed.promise]),
      timeoutMs,
      `Host did not become ready within ${timeoutMs} ms`
    )
    await Promise.race([
      waitForHttpReady(ready.origin, {
        ...this.#options.readiness,
        timeoutMs: this.#options.readiness?.timeoutMs ?? timeoutMs,
        signal: this.#readinessAbort.signal
      }),
      this.#failed.promise
    ])
    if (this.#phase !== 'starting') throw new Error('Host exited before readiness completed')
    this.#phase = 'ready'
    void paths
  }

  /** 启动失败时终止本次 child 并释放所有启动监听。 */
  async abortStartup(): Promise<void> {
    if (this.#closeEvent) {
      const deadline = Date.now() + (this.#options.shutdownTimeoutMs ?? 30_000)
      await this.#waitForTreeTermination(deadline)
      return
    }
    this.#intentional = true
    const deadline = Date.now() + (this.#options.shutdownTimeoutMs ?? 30_000)
    try {
      await this.#terminateWithin(deadline)
    } finally {
      this.#phase = 'closed'
      this.#cleanupListeners()
      if (!this.#closeEvent) this.#closed.resolve({ intentional: true })
    }
  }

  /** 幂等发送 stop，并等待 stopped/exit；超时后安全终止 child。 */
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposePromise = this.#dispose()
    return this.#disposePromise
  }

  /** 执行一次有界的 Host child 优雅关闭。 */
  async #dispose(): Promise<void> {
    if (this.#closeEvent) {
      const deadline = Date.now() + (this.#options.shutdownTimeoutMs ?? 30_000)
      await this.#waitForTreeTermination(deadline)
      return
    }
    this.#intentional = true
    const timeoutMs = this.#options.shutdownTimeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    try {
      if (this.#phase !== 'closed' && this.#child.connected) {
        const stopSent = await withTimeout(
          sendCommand(this.#child, { type: 'stop' }, remaining(deadline)),
          remaining(deadline),
          'Host stop IPC did not settle within the shutdown budget'
        ).then(() => true).catch(() => false)
        if (!stopSent) {
          await this.#terminateWithin(deadline)
          return
        }
      }
      const firstSettlement = await withTimeout(
        Promise.race([
          this.#stopped.promise.then(() => 'stopped' as const),
          this.#closed.promise.then(() => 'closed' as const)
        ]),
        remaining(deadline),
        `Host shutdown exceeded ${timeoutMs} ms`
      ).catch(() => undefined)
      const exitSettlement = firstSettlement === 'stopped'
        ? await withTimeout(this.#closed.promise, remaining(deadline), 'Host child did not exit after stopped').catch(() => undefined)
        : firstSettlement
      if (!exitSettlement) {
        await this.#terminateWithin(deadline)
        await withTimeout(this.#closed.promise, remaining(deadline), 'Host child did not report exit').catch(() => undefined)
      }
    } finally {
      if (!this.#closeEvent) {
        this.#phase = 'closed'
        this.#cleanupListeners()
        this.#closed.resolve({ intentional: true })
      }
    }
  }

  /** 处理 child -> parent 协议消息并阻止未知对象进入生命周期。 */
  #onMessage = (raw: unknown): void => {
    let message: HostProcessMessage
    try { message = parseHostProcessMessage(raw) }
    catch {
      this.#fail(new Error('Host child sent an invalid IPC message'))
      return
    }
    if (message.type === 'ready') {
      if (this.#phase !== 'starting') return
      this.#origin = message.origin
      this.#binding = message.binding
      this.#ready.resolve(message)
    } else if (message.type === 'startup-failed') {
      this.#fail(deserializeHostProcessError(message.error))
    } else if (message.type === 'stopped') {
      if (this.#intentional) this.#stopped.resolve()
    }
  }

  /** 将 child error 转换为启动失败或意外关闭结果。 */
  #onError = (error: Error): void => {
    if (this.#phase === 'starting') this.#fail(error)
    else if (!this.#intentional) {
      this.#abortReadiness(error)
      this.#startUnexpectedTermination()
      this.#settleClosed({ intentional: false, error })
    }
  }

  /** 将 child exit 转换为启动拒绝或可观察的 Host 关闭事件。 */
  #onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    const wasStarting = this.#phase === 'starting'
    const event: HostClosedEvent = {
      intentional: this.#intentional,
      ...(code === null ? {} : { code }),
      ...(signal === null ? {} : { signal }),
      ...(!this.#intentional
        ? { error: new Error(`Host child exited with ${code ?? signal ?? 'unknown'}`) }
        : {})
    }
    if (wasStarting) this.#fail(event.error ?? new Error('Host child exited before readiness'))
    if (!this.#intentional) {
      this.#abortReadiness(event.error)
      this.#startUnexpectedTermination()
    }
    this.#settleClosed(event)
  }

  /** 只结算一次启动失败，避免 error/exit 竞态重复处理。 */
  #fail(error: Error): void {
    if (this.#phase !== 'starting') return
    this.#abortReadiness(error)
    this.#failed.reject(error)
  }

  /** 取消正在进行的 HTTP readiness，避免 child 失败后继续轮询。 */
  #abortReadiness(reason?: unknown): void {
    if (!this.#readinessAbort.signal.aborted) this.#readinessAbort.abort(reason)
  }

  /** 启动一次有界的意外 Host 进程树清理。 */
  #startUnexpectedTermination(): void {
    if (this.#treeTermination) return
    const timeoutMs = this.#options.shutdownTimeoutMs ?? 30_000
    this.#treeTermination = terminateChildProcess(
      this.#child,
      timeoutMs,
      { ...this.#options.processTree, deadline: Date.now() + timeoutMs }
    ).catch(() => undefined)
  }

  /** 按调用方截止时间启动一次强制进程树清理。 */
  #terminateWithin(deadline: number): Promise<void> {
    if (this.#treeTermination) return this.#treeTermination
    this.#treeTermination = terminateChildProcess(this.#child, remaining(deadline), {
      ...this.#options.processTree,
      deadline
    })
    return this.#treeTermination
  }

  /** 在调用方的 shutdown 预算内等待已经开始的进程树清理。 */
  async #waitForTreeTermination(deadline: number): Promise<void> {
    if (!this.#treeTermination) return
    await withTimeout(this.#treeTermination, remaining(deadline), 'Host process tree cleanup exceeded the shutdown budget')
      .catch(() => undefined)
  }

  /** 只结算一次 closed，并清理所有 parent-side child/stream listeners。 */
  #settleClosed(event: HostClosedEvent): void {
    if (this.#closeEvent) return
    this.#closeEvent = event
    this.#phase = 'closed'
    this.#cleanupListeners()
    this.#closed.resolve(event)
  }

  /** 从 child 和 stdout/stderr 移除本 adapter 注册的监听器。 */
  #cleanupListeners(): void {
    this.#abortReadiness(new Error('Host readiness was cancelled'))
    this.#child.off('message', this.#onMessage)
    this.#child.off('exit', this.#onExit)
    this.#child.off('error', this.#onError)
    this.#cleanupOutput()
  }
}

type ReadyMessage = Extract<HostProcessMessage, { type: 'ready' }>

/** 创建只结算一次的异步 deferred。 */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** 给 readiness/关闭操作增加可配置的超时边界。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(new Error(message))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 向已连接 child 发送受控 stop 命令。 */
function sendCommand(child: ChildProcess, command: { readonly type: 'stop' }, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || !child.send) { reject(new Error('Host child IPC is disconnected')); return }
    let settled = false
    const finish = (error?: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('Host stop IPC did not settle')), Math.max(0, timeoutMs))
    try {
      child.send(command, finish)
    } catch (error) {
      finish(error as Error)
    }
  })
}

/** 计算 launcher shutdown 截止时间的剩余预算。 */
function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}
