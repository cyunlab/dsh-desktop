import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectWindowsDescendantPids, inspectMountedDmg, probeBundledRuntime, verifyExtractedBundleContents, verifyTauriArtifact } from '../../scripts/verify-tauri-artifact.mjs'
import { waitForListenerClosed } from '../../scripts/smoke-node-sidecar.mjs'

/** 创建带指定机器字段和可选 NSIS 标记的最小 PE 测试文件。 */
function fakePe(machine: number, marker = ''): Buffer {
  const buffer = Buffer.alloc(512)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(0x80, 0x3c)
  buffer.write('PE\0\0', 0x80, 'binary')
  buffer.writeUInt16LE(machine, 0x84)
  if (marker) buffer.write(marker, 0x100, 'ascii')
  return buffer
}

/** 创建包含真实安装目录内容的 Windows NSIS 验收夹具。 */
async function createWindowsFixture(): Promise<{ root: string; artifact: string; bundleRoot: string; extractedRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-contract-'))
  const bundleRoot = path.join(root, 'src-tauri', 'target', 'release', 'bundle')
  const artifactDirectory = path.join(bundleRoot, 'nsis')
  const artifact = path.join(artifactDirectory, 'DeepSeek Harness Desktop_1.1.1_x64-setup.exe')
  const extractedRoot = path.join(root, 'extracted-installer')
  const nodeExecutable = path.join(extractedRoot, 'resources', 'node', 'windows-x86_64', 'node.exe')
  const sidecar = path.join(extractedRoot, 'resources', 'dist', 'sidecar', 'index.js')
  const application = path.join(extractedRoot, 'DeepSeek Harness Desktop.exe')
  await Promise.all([artifactDirectory, path.dirname(nodeExecutable), path.dirname(sidecar), path.dirname(application)]
    .map(directory => mkdir(directory, { recursive: true })))
  await Promise.all([
    writeFile(artifact, fakePe(0x014c, 'Nullsoft NSIS')),
    writeFile(nodeExecutable, fakePe(0x8664)),
    writeFile(application, fakePe(0x8664)),
    writeFile(sidecar, 'console.log("sidecar")')
  ])
  return { root, artifact, bundleRoot, extractedRoot }
}

/** 创建只依赖 Node 内置模块的真实 sidecar 夹具，覆盖 verifier 的 stdout/stdin 生命周期。 */
async function createRuntimeFixture(sidecarSource: string): Promise<{ root: string; contentRoot: string; eventsFile: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-runtime-fixture-'))
  const contentRoot = path.join(root, 'mounted')
  const nodeExecutable = path.join(contentRoot, 'node', 'windows-x86_64', 'node.exe')
  const sidecar = path.join(contentRoot, 'dist', 'sidecar', 'index.js')
  await Promise.all([path.dirname(nodeExecutable), path.dirname(sidecar)].map(directory => mkdir(directory, { recursive: true })))
  await copyFile(process.execPath, nodeExecutable)
  await writeFile(sidecar, sidecarSource)
  return { root, contentRoot, eventsFile: path.join(root, 'events.log') }
}

/** 创建 POSIX detached probe 夹具；Windows 无 extensionless Node 入口，因此由对应测试跳过。 */
async function createPosixRuntimeFixture(sidecarSource: string): Promise<{ root: string; contentRoot: string; eventsFile: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-posix-runtime-fixture-'))
  const contentRoot = path.join(root, 'mounted')
  const nodeExecutable = path.join(contentRoot, 'node', 'macos-x86_64', 'node')
  const sidecar = path.join(contentRoot, 'dist', 'sidecar', 'index.js')
  const eventsFile = path.join(root, 'events.log')
  await Promise.all([path.dirname(nodeExecutable), path.dirname(sidecar)].map(directory => mkdir(directory, { recursive: true })))
  await copyFile(process.execPath, nodeExecutable)
  await writeFile(sidecar, sidecarSource)
  return { root, contentRoot, eventsFile }
}

/** 返回等待 stop 控制消息后才退出的 HTTP sidecar，防止 verifier 提前关闭 stdin。 */
function lifecycleSidecarSource(options: { readonly body?: string; readonly origin?: string } = {}): string {
  const body = JSON.stringify(options.body ?? '<!doctype html><html><body>fixture</body></html>')
  const origin = JSON.stringify(options.origin ?? '')
  return `
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
if (path.resolve(process.argv[1]) !== path.resolve(fileURLToPath(import.meta.url))) process.exit(0)
const eventsFile = process.env.DSH_FIXTURE_EVENTS
const record = event => eventsFile && appendFileSync(eventsFile, event + '\\n')
const body = ${body}
const server = createServer((_request, response) => {
  record('http-request')
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  record('ready')
  process.stdout.write(JSON.stringify({ type: 'ready', origin: ${origin} || 'http://127.0.0.1:' + address.port }) + '\\n')
})
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  if (line.trim() !== '{"type":"stop"}') return
  record('stop')
  record('stopped')
  process.stdout.write(JSON.stringify({ type: 'stopped' }) + '\\n')
  server.close(() => { record('listener-closed'); process.exit(0) })
})
`
}

/** 返回 leader 退出但保留 loopback listener 的 detached descendant 夹具。 */
function leaderExitDescendantSource(): string {
  const descendantSource = JSON.stringify([
    "const { appendFileSync } = require('node:fs')",
    "const { createServer } = require('node:net')",
    "const server = createServer()",
    "server.listen(0, '127.0.0.1', () => appendFileSync(process.env.DSH_FIXTURE_EVENTS, 'port:' + server.address().port + '\\n'))"
  ].join('\\n'))
  return `
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const eventsFile = process.env.DSH_FIXTURE_EVENTS
const child = spawn(process.execPath, ['-e', ${descendantSource}], { stdio: 'ignore' })
if (eventsFile) appendFileSync(eventsFile, 'leader-exit\\n')
process.exit(0)
void child
`
}

/** 返回 Windows 真实 descendant 夹具；leader 退出后 descendant 继续持有 loopback listener。 */
function windowsLeaderExitDescendantSource(): string {
  const descendantSource = JSON.stringify([
    "const { appendFileSync } = require('node:fs')",
    "const { createServer } = require('node:net')",
    "const server = createServer()",
    "server.listen(0, '127.0.0.1', () => appendFileSync(process.env.DSH_FIXTURE_EVENTS, 'port:' + server.address().port + '\\n'))"
  ].join('\n'))
  return `
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const eventsFile = process.env.DSH_FIXTURE_EVENTS
const child = spawn(process.execPath, ['--input-type=commonjs', '-e', ${descendantSource}], { windowsHide: true, stdio: 'ignore' })
if (eventsFile) {
  appendFileSync(eventsFile, 'pid:' + child.pid + '\\n')
  setTimeout(() => {
    appendFileSync(eventsFile, 'leader-exit\\n')
    process.stdout.write(JSON.stringify({ type: 'ready', origin: 'https://example.com/' }) + '\\n')
    process.exit(0)
  }, 500)
} else process.exit(0)
`
}

/** 等待测试夹具的 descendant PID 消失，避免只凭 taskkill 返回值误判清理成功。 */
async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`fixture process ${pid} is still running`)
}

/** 临时设置 fixture 事件文件环境，并在 probe 完成后恢复测试进程环境。 */
async function withFixtureEvents<T>(fixture: { readonly eventsFile: string }, callback: () => Promise<T>): Promise<T> {
  const previous = process.env.DSH_FIXTURE_EVENTS
  process.env.DSH_FIXTURE_EVENTS = fixture.eventsFile
  try { return await callback() } finally {
    if (previous === undefined) delete process.env.DSH_FIXTURE_EVENTS
    else process.env.DSH_FIXTURE_EVENTS = previous
  }
}

describe('Tauri artifact verification', () => {
  it('checks NSIS magic and the actual extracted application resources', async () => {
    const fixture = await createWindowsFixture()
    await expect(verifyTauriArtifact('win', {
      projectRoot: fixture.root,
      runtimeArch: 'x64',
      containerInspector: async () => verifyExtractedBundleContents(fixture.extractedRoot, 'win', 'x64')
    })).resolves.toBe(fixture.artifact)
  })

  it('fails when the extracted installer has resources but no application executable', async () => {
    const fixture = await createWindowsFixture()
    const resourceOnly = path.join(fixture.root, 'resource-only')
    await mkdir(path.join(resourceOnly, 'node', 'windows-x86_64'), { recursive: true })
    await mkdir(path.join(resourceOnly, 'dist', 'sidecar'), { recursive: true })
    await writeFile(path.join(resourceOnly, 'node', 'windows-x86_64', 'node.exe'), fakePe(0x8664))
    await writeFile(path.join(resourceOnly, 'dist', 'sidecar', 'index.js'), 'sidecar')
    await expect(verifyExtractedBundleContents(resourceOnly, 'win', 'x64'))
      .rejects.toThrow('application executable is missing')
  })

  it('rejects an MSI anywhere in the complete bundle tree', async () => {
    const fixture = await createWindowsFixture()
    const forbidden = path.join(fixture.bundleRoot, 'nested', 'unexpected.msi')
    await mkdir(path.dirname(forbidden), { recursive: true })
    await writeFile(forbidden, 'forbidden')
    await expect(verifyTauriArtifact('win', {
      projectRoot: fixture.root,
      runtimeArch: 'x64',
      containerInspector: async () => verifyExtractedBundleContents(fixture.extractedRoot, 'win', 'x64')
    })).rejects.toThrow('MSI output is forbidden')
  })

  it('rejects an executable extension whose content is not an NSIS PE container', async () => {
    const fixture = await createWindowsFixture()
    await writeFile(fixture.artifact, 'not an executable')
    await expect(verifyTauriArtifact('win', {
      projectRoot: fixture.root,
      runtimeArch: 'x64',
      containerInspector: async () => verifyExtractedBundleContents(fixture.extractedRoot, 'win', 'x64')
    })).rejects.toThrow('PE magic is missing')
  })

  it('runs the bundled runtime through ready, HTML, stop, and listener-closed in order', async () => {
    const fixture = await createRuntimeFixture(lifecycleSidecarSource())
    try {
      await withFixtureEvents(fixture, async () => {
        await expect(probeBundledRuntime(fixture.contentRoot, 'win', 'x64')).resolves.toBeUndefined()
      })
      await expect(readFile(fixture.eventsFile, 'utf8')).resolves.toBe('ready\nhttp-request\nstop\nstopped\nlistener-closed\n')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('canonicalizes a symlinked mount path before direct-entry startup', async () => {
    const fixture = await createRuntimeFixture(lifecycleSidecarSource())
    const aliasRoot = path.join(fixture.root, 'mount-alias')
    try {
      await symlink(fixture.contentRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(probeBundledRuntime(aliasRoot, 'win', 'x64')).resolves.toBeUndefined()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails on a silent code-0 sidecar instead of treating it as a successful probe', async () => {
    const fixture = await createRuntimeFixture('process.exit(0)\n')
    try {
      await expect(probeBundledRuntime(fixture.contentRoot, 'win', 'x64'))
        .rejects.toThrow('Bundled sidecar exited before ready with code 0')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('kills a detached descendant when the sidecar leader exits first', async () => {
    const fixture = await createPosixRuntimeFixture(leaderExitDescendantSource())
    try {
      await withFixtureEvents(fixture, async () => {
        await expect(probeBundledRuntime(fixture.contentRoot, 'mac', 'x64'))
          .rejects.toThrow('Bundled sidecar exited before ready with code 0')
      })
      let events = ''
      for (let attempt = 0; attempt < 40; attempt += 1) {
        events = await readFile(fixture.eventsFile, 'utf8').catch(() => '')
        if (events.includes('port:')) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const port = events.match(/port:(\d+)/)?.[1]
      expect(port).toBeDefined()
      await expect(waitForListenerClosed(`http://127.0.0.1:${port}`, 5_000)).resolves.toBeUndefined()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('kills a Windows descendant when the sidecar leader exits first', async () => {
    const fixture = await createRuntimeFixture(windowsLeaderExitDescendantSource())
    try {
      await withFixtureEvents(fixture, async () => {
        await expect(probeBundledRuntime(fixture.contentRoot, 'win', 'x64'))
          .rejects.toThrow('disallowed origin')
      })
      let events = ''
      for (let attempt = 0; attempt < 60; attempt += 1) {
        events = await readFile(fixture.eventsFile, 'utf8').catch(() => '')
        if (events.includes('port:')) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const pid = Number(events.match(/pid:(\d+)/)?.[1])
      const port = events.match(/port:(\d+)/)?.[1]
      expect(pid).toBeGreaterThan(0)
      expect(port).toBeDefined()
      await expect(waitForProcessExit(pid)).resolves.toBeUndefined()
      await expect(waitForListenerClosed(`http://127.0.0.1:${port}`, 5_000)).resolves.toBeUndefined()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)

  it('collects Windows descendants deepest-first through the injected snapshot seam', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const snapshot = JSON.stringify([
      { ProcessId: 100, ParentProcessId: 1 },
      { ProcessId: 200, ParentProcessId: 100 },
      { ProcessId: 300, ParentProcessId: 200 },
      { ProcessId: 400, ParentProcessId: 100 }
    ])
    await expect(collectWindowsDescendantPids(100, async (file, args) => {
      calls.push({ file, args })
      return { stdout: snapshot }
    })).resolves.toEqual([300, 200, 400])
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('powershell.exe')
    expect(calls[0].args).toContain('-NoProfile')
    expect(calls[0].args.join(' ')).not.toContain('DSH_FIXTURE_EVENTS')
  })

  it('rejects a remote ready origin before making an HTTP request', async () => {
    const fixture = await createRuntimeFixture(lifecycleSidecarSource({ origin: 'https://example.com/' }))
    try {
      await withFixtureEvents(fixture, async () => {
        await expect(probeBundledRuntime(fixture.contentRoot, 'win', 'x64'))
          .rejects.toThrow('disallowed origin')
      })
      await expect(readFile(fixture.eventsFile, 'utf8')).resolves.toBe('ready\n')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an empty HTML response while still cleaning the listener', async () => {
    const fixture = await createRuntimeFixture(lifecycleSidecarSource({ body: '   ' }))
    try {
      await withFixtureEvents(fixture, async () => {
        await expect(probeBundledRuntime(fixture.contentRoot, 'win', 'x64'))
          .rejects.toThrow('non-empty HTML')
      })
      await expect(readFile(fixture.eventsFile, 'utf8')).resolves.toMatch(/^ready\nhttp-request\n/)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('always detaches a DMG mount after inspection failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-mount-fixture-'))
    const calls: Array<{ file: string; args: string[] }> = []
    const canonicalRoot = await realpath(root)
    try {
      await expect(inspectMountedDmg('fixture.dmg', root, async mountPoint => {
        expect(mountPoint).toBe(path.join(canonicalRoot, 'mounted'))
        expect((await stat(mountPoint)).isDirectory()).toBe(true)
        throw new Error('probe failed')
      }, async (file, args) => {
        calls.push({ file, args })
      })).rejects.toThrow('probe failed')
      expect(calls.map(call => call.args[0])).toEqual(['attach', 'detach'])
      expect(calls[0].args).toContain(path.join(canonicalRoot, 'mounted'))
      expect(calls[1].args).toContain(path.join(canonicalRoot, 'mounted'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
