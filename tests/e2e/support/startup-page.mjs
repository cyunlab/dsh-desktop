const PACKAGED_STARTUP_URL = /^(?:http:\/\/tauri\.localhost|tauri:\/\/localhost)\/(?:index\.html)?$/

const STARTUP_STATE_TEXT = new Set([
  'Starting…',
  'Starting local Host…',
  'Waiting for client to start…',
  'Still starting…',
  'Startup failed',
  'Stopping local Host…'
])

/** 判断一个 WebDriver 页面快照是否已经提交了真实的 packaged startup page。 */
export function isPackagedStartupPage(snapshot) {
  return PACKAGED_STARTUP_URL.test(snapshot.url)
    && snapshot.readyState === 'complete'
    && snapshot.title === 'DeepSeek Harness Desktop'
    && snapshot.state !== undefined
    && STARTUP_STATE_TEXT.has(snapshot.state)
    && snapshot.message !== undefined
    && snapshot.message.length > 0
    && snapshot.requiredElements.every(Boolean)
}

/** 读取启动页 URL、生命周期文案和必需 DOM，避免在 about:blank 上执行脚本。 */
async function readStartupPage(browser) {
  const url = await browser.getUrl()
  if (!PACKAGED_STARTUP_URL.test(url)) return { url, requiredElements: [] }
  return await browser.execute(() => ({
    url: window.location.href,
    readyState: document.readyState,
    title: document.title,
    state: document.querySelector('#state')?.textContent?.trim(),
    message: document.querySelector('#message')?.textContent?.trim(),
    requiredElements: ['#state', '#message', '#actions', '#retry', '#copy', '#logs']
      .map(selector => Boolean(document.querySelector(selector)))
  }))
}

/** 等待 embedded WebDriver 越过窗口句柄就绪点，并返回已提交的真实启动页快照。 */
export async function waitForPackagedStartupPage(browser, options = {}) {
  const timeout = options.timeout ?? 30_000
  let latest = { url: '<unavailable>', requiredElements: [] }
  await browser.waitUntil(async () => {
    try {
      latest = await readStartupPage(browser)
      return isPackagedStartupPage(latest)
    } catch {
      return false
    }
  }, {
    timeout,
    interval: options.interval ?? 100,
    timeoutMsg: `packaged startup page did not commit; last snapshot: ${JSON.stringify(latest)}`
  })
  return latest
}
