import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { startHostProcess, type HostProcessRuntime, type HostProcessSystem } from '../../src/host-process/index.js'

class FakeHostSystem extends EventEmitter implements HostProcessSystem {
  readonly env = { DSH_HOME: '/tmp/harness-home' }
  readonly messages: unknown[] = []
  connected = true
  exitCode = 0

  /** 返回测试 child 的稳定工作目录。 */
  cwd(): string { return '/tmp/default-working-directory' }
  /** 记录发送给父进程的受控 IPC 消息。 */
  send(message: unknown, callback?: (error?: Error | null) => void): void {
    this.messages.push(message)
    callback?.(null)
  }
  /** 标记测试 IPC 已断开。 */
  disconnect(): void { this.connected = false }
  /** 记录退出码而不结束 Vitest 进程。 */
  exit(code = 0): never {
    this.exitCode = code
    return undefined as never
  }
}

/** 创建一个可观察的 fake Harness runtime。 */
function runtime(dispose = vi.fn(async () => undefined)): HostProcessRuntime {
  return {
    bootHarnessHost: vi.fn(async () => ({
      origin: 'http://127.0.0.1:43210',
      binding: { host: '127.0.0.1' as const, port: 43210 },
      dispose
    }))
  }
}

describe('Host child runtime', () => {
  it('boots in the supplied cwd/env and stops idempotently through validated IPC', async () => {
    const system = new FakeHostSystem()
    const dispose = vi.fn(async () => undefined)
    await startHostProcess(runtime(dispose), system)
    expect(system.messages).toEqual([{
      type: 'ready',
      origin: 'http://127.0.0.1:43210',
      binding: { host: '127.0.0.1', port: 43210 }
    }])

    system.emit('message', { type: 'stop' })
    system.emit('message', { type: 'stop' })
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    expect(system.messages).toContainEqual({ type: 'stopped' })
    expect(system.exitCode).toBe(0)
  })

  it('sends a redacted startup failure and exits non-zero', async () => {
    const system = new FakeHostSystem()
    const failingRuntime: HostProcessRuntime = {
      bootHarnessHost: vi.fn(async () => {
        throw Object.assign(new Error('startup detail'), { code: 'E_START', stack: 'private stack', cause: { secret: true } })
      })
    }

    await startHostProcess(failingRuntime, system)
    expect(system.messages).toEqual([{
      type: 'startup-failed',
      error: { name: 'Error', message: 'startup detail', code: 'E_START' }
    }])
    expect(system.exitCode).toBe(1)
  })
})
