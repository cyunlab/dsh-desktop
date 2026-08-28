import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createOssutilStorage,
  promoteStableRelease,
  runPromotionCli,
  verifyTauriSignature,
  type OssutilResult,
  type PromotionStorage
} from '../../scripts/promote-stable-release.mjs'

/** 创建包含四目标更新包与字面签名的发布目录。 */
async function createReleaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-promotion-'))
  const artifacts = [
    ['windows-x86_64', 'desktop.nsis.zip'],
    ['linux-x86_64', 'desktop.AppImage.tar.gz'],
    ['darwin-aarch64', 'desktop-aarch64.app.tar.gz'],
    ['darwin-x86_64', 'desktop-x86_64.app.tar.gz']
  ] as const
  for (const [target, filename] of artifacts) {
    const targetDirectory = path.join(directory, target)
    await mkdir(targetDirectory, { recursive: true })
    await writeFile(path.join(targetDirectory, filename), `${target}-package`)
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
      return writes.find(write => write.key === key)?.body ?? Buffer.alloc(0)
    }
  }
}

/** 使用通过的密码学验证 seam 执行测试 promotion。 */
function promoteFixture(options: Parameters<typeof promoteStableRelease>[0], storage: PromotionStorage) {
  return promoteStableRelease(options, storage, { verifySignature: async () => {} })
}

describe('Stable update promotion', () => {
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
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/windows-x86_64/0076b8231ad26d88f1d9f50c85e31f34d1669c6ccf4ca4b1570cb7f9cb794c30-desktop.nsis.zip',
            signature: 'literal-windows-x86_64-signature\n'
          },
          'linux-x86_64': {
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/linux-x86_64/b673dbc691888ed591d1e8d7b9ca2071b6d94a03129debd13d0c24c73f8e76ae-desktop.AppImage.tar.gz',
            signature: 'literal-linux-x86_64-signature\n'
          },
          'darwin-aarch64': {
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/darwin-aarch64/eb6dff2c53b529b402a85d26fb9c264e1102bbd41d32ed203c4c314a4acb4f83-desktop-aarch64.app.tar.gz',
            signature: 'literal-darwin-aarch64-signature\n'
          },
          'darwin-x86_64': {
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/darwin-x86_64/c838dd59aa087703d0fa3223e8fed37c49546d15caca947411264d6f0b154327-desktop-x86_64.app.tar.gz',
            signature: 'literal-darwin-x86_64-signature\n'
          }
        }
      })
      expect(storage.writes).toHaveLength(9)
      expect(storage.writes.slice(0, 8).every(write => write.cacheControl === 'public, max-age=31536000, immutable')).toBe(true)
      expect(storage.writes[1].key).toBe('dsh-desktop/releases/2.1.0/windows-x86_64/6db7805715b93f0d6e447c59cb476199f37623ed8c49664de1c9045ba338316a-desktop.nsis.zip.sig')
      expect(storage.writes.at(-1)).toMatchObject({
        key: 'dsh-desktop/channels/stable/latest.json',
        cacheControl: 'no-cache'
      })
      expect(JSON.parse(storage.writes.at(-1)!.body.toString('utf8'))).toEqual(manifest)
      expect(storage.events.at(-1)).toBe('replace:dsh-desktop/channels/stable/latest.json')
      expect(storage.events.slice(8, 16).every(event => event.startsWith('read:'))).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证同一 semver 的不同字节使用新 key，旧 immutable 对象不会被覆盖。 */
  it('uses different content-addressed keys for changed package and signature bytes', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    try {
      const first = await promoteFixture({
        tag: 'v2.1.0',
        releaseBody: 'First publication',
        publishedAt: '2026-08-28T02:30:00Z',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage)
      await writeFile(path.join(directory, 'windows-x86_64', 'desktop.nsis.zip'), 'changed-package')
      await writeFile(path.join(directory, 'windows-x86_64', 'desktop.nsis.zip.sig'), 'changed-signature\n')
      const second = await promoteFixture({
        tag: 'v2.1.0',
        releaseBody: 'Corrected publication',
        publishedAt: '2026-08-28T03:30:00Z',
        artifactsDirectory: directory,
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      }, storage)

      expect(second.platforms['windows-x86_64'].url).not.toBe(first.platforms['windows-x86_64'].url)
      const windowsObjects = storage.writes.filter(write => write.key.includes('/windows-x86_64/'))
      expect(windowsObjects).toHaveLength(4)
      expect(new Set(windowsObjects.map(write => write.key)).size).toBe(4)
      expect(storage.events.at(-1)).toBe('replace:dsh-desktop/channels/stable/latest.json')
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
      expect(storage.writes.some(write => write.key.endsWith('/channels/stable/latest.json'))).toBe(false)
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
      expect(storage.writes.some(write => write.key.endsWith('/channels/stable/latest.json'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证任一目标缺签名时 fail closed。 */
  it('fails closed when any target signature is missing', async () => {
    const directory = await createReleaseDirectory()
    await rm(path.join(directory, 'windows-x86_64', 'desktop.nsis.zip.sig'))
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
      await expect(promoteStableRelease({
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
      expect(storage.events).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证默认 minisign 适配器使用官方校验参数且不经 shell。 */
  it('verifies a Tauri signature with minisign and the configured public key', async () => {
    const calls: Array<{ args: string[]; shell: boolean }> = []
    /** 记录 minisign 适配器收到的公开参数，避免执行本机二进制。 */
    await verifyTauriSignature('/release/app.exe', '/release/app.exe.sig', 'RWQpublic', async (args, options) => {
      calls.push({ args, shell: options.shell })
    })
    expect(calls).toEqual([{
      args: ['-Vm', '/release/app.exe', '-x', '/release/app.exe.sig', '-P', 'RWQpublic'],
      shell: false
    }])
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
      expect(storage.writes).toHaveLength(0)
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

  /** 验证 published GitHub Release 与 STS 环境契约。 */
  it('builds the promotion only from a published GitHub Release and short-lived STS credentials', async () => {
    const directory = await createReleaseDirectory()
    const eventFile = path.join(directory, 'event.json')
    await writeFile(eventFile, JSON.stringify({
      action: 'published',
      repository: { full_name: 'cyunlab/dsh-desktop' },
      release: {
        draft: false,
        tag_name: 'v2.1.0',
        body: 'Notes from the published GitHub Release.',
        published_at: '2026-08-28T02:30:00Z'
      }
    }))
    let receivedOptions: Record<string, unknown> | undefined
    let receivedStorage: PromotionStorage | undefined
    try {
      await runPromotionCli({
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_REPOSITORY: 'cyunlab/dsh-desktop',
        OSS_BUCKET: 'cyunlab-public-releases',
        OSS_REGION: 'cn-shenzhen',
        UPDATE_BASE_URL: 'https://updates.cyunlab.com',
        TAURI_SIGNING_PUBLIC_KEY: 'RWQpublic',
        PROMOTION_ARTIFACTS_DIR: directory,
        ALIBABA_CLOUD_ACCESS_KEY_ID: 'temporary-id',
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'temporary-secret',
        ALIBABA_CLOUD_SECURITY_TOKEN: 'temporary-session-token'
      }, {
        createStorage(options) {
          expect(options).toMatchObject({
            bucket: 'cyunlab-public-releases',
            region: 'cn-shenzhen',
            credentials: { accessKeyId: 'temporary-id', securityToken: 'temporary-session-token' }
          })
          receivedStorage = createStorage()
          return receivedStorage
        },
        async promote(options, storage) {
          receivedOptions = options as unknown as Record<string, unknown>
          expect(storage).toBe(receivedStorage)
          return { version: '2.1.0', notes: '', pub_date: '', platforms: {} }
        }
      })
      expect(receivedOptions).toMatchObject({
        tag: 'v2.1.0',
        releaseBody: 'Notes from the published GitHub Release.',
        publishedAt: '2026-08-28T02:30:00Z',
        downloadOrigin: 'https://updates.cyunlab.com',
        prefix: 'dsh-desktop'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /** 验证缺少 STS session token 时不读取其他输入。 */
  it('refuses credentials without an STS session token', async () => {
    await expect(runPromotionCli({
      GITHUB_EVENT_PATH: '/not-read-with-invalid-credentials',
      OSS_BUCKET: 'bucket',
      OSS_REGION: 'cn-shenzhen',
      UPDATE_BASE_URL: 'https://updates.cyunlab.com',
      TAURI_SIGNING_PUBLIC_KEY: 'RWQpublic',
      ALIBABA_CLOUD_ACCESS_KEY_ID: 'long-lived-id',
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'long-lived-secret'
    })).rejects.toThrow('short-lived Alibaba Cloud STS credentials are required')
  })

  /** 验证缺少 updater 公钥时在读取 release 输入前 fail closed。 */
  it('refuses promotion without the Tauri signing public key', async () => {
    await expect(runPromotionCli({
      GITHUB_EVENT_PATH: '/not-read-without-public-key',
      OSS_BUCKET: 'bucket',
      OSS_REGION: 'cn-shenzhen',
      UPDATE_BASE_URL: 'https://updates.cyunlab.com',
      ALIBABA_CLOUD_ACCESS_KEY_ID: 'temporary-id',
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'temporary-secret',
      ALIBABA_CLOUD_SECURITY_TOKEN: 'temporary-token'
    })).rejects.toThrow('TAURI_SIGNING_PUBLIC_KEY is required')
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
      if (calls.length === 1 && args[0] === 'cat') throw new Error('NoSuchKey: object does not exist')
      return { stdout: args[0] === 'cat' ? Buffer.from('package bytes') : Buffer.alloc(0), stderr: '' }
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
      'cat',
      'oss://cyunlab-public-releases/dsh-desktop/releases/2.1.0/linux-x86_64/package',
      '--config-file',
      calls[2].configFile
    ])
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
      return { stdout: Buffer.from('existing bytes'), stderr: '' }
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
    expect(commands.every(args => args[0] === 'cat')).toBe(true)
  })

  /** 验证 workflow 显式 CLI 参数无需读取 event 文件。 */
  it('accepts the workflow CLI arguments without reading a GitHub event file', async () => {
    const storage = createStorage()
    let receivedOptions: Record<string, unknown> | undefined
    await runPromotionCli({
      OSS_BUCKET: 'cyunlab-public-releases',
      OSS_REGION: 'cn-shenzhen',
      UPDATE_BASE_URL: 'https://updates.cyunlab.com',
      TAURI_SIGNING_PUBLIC_KEY: 'RWQpublic',
      ALIBABA_CLOUD_ACCESS_KEY_ID: 'temporary-id',
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'temporary-secret',
      ALIBABA_CLOUD_SECURITY_TOKEN: 'temporary-token'
    }, {
      createStorage: () => storage,
      async promote(options) {
        receivedOptions = options as unknown as Record<string, unknown>
        return { version: '2.1.0', notes: '', pub_date: '', platforms: {} }
      }
    }, [
      '--tag', 'v2.1.0',
      '--notes', 'Published notes',
      '--published-at', '2026-08-28T02:30:00Z',
      '--assets', 'downloaded-artifacts',
      '--prefix', 'dsh-desktop'
    ])
    expect(receivedOptions).toMatchObject({
      tag: 'v2.1.0',
      releaseBody: 'Published notes',
      publishedAt: '2026-08-28T02:30:00Z',
      artifactsDirectory: 'downloaded-artifacts',
      prefix: 'dsh-desktop'
    })
  })
})
