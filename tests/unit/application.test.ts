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
    const lifecycle = new ApplicationLifecycle({ launch: () => new Promise(() => {}) }, await fixturePaths(), 10)
    void lifecycle.start()
    await vi.waitFor(() => expect(lifecycle.snapshot.state).toBe('booting'))
    await expect(lifecycle.stop()).resolves.toBeUndefined()
    expect(lifecycle.snapshot.state).toBe('stopped')
  })
})
