/** Tauri 产物验收选项。 */
export interface VerifyTauriArtifactOptions {
  readonly projectRoot?: string
  readonly runtimeArch?: string
  readonly containerInspector?: (artifact: string, contract: Readonly<Record<string, string>>) => Promise<void>
}

/** 读取 PE 可执行文件架构。 */
export function readPeArchitecture(file: string): Promise<string>

/** 读取 ELF 可执行文件架构。 */
export function readElfArchitecture(file: string): Promise<string>

/** 读取 Mach-O 可执行文件架构。 */
export function readMachOArchitecture(file: string): Promise<string>

/** 验证安装包展开目录内真正交付的应用和资源。 */
export function verifyExtractedBundleContents(contentRoot: string, platformName: string, runtimeArch?: string): Promise<void>

/** 使用解包后的官方 Node 和 published CLI 启动固定 dsh web 并验证清理。 */
export function probeBundledRuntime(contentRoot: string, platformName: string, runtimeArch?: string, log?: (message: string) => void): Promise<void>

/** 删除安装包检查目录，并重试卸载后的短暂文件系统占用。 */
export function removeInspectionRoot(
  directory: string,
  remover?: (directory: string, options: { recursive: true; force: true }) => Promise<void>,
  options?: {
    readonly maxRetries?: number
    readonly retryDelayMilliseconds?: number
    readonly warn?: (message: string) => void
  }
): Promise<void>

export function detachMountedDmg(
  mountPoint: string,
  commandRunner?: (file: string, args: string[]) => Promise<unknown>,
  options?: { maxRetries?: number; retryDelayMilliseconds?: number; warn?: (message: string) => void }
): Promise<void>

/** 在真实 DMG 挂载点内执行检查，并在异常路径也确认卸载命令已发出。 */
export function inspectMountedDmg(
  artifact: string,
  inspectionRoot: string,
  inspect: (mountPoint: string) => Promise<void>,
  commandRunner?: (file: string, args: string[]) => Promise<unknown>
): Promise<void>

/** 验证 Tauri 产物、架构和资源。 */
export function verifyTauriArtifact(platformName: string, options?: VerifyTauriArtifactOptions): Promise<string>
