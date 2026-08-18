import {
  deserializeHostProcessError,
  parseHostProcessCommand,
  serializeHostProcessError,
  type HostProcessCommand,
  type HostProcessMessage
} from '../shared/host-process-contract.js'
import { emergencyExitHostProcess, type HostProcessEmergencySystem } from './emergency-exit.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 可被测试替换的 Host child 进程运行时依赖。 */
export interface HostProcessRuntime {
  bootHarnessHost(paths: { readonly harnessHome: string; readonly defaultWorkingDirectory: string }): Promise<{
    readonly origin: string
    readonly binding: { readonly host: '127.0.0.1'; readonly port: number }
    dispose(): Promise<void>
  }>
}

/** 已创建 Host Handle 的最小 child-side 类型别名。 */
type HostProcessHandle = Awaited<ReturnType<HostProcessRuntime['bootHarnessHost']>>

/** 记录 boot 已完成或失败，供 parent disconnect 继续等待同一个异步尝试。 */
type HostProcessBootOutcome =
  | { readonly kind: 'fulfilled'; readonly handle: HostProcessHandle }
  | { readonly kind: 'rejected'; readonly error: unknown }

/** Host child 进程所需的最小 IPC/进程接口。 */
export interface HostProcessSystem extends HostProcessEmergencySystem {
  readonly env: NodeJS.ProcessEnv
  cwd(): string
  readonly connected?: boolean
  send?(message: HostProcessMessage, callback?: (error?: Error | null) => void): void
  disconnect?(): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  exitCode: number
  readonly parentDisconnectTimeoutMs?: number
}

type HostProcessShutdownCause =
  | { readonly kind: 'normal' }
  | { readonly kind: 'startup-failed'; readonly error: unknown }

/** 启动 child runtime；真实 Harness runtime 只在此函数内动态载入。 */
export async function startHostProcess(
  runtime: HostProcessRuntime,
  system: HostProcessSystem = process as unknown as HostProcessSystem
): Promise<void> {
  if (typeof system.send !== 'function') throw new Error('Host process IPC is unavailable')
  let handle: HostProcessHandle | undefined
  let bootOutcome: Promise<HostProcessBootOutcome> | undefined
  let readySent = false
  let stopping: Promise<void> | undefined
  let disconnectedStopping: Promise<void> | undefined
  let disconnectedDeadline: number | undefined
  let parentDisconnected = false
  const pendingSendRejectors = new Set<(error: Error) => void>()

  // 将 IPC 回调转换为可取消的 Promise，避免父进程断开后悬挂发送。
  const send = (message: HostProcessMessage): Promise<void> => new Promise((resolve, reject) => {
    if (parentDisconnected || typeof system.send !== 'function') { reject(new Error('Host process IPC is unavailable')); return }
    pendingSendRejectors.add(reject)
    try {
      system.send(message, error => {
        pendingSendRejectors.delete(reject)
        if (error) reject(error)
        else resolve()
      })
    } catch (error) {
      pendingSendRejectors.delete(reject)
      reject(error)
    }
  })

  /** 统一处理 stop、父 IPC 消失和启动异常，确保已创建的 Handle 总会 dispose。 */
  const shutdown = (exitCode: number, cause: HostProcessShutdownCause = { kind: 'normal' }): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      let disposeError: unknown
      let disposeFailed = false
      let finalExitCode = exitCode
      try {
        await handle?.dispose()
      } catch (error) {
        disposeFailed = true
        disposeError = error
        if (cause.kind === 'normal') finalExitCode = 1
      }
      try {
        if (cause.kind === 'startup-failed' && !readySent && !parentDisconnected) {
          try { await send({ type: 'startup-failed', error: serializeHostProcessError(cause.error) }) } catch { /* parent may already be gone */ }
        } else if (disposeFailed && cause.kind === 'normal' && readySent && !parentDisconnected) {
          try { await send({ type: 'stop-failed', error: serializeHostProcessError(disposeError) }) } catch { /* parent may already be gone */ }
        } else if (finalExitCode === 0 && readySent && !parentDisconnected) {
          try { await send({ type: 'stopped' }) } catch { /* parent may already be gone */ }
        }
      } finally {
        system.exitCode = finalExitCode
        if (!parentDisconnected) system.disconnect?.()
        system.exit(finalExitCode)
      }
    })()
    return stopping
  }

  /** 父 IPC 断开时用独立预算等待 dispose，超时后自发清理整个 child 树。 */
  const shutdownAfterParentDisconnect = (): Promise<void> => {
    if (disconnectedStopping) return disconnectedStopping
    disconnectedStopping = (async () => {
      const timeoutMs = system.parentDisconnectTimeoutMs ?? 2_000
      const deadline = disconnectedDeadline ??= Date.now() + Math.max(0, timeoutMs)
      const boot = handle
        ? { kind: 'fulfilled' as const, handle }
        : await waitForBootWithDeadline(bootOutcome, deadline)
      if (!boot) {
        await emergencyExitHostProcess(system, remaining(deadline), deadline)
        return
      }
      if (boot.kind === 'rejected') {
        system.exitCode = 1
        system.exit(1)
        return
      }
      handle = boot.handle
      const disposed = await disposeWithDeadline(handle, deadline)
      if (!disposed) {
        await emergencyExitHostProcess(system, remaining(deadline), deadline)
        return
      }
      system.exitCode = 0
      system.exit(0)
    })()
    return disconnectedStopping
  }

  // 父进程消失时不能保留真实 Harness 及其监听器。
  system.on('disconnect', () => {
    parentDisconnected = true
    for (const reject of pendingSendRejectors) reject(new Error('Host parent IPC disconnected'))
    pendingSendRejectors.clear()
    const emergencyShutdown = shutdownAfterParentDisconnect()
    if (!stopping) stopping = emergencyShutdown
    void emergencyShutdown
  })
  system.on('message', message => {
    let command: HostProcessCommand
    try { command = parseHostProcessCommand(message) }
    catch { return }
    if (command.type === 'stop') void shutdown(0)
  })

  // 先记录 boot promise，再开始 await，使 disconnect 能等待同一轮真实 boot。
  bootOutcome = Promise.resolve()
    .then(() => runtime.bootHarnessHost({
      harnessHome: system.env.DSH_HOME ?? '',
      defaultWorkingDirectory: system.cwd()
    }))
    .then(
      created => {
        handle = created
        return { kind: 'fulfilled' as const, handle: created }
      },
      error => ({ kind: 'rejected' as const, error })
    )

  try {
    // spawn 的 cwd/env 已在 child 创建时设定；这里首次动态加载真实 Harness。
    const boot = await bootOutcome
    if (boot === undefined) throw new Error('Host boot was not started')
    if (boot.kind === 'rejected') throw boot.error
    handle = boot.handle
    if (stopping || parentDisconnected) {
      if (parentDisconnected) {
        await disconnectedStopping
      } else {
        await handle.dispose().catch(() => undefined)
      }
      return
    }
    await send({ type: 'ready', origin: handle.origin, binding: handle.binding })
    readySent = true
  } catch (error) {
    await shutdown(1, { kind: 'startup-failed', error })
  }
}

/** 在 disconnect 的绝对 deadline 内等待 boot outcome，超时返回 undefined。 */
async function waitForBootWithDeadline(
  boot: Promise<HostProcessBootOutcome> | undefined,
  deadline: number
): Promise<HostProcessBootOutcome | undefined> {
  if (!boot) return undefined
  const timeoutMs = Math.max(0, deadline - Date.now())
  if (timeoutMs <= 0) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      boot,
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs) })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 在有限时间内等待已创建 Host Handle 的 dispose，避免父 IPC 消失后悬挂。 */
async function disposeWithDeadline(
  handle: Awaited<ReturnType<HostProcessRuntime['bootHarnessHost']>> | undefined,
  deadline: number
): Promise<boolean> {
  if (!handle) return true
  const disposal = Promise.resolve().then(() => handle.dispose()).then(() => true, () => false)
  const timeoutMs = Math.max(0, deadline - Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      disposal,
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)) })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 计算父 IPC 断开 emergency deadline 尚余的清理预算。 */
function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

/** 仅在 Electron 启动的真实 Host child 中延迟加载 Harness runtime。 */
async function main(): Promise<void> {
  // 把动态 import 放进 boot seam，使模块解析失败也能通过 startup-failed 协议返回。
  await startHostProcess({
    bootHarnessHost: async paths => {
      const runtime = await import('./runtime.js')
      return runtime.bootHarnessHost(paths)
    }
  })
}

/** 只在该文件被 child_process 直接执行时启动真实 Host。 */
function isDirectEntry(): boolean {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectEntry()) {
  void main().catch(error => {
    // main() 失败可能发生在 IPC 已经不可用时，只允许受控错误流出。
    const message = deserializeHostProcessError(serializeHostProcessError(error))
    process.stderr.write(`${message.name}: ${message.message}\n`)
    process.exitCode = 1
  })
}
