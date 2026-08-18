/** Electron 应用菜单与进程环境所需的最小接口。 */
export interface ElectronRuntimeOptions {
  platform: NodeJS.Platform
  removeApplicationMenu(): void
}

/** 配置 Desktop 在各平台启动时所需的 Electron 运行时行为。 */
export function configureElectronRuntime(options: ElectronRuntimeOptions): void {
  if (options.platform !== 'win32') return
  options.removeApplicationMenu()
}
