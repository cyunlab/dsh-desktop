import { describe, expect, it } from 'vitest'
import {
  connectUpdatePage,
  type UpdateDocument,
  type UpdateElement,
  type UpdateSnapshot,
  type UpdateState
} from '../../src/update/controller.js'

/** 创建可观察文本、可见性与点击行为的最小 DOM 元素。 */
function element(): UpdateElement & { click(): void } {
  const listeners: Array<() => void> = []
  return {
    textContent: '',
    hidden: false,
    disabled: false,
    value: undefined,
    max: undefined,
    removeAttribute(name) { if (name === 'value') this.value = undefined },
    addEventListener(_type, listener) { listeners.push(listener) },
    click() { for (const listener of listeners) listener() }
  }
}

/** 创建更新模态框测试使用的真实选择器边界。 */
function modalDocument() {
  const elements = new Map<string, ReturnType<typeof element>>([
    ['#update-current-version', element()],
    ['#update-state', element()],
    ['#update-message', element()],
    ['#update-release-notes', element()],
    ['#update-progress', element()],
    ['#update-progress-label', element()],
    ['#update-retry', element()],
    ['#update-later', element()],
    ['#update-restart', element()]
  ])
  return {
    document: { querySelector: selector => elements.get(selector) ?? null } satisfies UpdateDocument,
    elements
  }
}

/** 连接可主动推送快照的测试 Adapter。 */
function connect(initialState: UpdateState) {
  const view = modalDocument()
  let listener: ((snapshot: UpdateSnapshot) => void) | undefined
  const actions = { retry: 0, restart: 0, later: 0 }
  const api = {
    getCurrentVersion: async () => '2.0.15',
    getSnapshot: async () => ({ sequence: 1, automatic_download: true, state: initialState }),
    onSnapshot: (next: typeof listener) => { listener = next; return () => {} },
    retry: async () => { actions.retry += 1 },
    restart: async () => { actions.restart += 1 },
    later: async () => { actions.later += 1 }
  }
  connectUpdatePage(api, view.document)
  return {
    ...view,
    actions,
    emit(state: typeof initialState) { listener?.({ sequence: 2, automatic_download: true, state }) }
  }
}

describe('packaged update modal', () => {
  /** 可用更新展示当前版本、目标版本和 GitHub Release notes。 */
  it('shows the current and available versions with release notes', async () => {
    const view = modalDocument()
    connectUpdatePage({
      getCurrentVersion: async () => '2.0.15',
      getSnapshot: async () => ({
        sequence: 1,
        automatic_download: false,
        state: { kind: 'available', version: '2.1.0', release_notes: 'Safer updates\nNew sidebar action' }
      }),
      onSnapshot: () => () => {},
      retry: async () => {},
      restart: async () => {},
      later: async () => {}
    }, view.document)
    await Promise.resolve()
    await Promise.resolve()

    expect(view.elements.get('#update-current-version')?.textContent).toBe('Current version 2.0.15')
    expect(view.elements.get('#update-state')?.textContent).toBe('Version 2.1.0 is available')
    expect(view.elements.get('#update-release-notes')?.textContent).toBe('Safer updates\nNew sidebar action')
  })

  /** 已知总量使用确定进度，未知总量保留无 value 的不确定进度。 */
  it('renders determinate and indeterminate download progress', () => {
    const view = connect({
      kind: 'downloading',
      version: '2.1.0',
      release_notes: 'Notes',
      progress: { kind: 'known_total', downloaded_bytes: 25, total_bytes: 100 }
    })
    view.emit({
      kind: 'downloading',
      version: '2.1.0',
      release_notes: 'Notes',
      progress: { kind: 'known_total', downloaded_bytes: 25, total_bytes: 100 }
    })
    expect(view.elements.get('#update-progress')?.hidden).toBe(false)
    expect(view.elements.get('#update-progress')?.value).toBe(25)
    expect(view.elements.get('#update-progress')?.max).toBe(100)
    expect(view.elements.get('#update-progress-label')?.textContent).toBe('25% downloaded')

    view.emit({
      kind: 'downloading',
      version: '2.1.0',
      release_notes: 'Notes',
      progress: { kind: 'unknown_total', downloaded_bytes: 1_572_864 }
    })
    expect(view.elements.get('#update-progress')?.value).toBeUndefined()
    expect(view.elements.get('#update-progress-label')?.textContent).toBe('1.5 MB downloaded')
  })

  /** 只有 Rust 标记为可重试的失败才显示并接受 retry。 */
  it('offers retry for retryable failures but not terminal failures', () => {
    const view = connect({ kind: 'failed', operation: 'download', retryable: true, message: 'Connection lost' })
    view.emit({ kind: 'failed', operation: 'download', retryable: true, message: 'Connection lost' })
    expect(view.elements.get('#update-state')?.textContent).toBe('Update failed')
    expect(view.elements.get('#update-message')?.textContent).toBe('Connection lost')
    expect(view.elements.get('#update-retry')?.hidden).toBe(false)
    view.elements.get('#update-retry')?.click()
    expect(view.actions.retry).toBe(1)

    view.emit({ kind: 'failed', operation: 'check', retryable: false, message: 'Invalid signature' })
    expect(view.elements.get('#update-retry')?.hidden).toBe(true)
    view.elements.get('#update-retry')?.click()
    expect(view.actions.retry).toBe(1)
  })

  /** staged 更新明确询问重启，并允许稍后关闭而不消费状态。 */
  it('asks whether to restart and lets the user choose Later', () => {
    const view = connect({ kind: 'staged', version: '2.1.0', release_notes: 'Ready notes' })
    view.emit({ kind: 'staged', version: '2.1.0', release_notes: 'Ready notes' })
    expect(view.elements.get('#update-state')?.textContent).toBe('Version 2.1.0 is ready')
    expect(view.elements.get('#update-message')?.textContent).toBe('是否重启以更新应用')
    expect(view.elements.get('#update-release-notes')?.textContent).toBe('Ready notes')
    expect(view.elements.get('#update-restart')?.hidden).toBe(false)
    expect(view.actions).toEqual({ retry: 0, restart: 0, later: 0 })

    view.elements.get('#update-later')?.click()
    expect(view.actions.later).toBe(1)
    view.elements.get('#update-restart')?.click()
    expect(view.actions.restart).toBe(1)
  })
})
