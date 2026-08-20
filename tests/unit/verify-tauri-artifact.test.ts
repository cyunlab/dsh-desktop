import { copyFile, mkdir, mkdtemp, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectMountedDmg, probeBundledRuntime, verifyExtractedBundleContents, verifyTauriArtifact } from '../../scripts/verify-tauri-artifact.mjs'

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
async function createRuntimeFixture(sidecarSource: string): Promise<{ root: string; contentRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-runtime-fixture-'))
  const contentRoot = path.join(root, 'mounted')
  const nodeExecutable = path.join(contentRoot, 'node', 'windows-x86_64', 'node.exe')
  const sidecar = path.join(contentRoot, 'dist', 'sidecar', 'index.js')
  await Promise.all([path.dirname(nodeExecutable), path.dirname(sidecar)].map(directory => mkdir(directory, { recursive: true })))
  await copyFile(process.execPath, nodeExecutable)
  await writeFile(sidecar, sidecarSource)
  return { root, contentRoot }
}

/** 返回等待 stop 控制消息后才退出的 HTTP sidecar，防止 verifier 提前关闭 stdin。 */
function lifecycleSidecarSource(): string {
  return `
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
if (path.resolve(process.argv[1]) !== path.resolve(fileURLToPath(import.meta.url))) process.exit(0)
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>fixture</title>')
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(JSON.stringify({ type: 'ready', origin: 'http://127.0.0.1:' + address.port }) + '\\n')
})
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  if (line.trim() !== '{"type":"stop"}') return
  server.close(() => {
    process.stdout.write(JSON.stringify({ type: 'stopped' }) + '\\n')
    process.exit(0)
  })
})
`
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
    await expect(probeBundledRuntime(fixture.contentRoot, 'win', 'x64')).resolves.toBeUndefined()
  })

  it('canonicalizes a symlinked mount path before direct-entry startup', async () => {
    const fixture = await createRuntimeFixture(lifecycleSidecarSource())
    const aliasRoot = path.join(fixture.root, 'mount-alias')
    await symlink(fixture.contentRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(probeBundledRuntime(aliasRoot, 'win', 'x64')).resolves.toBeUndefined()
  })

  it('fails on a silent code-0 sidecar instead of treating it as a successful probe', async () => {
    const fixture = await createRuntimeFixture('process.exit(0)\n')
    await expect(probeBundledRuntime(fixture.contentRoot, 'win', 'x64'))
      .rejects.toThrow('Bundled sidecar exited before ready with code 0')
  })

  it('always detaches a DMG mount after inspection failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-mount-fixture-'))
    const calls: Array<{ file: string; args: string[] }> = []
    const canonicalRoot = await realpath(root)
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
  })
})
