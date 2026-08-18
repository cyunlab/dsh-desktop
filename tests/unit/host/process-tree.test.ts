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

  it('still asks taskkill to clean descendants after a Windows leader exited', async () => {
    class ExitedChild extends EventEmitter {
      pid = 4321
      exitCode: number | null = 1
      signalCode: NodeJS.Signals | null = null
      kill = vi.fn(() => true)
    }
    const terminator = new ExitedChild()
    terminator.pid = 9999
    const child = new ExitedChild()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => terminator.emit('exit', 0, null))
      return terminator as unknown as ChildProcess
    })

    await terminateChildProcess(child as unknown as ChildProcess, 50, {
      platform: 'win32',
      spawnProcess
    })
    expect(spawnProcess).toHaveBeenCalledWith('taskkill.exe', ['/pid', '4321', '/T', '/F'], expect.objectContaining({ shell: false }))
    expect(child.kill).not.toHaveBeenCalled()
  })

  it.each([0, 1, Number.NaN, -1, undefined])('never uses unsafe pid %s for process-tree cleanup', async pid => {
    /** 模拟带有危险/缺失 pid 的 child，并让安全 leader kill 立即退出。 */
    class UnsafeChild extends EventEmitter {
      pid = pid
      exitCode: number | null = null
      signalCode: NodeJS.Signals | null = null
      kill = vi.fn(() => {
        this.exitCode = 1
        this.emit('exit', 1, null)
        return true
      })
    }
    const child = new UnsafeChild()
    const spawnProcess = vi.fn()
    const killProcess = vi.fn()

    await terminateChildProcess(child as unknown as ChildProcess, 50, {
      platform: 'win32',
      spawnProcess,
      killProcess
    })

    expect(spawnProcess).not.toHaveBeenCalled()
    expect(killProcess).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
