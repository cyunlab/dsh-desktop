/** 从目标平台与 launch environment 推导 Tauri app config/cache 的唯一 updater 边界。 */
export function platformStatePaths(target: string, environment: Readonly<Record<string, string | undefined>>): {
  readonly configRoot: string
  readonly cacheRoot: string
  readonly logFile: string
  readonly stagedMetadata: string
  readonly stagedPackage: string
}

/** 从有界 JSONL 日志中解析与本次启动配置严格匹配的身份记录。 */
export function matchingConfigurationIdentityEvents(logBody: Buffer, expected: Readonly<{
  endpoint: string
  publicKeySha256: string
  platform: string
  version: string
  launchedAt: number
}>): ReadonlyArray<Readonly<{
  event: string
  app_version: string
  endpoint: string
  public_key_sha256: string
  platform: string
  correlation_id: string
  recorded_at: string
  process_id: number
}>>

/** 验证 staged metadata 与完整下载包同时绑定本次候选。 */
export function verifyStagedCandidate(metadata: unknown, packageBytes: Buffer, expected: Readonly<Record<string, string>>): true

/** 为真实原生关闭/退出生成不经过 shell 的精确命令。 */
export function nativeCloseCommandPlan(target: string, launch: Readonly<Record<string, unknown>>): {
  readonly executable: string
  readonly args: readonly string[]
  readonly environment: Readonly<Record<string, string>>
}

/** 在固定 Xvfb 内先启动 EWMH window manager，再以位置参数启动 exact AppImage。 */
export function linuxX11LaunchPlan(installationPath: string): {
  readonly executable: string
  readonly args: readonly string[]
  readonly display: string
  readonly xauthority: string
}

/** 先等待固定 Host ready，再观察依赖页面加载的 Linux X11 主窗口。 */
export function waitForLinuxDesktopReadiness<T>(waitForHost: () => Promise<unknown>, waitForWindow: () => Promise<T>): Promise<T>

/** 从 wmctrl 快照中只选择属于 Desktop 进程树的唯一窗口。 */
export function selectLinuxDesktopWindow(output: string, processPids: readonly number[]): string | undefined

/** 从 wmctrl 快照中只解析后续绑定所需的窗口 ID 与 PID。 */
export function parseLinuxDesktopWindows(output: string): ReadonlyArray<Readonly<{ windowId: string; pid: number }>>

/** hosted Windows 无交互 WebView 会话时跳过 Host readiness。 */
export function requiresDesktopHostReadiness(target: string): boolean

/** 从脱敏更新日志提取最新失败阶段，并识别无需等待自动重试的永久 HTTP 失败。 */
export function nativeUpdaterFailureSummary(logBody: Buffer): {
  readonly message: string
  readonly permanent: boolean
} | undefined

/** 从 ps 的 PID + command 行中只选 exact executable 及其参数。 */
export function parseDesktopProcessRows(output: string, executable: string): number[]

/** 判断 /proc/PID/environ 是否含 exact APPIMAGE 路径。 */
export function processEnvironmentContainsAppImage(environmentBytes: Buffer, installPath: string): boolean

/** 比较更新前后 canonical 安装根与主程序。 */
export function sameInstallationLocation(
  target: string,
  baseline: Readonly<Record<string, unknown>>,
  updated: Readonly<Record<string, unknown>>,
): boolean

/** 创建四平台 previous-Stable→candidate 正常退出升级的真实系统适配器。 */
export function createNativeUpdatePlatformAdapter(target: string, environment?: NodeJS.ProcessEnv, dependencies?: Readonly<Record<string, unknown>>): import('./native-update-smoke-driver.mjs').NativeUpdatePlatformAdapter
