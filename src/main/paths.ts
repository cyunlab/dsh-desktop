import { mkdir } from 'node:fs/promises'
import path from 'node:path'

export interface PathProvider { getPath(name: 'userData' | 'logs'): string }

export interface DesktopPaths {
  readonly harnessHome: string
  readonly defaultWorkingDirectory: string
  readonly logs: string
}

/** 选择 Desktop 管理的 Harness Home、默认工作目录和日志目录。 */
export function selectDesktopPaths(provider: PathProvider): DesktopPaths {
  const root = path.join(provider.getPath('userData'), 'deepseek-harness-desktop')
  return Object.freeze({
    harnessHome: path.join(root, 'harness-home'),
    defaultWorkingDirectory: path.join(root, 'default-working-directory'),
    logs: provider.getPath('logs')
  })
}

/** 创建 Desktop 启动所需的稳定可写目录。 */
export async function prepareDesktopPaths(paths: DesktopPaths): Promise<void> {
  await Promise.all(Object.values(paths).map(directory => mkdir(directory, { recursive: true })))
}
