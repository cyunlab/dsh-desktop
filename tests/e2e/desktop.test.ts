import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCommandWithTimeout } from '../../scripts/after-pack.mjs'

interface RunningDesktop {
  app: ElectronApplication
  page: Page
  root: string
  events: string
}

async function launchDesktop(options: { fakeHost?: boolean; failures?: number } = {}): Promise<RunningDesktop> {
  const root = await mkdtemp(path.join(tmpdir(), 'DSH Desktop E2E With Spaces '))
  const events = path.join(root, 'events.jsonl')
  const app = await electron.launch({
    executablePath: await packagedExecutable(),
    args: [],
    env: {
      ...process.env,
      ...(options.fakeHost ? { DSH_DESKTOP_TEST_HOST: 'fake' } : {}),
      DSH_DESKTOP_TEST_FAILURES: String(options.failures ?? 0),
      DSH_DESKTOP_TEST_USER_DATA: path.join(root, 'User Data With Spaces'),
      DSH_DESKTOP_TEST_EVENTS: events
    }
  })
  return { app, page: await app.firstWindow(), root, events }
}

async function packagedExecutable(): Promise<string> {
  const output = path.resolve('release', 'E2E Package With Spaces')
  const candidates = process.platform === 'darwin'
    ? [
        path.join(output, `mac-${process.arch}`, 'deepseek-harness-desktop.app', 'Contents', 'MacOS', 'deepseek-harness-desktop'),
        path.join(output, 'mac', 'deepseek-harness-desktop.app', 'Contents', 'MacOS', 'deepseek-harness-desktop')
      ]
    : process.platform === 'win32'
      ? [path.join(output, 'win-unpacked', 'deepseek-harness-desktop.exe')]
      : [path.join(output, 'linux-unpacked', 'deepseek-harness-desktop')]
  for (const candidate of candidates) {
    try { await access(candidate); return candidate } catch { /* try platform fallback */ }
  }
  throw new Error(`No unpacked packaged Desktop executable found under ${output}`)
}

async function eventNames(file: string): Promise<string[]> {
  const contents = await readFile(file, 'utf8').catch(() => '')
  return contents.trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { event: string }).event)
}

async function waitForWebClient(page: Page): Promise<void> {
  await page.waitForURL(url => url.protocol === 'http:' && url.hostname === '127.0.0.1', { timeout: 30_000 })
}

test('moves from the packaged startup page to the Web Client', async () => {
  const desktop = await launchDesktop()
  try {
    await waitForWebClient(desktop.page)
    await expect.poll(async () => {
      const names = await eventNames(desktop.events)
      const startup = names.indexOf('startup-page-loaded')
      return startup >= 0 && names.indexOf('web-client-loaded') > startup
    }).toBe(true)
    await expect(desktop.page).toHaveTitle(/DeepSeek Harness/)
    expect(new URL(desktop.page.url()).hostname).toBe('127.0.0.1')
  } finally { await desktop.app.close() }
})

test('a second launch activates the existing window without creating another Host', async () => {
  const desktop = await launchDesktop({ fakeHost: true })
  try {
    await expect(desktop.page.getByRole('heading', { name: 'DeepSeek Harness Web Client' })).toBeVisible()
    await desktop.app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window.minimize()
    })
    await expect.poll(() => desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(true)
    const executable = desktop.app.process().spawnfile
    await runCommandWithTimeout(executable, [], {
      DSH_DESKTOP_TEST_HOST: 'fake',
      DSH_DESKTOP_TEST_USER_DATA: path.join(desktop.root, 'User Data With Spaces'),
      DSH_DESKTOP_TEST_EVENTS: desktop.events
    }, 5_000)
    await expect.poll(async () => {
      const names = await eventNames(desktop.events)
      return names.slice(names.lastIndexOf('second-instance'))
    }).toEqual(['second-instance', 'window-restored', 'window-shown', 'window-focused'])
    expect(desktop.app.windows()).toHaveLength(1)
  } finally { await desktop.app.close() }
})

test('shows startup failure and retries in the same window', async () => {
  const desktop = await launchDesktop({ fakeHost: true, failures: 1 })
  try {
    await expect(desktop.page.getByRole('heading', { name: 'Startup failed' })).toBeVisible()
    await desktop.page.getByRole('button', { name: 'Retry' }).click()
    await expect(desktop.page.getByRole('heading', { name: 'DeepSeek Harness Web Client' })).toBeVisible()
    expect(desktop.app.windows()).toHaveLength(1)
  } finally { await desktop.app.close() }
})

test('hands external HTTP links off without navigating or opening a privileged window', async () => {
  const desktop = await launchDesktop({ fakeHost: true })
  try {
    await expect(desktop.page.getByRole('heading', { name: 'DeepSeek Harness Web Client' })).toBeVisible()
    const origin = desktop.page.url()
    await desktop.page.evaluate(() => window.open('https://example.com/docs', '_blank'))
    await expect.poll(() => eventNames(desktop.events)).toContain('external-link')
    expect(desktop.page.url()).toBe(origin)
    expect(desktop.app.windows()).toHaveLength(1)
  } finally { await desktop.app.close() }
})

test('closing the final window stops its listener and exits Desktop', async () => {
  const desktop = await launchDesktop()
  await waitForWebClient(desktop.page)
  const origin = desktop.page.url()
  const closed = desktop.app.waitForEvent('close')
  await desktop.page.close()
  await closed
  await expect(fetch(origin)).rejects.toThrow()
})
