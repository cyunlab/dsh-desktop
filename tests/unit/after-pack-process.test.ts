import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { runCommandWithTimeout, runTerminationCommand } from '../../scripts/after-pack.mjs'

describe.skipIf(process.platform === 'win32')('afterPack command timeout cleanup', () => {
  it('kills a SIGTERM-resistant descendant and confirms the process group is absent', async () => {
    const script = [
      "const { spawn } = require('node:child_process')",
      "const resistant = \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"",
      "const child = spawn(process.execPath, ['-e', resistant], { stdio: 'ignore' })",
      "console.log('process-group:' + process.pid + ' grandchild:' + child.pid)",
      'setInterval(() => {}, 1000)'
    ].join(';')

    let message = ''
    let group = 0
    let pid = 0
    let childAbsent = false
    let groupAbsent = false
    try {
      try {
        await runCommandWithTimeout(process.execPath, ['-e', script], {}, 150)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
        group = Number(message.match(/process-group:(\d+)/)?.[1])
        pid = Number(message.match(/grandchild:(\d+)/)?.[1])
      }
      childAbsent = processIsAbsent(pid)
      groupAbsent = processIsAbsent(-group)
    } finally {
      if (group > 0) try { process.kill(-group, 'SIGKILL') } catch {}
      if (pid > 0) try { process.kill(pid, 'SIGKILL') } catch {}
    }

    expect(message).toContain('terminated process tree')
    expect(group).toBeGreaterThan(0)
    expect(pid).toBeGreaterThan(0)
    expect(childAbsent).toBe(true)
    expect(groupAbsent).toBe(true)
  })
})

function processIsAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false } catch { return true }
}

describe('Windows termination command bound', () => {
  it('kills and rejects a taskkill subprocess that exceeds its deadline', async () => {
    const fake = new EventEmitter() as EventEmitter & { kill(signal: string): boolean }
    let killedWith = ''
    fake.kill = (signal: string) => {
      killedWith = signal
      queueMicrotask(() => fake.emit('exit', null, 'SIGKILL'))
      return true
    }
    const spawnProcess = (..._args: unknown[]) => fake

    await expect(runTerminationCommand('taskkill.exe', ['/T', '/F'], { spawnProcess, timeoutMs: 10 }))
      .rejects.toThrow('timed out')
    expect(killedWith).toBe('SIGKILL')
  })
})
