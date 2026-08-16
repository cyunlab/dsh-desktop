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
    idle: 'Waiting to start',
    preparing: 'Preparing application data…',
    booting: 'Starting local Host…',
    probing: 'Checking local Web Client…',
    ready: 'Web Client is ready',
    failed: 'Startup failed',
    retrying: 'Cleaning up before retry…',
    stopping: 'Stopping local Host…',
    stopped: 'Stopped'
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
