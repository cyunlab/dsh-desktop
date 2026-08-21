import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectMountedDmg, probeBundledRuntime, verifyExtractedBundleContents, verifyTauriArtifact } from '../../scripts/verify-tauri-artifact.mjs'
import { requiredRuntimeAssets, runtimeTarget } from '../../scripts/runtime-closure.mjs'
import { waitForListenerClosed } from '../../scripts/smoke-dsh-cli.mjs'

const desktopManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const pinnedDshVersion = desktopManifest.dependencies['@deepseek-ai/dsh'] as string

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

/** 为 artifact 静态验证创建完整的 Windows runtime closure。 */
async function createWindowsClosure(nodeModulesRoot: string): Promise<void> {
  const target = runtimeTarget('win32', 'x64')
  for (const name of [
    '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-cmdline',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/dsh-web-app'
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
async function createRuntimeFixture(cliSource: string): Promise<{ root: string; contentRoot: string; eventsFile: string; platformName: 'win' | 'mac' | 'linux'; runtimeArch: 'x64' | 'arm64' }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-direct-cli-fixture-'))
  const contentRoot = path.join(root, 'mounted')
  const target = hostArtifactTarget()
  const nodeExecutable = path.join(contentRoot, 'node', target.resourceName, target.executableName)
  const dsh = path.join(contentRoot, 'dist', 'node_modules', '@deepseek-ai', 'dsh')
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
  return { root, contentRoot, eventsFile: path.join(root, 'events.log'), platformName: target.platformName, runtimeArch: target.runtimeArch }
}

/** 返回遵守 direct CLI argv、HTTP 与操作系统信号契约的夹具源码。 */
function directCliSource(options: { readonly body?: string; readonly contentType?: string; readonly chunked?: boolean } = {}): string {
  return `
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
const eventsFile = process.env.DSH_FIXTURE_EVENTS
const record = event => eventsFile && appendFileSync(eventsFile, event + '\\n')
const expected = ['web', '--host', '127.0.0.1', '--port', '3080']
record('argv:' + JSON.stringify(process.argv.slice(2)))
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(64)
const server = createServer((_request, response) => {
  record('http-request')
  response.writeHead(200, { 'content-type': ${JSON.stringify(options.contentType ?? 'text/html; charset=utf-8')} })
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

/** 返回 leader 提前退出但 descendant 保留固定 listener 的夹具源码。 */
function leaderExitDescendantSource(): string {
  const descendant = JSON.stringify(`
const { appendFileSync } = require('node:fs')
const { createServer } = require('node:net')
const server = createServer()
server.listen(3080, '127.0.0.1', () => appendFileSync(process.env.DSH_FIXTURE_EVENTS, 'descendant-listener\\n'))
setInterval(() => {}, 1000)
`)
  return `
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
appendFileSync(process.env.DSH_FIXTURE_EVENTS, 'argv:' + JSON.stringify(process.argv.slice(2)) + '\\n')
spawn(process.execPath, ['-e', ${descendant}], { stdio: 'ignore' })
setTimeout(() => process.exit(0), 200)
`
}

describe.sequential('Tauri artifact verification', () => {
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
      expect(events).toContain('argv:["web","--host","127.0.0.1","--port","3080"]\n')
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

  it.skipIf(process.platform === 'win32')('kills a detached descendant when the CLI leader exits first', async () => {
    const fixture = await createRuntimeFixture(leaderExitDescendantSource())
    try {
      process.env.DSH_FIXTURE_EVENTS = fixture.eventsFile
      await expect(probeBundledRuntime(fixture.contentRoot, fixture.platformName, fixture.runtimeArch))
        .rejects.toThrow('exited before HTML readiness')
      await expect(waitForListenerClosed()).resolves.toBeUndefined()
    } finally {
      delete process.env.DSH_FIXTURE_EVENTS
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

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
})
