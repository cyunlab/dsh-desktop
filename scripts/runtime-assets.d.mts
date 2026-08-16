export interface RuntimeTarget { platform: 'darwin' | 'linux' | 'win32'; arch: 'arm64' | 'x64' }
export interface RuntimeAsset {
  path: string
  kind: 'file' | 'non-empty-directory'
  category: string
  executable: boolean
}
export function targetFromAfterPackContext(context: { electronPlatformName: string; arch: number | string }): RuntimeTarget
export function shouldRunPackagedProbe(target: RuntimeTarget, host?: { platform: string; arch: string }): boolean
export function requiredRuntimeAssets(target: RuntimeTarget): RuntimeAsset[]
export function verifyRequiredRuntimeAssets(root: string, target: RuntimeTarget): Promise<string[]>
