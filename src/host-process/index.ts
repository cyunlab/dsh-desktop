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
  let handle: Awaited<ReturnType<HostProcessRuntime['bootHarnessHost']>> | undefined
  let readySent = false
  let stopping: Promise<void> | undefined
  let disconnectedStopping: Promise<void> | undefined
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
      try {
        await handle?.dispose()
      } catch {
        // 退出路径不能把 child 留在 Harness 状态；原始错误通过受控协议报告。
      }
      try {
        if (cause.kind === 'startup-failed' && !readySent && !parentDisconnected) {
          try { await send({ type: 'startup-failed', error: serializeHostProcessError(cause.error) }) } catch { /* parent may already be gone */ }
        } else if (exitCode === 0 && readySent && !parentDisconnected) {
          try { await send({ type: 'stopped' }) } catch { /* parent may already be gone */ }
        }
      } finally {
        system.exitCode = exitCode
        if (!parentDisconnected) system.disconnect?.()
        system.exit(exitCode)
      }
    })()
    return stopping
  }

  /** 父 IPC 断开时用独立预算等待 dispose，超时后自发清理整个 child 树。 */
  const shutdownAfterParentDisconnect = (): Promise<void> => {
    if (disconnectedStopping) return disconnectedStopping
    disconnectedStopping = (async () => {
      const timeoutMs = system.parentDisconnectTimeoutMs ?? 2_000
      const disposed = await disposeWithTimeout(handle, timeoutMs)
      if (!disposed) {
        await emergencyExitHostProcess(system, timeoutMs)
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

  try {
    // spawn 的 cwd/env 已在 child 创建时设定；这里首次动态加载真实 Harness。
    handle = await runtime.bootHarnessHost({
      harnessHome: system.env.DSH_HOME ?? '',
      defaultWorkingDirectory: system.cwd()
    })
    if (stopping || parentDisconnected) {
      if (parentDisconnected) {
        const disposed = await disposeWithTimeout(handle, system.parentDisconnectTimeoutMs ?? 2_000)
        if (!disposed) await emergencyExitHostProcess(system, system.parentDisconnectTimeoutMs ?? 2_000)
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

/** 在有限时间内等待已创建 Host Handle 的 dispose，避免父 IPC 消失后悬挂。 */
async function disposeWithTimeout(
  handle: Awaited<ReturnType<HostProcessRuntime['bootHarnessHost']>> | undefined,
  timeoutMs: number
): Promise<boolean> {
  if (!handle) return true
  const disposal = Promise.resolve().then(() => handle.dispose()).then(() => true, () => false)
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
