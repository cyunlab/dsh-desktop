import { mkdir, mkdtemp } from 'node:fs/promises'
import { spawn as spawnChild, type SpawnOptions } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ProcessHostLauncher } from '../../../src/main/host/process-launcher.js'

async function fixturePaths() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh process host '))
  const paths = {
    harnessHome: path.join(root, 'Harness Home'),
    defaultWorkingDirectory: path.join(root, 'Default Working Directory'),
    logs: path.join(root, 'Logs')
  }
  await Promise.all(Object.values(paths).map(directory => mkdir(directory, { recursive: true })))
  return paths
}

describe('ProcessHostLauncher', () => {
  it('starts a child with isolated Node env/cwd, waits for HTTP readiness, and disposes idempotently', async () => {
    const paths = await fixturePaths()
    const parentCwd = process.cwd()
    const parentEnv = process.env.DSH_HOME
    const output: string[] = []
    let invocation: { command: string; args: string[]; options: SpawnOptions } | undefined
    const launcher = new ProcessHostLauncher({
      hostEntry: fileURLToPath(new URL('../../fixtures/host-process-child.mjs', import.meta.url)),
      readiness: { timeoutMs: 5_000 },
      onDiagnosticOutput: (_stream, value) => output.push(value),
      spawnProcess: (command, args, options) => {
        invocation = { command, args, options }
        return spawnChild(command, args, options)
      }
    })

    const handle = await launcher.launch(paths)
    expect(invocation).toMatchObject({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../fixtures/host-process-child.mjs', import.meta.url))],
      options: {
        cwd: paths.defaultWorkingDirectory,
        env: expect.objectContaining({ DSH_HOME: paths.harnessHome, ELECTRON_RUN_AS_NODE: '1' }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        shell: false
      }
    })
    expect(handle.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect((await fetch(handle.origin)).ok).toBe(true)
    await Promise.all([handle.dispose(), handle.dispose()])
    expect(process.cwd()).toBe(parentCwd)
    expect(process.env.DSH_HOME).toBe(parentEnv)
    await expect(fetch(handle.origin)).rejects.toThrow()
    expect(output.join('')).not.toContain('DSH_HOME')
  }, 15_000)
})
