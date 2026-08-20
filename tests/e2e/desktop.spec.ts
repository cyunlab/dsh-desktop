import { readFile, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { browser, expect, $ } from '@wdio/globals'
import { applicationPath } from './support/paths.mjs'
import { waitForPackagedStartupPage } from './support/startup-page.mjs'

const scenario = process.env.DSH_TEST_SCENARIO ?? 'success'

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
  expect(Number(parsed.port)).toBeGreaterThan(0)
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

/** 读取 sidecar fixture 写入的结构化生命周期事件。 */
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

/** 等待 sidecar 事件落盘，避免测试在子进程关闭前读取到旧快照。 */
async function waitForEvent(name: string): Promise<readonly Record<string, unknown>[]> {
  await browser.waitUntil(async () => (await readEvents()).some(event => event.event === name), { timeout: 15_000, timeoutMsg: `sidecar event ${name} was not recorded` })
  return readEvents()
}

/** 使用平台进程接口判断 Retry 前的旧 PID 是否仍存活。 */
function processExists(pid: number): boolean {
  if (process.platform === 'win32') return spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout.includes(`"${pid}"`)
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
  if (scenario === 'delayed-success') {
    /** 验证 WebDriver 越过 about:blank 后先看到真实启动页，再看到 loopback Web Client。 */
    it('shows the startup page before loading the loopback Web Client', async () => {
      const initialPage = await waitForPackagedStartupPage(browser)
      expect(initialPage.url).toMatch(/^http:\/\/tauri\.localhost\//)
      expect(initialPage.state).toMatch(/Starting|Waiting|Still starting|Startup failed|Stopping/)
      expect(initialPage.message).toBeTruthy()
      const origin = await waitForHarness()
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
      expect(await browser.getTitle()).toContain('DeepSeek Harness Test Client')
    })
  }

  if (scenario === 'retry') {
    it('renders controlled startup failure and retries after stopping the old sidecar', async () => {
      await waitForText('#state', 'Startup failed')
      await $('#retry').waitForDisplayed()
      await $('#copy').waitForDisplayed()
      await $('#logs').waitForDisplayed()
      await $('#copy').click()
      const diagnosticsRecords = await waitForRecord('diagnostics-copied')
      const diagnostics = String(diagnosticsRecords.find(event => event.event === 'diagnostics-copied')?.diagnostics ?? '')
      expect(diagnostics).toContain('"app_version"')
      expect(diagnostics).toContain('"error_code"')
      expect(diagnostics).not.toContain('http://')
      await $('#logs').click()
      await waitForRecord('logs-opened')
      await $('#retry').click()
      await waitForHarness()
      const events = await waitForEvent('ready')
      const names = events.map(event => event.event)
      expect(names).toContain('startup-failed')
      expect(names.indexOf('stop-ignored')).toBeGreaterThan(names.indexOf('startup-failed'))
      expect(names.indexOf('ready')).toBeGreaterThan(names.indexOf('stop-ignored'))
      const oldPids = events.filter(event => event.attempt === 1 && (event.event === 'fixture-started' || event.event === 'descendant-spawned')).map(event => Number(event.pid))
      expect(oldPids.every(pid => !processExists(pid))).toBe(true)
    })
  }

  if (scenario === 'prolonged') {
    it('offers Retry after prolonged startup and disables duplicate retry while stopping', async () => {
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
    it('returns to the failure page when a ready sidecar crashes', async () => {
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
      expect(records.filter(event => event.event === 'sidecar-spawned')).toHaveLength(1)
      const activation = records.find(event => event.event === 'single-instance-activated')
      expect(activation).toMatchObject({ beforeMinimized: true, unminimizeOk: true, showOk: true, focusOk: true, afterMinimized: false, visible: true, focused: true })
    })
  }

  if (scenario === 'stubborn-cleanup') {
    it('loads before runner verifies hard process-tree cleanup', async () => { await waitForHarness() })
  }

  /** 在每个桌面行为场景结束时销毁 WebView，验收 Tauri 侧的 sidecar 回收。 */
  after(async () => {
    await browser.closeWindow()
  })
})
