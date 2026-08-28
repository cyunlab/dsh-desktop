import type { AppUpdateCapability } from './index.js'

/** 隐藏 Adapter 的内部控制方法，只留下正式 Interface 的两个入口。 */
export function createAppUpdateCapabilityFacade(adapter: AppUpdateCapability): AppUpdateCapability {
  return Object.freeze({
    observe: adapter.observe.bind(adapter),
    open: adapter.open.bind(adapter),
  })
}
