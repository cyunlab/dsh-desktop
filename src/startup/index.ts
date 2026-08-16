import type { LifecycleSnapshot } from '../shared/startup-contract.js'

const api = window.desktopStartup
if (!api) throw new Error('Desktop startup bridge is unavailable')
const state = document.querySelector<HTMLElement>('#state')!
const message = document.querySelector<HTMLElement>('#message')!
const actions = document.querySelector<HTMLElement>('#actions')!

function render(snapshot: LifecycleSnapshot): void {
  state.textContent = snapshot.state === 'failed' ? 'Startup failed' : 'Starting local Host…'
  message.textContent = snapshot.message
  actions.hidden = snapshot.state !== 'failed'
}

document.querySelector('#retry')!.addEventListener('click', () => void api.retry())
document.querySelector('#copy')!.addEventListener('click', () => void api.copyDiagnostics())
document.querySelector('#logs')!.addEventListener('click', () => void api.revealLogs())
api.onSnapshot(render)
void api.getSnapshot().then(render)
