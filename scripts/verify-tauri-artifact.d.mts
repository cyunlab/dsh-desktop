/** Tauri 产物验收选项。 */
export interface VerifyTauriArtifactOptions {
  readonly projectRoot?: string
  readonly runtimeArch?: string
  readonly inspectContainer?: boolean
}

/** 读取 PE 可执行文件架构。 */
export function readPeArchitecture(file: string): Promise<string>

/** 读取 ELF 可执行文件架构。 */
export function readElfArchitecture(file: string): Promise<string>

/** 读取 Mach-O 可执行文件架构。 */
export function readMachOArchitecture(file: string): Promise<string>

/** 验证 Tauri 产物、架构和资源。 */
export function verifyTauriArtifact(platformName: string, options?: VerifyTauriArtifactOptions): Promise<string>
