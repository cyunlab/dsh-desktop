import { createElement, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { AppUpdateCapability, AppUpdateSnapshot } from '@cyunlab/dsh-desktop-capabilities'
import { createTauriAppUpdateCapability, createUnavailableAppUpdateCapability } from '@cyunlab/dsh-desktop-capabilities'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { UPDATE_LOCALE_NAMESPACE, en, translateZh, zh } from './locales.ts'
import type { UpdateLocaleKey } from './locales.ts'
import { installUpdateClientStyle } from './style.ts'

export type UpdateProgressPresentation =
  | { readonly kind: 'determinate'; readonly value: number }
  | { readonly kind: 'indeterminate' }

export interface UpdatePresentation {
  readonly label: string
  readonly tone: 'available' | 'downloading' | 'failed' | 'staged'
  readonly icon: string
  readonly progress?: UpdateProgressPresentation
}

export interface UpdateIndicatorProps extends SidebarFooterActionOwnerProps {
  readonly snapshot: AppUpdateSnapshot
  readonly open: () => Promise<void>
  readonly t?: (key: UpdateLocaleKey, parameters?: Record<string, unknown>) => string
}

interface UpdateClientContext {
  /** 注册随 Cordis fiber 释放的副作用。 */
  effect(factory: () => void | (() => void), label?: string): void
  locale: {
    /** 注册更新插件的本地化字典。 */
    register(namespace: string, dictionaries: { zh: typeof zh; en: typeof en }): () => void
  }
  slots: {
    /** 向正式侧边栏 footer action slot 注册一个稳定条目。 */
    register(
      options: { name: 'sidebar.footer.action'; id: string; order: number; locale: typeof UPDATE_LOCALE_NAMESPACE },
      component: (props: SidebarFooterActionOwnerProps & { t: NonNullable<UpdateIndicatorProps['t']> }) => ReactElement | null,
    ): () => void
  }
}

export interface UpdateSnapshotSource {
  /** 返回最新完整领域快照。 */
  getSnapshot(): AppUpdateSnapshot
  /** 订阅快照变更。 */
  subscribe(listener: () => void): () => void
  /** 释放领域观察与所有 React 订阅。 */
  dispose(): void
}

/** 将能力的立即观察协议适配为 React useSyncExternalStore 数据源。 */
export function createUpdateSnapshotSource(capability: AppUpdateCapability): UpdateSnapshotSource {
  let snapshot: AppUpdateSnapshot = { kind: 'unavailable' }
  const listeners = new Set<() => void>()
  let active = true
  const disposeCapability = capability.observe(nextSnapshot => {
    snapshot = nextSnapshot
    for (const listener of listeners) listener()
  })
  return {
    /** 返回最新完整领域快照。 */
    getSnapshot() { return snapshot },
    /** 订阅快照变化，并返回幂等取消函数。 */
    subscribe(listener) {
      if (!active) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** 关闭能力观察并清空所有 React 订阅。 */
    dispose() {
      if (!active) return
      active = false
      listeners.clear()
      disposeCapability()
    },
  }
}

/** 把下载字节转换为有界百分比，避免异常快照破坏 progressbar。 */
function downloadPercentage(downloadedBytes: number, totalBytes: number) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round((downloadedBytes / totalBytes) * 100)))
}

/** 将更新领域快照映射为侧边栏所需的最小呈现模型。 */
export function createUpdatePresentation(
  snapshot: AppUpdateSnapshot,
  t: NonNullable<UpdateIndicatorProps['t']> = translateZh,
): UpdatePresentation | undefined {
  switch (snapshot.kind) {
    case 'unavailable':
    case 'none':
      return undefined
    case 'available':
      return { label: t('available', { version: snapshot.version }), tone: 'available', icon: '↓' }
    case 'downloading': {
      const percentage = snapshot.totalBytes === undefined
        ? undefined
        : downloadPercentage(snapshot.downloadedBytes, snapshot.totalBytes)
      return {
        label: t('downloading', { version: snapshot.version }),
        tone: 'downloading',
        icon: '↓',
        progress: percentage === undefined
          ? { kind: 'indeterminate' }
          : { kind: 'determinate', value: percentage },
      }
    }
    case 'failed':
      return { label: t('failed'), tone: 'failed', icon: '!' }
    case 'staged':
      return { label: t('staged', { version: snapshot.version }), tone: 'staged', icon: '↻' }
  }
}

/** 渲染在宽栏和 rail 中共享可访问名称的更新操作。 */
export function UpdateIndicator({ wide, snapshot, open, t = translateZh }: UpdateIndicatorProps) {
  const presentation = createUpdatePresentation(snapshot, t)
  if (!presentation) return null
  const progress = presentation.progress
  const progressElement = progress
    ? createElement('span', {
        className: 'dsh-desktop-update-progress',
        role: 'progressbar',
        'aria-label': presentation.label,
        'aria-valuemin': progress.kind === 'determinate' ? 0 : undefined,
        'aria-valuemax': progress.kind === 'determinate' ? 100 : undefined,
        'aria-valuenow': progress.kind === 'determinate' ? progress.value : undefined,
        'data-indeterminate': progress.kind === 'indeterminate',
      }, createElement('span', { style: progress.kind === 'determinate' ? { width: `${progress.value}%` } : undefined }))
    : undefined
  return createElement('button', {
    type: 'button',
    className: 'dsh-desktop-update-action',
    'aria-label': presentation.label,
    'data-tone': presentation.tone,
    'data-wide': wide,
    onClick: open,
  },
  createElement('span', { className: 'dsh-desktop-update-icon', 'aria-hidden': true }, presentation.icon, progressElement),
  wide ? createElement('span', { className: 'dsh-desktop-update-copy' }, presentation.label) : undefined)
}

/** 以显式能力依赖注册 Desktop 更新 footer action，供生产 factory 与测试共用。 */
export function applyWithCapability(ctx: UpdateClientContext, capability: AppUpdateCapability) {
  const source = createUpdateSnapshotSource(capability)
  ctx.effect(() => source.dispose.bind(source), 'dsh-desktop-update: capability observation')
  ctx.effect(() => ctx.locale.register(UPDATE_LOCALE_NAMESPACE, { zh, en }), 'dsh-desktop-update: dictionaries')
  if (typeof document !== 'undefined') {
    ctx.effect(() => installUpdateClientStyle(), 'dsh-desktop-update: style')
  }
  /** 读取当前领域快照并委托纯呈现组件。 */
  function DesktopUpdateFooterAction({ wide, t }: SidebarFooterActionOwnerProps & { t: NonNullable<UpdateIndicatorProps['t']> }) {
    const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
    return createElement(UpdateIndicator, {
      wide,
      snapshot,
      open: capability.open.bind(capability),
      t,
    })
  }
  ctx.effect(() => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-desktop-update',
    order: 10,
    locale: UPDATE_LOCALE_NAMESPACE,
  }, DesktopUpdateFooterAction), 'dsh-desktop-update: footer action')
}

export const inject = ['slots', 'locale']

/** 判断页面是否运行在 Tauri WebView，普通浏览器不得尝试原生 IPC。 */
function isTauriPage(windowObject: Window = window) {
  return '__TAURI_INTERNALS__' in windowObject
}

/** 创建当前页面可用的最小更新能力，普通浏览器稳定返回 unavailable Adapter。 */
async function createPageAppUpdateCapability() {
  if (typeof window === 'undefined' || !isTauriPage()) return createUnavailableAppUpdateCapability()
  return createTauriAppUpdateCapability()
}

/** Harness Client loader 入口：解析页面 Adapter 后注册 footer action。 */
export async function apply(ctx: UpdateClientContext) {
  const capability = await createPageAppUpdateCapability()
  applyWithCapability(ctx, capability)
}
