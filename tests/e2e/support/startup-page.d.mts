export interface StartupPageSnapshot {
  readonly url: string
  readonly readyState?: string
  readonly title?: string
  readonly state?: string
  readonly message?: string
  readonly requiredElements: readonly boolean[]
}

export interface StartupPageWaitOptions {
  readonly timeout?: number
  readonly interval?: number
}

/** 判断一个 WebDriver 页面快照是否已经提交了真实的 packaged startup page。 */
export function isPackagedStartupPage(snapshot: StartupPageSnapshot): boolean
/** 等待 embedded WebDriver 越过窗口句柄就绪点，并返回已提交的真实启动页快照。 */
export function waitForPackagedStartupPage(browser: WebdriverIO.Browser, options?: StartupPageWaitOptions): Promise<StartupPageSnapshot>
