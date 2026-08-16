import { contextBridge, ipcRenderer } from 'electron'
import { startupChannels, type LifecycleSnapshot, type StartupApi } from '../shared/startup-contract.js'

if (globalThis.location.protocol === 'file:') {
  const api: StartupApi = Object.freeze({
    getSnapshot: () => ipcRenderer.invoke(startupChannels.snapshot) as Promise<LifecycleSnapshot>,
    onSnapshot(listener: (snapshot: LifecycleSnapshot) => void) {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: LifecycleSnapshot) => listener(snapshot)
      ipcRenderer.on(startupChannels.snapshot, handler)
      return () => ipcRenderer.removeListener(startupChannels.snapshot, handler)
    },
    retry: () => ipcRenderer.invoke(startupChannels.retry) as Promise<void>,
    copyDiagnostics: () => ipcRenderer.invoke(startupChannels.copyDiagnostics) as Promise<void>,
    revealLogs: () => ipcRenderer.invoke(startupChannels.revealLogs) as Promise<void>
  })
  contextBridge.exposeInMainWorld('desktopStartup', api)
}
