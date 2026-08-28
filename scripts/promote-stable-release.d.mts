export interface PromotionStorage {
  /** 上传对象到应用前缀内。 */
  putObject(key: string, body: Buffer, metadata: { readonly cacheControl: string; readonly contentType?: string }): Promise<void>
  /** 验证远端对象已可读取且与本地内容一致。 */
  verifyObject(key: string, body: Buffer): Promise<void>
}

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

/** 解析 CLI/environment 并执行 Stable promotion。 */
export function runPromotionCli(
  environment?: NodeJS.ProcessEnv,
  dependencies?: {
    readonly createStorage?: (options: OssutilStorageOptions) => PromotionStorage
    readonly promote?: typeof promoteStableRelease
  },
  args?: string[]
): Promise<StableManifest>

/** 提升一个完整的四目标更新发布。 */
export function promoteStableRelease(options: PromotionOptions, storage: PromotionStorage): Promise<StableManifest>
