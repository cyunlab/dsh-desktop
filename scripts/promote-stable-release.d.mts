export interface PromotionStorage {
  /** 只写一次 immutable 对象，或复用字节完全相同的已有对象。 */
  ensureObject(key: string, body: Buffer, metadata: ObjectMetadata): Promise<'uploaded' | 'reused'>
  /** 覆盖可变对象，并由 OSS Versioning 保留历史版本。 */
  replaceObject(key: string, body: Buffer, metadata: ObjectMetadata): Promise<void>
  /** 读取远端对象的原始字节。 */
  readObject(key: string): Promise<Buffer>
  /** 使用 OSS AppendObject(position=0) 原子获取全局 Stable promotion lock。 */
  acquirePromotionLock?(key: string, ownerBody: Buffer): Promise<void>
  /** 仅在 owner bytes 仍一致时释放全局 Stable promotion lock。 */
  releasePromotionLock?(key: string, ownerBody: Buffer): Promise<void>
}

export interface ObjectMetadata {
  readonly cacheControl: string
  readonly contentType?: string
  readonly downloadFilename?: string
}

export interface PromotionOptions {
  readonly tag: string
  readonly releaseBody: string
  readonly publishedAt: string
  readonly artifactsDirectory: string
  readonly downloadOrigin: string
  readonly prefix: string
}

export interface CandidatePreparationOptions extends PromotionOptions {
  readonly candidateCommit: string
}

export interface StableCandidate {
  readonly schema_version: 1
  readonly candidate_tag: string
  readonly candidate_commit: string
  readonly previous_stable_tag: string
  readonly previous_stable_version: string
  readonly previous_stable_url: string
  readonly previous_stable_manifest_sha256: string
  readonly manifest_url: string
  readonly manifest_sha256: string
  readonly manifest: StableManifest
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
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => Date
}

/** 创建使用短期 STS 环境变量的 OSS 存储适配器。 */
export function createOssutilStorage(options: OssutilStorageOptions): PromotionStorage

/** 以无 shell 子进程运行 ossutil。 */
export function runOssutilCommand(args: string[], options?: {
  readonly env?: NodeJS.ProcessEnv
  readonly executable?: string
}): Promise<OssutilResult>

/** 以无 shell 子进程运行 minisign。 */
export function runMinisignCommand(args: string[], options?: { readonly env?: NodeJS.ProcessEnv }): Promise<void>

/** 使用公钥验证一个 updater 产物及其签名。 */
export function verifyTauriSignature(
  artifactPath: string,
  signaturePath: string,
  publicKey: string,
  runMinisign?: MinisignRunner
): Promise<void>

/** 上传并验证不可变 candidate，但不修改 Stable。 */
export function prepareStableCandidate(
  options: CandidatePreparationOptions,
  storage: PromotionStorage,
  dependencies: { readonly verifySignature: (artifactPath: string, signaturePath: string) => Promise<void> }
): Promise<StableCandidate>

/** 复核 candidate 与上一 Stable 未漂移后，执行唯一的 Stable 写入。 */
export function finalizeStableCandidate(
  candidate: StableCandidate,
  storage: PromotionStorage,
  options: { readonly prefix?: string; readonly lockOwner: string }
): Promise<StableManifest>

/** 解析 candidate preparation CLI。 */
export function runCandidatePreparationCli(
  environment?: NodeJS.ProcessEnv,
  dependencies?: Record<string, unknown>,
  args?: string[]
): Promise<StableCandidate>

/** 解析 final promotion CLI。 */
export function runCandidateFinalizationCli(
  environment?: NodeJS.ProcessEnv,
  dependencies?: Record<string, unknown>,
  args?: string[]
): Promise<StableManifest>
