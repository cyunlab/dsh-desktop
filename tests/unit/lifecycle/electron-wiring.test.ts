import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationLifecycle } from '../../../src/main/lifecycle/application.js'
import { wireFinalWindowShutdown, wireLifecycleToWindow, type QuitEvent } from '../../../src/main/lifecycle/electron-wiring.js'
import { FakeHostLauncher } from '../../../src/main/host/fake-launcher.js'
import type { DiagnosticsSink } from '../../../src/main/diagnostics.js'

async function fixturePaths() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh wiring '))
  return {
    harnessHome: path.join(root, 'home'),
    fallbackWorkspace: path.join(root, 'workspace'),
    logs: path.join(root, 'logs')
  }
}

describe('Electron application wiring', () => {
  it('navigates the existing window to the ready Host origin', async () => {
    const dispose = vi.fn(async () => undefined)
    const lifecycle = new ApplicationLifecycle({
      launch: vi.fn(async () => ({ origin: 'http://127.0.0.1:45678', dispose }))
    }, await fixturePaths())
    const showHost = vi.fn(async () => undefined)
    const window = {
      publishSnapshot: vi.fn(),
      showHost
    }
    wireLifecycleToWindow(lifecycle, window)

    await lifecycle.start()
    await vi.waitFor(() => expect(showHost).toHaveBeenCalledWith('http://127.0.0.1:45678'))
    await lifecycle.stop()
  })

  it('reports a rejected Desktop Host navigation to the lifecycle', async () => {
    const lifecycle = new ApplicationLifecycle({
      launch: vi.fn(async () => ({ origin: 'http://127.0.0.1:45678', dispose: vi.fn(async () => undefined) }))
    }, await fixturePaths())
    const window = { publishSnapshot: vi.fn(), showHost: vi.fn(async () => { throw new Error('navigation failed') }) }
    wireLifecycleToWindow(lifecycle, window)

    await lifecycle.start()
    await vi.waitFor(() => expect(lifecycle.snapshot.state).toBe('failed'))
  })

  it('stops the listener before the final-window quit completes', async () => {
    class FakeApp extends EventEmitter {
      quitCalls = 0
      quit(): void {
        this.quitCalls += 1
        let prevented = false
        this.emit('before-quit', { preventDefault: () => { prevented = true } } satisfies QuitEvent)
        if (!prevented) this.emit('quit-complete')
      }
    }
    const app = new FakeApp()
    const lifecycle = new ApplicationLifecycle(new FakeHostLauncher(), await fixturePaths())
    await lifecycle.start()
    const origin = lifecycle.snapshot.origin!
    expect((await fetch(origin)).ok).toBe(true)
    wireFinalWindowShutdown(app, lifecycle)

    app.emit('window-all-closed')
    await vi.waitFor(() => expect(lifecycle.snapshot.state).toBe('stopped'))
    await vi.waitFor(() => expect(app.quitCalls).toBe(2))
    await expect(fetch(origin)).rejects.toThrow()
  })

  it('does not complete quit until a late launch handle has been disposed', async () => {
    class FakeApp extends EventEmitter {
      quitCalls = 0
      quit(): void {
        this.quitCalls += 1
        let prevented = false
        this.emit('before-quit', { preventDefault: () => { prevented = true } } satisfies QuitEvent)
        if (!prevented) this.emit('quit-complete')
      }
    }
    let resolveLaunch!: (handle: { origin: string; dispose(): Promise<void> }) => void
    let resolveDispose!: () => void
    const dispose = vi.fn(() => new Promise<void>(resolve => { resolveDispose = resolve }))
    const lifecycle = new ApplicationLifecycle({
      launch: () => new Promise(resolve => { resolveLaunch = resolve })
    }, await fixturePaths())
    void lifecycle.start()
    await vi.waitFor(() => expect(lifecycle.snapshot.state).toBe('booting'))
    const app = new FakeApp()
    wireFinalWindowShutdown(app, lifecycle)

    app.emit('window-all-closed')
    expect(app.quitCalls).toBe(1)
    resolveLaunch({ origin: 'http://127.0.0.1:45679', dispose })
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    expect(app.quitCalls).toBe(1)
    expect(lifecycle.snapshot.state).toBe('stopping')

    resolveDispose()
    await vi.waitFor(() => expect(app.quitCalls).toBe(2))
    expect(lifecycle.snapshot.state).toBe('stopped')
  })

  it('flushes stopped and failure diagnostics before completing quit', async () => {
    class FakeApp extends EventEmitter {
      quitCalls = 0
      quit(): void {
        this.quitCalls += 1
        let prevented = false
        this.emit('before-quit', { preventDefault: () => { prevented = true } } satisfies QuitEvent)
        if (!prevented) this.emit('quit-complete')
      }
    }
    const records: string[] = []
    const durableRecords: string[] = []
    let releaseFlush!: () => void
    const flush = vi.fn(() => {
      durableRecords.push(...records)
      return new Promise<void>(resolve => { releaseFlush = resolve })
    })
    const diagnostics: DiagnosticsSink = {
      lifecycle: snapshot => records.push(snapshot.state),
      assignedPort: vi.fn(),
      navigationRejected: vi.fn(),
      failure: area => records.push(`failure:${area}`),
      actionFailure: vi.fn(),
      flush
    }
    const lifecycle = new ApplicationLifecycle({ launch: async () => { throw new Error('private startup detail') } }, await fixturePaths(), 100, diagnostics)
    await lifecycle.start()
    const app = new FakeApp()
    wireFinalWindowShutdown(app, lifecycle)

    app.emit('window-all-closed')
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce())
    expect(records).toEqual(expect.arrayContaining(['failure:host-startup', 'stopping', 'stopped']))
    expect(durableRecords).toEqual(expect.arrayContaining(['failure:host-startup', 'stopping', 'stopped']))
    expect(app.quitCalls).toBe(1)
    releaseFlush()
    await vi.waitFor(() => expect(app.quitCalls).toBe(2))
  })

  it('bounds a diagnostics flush that never settles', async () => {
    class FakeApp extends EventEmitter {
      quitCalls = 0
      quit(): void {
        this.quitCalls += 1
        let prevented = false
        this.emit('before-quit', { preventDefault: () => { prevented = true } } satisfies QuitEvent)
        if (!prevented) this.emit('quit-complete')
      }
    }
    const diagnostics: DiagnosticsSink = {
      lifecycle: vi.fn(), assignedPort: vi.fn(), navigationRejected: vi.fn(), failure: vi.fn(), actionFailure: vi.fn(),
      flush: () => new Promise(() => {})
    }
    const lifecycle = new ApplicationLifecycle(new FakeHostLauncher(), await fixturePaths(), 100, diagnostics)
    await lifecycle.start()
    const app = new FakeApp()
    wireFinalWindowShutdown(app, lifecycle, 10)

    app.emit('window-all-closed')
    await vi.waitFor(() => expect(app.quitCalls).toBe(2))
    expect(lifecycle.snapshot.state).toBe('stopped')
  })
})
