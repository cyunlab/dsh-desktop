import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { LifecycleSnapshot, StartupApi } from '../shared/startup-contract.js'
import { connectStartupPage } from './controller.js'

declare const __DSH_E2E__: boolean

if (__DSH_E2E__) await import('@wdio/tauri-plugin')

const api: StartupApi = {
  getSnapshot: () => invoke<LifecycleSnapshot>('startup_snapshot'),
  onSnapshot(listener) {
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<LifecycleSnapshot>('startup:snapshot', event => listener(event.payload), { target: 'main' }).then(remove => {
      if (disposed) remove()
      else unlisten = remove
    })
    return () => { disposed = true; unlisten?.() }
  },
  retry: () => invoke('startup_retry'),
  copyDiagnostics: () => invoke('startup_copy_diagnostics')
}
connectStartupPage(api, document)
