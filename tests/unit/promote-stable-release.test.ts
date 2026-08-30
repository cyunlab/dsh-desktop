import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createOssutilStorage,
  finalizeStableCandidate,
  prepareStableCandidate,
  verifyTauriSignature,
  type OssutilResult,
  type PromotionStorage
} from '../../scripts/promote-stable-release.mjs'

/** 创建包含四目标更新包与字面签名的发布目录。 */
async function createReleaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-promotion-'))
  const artifacts = [
    ['windows-x86_64', 'dsh-desktop-windows-x86_64-updater.exe', Buffer.from([0x4d, 0x5a, 0x00, 0x01])],
    ['linux-x86_64', 'dsh-desktop-linux-x86_64-updater.AppImage', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0x41, 0x49, 0x02])],
    ['darwin-aarch64', 'dsh-desktop-darwin-aarch64-updater.app.tar.gz', Buffer.from([0x1f, 0x8b, 0x08, 0x00])],
    ['darwin-x86_64', 'dsh-desktop-darwin-x86_64-updater.app.tar.gz', Buffer.from([0x1f, 0x8b, 0x08, 0x00])]
  ] as const
  for (const [target, filename, body] of artifacts) {
    const targetDirectory = path.join(directory, target)
    await mkdir(targetDirectory, { recursive: true })
    await writeFile(path.join(targetDirectory, filename), body)
    await writeFile(path.join(targetDirectory, `${filename}.sig`), `literal-${target}-signature\n`)
  }
  return directory
}

/** 创建记录发布行为的内存存储边界。 */
function createStorage(): PromotionStorage & {
  events: string[]
  writes: Array<{ key: string; cacheControl: string; body: Buffer }>
} {
  const events: string[] = []
  const writes: Array<{ key: string; cacheControl: string; body: Buffer }> = []
  return {
    events,
    writes,
    /** 记录上传边界的可观察输入。 */
    async ensureObject(key, body, metadata) {
      events.push(`ensure:${key}`)
      const existing = writes.find(write => write.key === key)
      if (existing) {
        if (!existing.body.equals(body)) throw new Error(`immutable object changed: ${key}`)
        return 'reused' as const
      }
      writes.push({ key, body, cacheControl: metadata.cacheControl })
      return 'uploaded' as const
    },
    /** 记录允许覆盖的 Stable manifest 写入。 */
    async replaceObject(key, body, metadata) {
      events.push(`replace:${key}`)
      writes.push({ key, body, cacheControl: metadata.cacheControl })
    },
    /** 记录远端验证边界的调用顺序。 */
    async readObject(key) {
      events.push(`read:${key}`)
      for (let index = writes.length - 1; index >= 0; index -= 1) {
        if (writes[index].key === key) return writes[index].body
      }
      return Buffer.alloc(0)
    },
    /** 原子获取全局 Stable promotion lock。 */
    async acquirePromotionLock(key, body) {
      events.push(`lock:${key}`)
      writes.push({ key, body, cacheControl: 'no-cache' })
    },
    /** 仅由持有者释放全局 Stable promotion lock。 */
    async releasePromotionLock(key) {
      events.push(`unlock:${key}`)
    }
  }
}

/** 在 fake storage 中写入一个可供 candidate smoke 使用的上一 Stable pointer。 */
function seedPreviousStable(storage: ReturnType<typeof createStorage>) {
  storage.writes.push({
    key: 'dsh-desktop/channels/stable/latest.json',
    cacheControl: 'no-cache',
    body: Buffer.from(JSON.stringify({ version: '2.0.15', platforms: {} }))
  })
}

/** 仅通过生产 candidate prepare/finalize 协议执行测试 promotion。 */
async function promoteFixture(
  options: Omit<Parameters<typeof prepareStableCandidate>[0], 'candidateCommit'>,
  storage: ReturnType<typeof createStorage>,
  dependencies = { verifySignature: async (_artifactPath: string, _signaturePath: string) => {} }
) {
  if (!storage.writes.some(write => write.key.endsWith('/channels/stable/latest.json'))) seedPreviousStable(storage)
  const candidate = await prepareStableCandidate({
    ...options,
    candidateCommit: '0123456789abcdef0123456789abcdef01234567'
  }, storage, dependencies)
  return finalizeStableCandidate(candidate, storage, {
    prefix: options.prefix,
    lockOwner: `test-run:1:${candidate.candidate_commit}`
  })
}

describe('Stable update promotion', () => {
  /** 验证 candidate 阶段只写不可变对象和隔离 manifest，绝不提前修改 Stable。 */
  it('prepares an immutable candidate without changing Stable', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    seedPreviousStable(storage)
    try {
      const candidate = await prepareStableCandidate({
        tag: 'v2.1.0',
        releaseBody: 'Candidate release notes.',
        publishedAt: '2026-08-28T02:30:00Z',
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage, { verifySignature: async () => {} })

      expect(candidate).toMatchObject({
        schema_version: 1,
        candidate_tag: 'v2.1.0',
        candidate_commit: '0123456789abcdef0123456789abcdef01234567',
        manifest_url: expect.stringMatching(/^https:\/\/updates\.cyunlab\.com\/dsh-desktop\/candidates\/2\.1\.0\//),
        manifest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        previous_stable_tag: 'v2.0.15',
        previous_stable_version: '2.0.15',
        previous_stable_url: 'https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json',
        previous_stable_manifest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
      expect(Object.keys(candidate.manifest.platforms)).toEqual([
        'windows-x86_64',
        'linux-x86_64',
        'darwin-aarch64',
        'darwin-x86_64'
      ])
      expect(storage.events.some(event => event.startsWith('replace:'))).toBe(false)
      expect(storage.writes).toHaveLength(10)
      expect(storage.writes.slice(1).every(write => write.cacheControl === 'public, max-age=31536000, immutable')).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证 final promotion 复核远端 candidate 后才把同一份 manifest 写入 Stable。 */
  it('writes Stable only from the byte-identical verified candidate manifest', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    seedPreviousStable(storage)
    try {
      const candidate = await prepareStableCandidate({
        tag: 'v2.1.0',
        releaseBody: 'Candidate release notes.',
        publishedAt: '2026-08-28T02:30:00Z',
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage, { verifySignature: async () => {} })
      storage.events.length = 0

      const manifest = await finalizeStableCandidate(candidate, storage, { prefix: 'dsh-desktop', lockOwner: `test-run:1:${candidate.candidate_commit}` })

      expect(manifest).toEqual(candidate.manifest)
      expect(storage.events).toEqual([
        'lock:dsh-desktop/channels/stable/promotion.lock',
        'read:dsh-desktop/channels/stable/latest.json',
        expect.stringMatching(/^read:dsh-desktop\/candidates\/2\.1\.0\//),
        'replace:dsh-desktop/channels/stable/latest.json',
        'read:dsh-desktop/channels/stable/latest.json',
        'unlock:dsh-desktop/channels/stable/promotion.lock'
      ])
      expect(storage.writes.at(-1)).toMatchObject({
        key: 'dsh-desktop/channels/stable/latest.json',
        cacheControl: 'no-cache'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证 candidate manifest 被篡改时 final promotion 保留旧 Stable。 */
  it('leaves Stable untouched when the remote candidate manifest no longer matches its digest', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    seedPreviousStable(storage)
    try {
      const candidate = await prepareStableCandidate({
        tag: 'v2.1.0',
        releaseBody: 'Candidate release notes.',
        publishedAt: '2026-08-28T02:30:00Z',
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage, { verifySignature: async () => {} })
      storage.events.length = 0
      storage.readObject = async key => {
        storage.events.push(`read:${key}`)
        if (key === 'dsh-desktop/channels/stable/latest.json') {
          return storage.writes.find(write => write.key === key)!.body
        }
        return Buffer.from('{"tampered":true}\n')
      }

      await expect(finalizeStableCandidate(candidate, storage, { prefix: 'dsh-desktop', lockOwner: `test-run:1:${candidate.candidate_commit}` }))
        .rejects.toThrow('candidate manifest digest mismatch')
      expect(storage.events.some(event => event.startsWith('replace:'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证 smoke 期间 Stable pointer 发生漂移时拒绝覆盖新状态。 */
  it('leaves Stable untouched when the authoritative previous Stable changed during smoke', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    seedPreviousStable(storage)
    try {
      const candidate = await prepareStableCandidate({
        tag: 'v2.1.0',
        releaseBody: 'Candidate release notes.',
        publishedAt: '2026-08-28T02:30:00Z',
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage, { verifySignature: async () => {} })
      storage.events.length = 0
      storage.writes[0].body = Buffer.from(JSON.stringify({ version: '2.0.16', platforms: {} }))

      await expect(finalizeStableCandidate(candidate, storage, { prefix: 'dsh-desktop', lockOwner: `test-run:1:${candidate.candidate_commit}` }))
        .rejects.toThrow('previous Stable manifest changed after candidate preparation')
      expect(storage.events).toContain('lock:dsh-desktop/channels/stable/promotion.lock')
      expect(storage.events).not.toContain('unlock:dsh-desktop/channels/stable/promotion.lock')
      expect(storage.events.some(event => event.startsWith('replace:'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证没有真实 previous Stable 时不能准备 candidate 或进入 bootstrap bypass。 */
  it('fails closed when no previous Stable updater release exists', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    try {
      await expect(prepareStableCandidate({
        tag: 'v2.1.0',
        releaseBody: 'Candidate release notes.',
        publishedAt: '2026-08-28T02:30:00Z',
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage, { verifySignature: async () => {} })).rejects.toThrow('previous Stable manifest is required')
      expect(storage.events.some(event => event.startsWith('ensure:'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证伪装扩展名但没有目标平台 magic 的包在 OSS 写入前被拒绝。 */
  it('rejects an updater artifact whose executable format does not match its target', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    seedPreviousStable(storage)
    await writeFile(path.join(directory, 'windows-x86_64', 'dsh-desktop-windows-x86_64-updater.exe'), 'not-a-pe-file')
    try {
      await expect(prepareStableCandidate({
        tag: 'v2.1.0',
        releaseBody: 'Candidate release notes.',
        publishedAt: '2026-08-28T02:30:00Z',
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage, { verifySignature: async () => {} })).rejects.toThrow('invalid Windows updater executable')
      expect(storage.events.some(event => event.startsWith('ensure:'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证四目标发布内容、metadata 与最终 manifest 顺序。 */
  it('publishes the four updater targets using the GitHub Release body and literal signatures', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    try {
      const manifest = await promoteFixture({
        tag: 'v2.1.0',
        releaseBody: 'Fixed startup and update handling.',
        publishedAt: '2026-08-28T02:30:00Z',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage)

      expect(manifest).toEqual({
        version: '2.1.0',
        notes: 'Fixed startup and update handling.',
        pub_date: '2026-08-28T02:30:00Z',
        platforms: {
          'windows-x86_64': {
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/windows-x86_64/b2a78f2057a9e54b7ca5c10ed45b35c26f0e0e9515e842092c6cb9976f117133-dsh-desktop-windows-x86_64-updater.exe',
            signature: 'literal-windows-x86_64-signature\n'
          },
          'linux-x86_64': {
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/linux-x86_64/be9f459beb8b4cc94d69639157449701c5e65491c7962806be9f991971991e19-dsh-desktop-linux-x86_64-updater.AppImage',
            signature: 'literal-linux-x86_64-signature\n'
          },
          'darwin-aarch64': {
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/darwin-aarch64/fd72d30440b0bae1b1c6db6c8ad807f238ef3ca613aa7e8d5329e1e8ddf7da72-dsh-desktop-darwin-aarch64-updater.app.tar.gz',
            signature: 'literal-darwin-aarch64-signature\n'
          },
          'darwin-x86_64': {
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/darwin-x86_64/fd72d30440b0bae1b1c6db6c8ad807f238ef3ca613aa7e8d5329e1e8ddf7da72-dsh-desktop-darwin-x86_64-updater.app.tar.gz',
            signature: 'literal-darwin-x86_64-signature\n'
          }
        }
      })
      const immutableWrites = storage.writes.filter(write => write.cacheControl === 'public, max-age=31536000, immutable')
      expect(immutableWrites).toHaveLength(9)
      expect(immutableWrites[1].key).toBe('dsh-desktop/releases/2.1.0/windows-x86_64/6db7805715b93f0d6e447c59cb476199f37623ed8c49664de1c9045ba338316a-dsh-desktop-windows-x86_64-updater.exe.sig')
      expect(storage.writes.at(-1)).toMatchObject({
        key: 'dsh-desktop/channels/stable/latest.json',
        cacheControl: 'no-cache'
      })
      expect(JSON.parse(storage.writes.at(-1)!.body.toString('utf8'))).toEqual(manifest)
      expect(storage.events).toContain('replace:dsh-desktop/channels/stable/latest.json')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证同一 semver 的不同字节使用新 key，旧 immutable 对象不会被覆盖。 */
  it('uses different content-addressed keys for changed package and signature bytes', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    try {
      seedPreviousStable(storage)
      const first = await prepareStableCandidate({
        tag: 'v2.1.0',
        releaseBody: 'First publication',
        publishedAt: '2026-08-28T02:30:00Z',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop',
        candidateCommit: '0123456789abcdef0123456789abcdef01234567'
      }, storage, { verifySignature: async () => {} })
      await writeFile(path.join(directory, 'windows-x86_64', 'dsh-desktop-windows-x86_64-updater.exe'), Buffer.from([0x4d, 0x5a, 0x02, 0x03]))
      await writeFile(path.join(directory, 'windows-x86_64', 'dsh-desktop-windows-x86_64-updater.exe.sig'), 'changed-signature\n')
      const second = await prepareStableCandidate({
        tag: 'v2.1.0',
        releaseBody: 'Corrected publication',
        publishedAt: '2026-08-28T03:30:00Z',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop',
        candidateCommit: '89abcdef0123456789abcdef0123456789abcdef'
      }, storage, { verifySignature: async () => {} })

      expect(second.manifest.platforms['windows-x86_64'].url).not.toBe(first.manifest.platforms['windows-x86_64'].url)
      const windowsObjects = storage.writes.filter(write => write.key.includes('/windows-x86_64/'))
      expect(windowsObjects).toHaveLength(4)
      expect(new Set(windowsObjects.map(write => write.key)).size).toBe(4)
      expect(storage.events.some(event => event.startsWith('replace:'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证远端复核失败时不修改 Stable manifest。 */
  it('leaves the Stable manifest untouched when remote validation fails', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    /** 模拟远端校验在 Linux 对象处失败。 */
    storage.readObject = async key => {
      storage.events.push(`read:${key}`)
      if (key.includes('linux-x86_64')) throw new Error('remote object mismatch')
      return storage.writes.find(write => write.key === key)?.body ?? Buffer.alloc(0)
    }
    try {
      await expect(promoteFixture({
        tag: 'v2.1.0',
        releaseBody: 'Release notes',
        publishedAt: '2026-08-28T02:30:00Z',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage)).rejects.toThrow('remote object mismatch')
      expect(storage.events.some(event => event.startsWith('replace:'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证 immutable 上传失败时不修改 Stable manifest。 */
  it('leaves the Stable manifest untouched when an immutable upload fails', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    /** 模拟 immutable 对象上传在 macOS arm64 处失败。 */
    storage.ensureObject = async (key, body, metadata) => {
      storage.events.push(`ensure:${key}`)
      if (key.includes('darwin-aarch64')) throw new Error('OSS upload failed')
      storage.writes.push({ key, body, cacheControl: metadata.cacheControl })
      return 'uploaded' as const
    }
    try {
      await expect(promoteFixture({
        tag: 'v2.1.0',
        releaseBody: 'Release notes',
        publishedAt: '2026-08-28T02:30:00Z',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage)).rejects.toThrow('OSS upload failed')
      expect(storage.events.some(event => event.startsWith('replace:'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证任一目标缺签名时 fail closed。 */
  it('fails closed when any target signature is missing', async () => {
    const directory = await createReleaseDirectory()
    await rm(path.join(directory, 'windows-x86_64', 'dsh-desktop-windows-x86_64-updater.exe.sig'))
    try {
      await expect(promoteFixture({
        tag: 'v2.1.0',
        releaseBody: 'Release notes',
        publishedAt: '2026-08-28T02:30:00Z',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, createStorage())).rejects.toThrow('updater signature is missing for windows-x86_64')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证所有密码学签名在任何 OSS 操作前完成。 */
  it('verifies every updater signature before the first OSS operation', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    const verified: string[] = []
    try {
      await expect(promoteFixture({
        tag: 'v2.1.0',
        releaseBody: 'Release notes',
        publishedAt: '2026-08-28T02:30:00Z',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage, {
        async verifySignature(artifactPath, signaturePath) {
          verified.push(`${path.basename(artifactPath)}:${path.basename(signaturePath)}`)
          if (artifactPath.includes('darwin-aarch64')) throw new Error('invalid updater signature')
        }
      })).rejects.toThrow('invalid updater signature')
      expect(verified).toHaveLength(3)
      expect(storage.events.some(event => event.startsWith('ensure:'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证默认 minisign 适配器使用官方校验参数且不经 shell。 */
  it('verifies a Tauri signature with minisign and the configured public key', async () => {
    const calls: Array<{ args: string[]; shell: boolean }> = []
    const publicKeyPacket = 'RWST3AOnSlwxKdQeGVbg9+u22K2c7niKQPaCJy4ECs9GpC6Moedx+9uf'
    const tauriPublicKey = Buffer.from(`untrusted comment: minisign public key: 29315C4AA703DC93\n${publicKeyPacket}`).toString('base64')
    /** 记录 minisign 适配器收到的公开参数，避免执行本机二进制。 */
    await verifyTauriSignature('/release/app.exe', '/release/app.exe.sig', tauriPublicKey, async (args, options) => {
      calls.push({ args, shell: options.shell })
    })
    expect(calls).toEqual([{
      args: ['-Vm', '/release/app.exe', '-x', '/release/app.exe.sig', '-P', publicKeyPacket],
      shell: false
    }])
    await expect(verifyTauriSignature('/release/app.exe', '/release/app.exe.sig', publicKeyPacket, async () => undefined))
      .rejects.toThrow('base64-encoded two-line minisign public key file')
  })

  /** 验证非法 release tag 在上传前被拒绝。 */
  it('fails closed before upload when the release tag is not semantic', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    try {
      await expect(promoteFixture({
        tag: 'latest',
        releaseBody: 'Release notes',
        publishedAt: '2026-08-28T02:30:00Z',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage)).rejects.toThrow('release tag is not a semantic version')
      expect(storage.events.some(event => event.startsWith('ensure:'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证空 GitHub Release body 被拒绝。 */
  it('fails closed when the published release body is empty', async () => {
    const directory = await createReleaseDirectory()
    try {
      await expect(promoteFixture({
        tag: 'v2.1.0',
        releaseBody: '   ',
        publishedAt: '2026-08-28T02:30:00Z',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, createStorage())).rejects.toThrow('GitHub Release body is required')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证 ossutil v1 临时配置、权限和凭据隔离。 */
  it('uses a short-lived v1 ossutil config without exposing credentials in arguments or environment', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; configFile: string; config: string; directoryMode: number; fileMode: number }> = []
    /** 读取调用时仍存在的临时配置及其权限。 */
    const runOssutil = async (args: string[], options: { env: NodeJS.ProcessEnv }): Promise<OssutilResult> => {
      const configIndex = args.indexOf('--config-file')
      const configFile = args[configIndex + 1]
      const [config, directoryInformation, fileInformation] = await Promise.all([
        readFile(configFile, 'utf8'),
        stat(path.dirname(configFile)),
        stat(configFile)
      ])
      calls.push({
        args,
        env: options.env,
        configFile,
        config,
        directoryMode: directoryInformation.mode & 0o777,
        fileMode: fileInformation.mode & 0o777
      })
      const downloadsObject = args[0] === 'cp' && args[1]?.startsWith('oss://')
      if (calls.length === 1 && downloadsObject) throw new Error('NoSuchKey: object does not exist')
      if (downloadsObject) await writeFile(args[2], Buffer.from('package bytes'))
      return { stdout: Buffer.from('0.123(s) elapsed\n'), stderr: '' }
    }
    const storage = createOssutilStorage({
      bucket: 'cyunlab-public-releases',
      region: 'cn-shenzhen',
      prefix: 'dsh-desktop',
      credentials: {
        accessKeyId: 'temporary-id',
        accessKeySecret: 'temporary-secret',
        securityToken: 'temporary-token'
      },
      runOssutil
    })
    await storage.ensureObject('dsh-desktop/releases/2.1.0/linux-x86_64/package', Buffer.from('package bytes'), {
      cacheControl: 'public, max-age=31536000, immutable'
    })
    await storage.readObject('dsh-desktop/releases/2.1.0/linux-x86_64/package')
    await storage.replaceObject('dsh-desktop/channels/stable/latest.json', Buffer.from('{}'), {
      cacheControl: 'no-cache',
      contentType: 'application/json'
    })

    expect(calls[1].args).toContain('oss://cyunlab-public-releases/dsh-desktop/releases/2.1.0/linux-x86_64/package')
    expect(calls[1].args).toEqual(expect.arrayContaining([
      '--meta',
      'Cache-Control:public, max-age=31536000, immutable'
    ]))
    expect(calls[1].args).not.toContain('--force')
    expect(calls[2].args).toEqual([
      'cp',
      'oss://cyunlab-public-releases/dsh-desktop/releases/2.1.0/linux-x86_64/package',
      expect.any(String),
      '--force',
      '--config-file',
      calls[2].configFile
    ])
    await expect(stat(calls[2].args[2])).rejects.toThrow()
    expect(calls[3].args).toEqual(expect.arrayContaining([
      'cp',
      'oss://cyunlab-public-releases/dsh-desktop/channels/stable/latest.json',
      '--force',
      '--meta',
      'Cache-Control:no-cache#Content-Type:application/json'
    ]))
    expect(calls[0].config).toBe([
      '[Credentials]',
      'endpoint=oss-cn-shenzhen.aliyuncs.com',
      'accessKeyID=temporary-id',
      'accessKeySecret=temporary-secret',
      'stsToken=temporary-token',
      ''
    ].join('\n'))
    expect(calls.every(call => call.directoryMode === 0o700 && call.fileMode === 0o600)).toBe(true)
    expect(calls.every(call => !JSON.stringify(call.args).includes('temporary-'))).toBe(true)
    expect(calls.every(call => !JSON.stringify(call.env).includes('temporary-'))).toBe(true)
    expect(new Set(calls.map(call => call.configFile)).size).toBe(4)
    for (const call of calls) await expect(stat(call.configFile)).rejects.toThrow()
    await expect(storage.ensureObject('another-app/releases/2.1.0/package', Buffer.from('wrong scope'), {
      cacheControl: 'no-cache'
    })).rejects.toThrow('outside the configured application prefix')
  })

  /** 验证 immutable 对象仅可复用相同字节，绝不覆盖不同内容。 */
  it('reuses an identical immutable object and rejects different existing bytes', async () => {
    const commands: string[][] = []
    /** 模拟已存在的 immutable OSS 对象。 */
    const runOssutil = async (args: string[]): Promise<OssutilResult> => {
      commands.push(args)
      await writeFile(args[2], Buffer.from('existing bytes'))
      return { stdout: Buffer.from('0.123(s) elapsed\n'), stderr: '' }
    }
    const storage = createOssutilStorage({
      bucket: 'cyunlab-public-releases',
      region: 'cn-shenzhen',
      prefix: 'dsh-desktop',
      credentials: {
        accessKeyId: 'temporary-id',
        accessKeySecret: 'temporary-secret',
        securityToken: 'temporary-token'
      },
      runOssutil
    })
    await expect(storage.ensureObject('dsh-desktop/releases/2.1.0/package', Buffer.from('existing bytes'), {
      cacheControl: 'public, max-age=31536000, immutable'
    })).resolves.toBe('reused')
    await expect(storage.ensureObject('dsh-desktop/releases/2.1.0/package', Buffer.from('different bytes'), {
      cacheControl: 'public, max-age=31536000, immutable'
    })).rejects.toThrow('immutable OSS object already exists with different bytes')
    expect(commands.every(args => args[0] === 'cp' && args[1]?.startsWith('oss://'))).toBe(true)
  })

})
