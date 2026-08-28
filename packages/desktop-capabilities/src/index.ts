import { createAppUpdateCapabilityFacade } from './capability-facade.js'

/** Desktop 更新界面实际需要关注的完整状态。 */
export type AppUpdateSnapshot =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'none' }
  | { readonly kind: 'available'; readonly version: string; readonly releaseNotes: string }
  | {
      readonly kind: 'downloading'
      readonly version: string
      readonly releaseNotes: string
      readonly downloadedBytes: number
      readonly totalBytes?: number
    }
  | { readonly kind: 'staged'; readonly version: string; readonly releaseNotes: string }
  | {
      readonly kind: 'failed'
      readonly operation: 'check' | 'download'
      readonly retryable: boolean
      readonly message: string
    }

/** 接收一次完整 Desktop 更新状态。 */
export type AppUpdateObserver = (snapshot: AppUpdateSnapshot) => void

/** 向客户端插件提供最小、任务级的 Desktop 更新能力。 */
export interface AppUpdateCapability {
  /** 立即交付当前完整状态，并持续观察严格有序的变化。 */
  observe(observer: AppUpdateObserver): () => void

  /** 请求打开 Desktop 自有的可信更新界面。 */
  open(): Promise<void>
}

/** 更新能力调用方可稳定处理的错误类别。 */
export type AppUpdateCapabilityErrorCode = 'unavailable' | 'native_failure'

/** 隔离不稳定的原生错误文本并提供稳定分类。 */
export class AppUpdateCapabilityError extends Error {
  /** 创建带稳定错误码的更新能力错误。 */
  constructor(readonly code: AppUpdateCapabilityErrorCode, message: string) {
    super(message)
    this.name = 'AppUpdateCapabilityError'
  }
}

/** 表示当前页面不是 Desktop 可信运行环境。 */
class UnavailableAppUpdateCapability implements AppUpdateCapability {
  /** 立即告知调用方 Desktop 能力不可用。 */
  observe(observer: AppUpdateObserver): () => void {
    observer({ kind: 'unavailable' })
    return () => undefined
  }

  /** 拒绝在普通浏览器中打开 Desktop 更新界面。 */
  async open(): Promise<void> {
    throw new AppUpdateCapabilityError(
      'unavailable',
      'Desktop update capability is unavailable.',
    )
  }
}

/** 创建适用于普通浏览器的不可用 Adapter。 */
export function createUnavailableAppUpdateCapability(): AppUpdateCapability {
  return createAppUpdateCapabilityFacade(new UnavailableAppUpdateCapability())
}

export { createTauriAppUpdateCapability } from './tauri-adapter.js'
