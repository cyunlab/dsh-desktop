import type { ApplicationLifecycle } from './application.js'
import type { LifecycleSnapshot } from '../../shared/startup-contract.js'

/** 生命周期向 Desktop 窗口发送状态与 Host 导航请求的最小接口。 */
export interface LifecycleDesktopWindow {
  publishSnapshot(snapshot: LifecycleSnapshot): void
  showHost(origin: string): Promise<void>
}

/** 将生命周期状态变化连接到已封装的 Desktop 窗口。 */
export function wireLifecycleToWindow(
  lifecycle: ApplicationLifecycle,
  desktopWindow: LifecycleDesktopWindow
): () => void {
  return lifecycle.subscribe(snapshot => {
    desktopWindow.publishSnapshot(snapshot)
    if (snapshot.state !== 'ready' || !snapshot.origin) return
    void desktopWindow.showHost(snapshot.origin).catch(error => { void lifecycle.reportHostNavigationFailure(error) })
  })
}

export interface QuitEvent { preventDefault(): void }
export interface QuitApplication {
  on(event: 'window-all-closed', listener: () => void): unknown
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown
  quit(): void
}

/** 在最后一个窗口关闭时有序停止 Host 并落盘诊断信息。 */
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
