import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { connectUpdatePage, type UpdateModalApi, type UpdateSnapshot } from './controller.js'

const api: UpdateModalApi = {
  /** 读取当前 Desktop 版本。 */
  getCurrentVersion: getVersion,
  /** 读取 Rust 当前完整更新快照。 */
  getSnapshot: () => invoke<UpdateSnapshot>('app_update_snapshot'),
  /** 订阅仅投递到更新窗口的 Rust 完整快照。 */
  onSnapshot(listener) {
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<UpdateSnapshot>('app-update:snapshot', event => listener(event.payload), { target: 'app-update' }).then(remove => {
      if (disposed) remove()
      else unlisten = remove
    })
    return () => { disposed = true; unlisten?.() }
  },
  /** 请求 Rust 根据当前失败状态重试。 */
  retry: () => invoke('app_update_retry'),
  /** 请求 Rust 安装已暂存更新并重启。 */
  restart: () => invoke('app_update_restart'),
  /** 关闭当前打包来源更新窗口。 */
  later: () => getCurrentWindow().close()
}

connectUpdatePage(api, document)
