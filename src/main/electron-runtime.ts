/** Electron 应用菜单与进程环境所需的最小接口。 */
export interface ElectronRuntimeOptions {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  removeApplicationMenu(): void
}

/** 配置 Desktop 在各平台启动 Harness 前所需的 Electron 运行时行为。 */
export function configureElectronRuntime(options: ElectronRuntimeOptions): void {
  if (options.platform !== 'win32') return
  options.removeApplicationMenu()
  // Harness 的 Win32 目录选择器通过 process.execPath 启动 Node worker；
  // 在 Electron 内 process.execPath 指向应用 exe，需要显式切换为 Node 模式。
  options.env.ELECTRON_RUN_AS_NODE = '1'
}
