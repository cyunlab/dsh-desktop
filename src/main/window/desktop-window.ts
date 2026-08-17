import { pathToFileURL } from 'node:url'
import type { DiagnosticsSink } from '../diagnostics.js'
import type { LifecycleSnapshot } from '../../shared/startup-contract.js'
import { NavigationPolicy, type NavigationDecision } from './navigation-policy.js'

/** DesktopWindow 实际创建窗口时使用的最小安全配置。 */
export interface DesktopBrowserWindowOptions {
  width: number
  height: number
  minWidth: number
  minHeight: number
  title: string
  icon: string
  show: false
  webPreferences: {
    preload: string
    nodeIntegration: false
    contextIsolation: true
    sandbox: true
  }
}

/** DesktopWindow 所需的受控 webContents 表面。 */
export interface DesktopWebContents {
  on(event: 'did-finish-load', listener: () => void): unknown
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, target: string) => void): unknown
  setWindowOpenHandler(listener: (details: { url: string }) => { action: 'deny' }): unknown
  send(channel: string, snapshot: LifecycleSnapshot): void
  getURL(): string
}

/** DesktopWindow 所需的受控 BrowserWindow 表面。 */
export interface DesktopBrowserWindow {
  once(event: 'ready-to-show', listener: () => void): unknown
  on(event: 'closed', listener: () => void): unknown
  isDestroyed(): boolean
  destroy(): void
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  loadFile(path: string): Promise<unknown>
  loadURL(url: string): Promise<unknown>
  readonly webContents: DesktopWebContents
}

/** 记录窗口交互和页面加载的可选观测接口。 */
export interface DesktopWindowEventObserver {
  restored(): void
  shown(): void
  focused(): void
  startupPageLoaded(): void
  webClientLoaded(): void
}

/** 构造受控 DesktopWindow 的依赖与静态路径配置。 */
export interface DesktopWindowOptions {
  startupPath: string
  preloadPath: string
  iconPath: string
  snapshotChannel: string
  diagnostics: Pick<DiagnosticsSink, 'navigationRejected'>
  openExternal(url: string): Promise<unknown>
  createBrowserWindow(options: DesktopBrowserWindowOptions): DesktopBrowserWindow
  observe?: Partial<DesktopWindowEventObserver>
}

/** 将 BrowserWindow、安全导航、焦点与生命周期快照收敛为一个 Desktop 概念。 */
export class DesktopWindow {
  readonly #policy: NavigationPolicy
  readonly #observe: Required<DesktopWindowEventObserver>
  #window?: DesktopBrowserWindow
  #opening?: Promise<void>
  #pendingFocus = false

  /** 以路径、事件及窄化的 BrowserWindow 工厂建立 Desktop 窗口所有权。 */
  constructor(private readonly options: DesktopWindowOptions) {
    this.#policy = new NavigationPolicy(pathToFileURL(options.startupPath).href)
    this.#observe = {
      restored: options.observe?.restored ?? (() => {}),
      shown: options.observe?.shown ?? (() => {}),
      focused: options.observe?.focused ?? (() => {}),
      startupPageLoaded: options.observe?.startupPageLoaded ?? (() => {}),
      webClientLoaded: options.observe?.webClientLoaded ?? (() => {})
    }
  }

  /** 打开启动页；重复调用不会创建第二个仍存活的窗口。 */
  open(): Promise<void> {
    if (this.#opening) return this.#opening
    if (this.#liveWindow()) return Promise.resolve()
    let opening!: Promise<void>
    opening = this.#createAndLoad().finally(() => {
      if (this.#opening === opening) this.#opening = undefined
    })
    this.#opening = opening
    return opening
  }

  /** 创建窗口并加载启动页，失败时销毁并释放当前所有权。 */
  async #createAndLoad(): Promise<void> {
    const window = this.options.createBrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 720,
      minHeight: 520,
      title: 'DeepSeek Harness Desktop',
      icon: this.options.iconPath,
      show: false,
      webPreferences: {
        preload: this.options.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })
    this.#window = window
    this.#attach(window)
    try {
      await window.loadFile(this.options.startupPath)
    } catch (error) {
      if (this.#window === window) this.#window = undefined
      try {
        if (!window.isDestroyed()) window.destroy()
      } catch { /* 清理失败不能覆盖启动页加载错误。 */ }
      throw error
    }
  }

  /** 请求把当前窗口恢复、显示并聚焦；窗口未创建时保留请求。 */
  requestFocus(): void {
    const window = this.#liveWindow()
    if (!window) {
      this.#pendingFocus = true
      return
    }
    this.#focus(window)
  }

  /** 向当前启动页发送最新生命周期快照。 */
  publishSnapshot(snapshot: LifecycleSnapshot): void {
    this.#liveWindow()?.webContents.send(this.options.snapshotChannel, snapshot)
  }

  /** 允许指定 Host origin 并导航；失败时恢复启动页后仍向调用方报告原始错误。 */
  async showHost(origin: string): Promise<void> {
    const window = this.#liveWindow()
    if (!window) return
    this.#policy.setHostOrigin(origin)
    try {
      await window.loadURL(origin)
    } catch (error) {
      try { await window.loadFile(this.options.startupPath) } catch { /* 保留原始 Host 导航错误。 */ }
      throw error
    }
  }

  /** 返回当前仍可安全操作的窗口。 */
  #liveWindow(): DesktopBrowserWindow | undefined {
    return this.#window && !this.#window.isDestroyed() ? this.#window : undefined
  }

  /** 绑定新窗口的显示、关闭、导航和页面加载行为。 */
  #attach(window: DesktopBrowserWindow): void {
    window.once('ready-to-show', () => window.show())
    window.webContents.on('did-finish-load', () => {
      if (window.webContents.getURL().startsWith('file:')) this.#observe.startupPageLoaded()
      else this.#observe.webClientLoaded()
    })
    window.webContents.on('will-navigate', (event, target) => this.#handleNavigation(event, target))
    window.webContents.setWindowOpenHandler(({ url }) => {
      this.#rejectNavigation(url, this.#policy.decide(url))
      return { action: 'deny' }
    })
    window.on('closed', () => {
      if (this.#window === window) this.#window = undefined
    })
    if (!this.#pendingFocus) return
    this.#pendingFocus = false
    this.#focus(window)
  }

  /** 执行主框架导航策略。 */
  #handleNavigation(event: { preventDefault(): void }, target: string): void {
    const decision = this.#policy.decide(target)
    if (decision === 'allow') return
    event.preventDefault()
    this.#rejectNavigation(target, decision)
  }

  /** 记录拒绝导航，并在适用时安全委派外部链接。 */
  #rejectNavigation(target: string, decision: NavigationDecision): void {
    this.options.diagnostics.navigationRejected(target, decision)
    if (decision === 'external') void this.#openExternal(target)
  }

  /** 吞掉操作系统外部链接打开失败，避免未处理的拒绝。 */
  async #openExternal(target: string): Promise<void> {
    try { await this.options.openExternal(target) } catch { /* 外部应用失败不影响受控窗口。 */ }
  }

  /** 以既定观察顺序恢复、显示并聚焦窗口。 */
  #focus(window: DesktopBrowserWindow): void {
    if (window.isMinimized()) {
      window.restore()
      this.#observe.restored()
    }
    window.show()
    this.#observe.shown()
    window.focus()
    this.#observe.focused()
  }
}
