import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { ProcessHostLauncher } from '../../../src/main/host/process-launcher.js'
import type { HostHandle } from '../../../src/main/host/launcher.js'

async function fixturePaths() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh process host '))
  const paths = {
    harnessHome: path.join(root, 'Harness Home'),
    defaultWorkingDirectory: path.join(root, 'Default Working Directory'),
    logs: path.join(root, 'Logs')
  }
  await Promise.all(Object.values(paths).map(directory => mkdir(directory, { recursive: true })))
  return paths
}

describe('ProcessHostLauncher', () => {
  it('starts a child with isolated Node env/cwd, waits for HTTP readiness, and disposes idempotently', async () => {
    const paths = await fixturePaths()
    const parentCwd = process.cwd()
    const parentEnv = process.env.DSH_HOME
    const output: string[] = []
    let invocation: { command: string; args: string[]; options: SpawnOptions } | undefined
    const launcher = new ProcessHostLauncher({
      hostEntry: fileURLToPath(new URL('../../fixtures/host-process-child.mjs', import.meta.url)),
      readiness: { timeoutMs: 5_000 },
      onDiagnosticOutput: (_stream, value) => output.push(value),
      spawnProcess: (command, args, options) => {
        invocation = { command, args, options }
        return spawnChild(command, args, options)
      }
    })

    let handle: HostHandle | undefined
    try {
      handle = await launcher.launch(paths)
      expect(invocation).toMatchObject({
        command: process.execPath,
        args: [fileURLToPath(new URL('../../fixtures/host-process-child.mjs', import.meta.url))],
        options: {
          cwd: paths.defaultWorkingDirectory,
          env: expect.objectContaining({ DSH_HOME: paths.harnessHome, ELECTRON_RUN_AS_NODE: '1' }),
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          windowsHide: true,
          shell: false
        }
      })
      expect(handle.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect((await fetch(handle.origin)).ok).toBe(true)
      const smoke = await (await fetch(`${handle.origin}/plugin-smoke`)).json() as { nodeMode: boolean; cwd: string }
      expect(smoke.nodeMode).toBe(true)
      expect(smoke.cwd).toBe(await realpath(paths.defaultWorkingDirectory))
      await Promise.all([handle.dispose(), handle.dispose()])
      expect(process.cwd()).toBe(parentCwd)
      expect(process.env.DSH_HOME).toBe(parentEnv)
      await expect(fetch(handle.origin)).rejects.toThrow()
      expect(output.join('')).not.toContain('DSH_HOME')
    } finally {
      await handle?.dispose().catch(() => undefined)
    }
  }, 15_000)

  /** 使用 fixture 场景启动一个真实 child，验证 launcher 的失败与清理边界。 */
  async function launchScenario(scenario: string, options: {
    startupTimeoutMs?: number
    shutdownTimeoutMs?: number
    blockStopSendCallback?: boolean
    fetch?: typeof globalThis.fetch
  } = {}) {
    const paths = await fixturePaths()
    let child: ChildProcess | undefined
    const hostEntry = fileURLToPath(new URL('../../fixtures/host-process-scenarios.mjs', import.meta.url))
    const launcher = new ProcessHostLauncher({
      ...options,
      hostEntry,
      readiness: { timeoutMs: options.startupTimeoutMs ?? 5_000, fetch: options.fetch },
      spawnProcess: (command, args, spawnOptions) => {
        child = spawnChild(command, args, {
          ...spawnOptions,
          env: { ...spawnOptions.env, DSH_HOST_SCENARIO: scenario }
        })
        if (options.blockStopSendCallback) {
          const originalSend = child.send.bind(child)
          child.send = ((message: unknown, ...rest: unknown[]) => {
            if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'stop') return child
            return originalSend(message as never, ...(rest as never[]))
          }) as typeof child.send
        }
        return child
      }
    })
    return { paths, launcher, getChild: () => child }
  }

  it.each([
    ['invalid IPC message', 'invalid-message', /invalid IPC message/i],
    ['startup-failed', 'startup-failed', /fixture startup failure/],
    ['ready-before-exit', 'exit-before-ready', /exited before readiness|Host child exited/]
  ])('rejects %s and cleans the child', async (_label, scenario, expected) => {
    const attempt = await launchScenario(scenario)
    await expect(attempt.launcher.launch(attempt.paths)).rejects.toThrow(expected)
    await vi.waitFor(() => expect(attempt.getChild()?.exitCode ?? attempt.getChild()?.signalCode ?? null).not.toBeNull())
    const child = attempt.getChild()
    expect(child?.listenerCount('message')).toBe(0)
    expect(child?.listenerCount('exit')).toBe(0)
    expect(child?.listenerCount('error')).toBe(0)
    expect(child?.stdout?.listenerCount('data')).toBe(0)
    expect(child?.stderr?.listenerCount('data')).toBe(0)
  }, 15_000)

  it('races ready-to-HTTP probing against a child exit instead of accepting a reused port', async () => {
    const attempt = await launchScenario('ready-http-fail')
    const started = Date.now()
    await expect(attempt.launcher.launch(attempt.paths)).rejects.toThrow(/Host child exited|exited before readiness/)
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 10_000)

  it('aborts an in-flight HTTP probe when the child fails during readiness', async () => {
    const request = vi.fn((_origin: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    }))
    const attempt = await launchScenario('ready-http-fail', { fetch: request })
    await expect(attempt.launcher.launch(attempt.paths)).rejects.toThrow(/Host child exited|exited before readiness/)
    expect(request).toHaveBeenCalledOnce()
    const signal = request.mock.calls[0]?.[1]?.signal
    expect(signal?.aborted).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(request).toHaveBeenCalledOnce()
  }, 10_000)

  it('treats startup timeout as an attempt failure and terminates that child', async () => {
    const attempt = await launchScenario('timeout', { startupTimeoutMs: 50, shutdownTimeoutMs: 100 })
    await expect(attempt.launcher.launch(attempt.paths)).rejects.toThrow(/within 50 ms/)
    await vi.waitFor(() => expect(attempt.getChild()?.exitCode ?? attempt.getChild()?.signalCode ?? null).not.toBeNull())
  }, 10_000)

  it('reports ready-child crashes through closed without requiring a second launch', async () => {
    const attempt = await launchScenario('exit-after-ready')
    const handle = await attempt.launcher.launch(attempt.paths)
    try {
      await expect(handle.closed).resolves.toMatchObject({ intentional: false })
    } finally {
      await handle.dispose().catch(() => undefined)
    }
  }, 10_000)

  it('waits for child exit after stopped and only kills a shutdown timeout', async () => {
    const graceful = await launchScenario('ready')
    const gracefulHandle = await graceful.launcher.launch(graceful.paths)
    try {
      await expect(gracefulHandle.dispose()).resolves.toBeUndefined()
      await vi.waitFor(() => expect(graceful.getChild()?.exitCode ?? null).toBe(0))
    } finally {
      await gracefulHandle.dispose().catch(() => undefined)
    }

    const hanging = await launchScenario('shutdown-timeout', { shutdownTimeoutMs: 50 })
    const hangingHandle = await hanging.launcher.launch(hanging.paths)
    try {
      await expect(hangingHandle.dispose()).resolves.toBeUndefined()
      await vi.waitFor(() => expect(hanging.getChild()?.exitCode ?? hanging.getChild()?.signalCode ?? null).not.toBeNull())
    } finally {
      await hangingHandle.dispose().catch(() => undefined)
    }
  }, 15_000)

  it('terminates when the stop IPC callback never settles within the shutdown budget', async () => {
    const attempt = await launchScenario('ready', { shutdownTimeoutMs: 100, blockStopSendCallback: true })
    const handle = await attempt.launcher.launch(attempt.paths)
    const started = Date.now()
    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(500)
    await vi.waitFor(() => expect(attempt.getChild()?.exitCode ?? attempt.getChild()?.signalCode ?? null).not.toBeNull())
  }, 5_000)

  it('rejects and removes listeners when child emits error before ready', async () => {
    /** 模拟尚未启动完成、可发出 error/exit 的 ChildProcess seam。 */
    class ErroringChild extends EventEmitter {
      pid = undefined
      exitCode: number | null = null
      signalCode: NodeJS.Signals | null = null
      connected = false
      stdout = null
      stderr = null
      kill = vi.fn(() => {
        this.exitCode = 1
        this.emit('exit', 1, null)
        return true
      })
    }
    const child = new ErroringChild()
    const paths = await fixturePaths()
    const launcher = new ProcessHostLauncher({
      platform: 'darwin',
      hostEntry: '/tmp/host-entry.js',
      processTree: { platform: 'darwin' },
      spawnProcess: () => {
        queueMicrotask(() => child.emit('error', new Error('child spawn error')))
        return child as unknown as ChildProcess
      }
    })

    await expect(launcher.launch(paths)).rejects.toThrow('child spawn error')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.listenerCount('message')).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  })

  it('fails closed and taskkills when Windows Job Object setup fails', async () => {
    /** 模拟 Windows 上尚未退出的 child，并让终止动作产生 exit。 */
    class UnownedChild extends EventEmitter {
      pid = 4321
      exitCode: number | null = null
      signalCode: NodeJS.Signals | null = null
      connected = false
      stdout = null
      stderr = null
      kill = vi.fn(() => {
        this.exitCode = 1
        this.emit('exit', 1, null)
        return true
      })
    }
    const child = new UnownedChild()
    const terminator = new UnownedChild()
    terminator.pid = 9999
    const spawnProcess = vi.fn((command: string) => {
      if (command === 'taskkill.exe') {
        queueMicrotask(() => terminator.emit('exit', 0, null))
        return terminator as unknown as ChildProcess
      }
      return child as unknown as ChildProcess
    })
    const paths = await fixturePaths()
    const launcher = new ProcessHostLauncher({
      platform: 'win32',
      hostEntry: '/tmp/host-entry.js',
      shutdownTimeoutMs: 100,
      processTree: { platform: 'win32', spawnProcess },
      spawnProcess,
      windowsJobBindings: {
        createJobObjectW: vi.fn(() => null),
        setInformationJobObject: vi.fn(() => 1),
        openProcess: vi.fn(() => 22n),
        assignProcessToJobObject: vi.fn(() => 1),
        closeHandle: vi.fn(() => 1),
        getLastError: vi.fn(() => 5)
      }
    })

    await expect(launcher.launch(paths)).rejects.toThrow(/process isolation could not be established/i)
    expect(spawnProcess).toHaveBeenCalledWith('taskkill.exe', ['/pid', '4321', '/T', '/F'], expect.objectContaining({ shell: false }))
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
  }, 5_000)
})
