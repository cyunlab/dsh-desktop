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

/** 验证 Tauri 产物、架构和资源。 */
export function verifyTauriArtifact(platformName: string, options?: VerifyTauriArtifactOptions): Promise<string>
