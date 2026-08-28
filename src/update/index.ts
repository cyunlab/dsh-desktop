import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { connectUpdatePage, type UpdateModalApi, type UpdateSnapshot } from './controller.js'

const api: UpdateModalApi = {
  getCurrentVersion: getVersion,
  getSnapshot: () => invoke<UpdateSnapshot>('app_update_snapshot'),
  onSnapshot(listener) {
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<UpdateSnapshot>('app-update:snapshot', event => listener(event.payload), { target: 'app-update' }).then(remove => {
      if (disposed) remove()
      else unlisten = remove
    })
    return () => { disposed = true; unlisten?.() }
  },
  retry: () => invoke('app_update_retry'),
  restart: () => invoke('app_update_restart'),
  later: () => getCurrentWindow().close()
}

connectUpdatePage(api, document)
