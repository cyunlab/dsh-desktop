export type UpdateProgress =
  | { kind: 'unknown_total'; downloaded_bytes: number }
  | { kind: 'known_total'; downloaded_bytes: number; total_bytes: number }

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up_to_date' }
  | { kind: 'available'; version: string; release_notes: string }
  | { kind: 'downloading'; version: string; release_notes: string; progress: UpdateProgress }
  | { kind: 'staged'; version: string; release_notes: string }
  | { kind: 'failed'; operation: 'check' | 'download'; retryable: boolean; message: string }

export interface UpdateSnapshot {
  sequence: number
  state: UpdateState
  automatic_download: boolean
}

export interface UpdateModalApi {
  getCurrentVersion(): Promise<string>
  getSnapshot(): Promise<UpdateSnapshot>
  onSnapshot(listener: (snapshot: UpdateSnapshot) => void): () => void
  retry(): Promise<void>
  restart(): Promise<void>
  later(): Promise<void>
}

export interface UpdateElement {
  textContent: string | null
  hidden: boolean
  disabled?: boolean
  value?: number
  max?: number
  removeAttribute(name: string): void
  addEventListener(type: 'click', listener: () => void): void
}

export interface UpdateDocument {
  querySelector(selector: string): UpdateElement | null
}

/** 连接更新模态框与 Rust 所有的完整快照。 */
export function connectUpdatePage(api: UpdateModalApi, document: UpdateDocument): () => void {
  const currentVersion = requiredElement(document, '#update-current-version')
  const heading = requiredElement(document, '#update-state')
  const message = requiredElement(document, '#update-message')
  const progress = requiredElement(document, '#update-progress')
  const progressLabel = requiredElement(document, '#update-progress-label')
  const notes = requiredElement(document, '#update-release-notes')
  const retry = requiredElement(document, '#update-retry')
  const later = requiredElement(document, '#update-later')
  const restart = requiredElement(document, '#update-restart')
  let retryAvailable = false
  let renderedSequence = -1
  /** 按单调序号渲染 Rust 完整快照，避免较旧初始请求覆盖事件。 */
  const render = (snapshot: UpdateSnapshot): void => {
    if (snapshot.sequence < renderedSequence) return
    renderedSequence = snapshot.sequence
    const state = snapshot.state
    progress.hidden = state.kind !== 'downloading'
    progressLabel.textContent = ''
    message.textContent = ''
    notes.textContent = ''
    retryAvailable = state.kind === 'failed' && state.retryable
    retry.hidden = !retryAvailable
    retry.disabled = false
    restart.hidden = state.kind !== 'staged'
    restart.disabled = false
    if (state.kind === 'checking') {
      heading.textContent = 'Checking for updates…'
      return
    }
    if (state.kind === 'idle' || state.kind === 'up_to_date') {
      heading.textContent = 'You’re up to date'
      return
    }
    if (state.kind === 'available') {
      heading.textContent = `Version ${state.version} is available`
      notes.textContent = state.release_notes
      return
    }
    if (state.kind === 'downloading') {
      heading.textContent = `Downloading version ${state.version}`
      notes.textContent = state.release_notes
      if (state.progress.kind === 'known_total') {
        progress.value = state.progress.downloaded_bytes
        progress.max = state.progress.total_bytes
        const percent = state.progress.total_bytes === 0
          ? 0
          : Math.floor(state.progress.downloaded_bytes * 100 / state.progress.total_bytes)
        progressLabel.textContent = `${percent}% downloaded`
      } else {
        progress.removeAttribute('value')
        progressLabel.textContent = `${formatBytes(state.progress.downloaded_bytes)} downloaded`
      }
      return
    }
    if (state.kind === 'failed') {
      heading.textContent = 'Update failed'
      message.textContent = state.message
      return
    }
    if (state.kind === 'staged') {
      heading.textContent = `Version ${state.version} is ready`
      message.textContent = '是否重启以更新应用'
      notes.textContent = state.release_notes
    }
  }
  retry.addEventListener('click', () => {
    if (!retryAvailable || retry.disabled) return
    retry.disabled = true
    void api.retry().catch(() => { retry.disabled = false })
  })
  later.addEventListener('click', () => { void api.later().catch(() => undefined) })
  restart.addEventListener('click', () => {
    if (restart.hidden || restart.disabled) return
    restart.disabled = true
    void api.restart().catch(() => { restart.disabled = false })
  })
  void api.getCurrentVersion()
    .then(version => { currentVersion.textContent = `Current version ${version}` })
    .catch(() => { currentVersion.textContent = 'Current version unavailable' })
  const unsubscribe = api.onSnapshot(render)
  void api.getSnapshot().then(render).catch(() => undefined)
  return unsubscribe
}

/** 把未知总量的已下载字节格式化为简洁可读的大小。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 获取更新界面的必需元素，缺失时暴露打包模板错误。 */
function requiredElement(document: UpdateDocument, selector: string): UpdateElement {
  const found = document.querySelector(selector)
  if (!found) throw new Error(`Missing update element: ${selector}`)
  return found
}
