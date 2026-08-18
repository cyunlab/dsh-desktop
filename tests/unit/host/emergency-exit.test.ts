import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { emergencyExitHostProcess } from '../../../src/host-process/emergency-exit.js'

/** 创建不应被危险 PID 路径使用的退出 fake。 */
function createExitSystem(pid: number | undefined) {
  const terminator = new EventEmitter() as EventEmitter & ChildProcess & {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill: (signal: NodeJS.Signals) => boolean
  }
  terminator.exitCode = null
  terminator.signalCode = null
  terminator.kill = vi.fn(() => true)
  const system = {
    platform: 'win32' as const,
    pid,
    spawnProcess: vi.fn(() => terminator),
    killProcess: vi.fn(),
    exit: vi.fn(() => undefined as never)
  }
  return { system, terminator }
}

describe('Host child emergency exit', () => {
  it.each([0, 1, Number.NaN, -1, undefined])('does not taskkill or signal unsafe pid %s', async pid => {
    const { system } = createExitSystem(pid)

    await emergencyExitHostProcess(system, 20)

    expect(system.spawnProcess).not.toHaveBeenCalled()
    expect(system.killProcess).not.toHaveBeenCalled()
    expect(system.exit).toHaveBeenCalledWith(1)
  })

  it('falls back to a safe leader kill when taskkill exits nonzero', async () => {
    const { system, terminator } = createExitSystem(4321)
    terminator.exitCode = 5

    await emergencyExitHostProcess(system, 20)

    expect(system.spawnProcess).toHaveBeenCalledWith('taskkill.exe', ['/PID', '4321', '/T', '/F'], expect.objectContaining({ shell: false }))
    expect(system.killProcess).toHaveBeenCalledWith(4321, 'SIGKILL')
    expect(system.exit).toHaveBeenCalledWith(1)
  })
})
