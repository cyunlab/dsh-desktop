import { existsSync } from 'node:fs'
import path from 'node:path'

/** 返回当前平台的 Tauri debug 应用路径。 */
export function applicationPath() {
  const name = process.platform === 'win32' ? 'deepseek-harness-desktop.exe' : 'deepseek-harness-desktop'
  return path.resolve('src-tauri', 'target', 'debug', name)
}

/** 返回 ensure-node-sidecar 下载的官方 Node 路径。 */
export function officialNodePath() {
  const names = { win32: 'windows', darwin: 'macos', linux: 'linux' }
  const arches = { x64: 'x86_64', arm64: 'aarch64' }
  const platform = names[process.platform]
  const arch = arches[process.arch]
  if (!platform || !arch) throw new Error(`unsupported E2E platform: ${process.platform}-${process.arch}`)
  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  const candidate = path.resolve('resources', 'node', `${platform}-${arch}`, executable)
  if (!existsSync(candidate)) throw new Error(`official Node resource is missing: ${candidate}`)
  return candidate
}
