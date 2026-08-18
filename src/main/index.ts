import { app, BrowserWindow, clipboard, ipcMain, Menu, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { ApplicationLifecycle } from './lifecycle/application.js'
import { wireFinalWindowShutdown, wireLifecycleToWindow } from './lifecycle/electron-wiring.js'
import { ProcessHostLauncher } from './host/process-launcher.js'
import { prepareDesktopPaths, selectDesktopPaths } from './paths.js'
import { assertSupportedNodeVersion } from './version-guard.js'
import { DesktopWindow, type DesktopBrowserWindow, type DesktopBrowserWindowOptions } from './window/desktop-window.js'
import type { NavigationDecision } from './window/navigation-policy.js'
import { startupChannels } from '../shared/startup-contract.js'
import { NullDiagnostics, RollingDiagnostics, type DiagnosticContext, type DiagnosticsSink } from './diagnostics.js'
import { createStartupActions } from './startup-actions.js'
import { FakeHostLauncher } from './host/fake-launcher.js'
import { recordE2EEvent, shouldSuppressExternalOpen } from './e2e-observer.js'
import { configureElectronRuntime } from './electron-runtime.js'

const desktopLogoFileName = 'dsh-desktop-logo.png'

app.setName('DeepSeek Harness Desktop')
configureElectronRuntime({
  platform: process.platform,
  removeApplicationMenu: () => Menu.setApplicationMenu(null)
})
if (__DSH_E2E__ && process.env.DSH_DESKTOP_TEST_USER_DATA) app.setPath('userData', process.env.DSH_DESKTOP_TEST_USER_DATA)
assertSupportedNodeVersion(process.versions.node)
const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const startupPath = path.join(distRoot, 'startup', 'index.html')
const desktopLogoPath = path.join(distRoot, 'assets', desktopLogoFileName)
let windowDiagnostics: Pick<DiagnosticsSink, 'navigationRejected'> = new NullDiagnostics()

/** 将窗口导航拒绝延迟委派给 app ready 后创建的诊断实现。 */
function reportWindowNavigationRejected(target: string, decision: NavigationDecision): void {
  windowDiagnostics.navigationRejected(target, decision)
}

/** 使用生产 Electron adapter 创建受控 BrowserWindow。 */
function createDesktopBrowserWindow(options: DesktopBrowserWindowOptions): DesktopBrowserWindow {
  return new BrowserWindow(options)
}

/** 将受控外链交给 E2E 观察器或操作系统默认浏览器。 */
async function openDesktopExternal(target: string): Promise<void> {
  if (__DSH_E2E__) {
    recordE2EEvent('external-link')
    if (shouldSuppressExternalOpen()) return
  }
  await shell.openExternal(target)
}

/** 记录窗口恢复事件。 */
function observeWindowRestored(): void { recordE2EEvent('window-restored') }

/** 记录窗口显示事件。 */
function observeWindowShown(): void { recordE2EEvent('window-shown') }

/** 记录窗口聚焦事件。 */
function observeWindowFocused(): void { recordE2EEvent('window-focused') }

/** 记录启动页完成加载事件。 */
function observeStartupPageLoaded(): void { recordE2EEvent('startup-page-loaded') }

/** 记录 Web Client 完成加载事件。 */
function observeWebClientLoaded(): void { recordE2EEvent('web-client-loaded') }

const desktopWindow = new DesktopWindow({
  startupPath,
  preloadPath: path.join(distRoot, 'preload', 'startup.cjs'),
  iconPath: desktopLogoPath,
  snapshotChannel: startupChannels.snapshot,
  diagnostics: { navigationRejected: reportWindowNavigationRejected },
  createBrowserWindow: createDesktopBrowserWindow,
  openExternal: openDesktopExternal,
  observe: __DSH_E2E__ ? {
    restored: observeWindowRestored,
    shown: observeWindowShown,
    focused: observeWindowFocused,
    startupPageLoaded: observeStartupPageLoaded,
    webClientLoaded: observeWebClientLoaded
  } : undefined
})
if (process.env.DSH_PACKAGED_HOST_PROBE === '1') {
  void runPackagedHostProbe()
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (__DSH_E2E__) recordE2EEvent('second-instance')
    desktopWindow.requestFocus()
  })
  void run()
}

/** 启动打包产物 Host 探针并以进程状态码报告结果。 */
async function runPackagedHostProbe(): Promise<void> {
  try {
    await app.whenReady()
    const paths = selectDesktopPaths(app)
    await prepareDesktopPaths(paths)
    const handle = await new ProcessHostLauncher({ readiness: { timeoutMs: 120_000 } }).launch(paths)
    try {
      process.stdout.write(`${JSON.stringify({ probe: 'packaged-host-ready', origin: handle.origin })}\n`)
    } finally {
      await handle.dispose()
    }
    app.exit(0)
  } catch (error) {
    process.stderr.write(`packaged Host probe failed: ${inspect(error, { depth: 12 })}\n`)
    app.exit(1)
  }
}

/** 在 Electron 就绪后组合 Desktop、Host 生命周期与 IPC 服务。 */
async function run(): Promise<void> {
  await app.whenReady()

  if (process.platform === 'darwin') app.dock?.setIcon(desktopLogoPath)
  const paths = selectDesktopPaths(app)
  const diagnosticContext: DiagnosticContext = {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch
  }
  const diagnostics = new RollingDiagnostics(paths.logs, diagnosticContext)
  windowDiagnostics = diagnostics
  const launcher = __DSH_E2E__ && process.env.DSH_DESKTOP_TEST_HOST === 'fake'
    ? new FakeHostLauncher(Number.parseInt(process.env.DSH_DESKTOP_TEST_FAILURES ?? '0', 10) || 0)
    : new ProcessHostLauncher()
  const lifecycle = new ApplicationLifecycle(launcher, paths, 5_000, diagnostics)
  await desktopWindow.open()
  wireLifecycleToWindow(lifecycle, desktopWindow)

  ipcMain.handle(startupChannels.snapshot, () => lifecycle.snapshot)
  ipcMain.handle(startupChannels.retry, () => lifecycle.retry())
  const startupActions = createStartupActions(
    () => lifecycle.snapshot,
    diagnosticContext,
    paths.logs,
    { writeClipboard: text => clipboard.writeText(text), revealPath: target => shell.openPath(target) },
    diagnostics
  )
  ipcMain.handle(startupChannels.copyDiagnostics, () => startupActions.copyDiagnostics())
  ipcMain.handle(startupChannels.revealLogs, () => startupActions.revealLogs())

  wireFinalWindowShutdown(app, lifecycle)

  await lifecycle.start()
}
