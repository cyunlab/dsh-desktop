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

/** 在解压前校验 macOS tar member 与 symlink 均留在唯一 app 根内。 */
export function verifyMacArchiveListing(namesOutput: string, verboseOutput: string): true

/** 使用 Node 内置 Ed25519 对真实候选包验证 Tauri minisign 签名。 */
export function verifyTauriUpdaterSignature(packageBytes: Buffer, encodedSignature: string, encodedPublicKey: string): Promise<true>

/** 校验运行时 updater configuration identity 属于本次 Desktop 启动。 */
export function verifyConfigurationIdentityEvent(event: unknown, expectations: {
  readonly endpoint: string
  readonly publicKeySha256: string
  readonly platform: string
  readonly processId?: number
  readonly launchedAt: number
}): true
