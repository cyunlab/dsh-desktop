import type { LifecycleSnapshot, StartupApi } from '../shared/startup-contract.js'

export interface StartupElement {
  textContent: string | null
  hidden: boolean
  addEventListener(type: 'click', listener: () => void): void
}

export interface StartupDocument {
  querySelector(selector: string): StartupElement | null
}

export function connectStartupPage(api: StartupApi, document: StartupDocument): () => void {
  const state = requiredElement(document, '#state')
  const message = requiredElement(document, '#message')
  const actions = requiredElement(document, '#actions')
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
    actions.hidden = snapshot.state !== 'failed'
  }
  requiredElement(document, '#retry').addEventListener('click', () => { void api.retry().catch(() => undefined) })
  requiredElement(document, '#copy').addEventListener('click', () => { void api.copyDiagnostics().catch(() => undefined) })
  requiredElement(document, '#logs').addEventListener('click', () => { void api.revealLogs().catch(() => undefined) })
  const unsubscribe = api.onSnapshot(render)
  void api.getSnapshot().then(render).catch(() => undefined)
  return unsubscribe
}

function requiredElement(document: StartupDocument, selector: string): StartupElement {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`Missing startup element: ${selector}`)
  return element
}
