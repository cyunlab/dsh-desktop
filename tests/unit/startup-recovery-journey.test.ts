import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationLifecycle } from '../../src/main/lifecycle/application.js'
import { RollingDiagnostics, type DiagnosticContext } from '../../src/main/diagnostics.js'
import { createStartupActions } from '../../src/main/startup-actions.js'
import type { StartupApi } from '../../src/shared/startup-contract.js'
import { connectStartupPage, type StartupDocument, type StartupElement } from '../../src/startup/controller.js'

class FakeElement implements StartupElement {
  textContent: string | null = null
  hidden = false
  #click?: () => void
  addEventListener(_type: 'click', listener: () => void): void { this.#click = listener }
  click(): void { this.#click?.() }
}

function fakeDocument(): { document: StartupDocument; elements: Record<string, FakeElement> } {
  const elements = Object.fromEntries(['#state', '#message', '#actions', '#retry', '#copy', '#logs'].map(id => [id, new FakeElement()]))
  return { document: { querySelector: selector => elements[selector] ?? null }, elements }
}

const context: DiagnosticContext = {
  appVersion: '0.1.0', electronVersion: '43.4.0', nodeVersion: '24.1.0', platform: 'linux', arch: 'x64'
}

describe('startup failure recovery journey', () => {
  it('renders failure, exposes actions, retries through the bridge, and keeps copied/logged diagnostics redacted', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh recovery journey '))
    const paths = { harnessHome: path.join(root, 'home'), defaultWorkingDirectory: path.join(root, 'workspace'), logs: path.join(root, 'logs') }
    const diagnostics = new RollingDiagnostics(paths.logs, context)
    const dispose = vi.fn(async () => undefined)
    const launch = vi.fn()
      .mockRejectedValueOnce(new Error('Bearer private-credential prompt: private conversation'))
      .mockResolvedValueOnce({ origin: 'http://127.0.0.1:4567', binding: { host: '127.0.0.1', port: 4567 }, dispose })
    const lifecycle = new ApplicationLifecycle({ launch }, paths, 100, diagnostics)
    let clipboard = ''
    const revealPath = vi.fn(async () => '')
    const actions = createStartupActions(
      () => lifecycle.snapshot, context, paths.logs,
      { writeClipboard: text => { clipboard = text }, revealPath }, diagnostics
    )
    const api: StartupApi = {
      getSnapshot: async () => lifecycle.snapshot,
      onSnapshot: listener => lifecycle.subscribe(listener),
      retry: () => lifecycle.retry(),
      copyDiagnostics: () => actions.copyDiagnostics(),
      revealLogs: () => actions.revealLogs()
    }
    const { document, elements } = fakeDocument()
    connectStartupPage(api, document)

    await lifecycle.start()
    expect(elements['#state']?.textContent).toBe('Startup failed')
    expect(elements['#actions']?.hidden).toBe(false)
    expect(elements['#message']?.textContent).toMatch(/could not start/i)

    elements['#copy']?.click()
    elements['#logs']?.click()
    await vi.waitFor(() => expect(clipboard).toContain('State: failed'))
    expect(clipboard).not.toMatch(/credential|conversation|Bearer|127\.0\.0\.1/)
    expect(revealPath).toHaveBeenCalledWith(paths.logs)

    elements['#retry']?.click()
    await vi.waitFor(() => expect(elements['#state']?.textContent).toBe('Web Client is ready'))
    expect(elements['#actions']?.hidden).toBe(true)
    expect(launch).toHaveBeenCalledTimes(2)

    await diagnostics.flush()
    const log = await readFile(path.join(paths.logs, 'desktop.log'), 'utf8')
    expect(log).toContain('"area":"host-startup"')
    expect(log).toContain('"port":4567')
    expect(log).not.toMatch(/private-credential|private conversation|Bearer/)
    await lifecycle.stop()
  })
})
