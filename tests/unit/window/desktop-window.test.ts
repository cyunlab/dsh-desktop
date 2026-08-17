import { describe, expect, it, vi } from 'vitest'
import { DesktopWindow, type DesktopBrowserWindow, type DesktopBrowserWindowOptions } from '../../../src/main/window/desktop-window.js'

/** 为 DesktopWindow 测试创建可触发窗口与 webContents 事件的假窗口。 */
function fakeWindow(minimized = false): DesktopBrowserWindow & {
  emitWindow(event: 'ready-to-show' | 'closed'): void
  emitContents(event: 'did-finish-load' | 'will-navigate', target?: string): { preventDefault: ReturnType<typeof vi.fn> }
  openPopup(url: string): { action: 'deny' }
} {
  const windowListeners = new Map<string, () => void>()
  const contentListeners = new Map<string, unknown>()
  let popup = (_details: { url: string }): { action: 'deny' } => ({ action: 'deny' })
  const webContents = {
    on: vi.fn((event: 'did-finish-load' | 'will-navigate', listener: unknown) => { contentListeners.set(event, listener) }),
    setWindowOpenHandler: vi.fn(listener => { popup = listener }),
    send: vi.fn(),
    getURL: vi.fn(() => 'file:///desktop/startup.html')
  }
  return {
    once: vi.fn((event: 'ready-to-show', listener: () => void) => { windowListeners.set(event, listener) }),
    on: vi.fn((event: 'closed', listener: () => void) => { windowListeners.set(event, listener) }),
    isDestroyed: vi.fn(() => false), destroy: vi.fn(), isMinimized: vi.fn(() => minimized), restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
    loadFile: vi.fn(async () => undefined), loadURL: vi.fn(async () => undefined), webContents,
    emitWindow: event => windowListeners.get(event)?.(),
    emitContents: (event, target = '') => {
      const navigation = { preventDefault: vi.fn() }
      if (event === 'will-navigate') (contentListeners.get(event) as ((event: typeof navigation, target: string) => void) | undefined)?.(navigation, target)
      else (contentListeners.get(event) as (() => void) | undefined)?.()
      return navigation
    },
    openPopup: url => popup({ url })
  }
}

/** 创建一个使用假窗口工厂的 DesktopWindow 及其依赖 spies。 */
function fixture(windows: DesktopBrowserWindow[] = []) {
  const diagnostics = { navigationRejected: vi.fn() }
  const openExternal = vi.fn(async () => undefined)
  const createBrowserWindow = vi.fn((_options: DesktopBrowserWindowOptions) => windows.shift() ?? fakeWindow())
  return {
    diagnostics, openExternal, createBrowserWindow,
    desktop: new DesktopWindow({ startupPath: '/desktop/startup.html', preloadPath: '/desktop/preload.cjs', iconPath: '/desktop/icon.png', snapshotChannel: 'startup:snapshot', diagnostics, openExternal, createBrowserWindow })
  }
}

describe('DesktopWindow', () => {
  it('creates one secure startup window and opens the startup page idempotently', async () => {
    const window = fakeWindow(); const { desktop, createBrowserWindow } = fixture([window])
    await desktop.open(); await desktop.open()
    expect(createBrowserWindow).toHaveBeenCalledOnce()
    expect(createBrowserWindow.mock.calls[0][0]).toMatchObject({ show: false, webPreferences: { preload: '/desktop/preload.cjs', nodeIntegration: false, contextIsolation: true, sandbox: true } })
    expect(window.loadFile).toHaveBeenCalledWith('/desktop/startup.html')
    window.emitWindow('ready-to-show'); expect(window.show).toHaveBeenCalledOnce()
  })

  it('shares concurrent opening and retries with a new window after startup load failure', async () => {
    const first = fakeWindow(); const second = fakeWindow(); const failure = new Error('startup failed')
    let rejectLoad!: (error: Error) => void
    vi.mocked(first.loadFile).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLoad = reject }))
    const { desktop, createBrowserWindow } = fixture([first, second])
    const one = desktop.open(); const two = desktop.open()
    expect(two).toBe(one)
    expect(createBrowserWindow).toHaveBeenCalledOnce()
    rejectLoad(failure)
    await expect(one).rejects.toBe(failure); await expect(two).rejects.toBe(failure)
    expect(first.destroy).toHaveBeenCalledOnce()
    await desktop.open(); expect(createBrowserWindow).toHaveBeenCalledTimes(2); expect(second.loadFile).toHaveBeenCalledOnce()
  })

  it('does not let a window closed during opening clear its later replacement', async () => {
    const first = fakeWindow(); const second = fakeWindow(); let finishLoad!: () => void
    vi.mocked(first.loadFile).mockImplementationOnce(() => new Promise(resolve => { finishLoad = () => resolve(undefined) }))
    const { desktop, createBrowserWindow } = fixture([first, second])
    const firstOpening = desktop.open(); first.emitWindow('closed'); const secondOpening = desktop.open()
    expect(secondOpening).not.toBe(firstOpening); expect(createBrowserWindow).toHaveBeenCalledTimes(2); expect(second.loadFile).toHaveBeenCalledOnce()
    await secondOpening; finishLoad(); await firstOpening
    first.emitWindow('closed'); desktop.publishSnapshot({ state: 'idle', message: 'x' })
    expect(second.webContents.send).toHaveBeenCalledOnce()
  })

  it('recreates after close or destruction without clearing a replacement', async () => {
    const first = fakeWindow(); const second = fakeWindow(); const { desktop, createBrowserWindow } = fixture([first, second])
    await desktop.open(); first.emitWindow('closed'); await desktop.open(); expect(createBrowserWindow).toHaveBeenCalledTimes(2)
    first.emitWindow('closed'); desktop.publishSnapshot({ state: 'idle', message: 'x' }); expect(second.webContents.send).toHaveBeenCalledOnce()
  })

  it('recreates after the current window is destroyed', async () => {
    const first = fakeWindow(); const second = fakeWindow(); const { desktop, createBrowserWindow } = fixture([first, second])
    await desktop.open(); vi.mocked(first.isDestroyed).mockReturnValue(true); await desktop.open()
    expect(createBrowserWindow).toHaveBeenCalledTimes(2)
  })

  it('enforces allow, external, deny, and popup navigation policies', async () => {
    const window = fakeWindow(); const { desktop, diagnostics, openExternal } = fixture([window]); await desktop.open()
    const allowed = window.emitContents('will-navigate', 'file:///desktop/startup.html'); expect(allowed.preventDefault).not.toHaveBeenCalled()
    const external = window.emitContents('will-navigate', 'https://example.test'); const denied = window.emitContents('will-navigate', 'javascript:alert(1)')
    expect(external.preventDefault).toHaveBeenCalledOnce(); expect(denied.preventDefault).toHaveBeenCalledOnce(); await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://example.test'))
    expect(diagnostics.navigationRejected).toHaveBeenCalledWith('javascript:alert(1)', 'deny')
    expect(window.openPopup('https://example.test')).toEqual({ action: 'deny' }); await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2))
  })

  it('swallows rejected external opens', async () => {
    const window = fakeWindow(); const { desktop, openExternal } = fixture([window]); openExternal.mockRejectedValueOnce(new Error('unavailable')); await desktop.open()
    window.emitContents('will-navigate', 'https://example.test'); await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce())
  })

  it('retains pre-open focus and restores, shows, then focuses minimized windows', async () => {
    const window = fakeWindow(true); const actions: string[] = []; const parts = fixture([window])
    const desktop = new DesktopWindow({ startupPath: '/desktop/startup.html', preloadPath: '/desktop/preload.cjs', iconPath: '/desktop/icon.png', snapshotChannel: 'startup:snapshot', diagnostics: parts.diagnostics, openExternal: parts.openExternal, createBrowserWindow: parts.createBrowserWindow, observe: { restored: () => actions.push('restored'), shown: () => actions.push('shown'), focused: () => actions.push('focused') } })
    desktop.requestFocus(); await desktop.open(); expect(actions).toEqual(['restored', 'shown', 'focused'])
  })

  it('publishes snapshots only to a live window and observes page loads', async () => {
    const window = fakeWindow(); const events: string[] = []; const parts = fixture([window])
    const desktop = new DesktopWindow({ startupPath: '/desktop/startup.html', preloadPath: '/desktop/preload.cjs', iconPath: '/desktop/icon.png', snapshotChannel: 'startup:snapshot', diagnostics: parts.diagnostics, openExternal: parts.openExternal, createBrowserWindow: parts.createBrowserWindow, observe: { startupPageLoaded: () => events.push('startup'), webClientLoaded: () => events.push('client') } })
    desktop.publishSnapshot({ state: 'idle', message: 'x' }); await desktop.open(); desktop.publishSnapshot({ state: 'idle', message: 'x' }); window.emitContents('did-finish-load'); vi.mocked(window.webContents.getURL).mockReturnValue('http://127.0.0.1:1234'); window.emitContents('did-finish-load')
    expect(window.webContents.send).toHaveBeenCalledOnce(); expect(events).toEqual(['startup', 'client'])
  })

  it('shows Host after registering its origin and restores startup on navigation failure', async () => {
    const window = fakeWindow(); const { desktop } = fixture([window]); await desktop.open(); await desktop.showHost('http://127.0.0.1:1234'); expect(window.loadURL).toHaveBeenCalledWith('http://127.0.0.1:1234')
    const failure = new Error('host failed'); vi.mocked(window.loadURL).mockRejectedValueOnce(failure); await expect(desktop.showHost('http://127.0.0.1:1235')).rejects.toBe(failure); expect(window.loadFile).toHaveBeenCalledTimes(2)
    vi.mocked(window.loadURL).mockRejectedValueOnce(failure); vi.mocked(window.loadFile).mockRejectedValueOnce(new Error('restore failed')); await expect(desktop.showHost('http://127.0.0.1:1236')).rejects.toBe(failure)
  })

  it('replays a resolved stale Host navigation after its replacement startup completes', async () => {
    const first = fakeWindow(); const second = fakeWindow(); let finishOldNavigation!: () => void; let finishReplacementStartup!: () => void
    vi.mocked(first.loadURL).mockImplementationOnce(() => new Promise(resolve => { finishOldNavigation = () => resolve(undefined) }))
    vi.mocked(second.loadFile).mockImplementationOnce(() => new Promise(resolve => { finishReplacementStartup = () => resolve(undefined) }))
    const { desktop } = fixture([first, second]); await desktop.open()
    const showing = desktop.showHost('http://127.0.0.1:1234'); first.emitWindow('closed'); const replacementOpening = desktop.open()
    finishOldNavigation(); await Promise.resolve(); expect(second.loadURL).not.toHaveBeenCalled()
    finishReplacementStartup(); await replacementOpening; await showing
    expect(second.loadURL).toHaveBeenCalledWith('http://127.0.0.1:1234')
  })

  it('contains a rejected stale Host navigation and replays it on the replacement', async () => {
    const first = fakeWindow(); const second = fakeWindow(); const staleFailure = new Error('stale navigation failed'); let rejectOldNavigation!: () => void; let finishReplacementStartup!: () => void
    vi.mocked(first.loadURL).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOldNavigation = () => reject(staleFailure) }))
    vi.mocked(second.loadFile).mockImplementationOnce(() => new Promise(resolve => { finishReplacementStartup = () => resolve(undefined) }))
    const { desktop } = fixture([first, second]); await desktop.open()
    const showing = desktop.showHost('http://127.0.0.1:1234'); first.emitWindow('closed'); const replacementOpening = desktop.open()
    rejectOldNavigation(); await Promise.resolve(); expect(first.loadFile).toHaveBeenCalledOnce(); expect(second.loadURL).not.toHaveBeenCalled()
    finishReplacementStartup(); await replacementOpening; await expect(showing).resolves.toBeUndefined()
    expect(second.loadURL).toHaveBeenCalledWith('http://127.0.0.1:1234')
  })

  it('does nothing when asked to show a Host without a live window', async () => {
    const { desktop } = fixture(); await expect(desktop.showHost('http://127.0.0.1:1234')).resolves.toBeUndefined()
  })
})
