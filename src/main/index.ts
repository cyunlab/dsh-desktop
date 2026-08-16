import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ApplicationLifecycle } from './application.js'
import { HarnessHostLauncher } from './harness-host-launcher.js'
import { NavigationPolicy } from './navigation-policy.js'
import { selectDesktopPaths } from './paths.js'
import { SingleInstanceFocusCoordinator } from './single-instance-focus.js'
import { assertSupportedNodeVersion } from './version-guard.js'
import { navigateToHostSafely, openExternalSafely } from './window-effects.js'
import { startupChannels } from '../shared/startup-contract.js'

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
  const lifecycle = new ApplicationLifecycle(new HarnessHostLauncher(), paths)
  const policy = new NavigationPolicy(startupUrl)
  let window: BrowserWindow | null = null
  let quitting = false

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
      if (decision === 'external') void openExternalSafely(url => shell.openExternal(url), target)
    })
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (policy.decide(url) === 'external') void openExternalSafely(target => shell.openExternal(target), url)
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
  lifecycle.subscribe(snapshot => {
    if (!window || window.isDestroyed()) return
    window.webContents.send(startupChannels.snapshot, snapshot)
    if (snapshot.state === 'ready' && snapshot.origin) {
      policy.setHostOrigin(snapshot.origin)
      const targetWindow = window
      void navigateToHostSafely(
        () => targetWindow.loadURL(snapshot.origin!),
        () => targetWindow.loadFile(startupPath),
        error => { void lifecycle.reportHostNavigationFailure(error) }
      )
    }
  })

  ipcMain.handle(startupChannels.snapshot, () => lifecycle.snapshot)
  ipcMain.handle(startupChannels.retry, () => lifecycle.retry())
  ipcMain.handle(startupChannels.copyDiagnostics, () => clipboard.writeText(`DeepSeek Harness Desktop\nState: ${lifecycle.snapshot.state}\nMessage: ${lifecycle.snapshot.message}`))
  ipcMain.handle(startupChannels.revealLogs, () => shell.openPath(paths.logs))

  app.on('window-all-closed', () => { if (!quitting) app.quit() })
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void lifecycle.stop().finally(() => app.quit())
  })

  await lifecycle.start()
}
