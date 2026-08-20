import type { LifecycleSnapshot, StartupApi } from '../shared/startup-contract.js'

export interface StartupElement {
  textContent: string | null
  hidden: boolean
  disabled?: boolean
  addEventListener(type: 'click', listener: () => void): void
}

export interface StartupDocument {
  querySelector(selector: string): StartupElement | null
}

/** 连接启动页与 Tauri 生命周期快照，并协调恢复操作的可用状态。 */
export function connectStartupPage(api: StartupApi, document: StartupDocument): () => void {
  const state = requiredElement(document, '#state')
  const message = requiredElement(document, '#message')
  const actions = requiredElement(document, '#actions')
  const retry = requiredElement(document, '#retry')
  const copy = requiredElement(document, '#copy')
  const logs = requiredElement(document, '#logs')
  let retryInFlight = false
  const headings: Record<LifecycleSnapshot['state'], string> = {
    starting: 'Starting…',
    'starting-sidecar': 'Starting local Host…',
    'waiting-for-client': 'Waiting for client to start…',
    'prolonged-startup': 'Still starting…',
    ready: 'Ready',
    failed: 'Startup failed',
    stopping: 'Stopping local Host…'
  }
  const render = (snapshot: LifecycleSnapshot): void => {
    state.textContent = headings[snapshot.state]
    message.textContent = snapshot.message
    if (snapshot.state === 'failed' || snapshot.state === 'ready') retryInFlight = false
    const recoveryAvailable = snapshot.state === 'failed' || snapshot.state === 'prolonged-startup'
    actions.hidden = !recoveryAvailable
    retry.disabled = retryInFlight || !recoveryAvailable
    copy.disabled = !recoveryAvailable
    logs.disabled = !recoveryAvailable
  }
  retry.addEventListener('click', () => {
    if (retry.disabled) return
    retryInFlight = true
    retry.disabled = true
    void api.retry().catch(() => {
      retryInFlight = false
      retry.disabled = false
    })
  })
  copy.addEventListener('click', () => { void api.copyDiagnostics().catch(() => undefined) })
  logs.addEventListener('click', () => { void api.revealLogs().catch(() => undefined) })
  const unsubscribe = api.onSnapshot(render)
  void api.getSnapshot().then(render).catch(() => undefined)
  return unsubscribe
}

/** 获取启动页必需元素，缺失时立即暴露构建或模板错误。 */
function requiredElement(document: StartupDocument, selector: string): StartupElement {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`Missing startup element: ${selector}`)
  return element
}
