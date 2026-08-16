import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationLifecycle } from '../../src/main/application.js'
import { wireFinalWindowShutdown, wireLifecycleToWindow, type QuitEvent } from '../../src/main/application-wiring.js'
import { FakeHostLauncher } from '../../src/main/fake-host-launcher.js'
import { NavigationPolicy } from '../../src/main/navigation-policy.js'

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
    const loadURL = vi.fn(async () => undefined)
    const window = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
      loadURL,
      loadFile: vi.fn(async () => undefined)
    }
    const policy = new NavigationPolicy('file:///desktop/startup.html')
    wireLifecycleToWindow(lifecycle, () => window, '/desktop/startup.html', 'startup:snapshot', policy)

    await lifecycle.start()
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledWith('http://127.0.0.1:45678'))
    expect(policy.decide('http://127.0.0.1:45678/workspaces')).toBe('allow')
    await lifecycle.stop()
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
})
