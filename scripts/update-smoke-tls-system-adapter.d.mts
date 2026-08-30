export interface TemporaryTlsIdentity {
  readonly authority: string
  readonly authorityKey: string
  readonly certificate: string
  readonly key: string
  readonly directory: string
  readonly sha1Fingerprint: string
  readonly trustName: string
}

/** 在不改写既有内容的前提下，追加唯一的 exact hostname loopback 映射。 */
export function buildTemporaryHostsBytes(original: Buffer, hostname: string, address: string): Buffer

/** 为唯一临时 CA 生成各平台精确、可逆的信任存储命令。 */
export function tlsTrustCommandPlan(platform: NodeJS.Platform, identity: Pick<TemporaryTlsIdentity, 'authority' | 'sha1Fingerprint' | 'trustName'>, linuxDestination: string): unknown

/** 无 shell 执行有界系统命令，并只传入显式环境。 */
export function runBoundedCommand(executable: string, args: readonly string[], options?: Readonly<Record<string, unknown>>): Promise<string>

/** 返回 runner-only TLS gate 的真实系统适配器。 */
export function createUpdateSmokeTlsSystemAdapter(environment?: NodeJS.ProcessEnv, dependencies?: Readonly<Record<string, unknown>>): import('./update-smoke-tls-gate.mjs').UpdateSmokeTlsSystemAdapter
