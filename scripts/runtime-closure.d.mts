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

/** 打包 Node 与发布 CLI 组成的可移植命令。 */
export interface PackagedDshCliCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly environment: Readonly<NodeJS.ProcessEnv>
}

/** 构造或执行发布 CLI 所需的可移植运行时选项。 */
export interface PackagedDshCliOptions {
  readonly nodeExecutable: string
  readonly nodeModulesRoot: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly environment?: NodeJS.ProcessEnv
}

/** 一次发布 CLI 探测的退出和诊断结果。 */
export interface PackagedDshCliProbeResult {
  readonly code: 0
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly command: PackagedDshCliCommand
}

/** 返回当前构建平台的运行时约束。 */
export function runtimeTarget(runtimePlatform?: string, runtimeArch?: string): RuntimeTarget

/** 返回需要随应用发布的原生运行时文件清单。 */
export function requiredRuntimeAssets(target: RuntimeTarget): RuntimeAsset[]

/** 计算 Runtime closure 的 workspace 输入指纹。 */
export function runtimeInputHash(root: string, target: RuntimeTarget): Promise<string>

/** 按发布包的 package.json#bin.dsh 契约解析 CLI 入口。 */
export function resolveDshCliEntry(root: string): Promise<string>

/** 构造显式使用打包 Node 和便携依赖树的发布 CLI 命令。 */
export function packagedDshCliCommand(options: PackagedDshCliOptions): Promise<PackagedDshCliCommand>

/** 用显式打包 Node 执行一次发布 CLI 探测。 */
export function probePackagedDshCli(options: PackagedDshCliOptions): Promise<PackagedDshCliProbeResult>

/** 验证 production runtime closure 的依赖图和原生资产。 */
export function verifyRuntimeClosure(root: string, target: RuntimeTarget): Promise<true>

/** 生成并物化当前目标平台的 production runtime closure。 */
export function prepareRuntimeClosure(options?: {
  readonly projectRoot?: string
  readonly outputRoot?: string
  readonly target?: RuntimeTarget
}): Promise<string>
