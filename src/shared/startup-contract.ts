export const startupChannels = {
  snapshot: 'startup:snapshot',
  retry: 'startup:retry',
  copyDiagnostics: 'startup:copy-diagnostics',
  revealLogs: 'startup:reveal-logs'
} as const

export type LifecycleState = 'idle' | 'preparing' | 'booting' | 'probing' | 'ready' | 'failed' | 'retrying' | 'stopping' | 'stopped'

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
  revealLogs(): Promise<void>
}

declare global {
  interface Window { desktopStartup?: StartupApi }
}
