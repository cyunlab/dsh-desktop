/** 固定 Node sidecar 版本。 */
export const NODE_VERSION: string

/** 官方 Node 目标描述。 */
export interface NodeTarget {
  readonly resourceName: string
  readonly archiveName: string
  readonly archiveRoot: string
  readonly relativeExecutable: string
  readonly archiveExecutable: string
  readonly archiveKind: 'zip' | 'tar'
  readonly archiveSha256: string
  readonly runtimePlatform: string
  readonly runtimeArch: string
}

/** sidecar 安装选项。 */
export interface EnsureNodeSidecarOptions {
  readonly projectRoot?: string
  readonly cacheRoot?: string
  readonly runtimePlatform?: string
  readonly runtimeArch?: string
  readonly fetchImpl?: typeof fetch
  readonly lockOptions?: DirectoryLockOptions
}

/** 原子目录锁的测试和恢复阈值。 */
export interface DirectoryLockOptions {
  readonly retryMilliseconds?: number
  readonly staleMilliseconds?: number
  readonly timeoutMilliseconds?: number
  readonly heartbeatMilliseconds?: number
}

/** 返回官方 Node 归档和资源布局。 */
export function getNodeTarget(runtimePlatform?: string, runtimeArch?: string): NodeTarget

/** 返回当前平台的 Node 归档缓存目录。 */
export function getNodeCacheRoot(environment?: NodeJS.ProcessEnv, home?: string, runtimePlatform?: string): string

/** 确保固定版本官方 Node sidecar 已安装。 */
export function ensureNodeSidecar(options?: EnsureNodeSidecarOptions): Promise<string>

/** 下载归档到临时文件。 */
export function download(url: string, destination: string, fetchImpl?: typeof fetch): Promise<void>

/** 计算本地文件 SHA-256。 */
export function sha256(file: string): Promise<string>

/** 查找展开目录中的 Node 可执行文件。 */
export function findExecutable(directory: string, relativeExecutable: string): Promise<string | undefined>

/** 使用带陈旧锁恢复的原子目录锁执行任务。 */
export function withDirectoryLock<T>(lockPath: string, action: () => Promise<T>, options?: DirectoryLockOptions): Promise<T>
