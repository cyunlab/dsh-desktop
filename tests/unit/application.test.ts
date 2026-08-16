import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationLifecycle } from '../../src/main/application.js'
import type { HostLauncher } from '../../src/main/host-launcher.js'

async function fixturePaths() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh lifecycle '))
  return { harnessHome: path.join(root, 'home'), fallbackWorkspace: path.join(root, 'workspace'), logs: path.join(root, 'logs') }
}

describe('application lifecycle', () => {
  it('publishes the explicit startup states and disposes idempotently', async () => {
    const dispose = vi.fn(async () => undefined)
    const launcher: HostLauncher = { launch: vi.fn(async () => ({ origin: 'http://127.0.0.1:4567', dispose })) }
    const lifecycle = new ApplicationLifecycle(launcher, await fixturePaths())
    const states: string[] = []
    lifecycle.subscribe(snapshot => states.push(snapshot.state))
    await lifecycle.start()
    expect(states).toEqual(['idle', 'preparing', 'booting', 'probing', 'ready'])
    expect(lifecycle.snapshot.origin).toBe('http://127.0.0.1:4567')
    const first = lifecycle.stop()
    const second = lifecycle.stop()
    expect(first).toBe(second)
    await Promise.all([first, second])
    expect(dispose).toHaveBeenCalledOnce()
    expect(lifecycle.snapshot.state).toBe('stopped')
  })

  it('retries a failed launch once and ignores duplicate retry requests', async () => {
    const dispose = vi.fn(async () => undefined)
    const launch = vi.fn()
      .mockRejectedValueOnce(new Error('test startup failure'))
      .mockResolvedValueOnce({ origin: 'http://127.0.0.1:9876', dispose })
    const lifecycle = new ApplicationLifecycle({ launch }, await fixturePaths())
    await lifecycle.start()
    expect(lifecycle.snapshot).toMatchObject({ state: 'failed', message: 'The local Host could not start. Retry or copy diagnostics for help.' })
    const first = lifecycle.retry()
    const second = lifecycle.retry()
    await Promise.all([first, second])
    expect(launch).toHaveBeenCalledTimes(2)
    expect(lifecycle.snapshot.state).toBe('ready')
    await lifecycle.stop()
  })

  it('starts one fresh attempt when retry is requested from the failed-state notification', async () => {
    const dispose = vi.fn(async () => undefined)
    const launch = vi.fn()
      .mockRejectedValueOnce(new Error('first attempt failed'))
      .mockResolvedValueOnce({ origin: 'http://127.0.0.1:9988', dispose })
    const lifecycle = new ApplicationLifecycle({ launch }, await fixturePaths())
    let firstRetry: Promise<void> | undefined
    let duplicateRetry: Promise<void> | undefined
    lifecycle.subscribe(snapshot => {
      if (snapshot.state === 'failed') {
        firstRetry = lifecycle.retry()
        duplicateRetry = lifecycle.retry()
      }
    })

    await lifecycle.start()
    expect(firstRetry).toBe(duplicateRetry)
    await firstRetry
    expect(launch).toHaveBeenCalledTimes(2)
    expect(lifecycle.snapshot.state).toBe('ready')
    await lifecycle.stop()
  })

  it('atomically cancels an accepted retry when shutdown begins in the same turn', async () => {
    const launch = vi.fn().mockRejectedValueOnce(new Error('first attempt failed'))
    const lifecycleStates: string[] = []
    const diagnosticStates: string[] = []
    const diagnostics = {
      lifecycle: vi.fn(snapshot => diagnosticStates.push(snapshot.state)),
      assignedPort: vi.fn(), navigationRejected: vi.fn(), failure: vi.fn(), actionFailure: vi.fn(),
      flush: vi.fn(async () => undefined)
    }
    const lifecycle = new ApplicationLifecycle({ launch }, await fixturePaths(), 100, diagnostics)
    lifecycle.subscribe(snapshot => lifecycleStates.push(snapshot.state))
    await lifecycle.start()
    expect(lifecycle.snapshot.state).toBe('failed')

    const retry = lifecycle.retry()
    const duplicateRetry = lifecycle.retry()
    const stop = lifecycle.stop()
    const duplicateStop = lifecycle.stop()
    const retryAfterStop = lifecycle.retry()
    expect(retry).toBe(duplicateRetry)
    expect(stop).toBe(duplicateStop)

    await Promise.all([retry, stop, retryAfterStop])
    expect(launch).toHaveBeenCalledTimes(1)
    expect(lifecycle.snapshot.state).toBe('stopped')
    const stoppedAt = lifecycleStates.lastIndexOf('stopped')
    expect(lifecycleStates.slice(stoppedAt + 1)).toEqual([])
    const diagnosticStoppedAt = diagnosticStates.lastIndexOf('stopped')
    expect(diagnosticStates.slice(diagnosticStoppedAt + 1)).toEqual([])
    expect(lifecycle.retry()).toBe(stop)
  })

  it('waits for and disposes a launch that resolves during shutdown without leaving stopped', async () => {
    let resolveLaunch!: (handle: { origin: string, dispose(): Promise<void> }) => void
    const dispose = vi.fn(async () => undefined)
    const launch = new Promise<{ origin: string, dispose(): Promise<void> }>(resolve => { resolveLaunch = resolve })
    const lifecycle = new ApplicationLifecycle({ launch: () => launch }, await fixturePaths())
    const states: string[] = []
    lifecycle.subscribe(snapshot => states.push(snapshot.state))

    const starting = lifecycle.start()
    await vi.waitFor(() => expect(lifecycle.snapshot.state).toBe('booting'))
    const stopping = lifecycle.stop()
    await vi.waitFor(() => expect(lifecycle.snapshot.state).toBe('stopping'))
    let stopSettled = false
    void stopping.then(() => { stopSettled = true })
    await Promise.resolve()
    expect(stopSettled).toBe(false)

    resolveLaunch({ origin: 'http://127.0.0.1:7654', dispose })
    await Promise.all([starting, stopping])
    expect(dispose).toHaveBeenCalledOnce()
    expect(lifecycle.snapshot.state).toBe('stopped')
    expect(states.slice(states.lastIndexOf('stopped') + 1)).toEqual([])
  })

  it('bounds shutdown when a launch never settles', async () => {
    const failure = vi.fn()
    const diagnostics = { lifecycle: vi.fn(), assignedPort: vi.fn(), navigationRejected: vi.fn(), failure, actionFailure: vi.fn(), flush: vi.fn(async () => undefined) }
    const lifecycle = new ApplicationLifecycle({ launch: () => new Promise(() => {}) }, await fixturePaths(), 10, diagnostics)
    void lifecycle.start()
    await vi.waitFor(() => expect(lifecycle.snapshot.state).toBe('booting'))
    await expect(lifecycle.stop()).resolves.toBeUndefined()
    expect(lifecycle.snapshot.state).toBe('stopped')
    expect(failure).toHaveBeenCalledWith('host-shutdown-timeout', expect.any(Error))
  })
})
