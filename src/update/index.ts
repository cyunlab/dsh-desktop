import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up_to_date' }
  | { kind: 'available'; version: string; release_notes: string }
  | { kind: 'staged'; version: string; release_notes: string }
  | { kind: 'downloading'; version: string; release_notes: string; progress: { kind: string; downloaded_bytes: number; total_bytes?: number } }
  | { kind: 'failed'; message: string }

interface UpdateSnapshot { sequence: number; state: UpdateState; automatic_download: boolean }

const heading = document.querySelector<HTMLElement>('#update-state')!
const message = document.querySelector<HTMLElement>('#update-message')!
const actions = document.querySelector<HTMLElement>('#update-actions')!
const restart = document.querySelector<HTMLButtonElement>('#update-restart')!

/** 将 Rust 完整快照渲染到 Desktop 打包来源的更新界面。 */
function render(snapshot: UpdateSnapshot): void {
  const state = snapshot.state
  actions.hidden = state.kind !== 'staged'
  if (state.kind === 'checking') { heading.textContent = 'Checking for updates…'; message.textContent = ''; return }
  if (state.kind === 'up_to_date' || state.kind === 'idle') { heading.textContent = 'You’re up to date'; message.textContent = ''; return }
  if (state.kind === 'available') { heading.textContent = `Version ${state.version} is available`; message.textContent = state.release_notes; return }
  if (state.kind === 'downloading') { heading.textContent = `Downloading ${state.version}`; message.textContent = state.progress.kind === 'known_total' ? `${Math.floor(state.progress.downloaded_bytes * 100 / (state.progress.total_bytes ?? 1))}%` : `${state.progress.downloaded_bytes} bytes`; return }
  if (state.kind === 'staged') { heading.textContent = `Version ${state.version} is ready`; message.textContent = 'Restart Desktop when you are ready to finish updating.'; return }
  heading.textContent = 'Update failed'; message.textContent = state.message
}

restart.addEventListener('click', () => {
  restart.disabled = true
  void invoke('app_update_restart').catch(() => { restart.disabled = false })
})

render(await invoke<UpdateSnapshot>('app_update_snapshot'))
await listen<UpdateSnapshot>('app-update:snapshot', event => render(event.payload))
