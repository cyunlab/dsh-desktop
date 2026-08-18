import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProcessHostLauncher } from '../../src/main/host/process-launcher.js'

async function rpc<T>(origin: string, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `desktop-${method}`, method, payload })
  })
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

describe('published Harness Web composition', () => {
  it('binds loopback, serves Web/API, applies Workspace cwd and default cwd, and disposes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'DSH Real Host With Spaces '))
    const paths = {
      harnessHome: path.join(root, 'Harness Home'),
      defaultWorkingDirectory: path.join(root, 'Default Working Directory'),
      logs: path.join(root, 'Logs')
    }
    await Promise.all(Object.values(paths).map(directory => mkdir(directory, { recursive: true })))
    const selectedWorkspace = path.join(root, 'Selected Workspace')
    await mkdir(selectedWorkspace)
    const previousHome = process.env.DSH_HOME
    const previousCwd = process.cwd()
    const handle = await new ProcessHostLauncher({ readiness: { timeoutMs: 30_000 } }).launch(paths)
    try {
      const url = new URL(handle.origin)
      expect(url.hostname).toBe('127.0.0.1')
      expect(Number(url.port)).toBeGreaterThan(0)
      expect(handle.binding).toEqual({ host: '127.0.0.1', port: Number(url.port) })
      const response = await fetch(handle.origin)
      expect(response.ok).toBe(true)
      expect(response.headers.get('content-type')).toContain('text/html')

      const workspace = await rpc<{ workspace: { workspaceId: string; path: string }; created: boolean }>(
        handle.origin, 'workspace.create', { path: selectedWorkspace }
      )
      expect(workspace.created).toBe(true)
      expect(workspace.workspace.path).toBe(await realpath(selectedWorkspace))
      const selected = await rpc<{ sessionId: string }>(handle.origin, 'session.create', {
        workspaceId: workspace.workspace.workspaceId
      })
      const fallback = await rpc<{ sessionId: string }>(handle.origin, 'session.create', {})
      const sessions = await rpc<{ items: { sessionId: string; cwd?: string }[] }>(handle.origin, 'session.list', {})
      expect(await realpath(sessions.items.find(item => item.sessionId === selected.sessionId)?.cwd ?? ''))
        .toBe(await realpath(selectedWorkspace))
      expect(await realpath(sessions.items.find(item => item.sessionId === fallback.sessionId)?.cwd ?? ''))
        .toBe(await realpath(paths.defaultWorkingDirectory))
    } finally {
      await Promise.all([handle.dispose(), handle.dispose()])
    }
    expect(process.env.DSH_HOME).toBe(previousHome)
    expect(process.cwd()).toBe(previousCwd)
    await expect(fetch(handle.origin)).rejects.toThrow()
  }, 45_000)
})
