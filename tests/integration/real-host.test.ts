import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HarnessHostLauncher } from '../../src/main/harness-host-launcher.js'

describe.skipIf(process.env.DSH_REAL_HOST !== '1')('published Harness Web composition', () => {
  it('boots on an assigned loopback port, serves Web HTML, and disposes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'DSH Real Host With Spaces '))
    const paths = {
      harnessHome: path.join(root, 'Harness Home'),
      fallbackWorkspace: path.join(root, 'Fallback Workspace'),
      logs: path.join(root, 'Logs')
    }
    await Promise.all(Object.values(paths).map(directory => mkdir(directory, { recursive: true })))
    const previousHome = process.env.DSH_HOME
    const previousCwd = process.cwd()
    const handle = await new HarnessHostLauncher({ readiness: { timeoutMs: 30_000 } }).launch(paths)
    try {
      const url = new URL(handle.origin)
      expect(url.hostname).toBe('127.0.0.1')
      expect(Number(url.port)).toBeGreaterThan(0)
      const response = await fetch(handle.origin)
      expect(response.ok).toBe(true)
      expect(response.headers.get('content-type')).toContain('text/html')
    } finally {
      await Promise.all([handle.dispose(), handle.dispose()])
    }
    expect(process.env.DSH_HOME).toBe(previousHome)
    expect(process.cwd()).toBe(previousCwd)
    await expect(fetch(handle.origin)).rejects.toThrow()
  }, 45_000)
})
