/** 从目标平台与 launch environment 推导 Tauri app config/cache 的唯一 updater 边界。 */
export function platformStatePaths(target: string, environment: Readonly<Record<string, string | undefined>>): {
  readonly configRoot: string
  readonly cacheRoot: string
  readonly logFile: string
  readonly stagedMetadata: string
  readonly stagedPackage: string
}

/** 验证 staged metadata 与完整下载包同时绑定本次候选。 */
export function verifyStagedCandidate(metadata: unknown, packageBytes: Buffer, expected: Readonly<Record<string, string>>): true

/** 为真实原生关闭/退出生成不经过 shell 的精确命令。 */
export function nativeCloseCommandPlan(target: string, launch: Readonly<Record<string, unknown>>): {
  readonly executable: string
  readonly args: readonly string[]
  readonly environment: Readonly<Record<string, string>>
}

/** 创建四平台 previous-Stable→candidate 正常退出升级的真实系统适配器。 */
export function createNativeUpdatePlatformAdapter(target: string, environment?: NodeJS.ProcessEnv, dependencies?: Readonly<Record<string, unknown>>): import('./native-update-smoke-driver.mjs').NativeUpdatePlatformAdapter
