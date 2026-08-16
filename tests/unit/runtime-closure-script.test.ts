import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { requiredRuntimeAssets } from '../../scripts/runtime-assets.mjs'

const verifier = path.resolve('scripts/verify-runtime-closure.mjs')

async function writePackage(root: string, name: string, manifest: Record<string, unknown> = {}): Promise<string> {
  const directory = path.join(root, 'node_modules', ...name.split('/'))
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
  return directory
}

async function writeRequiredAssets(root: string): Promise<void> {
  for (const asset of requiredRuntimeAssets({ platform: 'darwin', arch: 'arm64' })) {
    const target = path.join(root, asset.path)
    if (asset.kind === 'non-empty-directory') {
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'asset.js'), 'asset')
    } else {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, 'asset')
      if (asset.executable) await chmod(target, 0o755)
    }
  }
}

describe('runtime closure verifier CLI', () => {
  it('rejects a dynamically configured plugin omitted from the staged application', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'desktop-closure-'))
    await writeRequiredAssets(root)
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      dependencies: { '@deepseek-ai/dsh-base': '1.0.0' }
    }))
    const bundle = await writePackage(root, '@deepseek-ai/dsh-base')
    await writeFile(path.join(bundle, 'cordis.patch.yml'), "- insert:\n  - name: '@deepseek-ai/missing-plugin'\n")

    const result = spawnSync(process.execPath, [verifier, '--app-dir', root, '--target-platform', 'darwin', '--target-arch', 'arm64'], { encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@deepseek-ai/dsh-base/cordis.patch.yml -> @deepseek-ai/missing-plugin')
  })

  it('accepts required manifest dependencies and dynamically configured plugins in the staged application', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'desktop-closure-'))
    await writeRequiredAssets(root)
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      dependencies: { '@deepseek-ai/dsh-base': '1.0.0' }
    }))
    const bundle = await writePackage(root, '@deepseek-ai/dsh-base', {
      dependencies: { '@deepseek-ai/configured-plugin': '1.0.0' }
    })
    await writeFile(path.join(bundle, 'cordis.patch.yml'), "- insert:\n  - name: '@deepseek-ai/configured-plugin'\n")
    await writePackage(root, '@deepseek-ai/configured-plugin')

    const result = spawnSync(process.execPath, [verifier, '--app-dir', root, '--target-platform', 'darwin', '--target-arch', 'arm64'], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('runtime closure verified')
  })
})
