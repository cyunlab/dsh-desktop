import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { ownProcessTree, processTreeHasExited, terminateProcessTree, waitForListenerClosed, windowsJobControllerArguments } from '../../scripts/smoke-dsh-cli.mjs'

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
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    await terminateProcessTree(child, 5_000)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('keeps a Windows child owned after the Job root exits immediately', async () => {
    const fakeChild = { pid: 11, exitCode: null, signalCode: null } as ReturnType<typeof spawn>
    const responses = [1, 0]
    const ownership = ownProcessTree(fakeChild, {
      platformName: 'win32',
      rootPid: 22,
      controllerProcess: fakeChild,
      windowsController: { request: async () => responses.shift() ?? 0 }
    })
    await expect(processTreeHasExited(ownership)).resolves.toBe(false)
    await expect(processTreeHasExited(ownership)).resolves.toBe(true)
  })

  it('does not consult or signal a reused PID after the Windows Job becomes empty', async () => {
    const fakeChild = { pid: 11, exitCode: null, signalCode: null } as ReturnType<typeof spawn>
    const commands: string[] = []
    const ownership = ownProcessTree(fakeChild, {
      platformName: 'win32',
      rootPid: 22,
      controllerProcess: fakeChild,
      windowsController: { request: async command => { commands.push(command); return 0 } }
    })
    await expect(processTreeHasExited(ownership)).resolves.toBe(true)
    expect(commands).toEqual(['STATUS'])
  })

  it('bounds a hung Windows Job controller request by the caller deadline', async () => {
    const fakeChild = { pid: 11, exitCode: null, signalCode: null } as ReturnType<typeof spawn>
    const ownership = ownProcessTree(fakeChild, {
      platformName: 'win32',
      rootPid: 22,
      controllerProcess: fakeChild,
      windowsController: { request: async () => new Promise<never>(() => {}) }
    })
    await expect(processTreeHasExited(ownership, 25)).rejects.toThrow('STATUS exceeded 25ms')
  })

  it('kills the Job controller when its protocol fails so KILL_ON_JOB_CLOSE owns cleanup', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const ownership = ownProcessTree(child, {
      platformName: 'win32',
      rootPid: 22,
      controllerProcess: child,
      windowsController: { request: async () => { throw new Error('controller failed') } }
    })
    await terminateProcessTree(child, 2_000, ownership)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('keeps the Win32 launch order suspended, assigned, then resumed', async () => {
    const source = await readFile(new URL('../../scripts/windows-job-controller.ps1', import.meta.url), 'utf8')
    const create = source.indexOf('::CreateProcess(')
    const assign = source.indexOf('::AssignProcessToJobObject(')
    const resume = source.indexOf('::ResumeThread(')
    expect(source).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
    expect(source).toContain('CREATE_SUSPENDED')
    expect(create).toBeGreaterThanOrEqual(0)
    expect(assign).toBeGreaterThan(create)
    expect(resume).toBeGreaterThan(assign)
  })

  it('passes the packaged executable, exact argv and cwd through the Job controller', () => {
    const command = {
      executable: 'C:\\Program Files\\DeepSeek Harness Desktop\\resources\\node.exe',
      args: ['C:\\bundle\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', 'web', '--host', '127.0.0.1', '--port', '3080'],
      environment: { DSH_HOME: 'C:\\fixture-home' }
    }
    const argumentsList = windowsJobControllerArguments(command, 'C:\\probe cwd')
    const executableIndex = argumentsList.indexOf('-Executable')
    const encodedArgumentsIndex = argumentsList.indexOf('-ArgumentsBase64')
    const workingDirectoryIndex = argumentsList.indexOf('-WorkingDirectory')
    expect(argumentsList[executableIndex + 1]).toBe(command.executable)
    expect(JSON.parse(Buffer.from(argumentsList[encodedArgumentsIndex + 1], 'base64').toString('utf8'))).toEqual(command.args)
    expect(argumentsList[workingDirectoryIndex + 1]).toBe('C:\\probe cwd')
  })
})
