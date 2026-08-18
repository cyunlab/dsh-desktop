import {
  deserializeHostProcessError,
  parseHostProcessCommand,
  serializeHostProcessError,
  type HostProcessCommand,
  type HostProcessMessage
} from '../shared/host-process-contract.js'

/** 可被测试替换的 Host child 进程运行时依赖。 */
export interface HostProcessRuntime {
  bootHarnessHost(paths: { readonly harnessHome: string; readonly defaultWorkingDirectory: string }): Promise<{
    readonly origin: string
    readonly binding: { readonly host: '127.0.0.1'; readonly port: number }
    dispose(): Promise<void>
  }>
}

/** Host child 进程所需的最小 IPC/进程接口。 */
export interface HostProcessSystem {
  readonly env: NodeJS.ProcessEnv
  cwd(): string
  readonly connected?: boolean
  send?(message: HostProcessMessage, callback?: (error?: Error | null) => void): void
  disconnect?(): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  exitCode: number
  exit(code?: number): never
}

/** 启动 child runtime；真实 Harness runtime 只在此函数内动态载入。 */
export async function startHostProcess(
  runtime: HostProcessRuntime,
  system: HostProcessSystem = process as unknown as HostProcessSystem
): Promise<void> {
  if (typeof system.send !== 'function') throw new Error('Host process IPC is unavailable')
  let handle: Awaited<ReturnType<HostProcessRuntime['bootHarnessHost']>> | undefined
  let readySent = false
  let stopping: Promise<void> | undefined
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
  const shutdown = (exitCode: number, startupError?: unknown): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      try {
        await handle?.dispose()
      } catch {
        // 退出路径不能把 child 留在 Harness 状态；原始错误通过受控协议报告。
      }
      try {
        if (startupError !== undefined && !readySent && !parentDisconnected) {
          try { await send({ type: 'startup-failed', error: serializeHostProcessError(startupError) }) } catch { /* parent may already be gone */ }
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

  // 父进程消失时不能保留真实 Harness 及其监听器。
  system.on('disconnect', () => {
    parentDisconnected = true
    for (const reject of pendingSendRejectors) reject(new Error('Host parent IPC disconnected'))
    pendingSendRejectors.clear()
    void shutdown(0)
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
      await handle.dispose().catch(() => undefined)
      return
    }
    await send({ type: 'ready', origin: handle.origin, binding: handle.binding })
    readySent = true
  } catch (error) {
    await shutdown(1, error)
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

void main().catch(error => {
  // main() 失败可能发生在 IPC 已经不可用时，只允许受控错误流出。
  const message = deserializeHostProcessError(serializeHostProcessError(error))
  process.stderr.write(`${message.name}: ${message.message}\n`)
  process.exitCode = 1
})
