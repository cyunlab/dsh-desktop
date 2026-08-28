import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectMountedDmg, probeBundledRuntime, removeInspectionRoot, verifyExtractedBundleContents, verifyTauriArtifact } from '../../scripts/verify-tauri-artifact.mjs'
import { requiredRuntimeAssets, runtimeTarget } from '../../scripts/runtime-closure.mjs'
import { probeDirectDshWeb, waitForListenerClosed } from '../../scripts/smoke-dsh-cli.mjs'

const desktopManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const pinnedDshVersion = desktopManifest.dependencies['@deepseek-ai/dsh'] as string
const FIXED_PORT_TEST_TIMEOUT_MS = 7 * 60_000

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

/** 创建带 x86_64 ELF 头和 AppImage type-2 magic 的最小测试文件。 */
function fakeAppImage(): Buffer {
  const buffer = Buffer.alloc(512)
  buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0)
  buffer.set([0x41, 0x49, 2], 8)
  buffer.writeUInt16LE(0x3e, 18)
  return buffer
}

/** 为 artifact 静态验证创建完整的 Windows runtime closure。 */
async function createWindowsClosure(nodeModulesRoot: string): Promise<void> {
  const target = runtimeTarget('win32', 'x64')
  for (const name of [
    '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-cmdline',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/dsh-web-app',
    '@cyunlab/dsh-desktop-capabilities',
    '@cyunlab/dsh-desktop-update-client'
  ]) {
    const directory = path.join(nodeModulesRoot, name)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: 'fixture', dependencies: {} }))
  }
  const dsh = path.join(nodeModulesRoot, '@deepseek-ai', 'dsh')
  await mkdir(path.join(dsh, 'lib'), { recursive: true })
  await writeFile(path.join(dsh, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: pinnedDshVersion,
    bin: { dsh: 'lib/bin.js' },
    dependencies: {}
  }))
  await writeFile(path.join(dsh, 'lib', 'bin.js'), 'process.exit(0)\n')
  for (const asset of requiredRuntimeAssets(target)) {
    const targetPath = path.join(nodeModulesRoot, asset.path)
    if (asset.kind === 'non-empty-directory') {
      await mkdir(targetPath, { recursive: true })
      await writeFile(path.join(targetPath, 'asset.js'), 'asset')
    } else {
      await mkdir(path.dirname(targetPath), { recursive: true })
      await writeFile(targetPath, 'asset')
    }
  }
}

/** 创建包含真实安装目录内容的 Windows NSIS 验收夹具。 */
async function createWindowsFixture(): Promise<{ root: string; artifact: string; bundleRoot: string; extractedRoot: string; nodeModulesRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-contract-'))
  const bundleRoot = path.join(root, 'src-tauri', 'target', 'release', 'bundle')
  const artifactDirectory = path.join(bundleRoot, 'nsis')
  const artifact = path.join(artifactDirectory, 'DeepSeek Harness Desktop_1.1.1_x64-setup.exe')
  const extractedRoot = path.join(root, 'extracted-installer')
  const nodeExecutable = path.join(extractedRoot, 'resources', 'node', 'windows-x86_64', 'node.exe')
  const nodeModulesRoot = path.join(extractedRoot, 'resources', 'dist', 'node_modules')
  const application = path.join(extractedRoot, 'DeepSeek Harness Desktop.exe')
  await Promise.all([artifactDirectory, path.dirname(nodeExecutable), path.dirname(application)]
    .map(directory => mkdir(directory, { recursive: true })))
  await Promise.all([
    writeFile(artifact, fakePe(0x014c, 'Nullsoft NSIS')),
    writeFile(nodeExecutable, fakePe(0x8664)),
    writeFile(application, fakePe(0x8664))
  ])
  await createWindowsClosure(nodeModulesRoot)
  return { root, artifact, bundleRoot, extractedRoot, nodeModulesRoot }
}

/** 返回当前主机在 artifact contract 中的标签和资源目录。 */
function hostArtifactTarget(): { platformName: 'win' | 'mac' | 'linux'; runtimeArch: 'x64' | 'arm64'; resourceName: string; executableName: string } {
  const runtimeArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return { platformName: 'win', runtimeArch, resourceName: 'windows-x86_64', executableName: 'node.exe' }
  if (process.platform === 'darwin') return { platformName: 'mac', runtimeArch, resourceName: runtimeArch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64', executableName: 'node' }
  return { platformName: 'linux', runtimeArch, resourceName: 'linux-x86_64', executableName: 'node' }
}

/** 创建只依赖 Node 内置模块的 published CLI 夹具。 */
async function createRuntimeFixture(cliSource: string): Promise<{ root: string; contentRoot: string; eventsFile: string; nodeExecutable: string; nodeModulesRoot: string; platformName: 'win' | 'mac' | 'linux'; runtimeArch: 'x64' | 'arm64' }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-direct-cli-fixture-'))
  const contentRoot = path.join(root, 'mounted')
  const target = hostArtifactTarget()
  const nodeExecutable = path.join(contentRoot, 'node', target.resourceName, target.executableName)
  const nodeModulesRoot = path.join(contentRoot, 'dist', 'node_modules')
  const dsh = path.join(nodeModulesRoot, '@deepseek-ai', 'dsh')
  const cliEntry = path.join(dsh, 'lib', 'fixture-cli.mjs')
  await Promise.all([path.dirname(nodeExecutable), path.dirname(cliEntry)].map(directory => mkdir(directory, { recursive: true })))
  if (process.platform === 'win32') await copyFile(process.execPath, nodeExecutable)
  else {
    await writeFile(nodeExecutable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
    await chmod(nodeExecutable, 0o755)
  }
  await writeFile(path.join(dsh, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: pinnedDshVersion,
    bin: { dsh: 'lib/fixture-cli.mjs' },
    dependencies: {}
  }))
  await writeFile(cliEntry, cliSource)
  const desktopPatch = path.join(nodeModulesRoot, '@cyunlab', 'dsh-desktop-update-client', 'cordis.patch.yml')
  const desktopEntry = path.join(path.dirname(desktopPatch), 'lib', 'index.js')
  await mkdir(path.dirname(desktopEntry), { recursive: true })
  await writeFile(desktopPatch, "- insert:\n    - id: dsh-desktop-update-client\n      name: '@cyunlab/dsh-desktop-update-client'\n")
  await writeFile(desktopEntry, 'export function apply() {}\n')
  return { root, contentRoot, eventsFile: path.join(root, 'events.log'), nodeExecutable, nodeModulesRoot, platformName: target.platformName, runtimeArch: target.runtimeArch }
}

/** 返回遵守 direct CLI argv、HTTP 与操作系统信号契约的夹具源码。 */
function directCliSource(options: { readonly body?: string; readonly contentType?: string; readonly chunked?: boolean; readonly redirect?: boolean; readonly stdoutFlood?: boolean } = {}): string {
  return `
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
const eventsFile = process.env.DSH_FIXTURE_EVENTS
const record = event => eventsFile && appendFileSync(eventsFile, event + '\\n')
const args = process.argv.slice(2)
const expectedTail = ['--host', '127.0.0.1', '--port', '3080']
record('argv:' + JSON.stringify(process.argv.slice(2)))
if (args[0] !== 'web' || args[1] !== '--patch' || path.basename(args[2] ?? '') !== 'cordis.patch.yml' || JSON.stringify(args.slice(3)) !== JSON.stringify(expectedTail)) process.exit(64)
${options.stdoutFlood ? "for (let index = 0; index < 256; index += 1) process.stdout.write('x'.repeat(65536))" : ''}
const server = createServer((_request, response) => {
  record('http-request')
  response.writeHead(${options.redirect ? 302 : 200}, { 'content-type': ${JSON.stringify(options.contentType ?? 'text/html; charset=utf-8')}${options.redirect ? ", location: 'http://127.0.0.1:3080/final'" : ''} })
  ${options.chunked ? "response.write('<!doctype html><html>'); setTimeout(() => response.end('<body>chunked</body></html>'), 20)" : `response.end(${JSON.stringify(options.body ?? '<!doctype html><html><body>fixture</body></html>')})`}
})
server.listen(3080, '127.0.0.1', () => record('listener-started'))
let stopping = false
const stop = signal => {
  if (stopping) return
  stopping = true
  record('signal:' + signal)
  server.close(() => { record('listener-closed'); process.exit(0) })
}
process.once('SIGTERM', () => stop('SIGTERM'))
process.once('SIGINT', () => stop('SIGINT'))
`
}

/** 返回 HTML 正常、leader 正常退出且 descendant 不占 listener 的夹具源码。 */
function leaderExitDescendantSource(): string {
  const descendant = JSON.stringify(`
const { appendFileSync } = require('node:fs')
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
setInterval(() => {}, 1000)
`)
  return `
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
appendFileSync(process.env.DSH_FIXTURE_EVENTS, 'argv:' + JSON.stringify(process.argv.slice(2)) + '\\n')
const stubborn = spawn(process.execPath, ['-e', ${descendant}], { stdio: 'ignore' })
appendFileSync(process.env.DSH_FIXTURE_EVENTS, 'descendant-alive:' + stubborn.pid + '\\n')
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><p>leader exits</p>')
  server.close(() => process.exit(0))
})
server.listen(3080, '127.0.0.1')
`
}

/** 返回 leader 可优雅退出、descendant 会记录并忽略 TERM 的 POSIX 夹具源码。 */
function gracefulLeaderStubbornDescendantSource(): string {
  const descendant = JSON.stringify(`
const { appendFileSync } = require('node:fs')
process.on('SIGTERM', () => appendFileSync(process.env.DSH_FIXTURE_EVENTS, 'descendant-term\\n'))
process.send?.('ready')
setInterval(() => {}, 1000)
`)
  return `
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
const stubborn = spawn(process.execPath, ['-e', ${descendant}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
appendFileSync(process.env.DSH_FIXTURE_EVENTS, 'descendant-alive:' + stubborn.pid + '\\n')
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><p>graceful leader</p>')
})
stubborn.once('message', () => server.listen(3080, '127.0.0.1'))
process.once('SIGTERM', () => server.close(() => process.exit(0)))
`
}

/** 使用平台接口判断记录的 descendant PID 是否仍存活。 */
function processExists(pid: number): boolean {
  if (process.platform === 'win32') return spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 2_000, killSignal: 'SIGKILL' }).stdout.includes(`"${pid}"`)
  try { process.kill(pid, 0); return true } catch { return false }
}

describe.sequential('Tauri artifact verification', { timeout: FIXED_PORT_TEST_TIMEOUT_MS }, () => {
  /** 验证 Linux 发布验收使用 x86_64 AppImage 容器与运行时闭包。 */
  it('accepts one x86_64 AppImage as the Linux release artifact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-appimage-contract-'))
    const artifactDirectory = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'appimage')
    const artifact = path.join(artifactDirectory, 'DeepSeek Harness Desktop_1.1.1_amd64.AppImage')
    try {
      await mkdir(artifactDirectory, { recursive: true })
      await writeFile(artifact, fakeAppImage())
      await expect(verifyTauriArtifact('linux', {
        projectRoot: root,
        runtimeArch: 'x64',
        containerInspector: async () => undefined
      })).resolves.toBe(artifact)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('checks NSIS magic, application, official Node and the complete published CLI closure', async () => {
    const fixture = await createWindowsFixture()
    try {
      await expect(verifyTauriArtifact('win', {
        projectRoot: fixture.root,
        runtimeArch: 'x64',
        containerInspector: async () => verifyExtractedBundleContents(fixture.extractedRoot, 'win', 'x64')
      })).resolves.toBe(fixture.artifact)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails when the extracted installer has no application executable', async () => {
    const fixture = await createWindowsFixture()
    try {
      await rm(path.join(fixture.extractedRoot, 'DeepSeek Harness Desktop.exe'))
      await expect(verifyExtractedBundleContents(fixture.extractedRoot, 'win', 'x64'))
        .rejects.toThrow('application executable is missing')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([
    ['CLI entry', path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js')],
    ['CLI configuration', path.join('@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard', 'preset.yml')],
    ['frontend', path.join('@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')],
    ['Desktop capability bridge', path.join('@cyunlab', 'dsh-desktop-capabilities', 'lib', 'index.js')],
    ['Desktop update client', path.join('@cyunlab', 'dsh-desktop-update-client', 'lib', 'client.js')],
    ['native dependency', path.join('node-pty', 'prebuilds', 'win32-x64', 'pty.node')],
    ['helper', path.join('node-pty', 'build', 'Release', 'conpty', 'OpenConsole.exe')]
  ])('rejects an artifact missing its %s', async (_label, relative) => {
    const fixture = await createWindowsFixture()
    try {
      await rm(path.join(fixture.nodeModulesRoot, relative), { recursive: true, force: true })
      await expect(verifyExtractedBundleContents(fixture.extractedRoot, 'win', 'x64')).rejects.toThrow()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an MSI anywhere in the complete bundle tree', async () => {
    const fixture = await createWindowsFixture()
    try {
      const forbidden = path.join(fixture.bundleRoot, 'nested', 'unexpected.msi')
      await mkdir(path.dirname(forbidden), { recursive: true })
      await writeFile(forbidden, 'forbidden')
      await expect(verifyTauriArtifact('win', {
        projectRoot: fixture.root,
        runtimeArch: 'x64',
        containerInspector: async () => verifyExtractedBundleContents(fixture.extractedRoot, 'win', 'x64')
      })).rejects.toThrow('MSI output is forbidden')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an executable extension whose content is not an NSIS PE container', async () => {
    const fixture = await createWindowsFixture()
    try {
      await writeFile(fixture.artifact, 'not an executable')
      await expect(verifyTauriArtifact('win', {
        projectRoot: fixture.root,
        runtimeArch: 'x64',
        containerInspector: async () => verifyExtractedBundleContents(fixture.extractedRoot, 'win', 'x64')
      })).rejects.toThrow('PE magic is missing')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('runs package.json#bin.dsh with exact web argv, accepts chunked HTML and closes the listener', async () => {
    const fixture = await createRuntimeFixture(directCliSource({ chunked: true }))
    try {
      process.env.DSH_FIXTURE_EVENTS = fixture.eventsFile
      await expect(probeBundledRuntime(fixture.contentRoot, fixture.platformName, fixture.runtimeArch)).resolves.toBeUndefined()
      const events = await readFile(fixture.eventsFile, 'utf8')
      const argv = events.split('\n').find(line => line.startsWith('argv:'))
      expect(argv).toBeDefined()
      const argumentsList = JSON.parse(argv!.slice('argv:'.length)) as string[]
      expect(argumentsList.slice(0, 2)).toEqual(['web', '--patch'])
      expect(argumentsList[2]).toContain(`${path.sep}.dsh-desktop${path.sep}runtime${path.sep}cordis.patch.yml`)
      expect(argumentsList.slice(3)).toEqual(['--host', '127.0.0.1', '--port', '3080'])
      expect(events).toContain('http-request\n')
      expect(events).toContain('listener-closed\n')
      await expect(waitForListenerClosed()).resolves.toBeUndefined()
    } finally {
      delete process.env.DSH_FIXTURE_EVENTS
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('canonicalizes a symlinked mount path before resolving package.json#bin.dsh', async () => {
    const fixture = await createRuntimeFixture(directCliSource())
    const aliasRoot = path.join(fixture.root, 'mount-alias')
    try {
      await symlink(fixture.contentRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(probeBundledRuntime(aliasRoot, fixture.platformName, fixture.runtimeArch)).resolves.toBeUndefined()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails when the direct CLI exits before HTML without depending on stdout', async () => {
    const fixture = await createRuntimeFixture('process.exit(0)\n')
    try {
      await expect(probeBundledRuntime(fixture.contentRoot, fixture.platformName, fixture.runtimeArch))
        .rejects.toThrow('exited before HTML readiness')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('tracks and force-kills a stubborn descendant after a normally exiting HTML leader', async () => {
    const fixture = await createRuntimeFixture(leaderExitDescendantSource())
    try {
      process.env.DSH_FIXTURE_EVENTS = fixture.eventsFile
      await expect(probeBundledRuntime(fixture.contentRoot, fixture.platformName, fixture.runtimeArch)).resolves.toBeUndefined()
      const events = await readFile(fixture.eventsFile, 'utf8')
      const descendantPid = Number(events.match(/descendant-alive:(\d+)/)?.[1])
      expect(Number.isInteger(descendantPid)).toBe(true)
      expect(processExists(descendantPid)).toBe(false)
      await expect(waitForListenerClosed()).resolves.toBeUndefined()
    } finally {
      delete process.env.DSH_FIXTURE_EVENTS
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, FIXED_PORT_TEST_TIMEOUT_MS)

  it.skipIf(process.platform === 'win32')('signals only the POSIX leader during the graceful window', async () => {
    const fixture = await createRuntimeFixture(gracefulLeaderStubbornDescendantSource())
    try {
      process.env.DSH_FIXTURE_EVENTS = fixture.eventsFile
      await expect(probeBundledRuntime(fixture.contentRoot, fixture.platformName, fixture.runtimeArch)).resolves.toBeUndefined()
      const events = await readFile(fixture.eventsFile, 'utf8')
      expect(events).not.toContain('descendant-term')
      const descendantPid = Number(events.match(/descendant-alive:(\d+)/)?.[1])
      expect(processExists(descendantPid)).toBe(false)
    } finally {
      delete process.env.DSH_FIXTURE_EVENTS
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, FIXED_PORT_TEST_TIMEOUT_MS)

  it('rejects non-text/html while still cleaning the listener', async () => {
    const fixture = await createRuntimeFixture(directCliSource({ contentType: 'application/xhtml+xml' }))
    try {
      await expect(probeBundledRuntime(fixture.contentRoot, fixture.platformName, fixture.runtimeArch))
        .rejects.toThrow('exact text/html')
      await expect(waitForListenerClosed()).resolves.toBeUndefined()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects empty HTML while still cleaning the listener', async () => {
    const fixture = await createRuntimeFixture(directCliSource({ body: '   ' }))
    try {
      await expect(probeBundledRuntime(fixture.contentRoot, fixture.platformName, fixture.runtimeArch))
        .rejects.toThrow('non-empty HTML')
      await expect(waitForListenerClosed()).resolves.toBeUndefined()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects redirects without following them', async () => {
    const fixture = await createRuntimeFixture(directCliSource({ redirect: true }))
    try {
      await expect(probeBundledRuntime(fixture.contentRoot, fixture.platformName, fixture.runtimeArch))
        .rejects.toThrow('HTTP 302')
      await expect(waitForListenerClosed()).resolves.toBeUndefined()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects HTML larger than the 64 KiB readiness bus limit', async () => {
    const fixture = await createRuntimeFixture(directCliSource({ body: 'x'.repeat(64 * 1024 + 1) }))
    try {
      await expect(probeBundledRuntime(fixture.contentRoot, fixture.platformName, fixture.runtimeArch))
        .rejects.toThrow('65536 byte HTML limit')
      await expect(waitForListenerClosed()).resolves.toBeUndefined()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('drains a flooding stdout pipe before HTML readiness', async () => {
    const fixture = await createRuntimeFixture(directCliSource({ stdoutFlood: true }))
    try {
      await expect(probeBundledRuntime(fixture.contentRoot, fixture.platformName, fixture.runtimeArch)).resolves.toBeUndefined()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('reports spawn errors and still completes cleanup', async () => {
    const fixture = await createRuntimeFixture(directCliSource())
    try {
      await writeFile(fixture.nodeExecutable, 'not executable')
      await chmod(fixture.nodeExecutable, 0o644)
      await expect(probeDirectDshWeb({ nodeExecutable: fixture.nodeExecutable, nodeModulesRoot: fixture.nodeModulesRoot, timeoutMilliseconds: 2_000 }))
        .rejects.toThrow('spawn failed')
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
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retries transient macOS mount-directory cleanup failures', async () => {
    let attempts = 0
    await expect(removeInspectionRoot('/tmp/fixture', async () => {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }, { retryDelayMilliseconds: 1 })).resolves.toBeUndefined()
    expect(attempts).toBe(3)
  })

  it('does not invalidate a verified artifact when detached mount cleanup stays busy', async () => {
    const warnings: string[] = []
    await expect(removeInspectionRoot('/tmp/fixture', async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }, {
      maxRetries: 2,
      retryDelayMilliseconds: 1,
      warn: message => warnings.push(message)
    })).resolves.toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('EBUSY')])
  })
})
