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
    const initialRows = [
      { pid: 11, parentPid: 1, creationDate: 'root-created' },
      { pid: 22, parentPid: 11, creationDate: 'child-created' },
      { pid: 33, parentPid: 22, creationDate: 'grandchild-created' }
    ]
    const afterLeaderExit = initialRows.slice(1)
    expect(windowsOwnedProcessIds(11, 'root-created', initialRows)).toEqual([11, 22, 33])
    const fakeChild = { pid: 11 } as ReturnType<typeof spawn>
    let queryCount = 0
    const ownership = await ownProcessTree(fakeChild, {
      platformName: 'win32',
      queryWindowsProcesses: async () => queryCount++ === 0 ? initialRows : afterLeaderExit
    })
    await expect(processTreeHasExited(ownership)).resolves.toBe(false)
  })

  it('rejects a reused Windows PID whose creation identity does not match', async () => {
    const rows = [
      { pid: 11, parentPid: 1, creationDate: 'reused-root' },
      { pid: 22, parentPid: 11, creationDate: 'unrelated-child' }
    ]
    expect(windowsOwnedProcessIds(11, 'original-root', rows)).toEqual([])
    const ownership = {
      rootPid: 11,
      platformName: 'win32' as const,
      queryWindowsProcesses: async () => rows,
      knownProcessIdentities: new Map([[11, 'original-root']])
    }
    await expect(processTreeHasExited(ownership)).resolves.toBe(true)
  })

  it('bounds a hung Windows process query by the caller deadline', async () => {
    const ownership = {
      rootPid: 11,
      platformName: 'win32' as const,
      queryWindowsProcesses: async () => new Promise<never>(() => {}),
      knownProcessIdentities: new Map([[11, 'root-created']])
    }
    await expect(processTreeHasExited(ownership, 25)).rejects.toThrow('exceeded 25ms')
  })
})
