import type { DesktopPaths } from '../paths.js'

export interface HostHandle {
  readonly origin: string
  /** Actual listener values reported by the Host service after binding. */
  readonly binding?: Readonly<{ host: string; port: number }>
  dispose(): Promise<void>
}

export interface HostLauncher {
  launch(paths: DesktopPaths): Promise<HostHandle>
}
