export interface BootstrapCommandPlan {
  readonly install: { readonly executable: string; readonly args: readonly string[]; readonly environment: Readonly<Record<string, string>> }
  readonly discovery?: { readonly registryRoot: string; readonly locationRoot: string }
  readonly launch?: { readonly executable: string; readonly args: readonly string[]; readonly environment: Readonly<Record<string, string>> }
  readonly replacementPath?: string
  readonly trustChecks?: readonly { readonly executable: string; readonly args: readonly string[]; readonly appendApplication: boolean }[]
}

/** 为受信目标生成不经过 shell 的原生 fresh-install 命令计划。 */
export function buildBootstrapCommandPlan(options: {
  readonly target: string
  readonly packagePath: string
  readonly installRoot: string
  readonly signingConfigured?: boolean
}): BootstrapCommandPlan

/** 为 `/Applications` 中保留原名的 app 生成 hosted runner 已验证的最小 LaunchServices 启动计划。 */
export function buildMacLaunchPlan(application: string): {
  readonly executable: '/usr/bin/open'
  readonly args: readonly ['-a', string]
}

/** 为 hosted runner 生成保留 bundle 原名且必须预先不存在的 `/Applications` 路径。 */
export function macApplicationsStagingPath(): string

/** 只把真实桌面启动所需的受信系统变量传入原生进程，拒绝继承 CI 凭证。 */
export function selectBootstrapCommandEnvironment(environment: Readonly<Record<string, string | undefined>>): Record<string, string>

/** hosted Windows 无交互 WebView 会话时使用已安装 runtime 探测，其他平台仍要求 Desktop 监督 Host。 */
export function requiresDesktopHostReadiness(target: string): boolean

/** 在解压前校验 macOS tar member 与 symlink 均留在唯一 app 根内。 */
export function verifyMacArchiveListing(namesOutput: string, verboseOutput: string): true

/** 使用 Node 内置 Ed25519 对真实候选包验证 Tauri minisign 签名。 */
export function verifyTauriUpdaterSignature(packageBytes: Buffer, encodedSignature: string, encodedPublicKey: string): Promise<true>

/** 无 shell 执行有界命令并收集诊断。 */
export function runCommand(executable: string, args: readonly string[], options?: {
  readonly cwd?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly outputBound?: number
}): Promise<string>

/** 启动真实 Desktop 主进程并保留有界诊断。 */
export function launchApplication(executable: string, args: readonly string[], environment: Readonly<Record<string, string | undefined>>): {
  readonly pid: number | undefined
  readonly exitCode: () => number | null | undefined
  readonly exitStatus: () => string | undefined
  readonly diagnostics: () => string
}

/** 读取固定 loopback Host 的有界 HTTP 响应。 */
export function requestLoopbackHttp(url?: string, timeoutMilliseconds?: number, maximumBytes?: number): Promise<{
  readonly statusCode: number
  readonly contentType: string
  readonly body: string
}>

/** 从平台端口工具输出解析唯一固定 Host listener PID。 */
export function parseListenerProcessId(output: unknown): number

/** 校验运行时 updater configuration identity 属于本次 Desktop 启动。 */
export function verifyConfigurationIdentityEvent(event: unknown, expectations: {
  readonly endpoint: string
  readonly publicKeySha256: string
  readonly appVersion: string
  readonly platform: string
  readonly processId?: number
  readonly launchedAt: number
}): true

/** 按 Windows 路径语义校验 NSIS 当前用户安装记录与版本。 */
export function verifyWindowsInstallationRecord(record: {
  readonly DisplayVersion?: unknown
  readonly WindowsInstaller?: unknown
}, version: string, installLocation: string, userRoot: string): true

/** 解析注册表中可选成对引号包裹的绝对 Windows 安装路径。 */
export function normalizeWindowsRegistryPath(value: unknown): string

/** 把主流程错误与 finally 清理错误合并，避免后者覆盖真正失败原因。 */
export function combineBootstrapFailure(primaryError: Error | undefined, cleanupErrors: readonly (Error | undefined)[]): Error | undefined

/** 执行真实四平台 fresh-install 并仅在所有检查成功后返回观察。 */
export function runNativeBootstrapDriver(options: Readonly<Record<string, string>>, environment?: Readonly<Record<string, string | undefined>>): Promise<unknown>
