export const startupChannels = {
  snapshot: 'startup:snapshot',
  retry: 'startup:retry',
  copyDiagnostics: 'startup:copy-diagnostics'
} as const

export type LifecycleState = 'starting' | 'waiting-for-client' | 'prolonged-startup' | 'ready' | 'failed' | 'stopping'

export interface LifecycleSnapshot {
  readonly state: LifecycleState
  readonly message: string
  readonly origin?: string
}

export interface StartupApi {
  getSnapshot(): Promise<LifecycleSnapshot>
  onSnapshot(listener: (snapshot: LifecycleSnapshot) => void): () => void
  retry(): Promise<void>
  copyDiagnostics(): Promise<void>
}

declare global {
  interface Window { desktopStartup?: StartupApi }
}
