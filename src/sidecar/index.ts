import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootHarnessHost } from '../host-process/runtime.js'
import { serializeError } from './test-seams.js'

/** Sidecar 生命周期消息。业务流量继续使用 Harness 的 loopback Web 接口。 */
type SidecarMessage =
  | { readonly type: 'ready'; readonly origin: string; readonly binding: { readonly host: '127.0.0.1'; readonly port: number } }
  | { readonly type: 'startup-failed'; readonly error: { readonly name: string; readonly message: string } }
  | { readonly type: 'stopped' }
  | { readonly type: 'stop-failed'; readonly error: { readonly name: string; readonly message: string } }

/** 向 Tauri Rust 父进程写入一条结构化生命周期消息。 */
function send(message: SidecarMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** 启动官方 Node sidecar，在同一进程内 boot Harness 并处理优雅退出。 */
export async function startNodeSidecar(): Promise<void> {
  let disposed = false
  const handle = await bootHarnessHost({
    harnessHome: process.env.DSH_HOME ?? '',
    defaultWorkingDirectory: process.cwd()
  })
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    try {
      await handle.dispose()
      send({ type: 'stopped' })
      process.exit(0)
    } catch (error) {
      send({ type: 'stop-failed', error: serializeError(error) })
      process.exitCode = 1
    }
  }
  process.once('SIGINT', () => { void dispose() })
  process.once('SIGTERM', () => { void dispose() })
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', line => {
    if (line.trim() === '{"type":"stop"}') void dispose()
  })
  send({ type: 'ready', origin: handle.origin, binding: handle.binding })
  await new Promise<void>(resolve => {
    process.once('beforeExit', () => { void dispose().finally(resolve) })
  })
}

/** 仅在官方 Node 直接执行 sidecar 文件时启动。 */
function isDirectEntry(): boolean {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectEntry()) {
  void startNodeSidecar().catch(error => {
    send({ type: 'startup-failed', error: serializeError(error) })
    process.exitCode = 1
  })
}
