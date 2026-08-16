import { mkdir } from 'node:fs/promises'
import path from 'node:path'

export interface PathProvider { getPath(name: 'userData' | 'logs'): string }

export interface DesktopPaths {
  readonly harnessHome: string
  readonly fallbackWorkspace: string
  readonly logs: string
}

export function selectDesktopPaths(provider: PathProvider): DesktopPaths {
  const root = path.join(provider.getPath('userData'), 'deepseek-harness-desktop')
  return Object.freeze({
    harnessHome: path.join(root, 'harness-home'),
    fallbackWorkspace: path.join(root, 'fallback-workspace'),
    logs: provider.getPath('logs')
  })
}

export async function prepareDesktopPaths(paths: DesktopPaths): Promise<void> {
  await Promise.all(Object.values(paths).map(directory => mkdir(directory, { recursive: true })))
}
