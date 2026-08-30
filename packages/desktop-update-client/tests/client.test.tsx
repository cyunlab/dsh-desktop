import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AppUpdateCapability, AppUpdateSnapshot } from '@cyunlab/dsh-desktop-capabilities'
import { UpdateIndicator, apply, applyWithCapability, createUpdatePresentation, createUpdateSnapshotSource } from '../src/client/index.tsx'
import { translateZh } from '../src/client/locales.ts'

/** 创建只暴露更新领域接口的测试能力。 */
function capabilityWith(snapshot: AppUpdateSnapshot) {
  const open = vi.fn(async () => undefined)
  const dispose = vi.fn()
  const capability: AppUpdateCapability = {
    observe(observer) {
      observer(snapshot)
      return dispose
    },
    open,
  }
  return { capability, dispose, open }
}

/** 创建能按顺序发布领域快照的测试能力。 */
function publishingCapability(initial: AppUpdateSnapshot) {
  let observer: ((snapshot: AppUpdateSnapshot) => void) | undefined
  const capability: AppUpdateCapability = {
    observe(nextObserver) {
      observer = nextObserver
      nextObserver(initial)
      return () => { observer = undefined }
    },
    async open() {},
  }
  return {
    capability,
    /** 发布一次后续快照。 */
    publish(snapshot: AppUpdateSnapshot) { observer?.(snapshot) },
  }
}

/** 创建可观察 slot 与 effect 生命周期的最小 ClientContext。 */
function clientContext() {
  const effects: Array<() => void> = []
  const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
  return {
    effects,
    registrations,
    ctx: {
      effect(factory: () => void | (() => void)) {
        const dispose = factory()
        if (dispose) effects.push(dispose)
      },
      locale: { register: vi.fn(() => vi.fn()) },
      slots: {
        register: vi.fn((options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return vi.fn()
        }),
      },
    },
  }
}

describe('Desktop update client', () => {
  /** unavailable 与无注意事项状态不得占用侧边栏。 */
  it.each([{ kind: 'unavailable' }, { kind: 'none' }] as const)('hides $kind state', snapshot => {
    expect(createUpdatePresentation(snapshot)).toBeUndefined()
  })

  /** 可用、失败与暂存状态映射为明确的用户注意信号。 */
  it.each([
    [{ kind: 'available', version: '2.1.0', releaseNotes: '' }, '有新版本 2.1.0', 'available'],
    [{ kind: 'failed', operation: 'download', retryable: true, message: 'offline' }, '更新失败', 'failed'],
    [{ kind: 'staged', version: '2.1.0', releaseNotes: '' }, '重启以更新到 2.1.0', 'staged'],
  ] as const)('maps %s to accessible attention copy', (snapshot, label, tone) => {
    expect(createUpdatePresentation(snapshot)).toMatchObject({ label, tone })
  })

  /** 已知总量呈现确定进度，未知总量保持不确定进度。 */
  it('distinguishes determinate and indeterminate downloads', () => {
    expect(createUpdatePresentation({ kind: 'downloading', version: '2.1.0', releaseNotes: '', downloadedBytes: 25, totalBytes: 100 }))
      .toMatchObject({ progress: { kind: 'determinate', value: 25 } })
    expect(createUpdatePresentation({ kind: 'downloading', version: '2.1.0', releaseNotes: '', downloadedBytes: 25 }))
      .toMatchObject({ progress: { kind: 'indeterminate' } })
  })

  /** 宽栏与窄栏都保留同一可访问名称，窄栏不重复可见文字。 */
  it('renders accessible wide and rail output', () => {
    const snapshot = { kind: 'available', version: '2.1.0', releaseNotes: '' } as const
    const wide = renderToStaticMarkup(<UpdateIndicator wide snapshot={snapshot} open={async () => undefined} />)
    const rail = renderToStaticMarkup(<UpdateIndicator wide={false} snapshot={snapshot} open={async () => undefined} />)
    expect(wide).toContain('aria-label="有新版本 2.1.0"')
    expect(wide).toContain('有新版本 2.1.0</span>')
    expect(rail).toContain('aria-label="有新版本 2.1.0"')
    expect(rail).not.toContain('有新版本 2.1.0</span>')
  })

  /** progressbar 只在已知总量时暴露数值，未知总量保持无 aria-valuenow。 */
  it('renders determinate and indeterminate progress semantics', () => {
    const known = renderToStaticMarkup(<UpdateIndicator
      wide
      snapshot={{ kind: 'downloading', version: '2.1.0', releaseNotes: '', downloadedBytes: 25, totalBytes: 100 }}
      open={async () => undefined}
    />)
    const unknown = renderToStaticMarkup(<UpdateIndicator
      wide
      snapshot={{ kind: 'downloading', version: '2.1.0', releaseNotes: '', downloadedBytes: 25 }}
      open={async () => undefined}
    />)
    expect(known).toContain('aria-valuenow="25"')
    expect(unknown).toContain('role="progressbar"')
    expect(unknown).not.toContain('aria-valuenow')
  })

  /** 普通浏览器使用 unavailable Adapter，正式 apply 仍不得渲染 Desktop action。 */
  it('renders no Desktop action in a normal browser', async () => {
    const runtime = clientContext()
    await apply(runtime.ctx)
    const registration = runtime.registrations[0]
    const Component = registration?.component as (props: { wide: boolean; t: typeof translateZh }) => ReturnType<typeof UpdateIndicator>
    expect(renderToStaticMarkup(<Component wide t={translateZh} />)).toBe('')
  })

  /** apply 注册真实 footer list slot，并让 capability 与 slot disposer 同属 effect 生命周期。 */
  it('registers and disposes the footer slot lifecycle', () => {
    const runtime = clientContext()
    const update = capabilityWith({ kind: 'available', version: '2.1.0', releaseNotes: '' })
    applyWithCapability(runtime.ctx, update.capability)
    expect(runtime.registrations).toHaveLength(1)
    expect(runtime.registrations[0]?.options).toMatchObject({
      name: 'sidebar.footer.action',
      id: 'dsh-desktop-update',
    })
    for (const dispose of runtime.effects.reverse()) dispose()
    expect(update.dispose).toHaveBeenCalledOnce()
  })

  /** capability 的后续状态必须通知 React 外部存储订阅者，dispose 后停止通知。 */
  it('publishes later snapshots through an observable source', () => {
    const update = publishingCapability({ kind: 'none' })
    const source = createUpdateSnapshotSource(update.capability)
    const changed = vi.fn()
    const unsubscribe = source.subscribe(changed)
    update.publish({ kind: 'available', version: '2.1.0', releaseNotes: '' })
    expect(changed).toHaveBeenCalledOnce()
    expect(source.getSnapshot()).toMatchObject({ kind: 'available', version: '2.1.0' })
    unsubscribe()
    source.dispose()
    update.publish({ kind: 'staged', version: '2.1.0', releaseNotes: '' })
    expect(changed).toHaveBeenCalledOnce()
  })

  /** 激活按钮只调用能力的 open，不获得其他原生操作。 */
  it('opens only the trusted Desktop surface', async () => {
    const update = capabilityWith({ kind: 'staged', version: '2.1.0', releaseNotes: '' })
    const tree = UpdateIndicator({ wide: true, snapshot: { kind: 'staged', version: '2.1.0', releaseNotes: '' }, open: update.capability.open.bind(update.capability) }) as { props: { onClick: () => Promise<void> } }
    await tree.props.onClick()
    expect(update.open).toHaveBeenCalledOnce()
  })
})
