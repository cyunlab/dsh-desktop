import { describe, expect, it } from 'vitest'
import { runCommandWithTimeout } from '../../scripts/after-pack.mjs'

describe.skipIf(process.platform === 'win32')('afterPack command timeout cleanup', () => {
  it('terminates the spawned process group before rejecting', async () => {
    const script = [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "console.log('grandchild:' + child.pid)",
      'setInterval(() => {}, 1000)'
    ].join(';')

    let message = ''
    try {
      await runCommandWithTimeout(process.execPath, ['-e', script], {}, 150)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('terminated process tree')
    const pid = Number(message.match(/grandchild:(\d+)/)?.[1])
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
