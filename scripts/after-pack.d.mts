import type { RuntimeTarget } from './runtime-assets.mjs'
interface AfterPackContextLike {
  appOutDir: string
  electronPlatformName: string
  arch: number | string
  packager: { appInfo: { productFilename: string } }
}
interface Dependencies {
  runCommand?: (command: string, args: string[], environment: Record<string, string>, timeoutMs?: number) => Promise<string>
  host?: RuntimeTarget
  log?: (message: string) => void
  prepareAssets?: (root: string, target: RuntimeTarget) => Promise<void>
}
export default function afterPack(context: AfterPackContextLike): Promise<void>
export function runAfterPack(context: AfterPackContextLike, dependencies?: Dependencies): Promise<void>
export function runCommandWithTimeout(command: string, args: string[], environment: Record<string, string>, timeoutMs?: number): Promise<string>
export function runTerminationCommand(command: string, args: string[], options?: {
  spawnProcess?: (...args: unknown[]) => { once(event: string, listener: (...args: unknown[]) => void): unknown; kill(signal: string): unknown }
  timeoutMs?: number
}): Promise<void>
