import type { DesktopPaths } from './paths.js'

export interface HostHandle {
  readonly origin: string
  dispose(): Promise<void>
}

export interface HostLauncher {
  launch(paths: DesktopPaths): Promise<HostHandle>
}
