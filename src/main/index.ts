import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ApplicationLifecycle } from './application.js'
import { wireFinalWindowShutdown, wireLifecycleToWindow } from './application-wiring.js'
import { HarnessHostLauncher } from './harness-host-launcher.js'
import { NavigationPolicy } from './navigation-policy.js'
import { selectDesktopPaths } from './paths.js'
import { SingleInstanceFocusCoordinator } from './single-instance-focus.js'
import { assertSupportedNodeVersion } from './version-guard.js'
import { openExternalSafely } from './window-effects.js'
import { startupChannels } from '../shared/startup-contract.js'
import { RollingDiagnostics, type DiagnosticContext } from './diagnostics.js'
import { createStartupActions } from './startup-actions.js'

app.setName('DeepSeek Harness Desktop')
assertSupportedNodeVersion(process.versions.node)
const focusCoordinator = new SingleInstanceFocusCoordinator()
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => focusCoordinator.requestFocus())
  void run()
}

async function run(): Promise<void> {
  await app.whenReady()

  const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const startupPath = path.join(distRoot, 'startup', 'index.html')
  const startupUrl = pathToFileURL(startupPath).href
  const paths = selectDesktopPaths(app)
  const diagnosticContext: DiagnosticContext = {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch
  }
  const diagnostics = new RollingDiagnostics(paths.logs, diagnosticContext)
  const lifecycle = new ApplicationLifecycle(new HarnessHostLauncher(), paths, 5_000, diagnostics)
  const policy = new NavigationPolicy(startupUrl)
  let window: BrowserWindow | null = null

  const createWindow = (): BrowserWindow => {
    const created = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 720,
      minHeight: 520,
      title: 'DeepSeek Harness Desktop',
      show: false,
      webPreferences: {
        preload: path.join(distRoot, 'preload', 'startup.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })
    created.once('ready-to-show', () => created.show())
    created.webContents.on('will-navigate', (event, target) => {
      const decision = policy.decide(target)
      if (decision === 'allow') return
      event.preventDefault()
      diagnostics.navigationRejected(target, decision)
      if (decision === 'external') void openExternalSafely(url => shell.openExternal(url), target)
    })
    created.webContents.setWindowOpenHandler(({ url }) => {
      const decision = policy.decide(url)
      diagnostics.navigationRejected(url, decision)
      if (decision === 'external') void openExternalSafely(target => shell.openExternal(target), url)
      return { action: 'deny' }
    })
    created.on('closed', () => {
      focusCoordinator.detach(created)
      window = null
    })
    focusCoordinator.attach(created)
    return created
  }

  window = createWindow()
  await window.loadFile(startupPath)
  wireLifecycleToWindow(lifecycle, () => window, startupPath, startupChannels.snapshot, policy)

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
