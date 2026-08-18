import { EventEmitter } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { terminateChildProcess } from '../../../src/main/host/process-tree.js'

describe('Host process tree termination', () => {
  it('kills a TERM-resistant descendant in a detached Unix process group', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(tmpdir(), 'dsh process tree '))
    const pidFile = path.join(root, 'descendant.pid')
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../fixtures/process-tree-parent.mjs', import.meta.url))], {
      detached: true,
      cwd: root,
      env: { ...process.env, DSH_TREE_PID_FILE: pidFile },
      stdio: 'ignore',
      shell: false
    })
    await vi.waitFor(async () => expect(await readFile(pidFile, 'utf8')).toMatch(/^\d+$/))
    const descendantPid = Number(await readFile(pidFile, 'utf8'))
    await terminateChildProcess(child, 100)
    await vi.waitFor(() => expect(() => process.kill(descendantPid, 0)).toThrow())
  }, 10_000)

  it('cleans a Unix process group even after the leader exits unexpectedly', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(tmpdir(), 'dsh process tree exited '))
    const pidFile = path.join(root, 'descendant.pid')
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../fixtures/process-tree-parent.mjs', import.meta.url))], {
      detached: true,
      cwd: root,
      env: { ...process.env, DSH_TREE_PID_FILE: pidFile, DSH_TREE_EXIT_LEADER: '1' },
      stdio: 'ignore',
      shell: false
    })
    await vi.waitFor(async () => expect(await readFile(pidFile, 'utf8')).toMatch(/^\d+$/))
    const descendantPid = Number(await readFile(pidFile, 'utf8'))
    await vi.waitFor(() => expect(child.exitCode).not.toBeNull())
    await terminateChildProcess(child, 100)
    await vi.waitFor(() => expect(() => process.kill(descendantPid, 0)).toThrow())
  }, 10_000)

  it('uses taskkill /T /F with shell disabled on Windows', async () => {
    class FakeChild extends EventEmitter {
      pid = 1234
      exitCode: number | null = null
      signalCode: NodeJS.Signals | null = null
      kill = vi.fn((signal: NodeJS.Signals) => {
        if (signal === 'SIGKILL') {
          this.exitCode = 137
          this.emit('exit', this.exitCode, null)
        }
        return true
      })
    }
    const terminator = new FakeChild()
    terminator.pid = 9999
    const child = new FakeChild()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => terminator.emit('exit', 0, null))
      return terminator as unknown as ChildProcess
    })

    await terminateChildProcess(child as unknown as ChildProcess, 50, {
      platform: 'win32',
      spawnProcess
    })
    expect(spawnProcess).toHaveBeenCalledWith('taskkill.exe', ['/pid', '1234', '/T', '/F'], expect.objectContaining({
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    }))
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
