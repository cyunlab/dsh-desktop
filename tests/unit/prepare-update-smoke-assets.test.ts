import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { prepareUpdateSmokeAsset } from '../../scripts/prepare-update-smoke-assets.mjs'

const roots: string[] = []

/** 生成包含 NSIS marker 的最小测试包。 */
function nsisBytes() {
  const body = Buffer.alloc(256)
  body.write('MZ', 0, 'ascii')
  body.write('Nullsoft NSIS', 64, 'ascii')
  return body
}

/** 生成按内容摘要命名的 immutable URL。 */
function immutableUrl(version: string, target: string, body: Buffer) {
  const digest = createHash('sha256').update(body).digest('hex')
  return `https://updates.cyunlab.com/dsh-desktop/releases/${version}/${target}/${digest}-desktop.exe`
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('update smoke asset preparer public seam', () => {
  /** manifest 是 baseline/candidate 选择的唯一权威并保留 literal signature pairing。 */
  it('downloads the exact target object and signature from an immutable manifest', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'smoke-assets-'))
    roots.push(directory)
    const packageBody = nsisBytes()
    const url = immutableUrl('2.0.15', 'windows-x86_64', packageBody)
    const manifestBody = Buffer.from(JSON.stringify({
      version: '2.0.15',
      platforms: { 'windows-x86_64': { url, signature: 'literal-updater-signature' } }
    }))
    const fetcher = async (requested: string) => new Response(requested.endsWith('latest.json') ? manifestBody : packageBody, { status: 200 })
    const result = await prepareUpdateSmokeAsset({ manifestUrl: 'https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json', target: 'windows-x86_64', expectedVersion: '2.0.15', outputDirectory: directory, label: 'baseline' }, { fetcher })
    expect(result.artifactUrl).toBe(url)
    expect(await readFile(result.signaturePath, 'utf8')).toBe('literal-updater-signature')
    expect(result.manifestSha256).toBe(createHash('sha256').update(manifestBody).digest('hex'))
  })

  /** 缺目标、可变URL、摘要不匹配或错误容器必须 fail closed。 */
  it('rejects missing target and tampered immutable objects', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'smoke-assets-'))
    roots.push(directory)
    const missing = Buffer.from(JSON.stringify({ version: '2.0.15', platforms: {} }))
    await expect(prepareUpdateSmokeAsset({ manifestUrl: 'https://updates.cyunlab.com/stable.json', target: 'windows-x86_64', expectedVersion: '2.0.15', outputDirectory: directory, label: 'baseline' }, { fetcher: async () => new Response(missing) }))
      .rejects.toThrow('target is missing')
    const body = nsisBytes()
    const manifest = Buffer.from(JSON.stringify({ version: '2.0.15', platforms: { 'windows-x86_64': { url: `https://updates.cyunlab.com/dsh-desktop/releases/2.0.15/windows-x86_64/${'0'.repeat(64)}-desktop.exe`, signature: 'sig' } } }))
    await expect(prepareUpdateSmokeAsset({ manifestUrl: 'https://updates.cyunlab.com/stable.json', target: 'windows-x86_64', expectedVersion: '2.0.15', outputDirectory: directory, label: 'baseline' }, { fetcher: async url => new Response(url.endsWith('stable.json') ? manifest : body) }))
      .rejects.toThrow('digest does not match immutable URL')
  })

  /** candidate 绝不能把 Stable latest.json 当作隔离测试 manifest。 */
  it('rejects Stable as the candidate manifest', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'smoke-assets-'))
    roots.push(directory)
    await expect(prepareUpdateSmokeAsset({ manifestUrl: 'https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json', target: 'windows-x86_64', expectedVersion: '2.1.0', outputDirectory: directory, label: 'candidate' }))
      .rejects.toThrow('isolated manifest')
  })
})
