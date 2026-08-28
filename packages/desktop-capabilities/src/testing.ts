import type { AppUpdateCapability, AppUpdateObserver, AppUpdateSnapshot } from './index.js'
import { createAppUpdateCapabilityFacade } from './capability-facade.js'

/** 为测试保存当前状态并同步通知观察者。 */
class InMemoryAppUpdateCapability implements AppUpdateCapability {
  private readonly observers = new Set<AppUpdateObserver>()

  /** 使用测试指定的初始完整状态创建能力。 */
  constructor(private snapshot: AppUpdateSnapshot) {}

  /** 立即交付当前状态，并订阅后续状态。 */
  observe(observer: AppUpdateObserver): () => void {
    this.observers.add(observer)
    observer(this.snapshot)
    return () => this.observers.delete(observer)
  }

  /** 在测试 Adapter 中记录一次可信界面打开请求。 */
  async open(): Promise<void> {}

  /** 向仍在订阅的观察者发布新的完整状态。 */
  publish(snapshot: AppUpdateSnapshot): void {
    this.snapshot = snapshot
    for (const observer of this.observers) observer(snapshot)
  }
}

/** 控制内存 Adapter，而不扩大被测 capability 的公开权限。 */
export interface InMemoryAppUpdateController {
  publish(snapshot: AppUpdateSnapshot): void
}

/** 创建可确定性控制的内存更新能力。 */
export function createInMemoryAppUpdateCapability(initial: AppUpdateSnapshot): {
  readonly capability: AppUpdateCapability
  readonly controller: InMemoryAppUpdateController
} {
  const adapter = new InMemoryAppUpdateCapability(initial)
  return {
    capability: createAppUpdateCapabilityFacade(adapter),
    controller: { publish: snapshot => adapter.publish(snapshot) },
  }
}
