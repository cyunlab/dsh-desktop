import {
  AppUpdateCapabilityError,
  type AppUpdateCapability,
  type AppUpdateObserver,
  type AppUpdateSnapshot,
} from './index.js'
import { createAppUpdateCapabilityFacade } from './capability-facade.js'

/** 包内私有的窄 Tauri 传输边界，不允许调用任意 command。 */
interface AppUpdateTauriTransport {
  /** 订阅 Rust 发布的完整快照事件。 */
  listenSnapshot(observer: (snapshot: unknown) => void): Promise<() => void>

  /** 读取 Rust 当前完整快照。 */
  readSnapshot(): Promise<unknown>

  /** 请求 Rust 打开可信更新界面。 */
  openSurface(): Promise<void>
}

/** 已验证且仅供 Adapter 排序使用的原生完整快照。 */
interface OrderedAppUpdateSnapshot {
  readonly sequence: number
  readonly snapshot: AppUpdateSnapshot
}

/** 维护原生序列顺序并向客户端呈现窄能力。 */
class TauriAppUpdateCapability implements AppUpdateCapability {
  private readonly observers = new Set<AppUpdateObserver>()
  private sequence = -1
  private snapshot: AppUpdateSnapshot = { kind: 'none' }

  /** 绑定只允许打开可信更新界面的传输。 */
  constructor(private readonly transport: AppUpdateTauriTransport) {}

  /** 接受严格更新的原生快照并同步发布完整状态。 */
  acceptNative(value: unknown): void {
    const ordered = normalizeNativeSnapshot(value)
    if (ordered.sequence <= this.sequence) return
    this.sequence = ordered.sequence
    this.snapshot = ordered.snapshot
    for (const observer of this.observers) observer(this.snapshot)
  }

  /** 立即交付当前状态，并订阅后续严格有序状态。 */
  observe(observer: AppUpdateObserver): () => void {
    this.observers.add(observer)
    observer(this.snapshot)
    return () => this.observers.delete(observer)
  }

  /** 仅请求 Rust 打开 Desktop 自有更新界面。 */
  async open(): Promise<void> {
    try {
      await this.transport.openSurface()
    } catch {
      throw new AppUpdateCapabilityError(
        'native_failure',
        'Desktop could not open the update surface.',
      )
    }
  }
}

/** 断言动态输入是非空对象。 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppUpdateCapabilityError('native_failure', 'Desktop update state is invalid.')
  }
  return value as Record<string, unknown>
}

/** 读取原生状态中必须存在的字符串字段。 */
function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new AppUpdateCapabilityError('native_failure', 'Desktop update state is invalid.')
  }
  return value
}

/** 将 Rust 原生状态收窄为客户端 UI 状态。 */
function normalizeNativeState(value: unknown): AppUpdateSnapshot {
  const state = requireRecord(value)
  const kind = requireString(state, 'kind')
  if (kind === 'idle' || kind === 'checking' || kind === 'up_to_date') return { kind: 'none' }
  if (kind === 'available' || kind === 'staged') {
    return {
      kind,
      version: requireString(state, 'version'),
      releaseNotes: requireString(state, 'release_notes'),
    }
  }
  if (kind === 'downloading') {
    const progress = requireRecord(state.progress)
    const progressKind = requireString(progress, 'kind')
    const downloadedBytes = progress.downloaded_bytes
    const totalBytes = progress.total_bytes
    if (
      (progressKind !== 'unknown_total' && progressKind !== 'known_total') ||
      typeof downloadedBytes !== 'number' ||
      !Number.isFinite(downloadedBytes) ||
      downloadedBytes < 0 ||
      (progressKind === 'known_total' &&
        (typeof totalBytes !== 'number' || !Number.isFinite(totalBytes) || totalBytes < 0))
    ) {
      throw new AppUpdateCapabilityError('native_failure', 'Desktop update state is invalid.')
    }
    return {
      kind: 'downloading',
      version: requireString(state, 'version'),
      releaseNotes: requireString(state, 'release_notes'),
      downloadedBytes,
      ...(progressKind === 'known_total' ? { totalBytes: totalBytes as number } : {}),
    }
  }
  if (kind === 'failed') {
    const operation = state.operation
    if ((operation !== 'check' && operation !== 'download') || typeof state.retryable !== 'boolean') {
      throw new AppUpdateCapabilityError('native_failure', 'Desktop update state is invalid.')
    }
    return {
      kind: 'failed',
      operation,
      retryable: state.retryable,
      message: requireString(state, 'message'),
    }
  }
  throw new AppUpdateCapabilityError('native_failure', 'Desktop update state is invalid.')
}

/** 验证原生 sequence 并隐藏所有非 UI 字段。 */
function normalizeNativeSnapshot(value: unknown): OrderedAppUpdateSnapshot {
  const native = requireRecord(value)
  if (!Number.isSafeInteger(native.sequence) || (native.sequence as number) < 0) {
    throw new AppUpdateCapabilityError('native_failure', 'Desktop update state is invalid.')
  }
  return {
    sequence: native.sequence as number,
    snapshot: normalizeNativeState(native.state),
  }
}

/** 使用包内注入的窄传输建立先订阅后取快照的生产 Adapter。 */
export async function createTauriAppUpdateCapabilityWithTransport(
  transport: AppUpdateTauriTransport,
): Promise<AppUpdateCapability> {
  const capability = new TauriAppUpdateCapability(transport)
  let unlisten: () => void
  try {
    unlisten = await transport.listenSnapshot(snapshot => {
      try {
        capability.acceptNative(snapshot)
      } catch {
        // 原生异常事件不能破坏最后一个已验证状态或事件分发循环。
      }
    })
  } catch {
    throw new AppUpdateCapabilityError(
      'native_failure',
      'Desktop update state is unavailable.',
    )
  }
  try {
    capability.acceptNative(await transport.readSnapshot())
    return createAppUpdateCapabilityFacade(capability)
  } catch {
    unlisten()
    throw new AppUpdateCapabilityError(
      'native_failure',
      'Desktop update state is unavailable.',
    )
  }
}

/** 连接固定的 Tauri command 与事件，不接受调用方提供任何原生参数。 */
export async function createTauriAppUpdateCapability(): Promise<AppUpdateCapability> {
  try {
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ])
    return await createTauriAppUpdateCapabilityWithTransport({
      listenSnapshot: async observer =>
        listen<unknown>('app-update:snapshot', event => observer(event.payload)),
      readSnapshot: async () => invoke<unknown>('app_update_snapshot'),
      openSurface: async () => invoke<void>('app_update_open_surface'),
    })
  } catch (error) {
    if (error instanceof AppUpdateCapabilityError) throw error
    throw new AppUpdateCapabilityError(
      'native_failure',
      'Desktop update state is unavailable.',
    )
  }
}
