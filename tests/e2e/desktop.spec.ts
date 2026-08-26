import { readFile, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { browser, expect, $ } from '@wdio/globals'
import { applicationPath } from './support/paths.mjs'
import { isPackagedStartupUrl, waitForPackagedStartupPage } from './support/startup-page.mjs'

const scenario = process.env.DSH_TEST_SCENARIO ?? 'success'
let scenarioTestsPassed = true

/** 等待元素展示目标文本，兼容启动页到 loopback 页面之间的导航。 */
async function waitForText(selector: string, expected: string, timeout = 15_000): Promise<void> {
  try {
    await browser.waitUntil(async () => {
      try { return (await $(selector).getText()).includes(expected) } catch { return false }
    }, { timeout, timeoutMsg: `${selector} did not contain ${expected}` })
  } catch (error) {
    const url = await browser.getUrl().catch(() => '<unavailable>')
    const source = await browser.getPageSource().catch(() => '<unavailable>')
    throw new Error(`${String(error)}; current URL: ${url}; page: ${source.slice(0, 500)}`)
  }
}

/** 等待真实 loopback Harness 页面加载并返回当前 origin。 */
async function waitForHarness(): Promise<string> {
  try {
    await $('[data-testid="harness-ready"]').waitForDisplayed({ timeout: 45_000 })
  } catch (error) {
    const url = await browser.getUrl().catch(() => '<unavailable>')
    throw new Error(`${String(error)}; current URL: ${url}; records: ${JSON.stringify(await readRecords())}`)
  }
  const origin = await browser.getUrl()
  const parsed = new URL(origin)
  expect(parsed.protocol).toBe('http:')
  expect(parsed.hostname).toBe('127.0.0.1')
  expect(Number(parsed.port)).toBe(3080)
  return origin
}

/** 等待真实 Harness UI 根节点完成挂载。 */
async function waitForRealHarness(): Promise<string> {
  await browser.waitUntil(async () => (await browser.getUrl()).startsWith('http://127.0.0.1:'), { timeout: 60_000 })
  await browser.waitUntil(async () => (await browser.execute(() => document.querySelector('#root')?.childElementCount ?? 0)) > 0, { timeout: 60_000 })
  return browser.getUrl()
}

/** 通过真实用户点击触发 target=_blank 请求，兼容 WebKit 的脚本 popup 手势限制。 */
async function requestPopup(url: string): Promise<void> {
  await browser.execute((targetUrl: string) => {
    document.querySelector('#dsh-e2e-popup-link')?.remove()
    const link = document.createElement('a')
    link.id = 'dsh-e2e-popup-link'
    link.href = targetUrl
    link.target = '_blank'
    link.textContent = 'Open test popup'
    document.body.appendChild(link)
  }, url)
  await $('#dsh-e2e-popup-link').click()
}

/** 读取 CLI fixture 写入的结构化测试事件。 */
async function readEvents(): Promise<readonly Record<string, unknown>[]> {
  const file = process.env.DSH_TEST_EVENTS
  if (!file) return []
  const contents = await readFile(file, 'utf8').catch(() => '')
  return contents.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
  })
}

/** 读取 Tauri debug+wdio recorder 事件。 */
async function readRecords(): Promise<readonly Record<string, unknown>[]> {
  const file = process.env.DSH_TEST_RECORDS
  if (!file) return []
  const contents = await readFile(file, 'utf8').catch(() => '')
  return contents.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] } })
}

/** 等待桌面 recorder 写入指定事件。 */
async function waitForRecord(name: string): Promise<readonly Record<string, unknown>[]> {
  await browser.waitUntil(async () => (await readRecords()).some(event => event.event === name), { timeout: 20_000 })
  return readRecords()
}

/** 等待 CLI fixture 事件落盘，避免测试在子进程关闭前读取到旧快照。 */
async function waitForEvent(name: string): Promise<readonly Record<string, unknown>[]> {
  await browser.waitUntil(async () => (await readEvents()).some(event => event.event === name), { timeout: 15_000, timeoutMsg: `CLI fixture event ${name} was not recorded` })
  return readEvents()
}

/** 不依赖 WebDriver 轮询文件系统，验收最后 generation、进程树和 listener 全部关闭。 */
async function waitForNativeCleanup(): Promise<number> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const records = await readRecords()
    const events = await readEvents()
    const backendPid = Number(records.find(event => event.event === 'backend-started')?.pid)
    const lastSpawn = records.filter(event => event.event === 'cli-spawned').at(-1)
    const generation = Number(lastSpawn?.generation)
    const requestIndex = records.findIndex(event => event.event === 'native-shutdown-requested'
      && event.source === 'close-requested' && event.generation === generation)
    const completionIndex = records.findIndex(event => event.event === 'native-shutdown-completed'
      && event.generation === generation && event.cleanupSucceeded === true)
    const cliCleaned = records.some(event => event.event === 'cli-cleaned' && event.generation === generation)
    const pids = [...new Set([
      ...records.filter(event => event.event === 'cli-spawned').map(event => Number(event.pid)),
      ...events.filter(event => event.event === 'descendant-spawned').map(event => Number(event.pid)),
      backendPid
    ].filter(Number.isInteger))]
    const origins = records.filter(event => event.event === 'client-page-served').map(event => String(event.origin))
    const listenersClosed = (await Promise.all(origins.map(async origin => {
      try { await fetch(origin, { signal: AbortSignal.timeout(300) }); return false } catch { return true }
    }))).every(Boolean)
    if (Number.isInteger(generation)
      && requestIndex >= 0
      && completionIndex > requestIndex
      && cliCleaned
      && pids.every(pid => !processExists(pid))
      && listenersClosed) return generation
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Final-window shutdown did not complete owned generation cleanup: ${JSON.stringify(await readRecords())}`)
}

/** 使用平台进程接口判断 Retry 前的旧 PID 是否仍存活。 */
function processExists(pid: number): boolean {
  if (process.platform === 'win32') return spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 2_000, killSignal: 'SIGKILL' }).stdout.includes(`"${pid}"`)
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 启动第二个相同 Tauri 进程并等待单实例插件将其转发退出。 */
async function launchSecondInstance(): Promise<void> {
  const second = spawn(applicationPath(), [], { env: process.env, stdio: 'ignore', windowsHide: true })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { second.kill(); reject(new Error('second Tauri instance did not exit')) }, 15_000)
    second.once('error', error => { clearTimeout(timer); reject(error) })
    second.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

describe('DeepSeek Harness Desktop Tauri behavior', () => {
  /** 记录任何行为断言失败，防止 runner 把真正失败误判成预期 backend 断连。 */
  afterEach(function () {
    if (this.currentTest?.state !== 'passed') scenarioTestsPassed = false
  })
  if (scenario === 'delayed-success') {
    /** 验证 WebDriver 越过 about:blank 后先看到真实启动页，再看到 loopback Web Client。 */
    it('shows the startup page before loading the loopback Web Client', async () => {
      const initialPage = await waitForPackagedStartupPage(browser)
      expect(isPackagedStartupUrl(initialPage.url)).toBe(true)
      expect(initialPage.state).toMatch(/Starting|Waiting|Still starting|Startup failed|Stopping/)
      expect(initialPage.message).toBeTruthy()
      const origin = await waitForHarness()
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
      expect(await browser.getTitle()).toContain('DeepSeek Harness Test Client')
    })
  }

  if (scenario === 'retry') {
    /** 从仍存活且占用固定端口的 Prolonged 轮次触发 Retry，验证回收先于替代轮次。 */
    it('reclaims the live prolonged CLI before starting its replacement', async () => {
      await waitForPackagedStartupPage(browser)
      await waitForText('#state', 'Still starting', 15_000)
      await $('#retry').waitForDisplayed()
      await $('#copy').waitForDisplayed()
      await $('#copy').click()
      const diagnosticsRecords = await waitForRecord('diagnostics-copied')
      const diagnostics = String(diagnosticsRecords.find(event => event.event === 'diagnostics-copied')?.diagnostics ?? '')
      expect(diagnostics).toContain('"app_version"')
      expect(diagnostics).toContain('"error_code"')
      expect(diagnostics).not.toContain('http://')
      await $('#retry').click()
      await waitForHarness()
      const events = await waitForEvent('html-listener-ready')
      const oldPids = events.filter(event => event.attempt === 1 && (event.event === 'fixture-started' || event.event === 'descendant-spawned')).map(event => Number(event.pid))
      expect(oldPids.length).toBe(2)
      expect(oldPids.every(pid => !processExists(pid))).toBe(true)
      const records = await waitForRecord('cli-cleaned')
      const cleaned = records.findIndex(event => event.event === 'cli-cleaned' && event.generation === 1)
      const replacementSpawned = records.findIndex(event => event.event === 'cli-spawned' && event.generation === 3)
      expect(cleaned).toBeGreaterThanOrEqual(0)
      expect(replacementSpawned).toBeGreaterThan(cleaned)
      const listenerClosed = events.findIndex(event => event.event === 'server-closed' && event.attempt === 1)
      const replacementStarted = events.findIndex(event => event.event === 'fixture-started' && event.attempt === 2)
      const replacementReady = events.findIndex(event => event.event === 'html-listener-ready' && event.attempt === 2)
      expect(listenerClosed).toBeGreaterThanOrEqual(0)
      expect(replacementStarted).toBeGreaterThan(listenerClosed)
      expect(replacementReady).toBeGreaterThan(replacementStarted)
    })
  }

  if (scenario === 'prolonged') {
    /** 先同步到真实 packaged startup page，再观察 prolonged-startup 生命周期。 */
    it('offers Retry after prolonged startup and disables duplicate retry while stopping', async () => {
      await waitForPackagedStartupPage(browser)
      await waitForText('#state', 'Still starting', 45_000)
      await browser.pause(1_000)
      expect(await $('#state').getText()).toContain('Still starting')
      await $('#retry').waitForDisplayed()
      expect(await $('#retry').isEnabled()).toBe(true)
      await $('#retry').click()
      expect(await $('#retry').isEnabled()).toBe(false)
      await waitForHarness()
    })
  }

  if (scenario === 'crash-after-ready') {
    it('returns to the failure page when a ready CLI crashes', async () => {
      await waitForHarness()
      const crashTrigger = process.env.DSH_TEST_CRASH_TRIGGER
      if (!crashTrigger) throw new Error('DSH_TEST_CRASH_TRIGGER is required')
      await writeFile(crashTrigger, 'crash', 'utf8')
      await waitForText('#state', 'Startup failed')
      const events = await waitForEvent('crashed')
      expect(events.map(event => event.event)).toContain('crashed')
    })
  }

  if (scenario === 'real-harness') {
    it('keeps external and non-http popup requests out of the Desktop WebView', async () => {
      const origin = await waitForRealHarness()
      await requestPopup('https://example.com/dsh-e2e')
      await requestPopup('file:///dsh-e2e-private')
      await requestPopup('dsh-test://private')
      await requestPopup('unknown-scheme://private')
      const records = await waitForRecord('external-open')
      expect(records.filter(event => event.event === 'external-open')).toEqual([{ event: 'external-open', url: 'https://example.com/dsh-e2e' }])
      await browser.pause(500)
      expect(await browser.getWindowHandles()).toHaveLength(1)
      expect(await browser.getUrl()).toBe(origin)
    })

    it('focuses the existing Desktop without starting another Host on a second launch', async () => {
      const origin = await waitForRealHarness()
      await browser.minimizeWindow()
      await launchSecondInstance()
      const records = await waitForRecord('single-instance-activated')
      expect(await browser.getWindowHandles()).toHaveLength(1)
      expect(await browser.getUrl()).toBe(origin)
      expect(records.filter(event => event.event === 'cli-spawned')).toHaveLength(1)
      const activation = records.find(event => event.event === 'single-instance-activated')
      expect(activation).toMatchObject({ beforeMinimized: true, unminimizeOk: true, showOk: true, focusOk: true, afterMinimized: false, visible: true, focused: true })
    })
  }

  if (scenario === 'stubborn-cleanup') {
    it('loads before runner verifies hard process-tree cleanup', async () => { await waitForHarness() })
  }

  /** 调用真实 Tauri Window.close 触发 CloseRequested，并在 WebDriver session 断开后只轮询文件系统。 */
  after(async () => {
    const completionFile = process.env.DSH_TEST_COMPLETION_FILE
    try {
      await browser.execute(async () => {
        const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> } }).__TAURI_INTERNALS__
        if (!internals) throw new Error('Tauri internals are unavailable')
        await internals.invoke('plugin:window|close', { label: 'main' })
      })
    } catch (error) {
      // embedded provider 随最后窗口退出，成功的 close 可能先切断命令响应；后续 native cleanup 验证决定是否真的成功。
      if (!/ECONNREFUSED|UND_ERR_SOCKET/.test(String(error))) throw error
    }
    const generation = await waitForNativeCleanup()
    if (scenarioTestsPassed && completionFile) {
      await writeFile(completionFile, JSON.stringify({ status: 'passed', generation }), 'utf8')
    }
  })
})
