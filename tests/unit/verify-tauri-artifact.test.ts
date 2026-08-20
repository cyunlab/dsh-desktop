import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyExtractedBundleContents, verifyTauriArtifact } from '../../scripts/verify-tauri-artifact.mjs'

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
})
