import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ownProcessTree, processTreeHasExited, terminateProcessTree, waitForListenerClosed, windowsOwnedProcessIds } from '../../scripts/smoke-dsh-cli.mjs'

describe('published dsh CLI smoke cleanup', () => {
  it('waits until the Harness listener actually stops accepting connections', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test listener did not expose a TCP port')
    const origin = `http://127.0.0.1:${address.port}`
    await expect(waitForListenerClosed(origin, 100)).rejects.toThrow('still accepts connections')
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await expect(waitForListenerClosed(origin, 1_000)).resolves.toBeUndefined()
  })

  it('force-terminates and awaits a CLI process group', async () => {
    const child = spawn(process.execPath, ['-e', "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true
    })
    await terminateProcessTree(child, 5_000)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('retains Windows descendants through a stable root PID after the leader disappears', async () => {
    const rows = [{ pid: 22, parentPid: 11 }, { pid: 33, parentPid: 22 }, { pid: 44, parentPid: 1 }]
    expect(windowsOwnedProcessIds(11, rows)).toEqual([22, 33])
    const fakeChild = { pid: 11 } as ReturnType<typeof spawn>
    const ownership = ownProcessTree(fakeChild, { platformName: 'win32', queryWindowsProcesses: async () => rows })
    await expect(processTreeHasExited(ownership)).resolves.toBe(false)
  })
})
