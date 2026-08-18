import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** 兼容旧调用方的 Host launcher 名称；真实实现已经是进程隔离 adapter。 */
export { ProcessHostLauncher as HarnessHostLauncher } from './process-launcher.js'
export type { ProcessHostLauncherOptions as HarnessHostLauncherOptions } from './process-launcher.js'

/** 将 Electron ASAR 中的逻辑模块路径映射到实际解包的运行时目录。 */
export function resolveRuntimeManifestPath(resolvedUrl: string): string {
  const manifestPath = fileURLToPath(resolvedUrl)
  const archiveSegment = `${path.sep}app.asar${path.sep}`
  return manifestPath.includes(archiveSegment)
    ? manifestPath.replace(archiveSegment, `${path.sep}app.asar.unpacked${path.sep}`)
    : manifestPath
}
