import type { ApplicationLifecycle } from './application.js'
import type { NavigationPolicy } from '../navigation-policy.js'
import { navigateToHostSafely } from '../window-effects.js'

export interface LifecycleWindow {
  isDestroyed(): boolean
  readonly webContents: { send(channel: string, snapshot: unknown): void }
  loadURL(url: string): Promise<unknown>
  loadFile(path: string): Promise<unknown>
}

export function wireLifecycleToWindow(
  lifecycle: ApplicationLifecycle,
  getWindow: () => LifecycleWindow | null,
  startupPath: string,
  snapshotChannel: string,
  policy: NavigationPolicy
): () => void {
  return lifecycle.subscribe(snapshot => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(snapshotChannel, snapshot)
    if (snapshot.state !== 'ready' || !snapshot.origin) return
    policy.setHostOrigin(snapshot.origin)
    void navigateToHostSafely(
      () => window.loadURL(snapshot.origin!),
      () => window.loadFile(startupPath),
      error => { void lifecycle.reportHostNavigationFailure(error) }
    )
  })
}

export interface QuitEvent { preventDefault(): void }
export interface QuitApplication {
  on(event: 'window-all-closed', listener: () => void): unknown
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown
  quit(): void
}

export function wireFinalWindowShutdown(app: QuitApplication, lifecycle: ApplicationLifecycle, diagnosticsFlushTimeoutMs = 1_000): void {
  let quitting = false
  app.on('window-all-closed', () => { if (!quitting) app.quit() })
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void lifecycle.stop().catch(() => undefined)
      .then(() => lifecycle.flushDiagnostics(diagnosticsFlushTimeoutMs))
      .finally(() => app.quit())
  })
}
