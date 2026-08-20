/** 固定的当前平台 runtime target。 */
export interface RuntimeTarget {
  readonly platform: 'win32' | 'darwin' | 'linux'
  readonly arch: 'x64' | 'arm64'
  readonly resourceName: string
}

/** 随 Tauri 应用发布的 runtime asset。 */
export interface RuntimeAsset {
  readonly path: string
  readonly kind: 'file' | 'non-empty-directory'
  readonly category: string
  readonly executable: boolean
}

/** 返回当前构建平台的运行时约束。 */
export function runtimeTarget(runtimePlatform?: string, runtimeArch?: string): RuntimeTarget

/** 返回需要随应用发布的原生运行时文件清单。 */
export function requiredRuntimeAssets(target: RuntimeTarget): RuntimeAsset[]

/** 验证 production runtime closure 的依赖图和原生资产。 */
export function verifyRuntimeClosure(root: string, target: RuntimeTarget): Promise<true>

/** 生成并物化当前目标平台的 production runtime closure。 */
export function prepareRuntimeClosure(options?: {
  readonly projectRoot?: string
  readonly outputRoot?: string
  readonly target?: RuntimeTarget
}): Promise<string>
