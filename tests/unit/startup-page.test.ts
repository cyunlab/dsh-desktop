import { describe, expect, it } from 'vitest'
import { isPackagedStartupPage, waitForPackagedStartupPage } from '../e2e/support/startup-page.mjs'

/** 返回包含真实 packaged startup page 关键状态的测试快照。 */
function startupSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    url: 'http://tauri.localhost/index.html',
    readyState: 'complete',
    title: 'DeepSeek Harness Desktop',
    state: 'Starting local Host…',
    message: 'Starting.',
    requiredElements: [true, true, true, true, true, true],
    ...overrides
  }
}

describe('packaged startup page synchronization', () => {
  /** 验证 embedded session 的 about:blank 不能满足启动页断言。 */
  it('does not mistake an about:blank WebDriver session for the startup page', () => {
    expect(isPackagedStartupPage(startupSnapshot({ url: 'about:blank' }))).toBe(false)
  })

  /** 验证等待器会先读取 URL，再对已提交页面执行 DOM 检查。 */
  it('waits through a transient about:blank session before executing page checks', async () => {
    const urls = ['about:blank', 'http://tauri.localhost/']
    let executeCalls = 0
    const fakeBrowser = {
      getUrl: async () => urls.shift() ?? 'http://tauri.localhost/',
      execute: async () => {
        executeCalls += 1
        return startupSnapshot({ url: 'http://tauri.localhost/' })
      },
      waitUntil: async (condition: () => Promise<boolean>) => {
        while (!(await condition())) {}
      }
    } as unknown as WebdriverIO.Browser

    await expect(waitForPackagedStartupPage(fakeBrowser)).resolves.toMatchObject({ url: 'http://tauri.localhost/' })
    expect(executeCalls).toBe(1)
  })

  /** 验证 packaged URL、生命周期文案和必需 DOM 缺一不可。 */
  it('requires the committed packaged URL, lifecycle state, and required DOM', () => {
    expect(isPackagedStartupPage(startupSnapshot())).toBe(true)
    expect(isPackagedStartupPage(startupSnapshot({ url: 'http://127.0.0.1:4312/' }))).toBe(false)
    expect(isPackagedStartupPage(startupSnapshot({ state: 'Ready' }))).toBe(false)
    expect(isPackagedStartupPage(startupSnapshot({ requiredElements: [true, true, false, true, true, true] }))).toBe(false)
  })
})
