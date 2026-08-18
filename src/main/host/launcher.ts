import type { DesktopPaths } from '../paths.js'

/** Host child 关闭时传递给生命周期协调器的最小结果。 */
export interface HostClosedEvent {
  readonly intentional: boolean
  readonly code?: number
  readonly signal?: NodeJS.Signals
  readonly error?: Error
}

export interface HostHandle {
  readonly origin: string
  /** Actual listener values reported by the Host service after binding. */
  readonly binding?: Readonly<{ host: string; port: number }>
  /** Resolves once the Host closes; unexpected close has intentional=false. */
  readonly closed?: Promise<HostClosedEvent>
  dispose(): Promise<void>
}

export interface HostLauncher {
  launch(paths: DesktopPaths): Promise<HostHandle>
}
