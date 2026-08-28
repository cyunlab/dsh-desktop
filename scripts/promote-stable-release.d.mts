export interface PromotionStorage {
  /** 只写一次 immutable 对象，或复用字节完全相同的已有对象。 */
  ensureObject(key: string, body: Buffer, metadata: ObjectMetadata): Promise<'uploaded' | 'reused'>
  /** 覆盖可变对象，并由 OSS Versioning 保留历史版本。 */
  replaceObject(key: string, body: Buffer, metadata: ObjectMetadata): Promise<void>
  /** 读取远端对象的原始字节。 */
  readObject(key: string): Promise<Buffer>
}

export interface ObjectMetadata { readonly cacheControl: string; readonly contentType?: string }

export interface PromotionOptions {
  readonly tag: string
  readonly releaseBody: string
  readonly publishedAt: string
  readonly artifactsDirectory: string
  readonly downloadOrigin: string
  readonly prefix: string
}

export interface StableManifest {
  readonly version: string
  readonly notes: string
  readonly pub_date: string
  readonly platforms: Readonly<Record<string, { readonly url: string; readonly signature: string }>>
}

export interface OssutilResult { readonly stdout: Buffer; readonly stderr: string }
export type MinisignRunner = (args: string[], options: { readonly shell: false; readonly env: NodeJS.ProcessEnv }) => Promise<void>
export interface OssutilStorageOptions {
  readonly bucket: string
  readonly region: string
  readonly prefix: string
  readonly credentials: {
    readonly accessKeyId: string
    readonly accessKeySecret: string
    readonly securityToken: string
  }
  readonly runOssutil?: (args: string[], options: { readonly env: NodeJS.ProcessEnv }) => Promise<OssutilResult>
}

/** 创建使用短期 STS 环境变量的 OSS 存储适配器。 */
export function createOssutilStorage(options: OssutilStorageOptions): PromotionStorage

/** 以无 shell 子进程运行 ossutil。 */
export function runOssutilCommand(args: string[], options?: { readonly env?: NodeJS.ProcessEnv }): Promise<OssutilResult>

/** 以无 shell 子进程运行 minisign。 */
export function runMinisignCommand(args: string[], options?: { readonly env?: NodeJS.ProcessEnv }): Promise<void>

/** 使用公钥验证一个 updater 产物及其签名。 */
export function verifyTauriSignature(
  artifactPath: string,
  signaturePath: string,
  publicKey: string,
  runMinisign?: MinisignRunner
): Promise<void>

/** 解析 CLI/environment 并执行 Stable promotion。 */
export function runPromotionCli(
  environment?: NodeJS.ProcessEnv,
  dependencies?: {
    readonly createStorage?: (options: OssutilStorageOptions) => PromotionStorage
    readonly promote?: typeof promoteStableRelease
    readonly verifySignature?: (artifactPath: string, signaturePath: string) => Promise<void>
    readonly runMinisign?: MinisignRunner
  },
  args?: string[]
): Promise<StableManifest>

/** 提升一个完整的四目标更新发布。 */
export function promoteStableRelease(
  options: PromotionOptions,
  storage: PromotionStorage,
  dependencies: { readonly verifySignature: (artifactPath: string, signaturePath: string) => Promise<void> }
): Promise<StableManifest>
