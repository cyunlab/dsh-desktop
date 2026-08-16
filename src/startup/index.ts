import type { LifecycleSnapshot } from '../shared/startup-contract.js'

const api = window.desktopStartup
if (!api) throw new Error('Desktop startup bridge is unavailable')
const state = document.querySelector<HTMLElement>('#state')!
const message = document.querySelector<HTMLElement>('#message')!
const actions = document.querySelector<HTMLElement>('#actions')!

function render(snapshot: LifecycleSnapshot): void {
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
  state.textContent = headings[snapshot.state]
  message.textContent = snapshot.message
  actions.hidden = snapshot.state !== 'failed'
}

document.querySelector('#retry')!.addEventListener('click', () => { void api.retry().catch(() => undefined) })
document.querySelector('#copy')!.addEventListener('click', () => { void api.copyDiagnostics().catch(() => undefined) })
document.querySelector('#logs')!.addEventListener('click', () => { void api.revealLogs().catch(() => undefined) })
api.onSnapshot(render)
void api.getSnapshot().then(render).catch(() => undefined)
