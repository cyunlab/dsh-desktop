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
  let ready = false
  let stopping: Promise<void> | undefined
  let parentDisconnected = false

  const send = (message: HostProcessMessage): Promise<void> => new Promise((resolve, reject) => {
    if (typeof system.send !== 'function') { reject(new Error('Host process IPC is unavailable')); return }
    system.send(message, error => error ? reject(error) : resolve())
  })

  const disposeAndExit = async (exitCode: number): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      try { await handle?.dispose() } finally {
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
    void disposeAndExit(0)
  })
  system.on('message', message => {
    let command: HostProcessCommand
    try { command = parseHostProcessCommand(message) }
    catch { return }
    if (command.type === 'stop') void stop()
  })

  const stop = async (): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      try { await handle?.dispose() } finally {
        if (ready && !parentDisconnected) {
          try { await send({ type: 'stopped' }) } catch { /* parent may already be gone */ }
        }
        if (!parentDisconnected) system.disconnect?.()
        system.exit(0)
      }
    })()
    return stopping
  }

  try {
    // spawn 的 cwd/env 已在 child 创建时设定；这里首次动态加载真实 Harness。
    handle = await runtime.bootHarnessHost({
      harnessHome: system.env.DSH_HOME ?? '',
      defaultWorkingDirectory: system.cwd()
    })
    await send({ type: 'ready', origin: handle.origin, binding: handle.binding })
    ready = true
  } catch (error) {
    try { await send({ type: 'startup-failed', error: serializeHostProcessError(error) }) } finally {
      system.exitCode = 1
      system.disconnect?.()
      system.exit(1)
    }
  }
}

/** 仅在 Electron 启动的真实 Host child 中加载 Harness runtime。 */
async function main(): Promise<void> {
  const runtime = await import('./runtime.js')
  await startHostProcess(runtime)
}

void main().catch(error => {
  // main() 失败可能发生在 IPC 已经不可用时，只允许受控错误流出。
  const message = deserializeHostProcessError(serializeHostProcessError(error))
  process.stderr.write(`${message.name}: ${message.message}\n`)
  process.exitCode = 1
})
