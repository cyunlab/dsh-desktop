import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createOssutilStorage,
  promoteStableRelease,
  runPromotionCli,
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
    async putObject(key, body, metadata) {
      events.push(`put:${key}`)
      writes.push({ key, body, cacheControl: metadata.cacheControl })
    },
    /** 记录远端验证边界的调用顺序。 */
    async verifyObject(key) { events.push(`verify:${key}`) }
  }
}

describe('Stable update promotion', () => {
  it('publishes the four updater targets using the GitHub Release body and literal signatures', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    try {
      const manifest = await promoteStableRelease({
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
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/windows-x86_64/desktop.nsis.zip',
            signature: 'literal-windows-x86_64-signature\n'
          },
          'linux-x86_64': {
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/linux-x86_64/desktop.AppImage.tar.gz',
            signature: 'literal-linux-x86_64-signature\n'
          },
          'darwin-aarch64': {
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/darwin-aarch64/desktop-aarch64.app.tar.gz',
            signature: 'literal-darwin-aarch64-signature\n'
          },
          'darwin-x86_64': {
            url: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/darwin-x86_64/desktop-x86_64.app.tar.gz',
            signature: 'literal-darwin-x86_64-signature\n'
          }
        }
      })
      expect(storage.writes).toHaveLength(9)
      expect(storage.writes.slice(0, 8).every(write => write.cacheControl === 'public, max-age=31536000, immutable')).toBe(true)
      expect(storage.writes.at(-1)).toMatchObject({
        key: 'dsh-desktop/channels/stable/latest.json',
        cacheControl: 'no-cache'
      })
      expect(JSON.parse(storage.writes.at(-1)!.body.toString('utf8'))).toEqual(manifest)
      expect(storage.events.at(-1)).toBe('put:dsh-desktop/channels/stable/latest.json')
      expect(storage.events.slice(8, 16).every(event => event.startsWith('verify:'))).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('leaves the Stable manifest untouched when remote validation fails', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    /** 模拟远端校验在 Linux 对象处失败。 */
    storage.verifyObject = async key => {
      storage.events.push(`verify:${key}`)
      if (key.includes('linux-x86_64')) throw new Error('remote object mismatch')
    }
    try {
      await expect(promoteStableRelease({
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

  it('leaves the Stable manifest untouched when an immutable upload fails', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    /** 模拟 immutable 对象上传在 macOS arm64 处失败。 */
    storage.putObject = async (key, body, metadata) => {
      storage.events.push(`put:${key}`)
      if (key.includes('darwin-aarch64')) throw new Error('OSS upload failed')
      storage.writes.push({ key, body, cacheControl: metadata.cacheControl })
    }
    try {
      await expect(promoteStableRelease({
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

  it('fails closed when any target signature is missing', async () => {
    const directory = await createReleaseDirectory()
    await rm(path.join(directory, 'windows-x86_64', 'desktop.nsis.zip.sig'))
    try {
      await expect(promoteStableRelease({
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

  it('fails closed before upload when the release tag is not semantic', async () => {
    const directory = await createReleaseDirectory()
    const storage = createStorage()
    try {
      await expect(promoteStableRelease({
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

  it('fails closed when the published release body is empty', async () => {
    const directory = await createReleaseDirectory()
    try {
      await expect(promoteStableRelease({
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

  it('refuses credentials without an STS session token', async () => {
    await expect(runPromotionCli({
      GITHUB_EVENT_PATH: '/not-read-with-invalid-credentials',
      OSS_BUCKET: 'bucket',
      OSS_REGION: 'cn-shenzhen',
      UPDATE_BASE_URL: 'https://updates.cyunlab.com',
      ALIBABA_CLOUD_ACCESS_KEY_ID: 'long-lived-id',
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'long-lived-secret'
    })).rejects.toThrow('short-lived Alibaba Cloud STS credentials are required')
  })

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
    await storage.putObject('dsh-desktop/releases/2.1.0/linux-x86_64/package', Buffer.from('package bytes'), {
      cacheControl: 'public, max-age=31536000, immutable'
    })
    await storage.verifyObject('dsh-desktop/releases/2.1.0/linux-x86_64/package', Buffer.from('package bytes'))

    expect(calls[0].args).toContain('oss://cyunlab-public-releases/dsh-desktop/releases/2.1.0/linux-x86_64/package')
    expect(calls[0].args).toEqual(expect.arrayContaining([
      '--meta',
      'Cache-Control:public, max-age=31536000, immutable'
    ]))
    expect(calls[1].args).toEqual([
      'cat',
      'oss://cyunlab-public-releases/dsh-desktop/releases/2.1.0/linux-x86_64/package',
      '--config-file',
      calls[1].configFile
    ])
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
    expect(new Set(calls.map(call => call.configFile)).size).toBe(2)
    for (const call of calls) await expect(stat(call.configFile)).rejects.toThrow()
    await expect(storage.putObject('another-app/releases/2.1.0/package', Buffer.from('wrong scope'), {
      cacheControl: 'no-cache'
    })).rejects.toThrow('outside the configured application prefix')
  })

  it('accepts the workflow CLI arguments without reading a GitHub event file', async () => {
    const storage = createStorage()
    let receivedOptions: Record<string, unknown> | undefined
    await runPromotionCli({
      OSS_BUCKET: 'cyunlab-public-releases',
      OSS_REGION: 'cn-shenzhen',
      UPDATE_BASE_URL: 'https://updates.cyunlab.com',
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
