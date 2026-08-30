import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  finalizeBootstrapStableCandidate,
  prepareBootstrapStableCandidate,
  createOssutilStorage,
  runBootstrapFinalizationCli,
  type BootstrapStableCandidate,
  type PromotionStorage
} from '../../scripts/promote-stable-release.mjs'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const LEGACY_VERSION = '2.0.17'
const LEGACY_BODY = Buffer.from(`{"version":"${LEGACY_VERSION}","platforms":{}}\n`)
const LEGACY_SHA256 = createHash('sha256').update(LEGACY_BODY).digest('hex')

/** 创建能够观察 bootstrap OSS 读取与写入顺序的内存存储。 */
function createBootstrapStorage(): PromotionStorage & {
  readonly objects: Map<string, Buffer>
  readonly events: string[]
} {
  const objects = new Map<string, Buffer>([['dsh-desktop/channels/stable/latest.json', LEGACY_BODY]])
  const events: string[] = []
  return {
    objects,
    events,
    async ensureObject(key, body) {
      events.push(`ensure:${key}`)
      const current = objects.get(key)
      if (current && !current.equals(body)) throw new Error(`immutable object changed: ${key}`)
      objects.set(key, Buffer.from(body))
      return current ? 'reused' : 'uploaded'
    },
    async replaceObject(key, body) {
      events.push(`replace:${key}`)
      objects.set(key, Buffer.from(body))
    },
    async readObject(key) {
      events.push(`read:${key}`)
      const body = objects.get(key)
      if (!body) throw new Error(`NoSuchKey: ${key}`)
      return Buffer.from(body)
    },
    async listObjects(prefix) {
      events.push(`list:${prefix}`)
      return [...objects.keys()].filter(key => key.startsWith(prefix)).sort()
    },
    async acquirePromotionLock(key, body) {
      events.push(`lock:${key}`)
      if (objects.has(key)) throw new Error('promotion lock acquisition conflict')
      objects.set(key, Buffer.from(body))
    },
    async releasePromotionLock(key, ownerBody) {
      events.push(`unlock:${key}`)
      if (!objects.get(key)?.equals(ownerBody)) throw new Error('promotion lock ownership changed')
      objects.delete(key)
    }
  }
}

/** 创建无需真实二进制下载的已准备 bootstrap candidate。 */
function candidateFixture(): BootstrapStableCandidate {
  const manifest = {
    version: '2.1.0',
    notes: 'First updater release.',
    pub_date: '2026-08-29T01:00:00Z',
    platforms: Object.fromEntries([
      'windows-x86_64',
      'linux-x86_64',
      'darwin-aarch64',
      'darwin-x86_64'
    ].map(target => [target, { url: `https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/${target}/package`, signature: `signature-${target}` }]))
  }
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const manifestSha256 = createHash('sha256').update(manifestBody).digest('hex')
  return {
    schema_version: 1,
    bootstrap_kind: 'first-updater-stable',
    candidate_tag: 'v2.1.0',
    candidate_version: '2.1.0',
    candidate_commit: COMMIT,
    legacy_stable_version: LEGACY_VERSION,
    legacy_stable_manifest_sha256: createHash('sha256').update(LEGACY_BODY).digest('hex'),
    manifest_url: `https://updates.cyunlab.com/dsh-desktop/candidates/2.1.0/${COMMIT}/${manifestSha256}-latest.json`,
    manifest_sha256: manifestSha256,
    manifest
  }
}

/** 在存储中放入 candidate manifest，并创建严格命名的四目标 evidence 占位文件。 */
async function seedFinalizationInputs(storage: ReturnType<typeof createBootstrapStorage>, candidate: BootstrapStableCandidate) {
  storage.objects.set(new URL(candidate.manifest_url).pathname.slice(1), Buffer.from(`${JSON.stringify(candidate.manifest, null, 2)}\n`))
  const evidence = await mkdtemp(path.join(tmpdir(), 'dsh-bootstrap-evidence-'))
  for (const target of ['windows-x86_64', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64']) {
    const body = Buffer.from(`${JSON.stringify({ target })}\n`)
    await writeFile(path.join(evidence, `${target}.json`), body)
    await writeFile(path.join(evidence, `${target}.json.sha256`), `${createHash('sha256').update(body).digest('hex')}  ${target}.json\n`)
  }
  return evidence
}

describe('one-time first-updater Stable bootstrap', () => {
  /** 只允许显式审批的 tag、version、完整 commit 和上一 Stable 身份。 */
  it('prepares only the explicitly approved candidate against the approved legacy Stable', async () => {
    const storage = createBootstrapStorage()
    const expected = candidateFixture()
    const prepared = await prepareBootstrapStableCandidate({
      approvedTag: 'v2.1.0',
      approvedVersion: '2.1.0',
      approvedCommit: COMMIT,
      approvedLegacyVersion: LEGACY_VERSION,
      approvedLegacyManifestSha256: LEGACY_SHA256,
      prefix: 'dsh-desktop'
    }, storage, {
      prepareCandidate: async () => ({ ...expected, previous_stable_version: LEGACY_VERSION })
    })

    expect(prepared).toEqual(expected)
    expect(storage.events).toContain('list:dsh-desktop/bootstrap/receipts/')

    await expect(prepareBootstrapStableCandidate({
      approvedTag: 'v2.1.0', approvedVersion: '2.1.1', approvedCommit: COMMIT,
      approvedLegacyVersion: LEGACY_VERSION,
      approvedLegacyManifestSha256: LEGACY_SHA256, prefix: 'dsh-desktop'
    }, storage, { prepareCandidate: async () => expected })).rejects.toThrow('approved tag and version')

    storage.objects.set('dsh-desktop/channels/stable/latest.json', Buffer.from('{"version":"2.0.16"}\n'))
    await expect(prepareBootstrapStableCandidate({
      approvedTag: 'v2.1.0', approvedVersion: '2.1.0', approvedCommit: COMMIT,
      approvedLegacyVersion: LEGACY_VERSION,
      approvedLegacyManifestSha256: LEGACY_SHA256, prefix: 'dsh-desktop'
    }, storage, { prepareCandidate: async () => expected })).rejects.toThrow('legacy Stable version does not match')
  })

  /** 任意已存在或部分写入的 bootstrap receipt 都会阻止准备与复用。 */
  it('rejects an existing bootstrap receipt before candidate preparation', async () => {
    const storage = createBootstrapStorage()
    storage.objects.set('dsh-desktop/bootstrap/receipts/partial.json', Buffer.from('partial'))
    let called = false
    await expect(prepareBootstrapStableCandidate({
      approvedTag: 'v2.1.0', approvedVersion: '2.1.0', approvedCommit: COMMIT,
      approvedLegacyVersion: LEGACY_VERSION,
      approvedLegacyManifestSha256: LEGACY_SHA256, prefix: 'dsh-desktop'
    }, storage, { prepareCandidate: async () => { called = true; return candidateFixture() } }))
      .rejects.toThrow('bootstrap receipt already exists')
    expect(called).toBe(false)
  })

  /** 拒绝无法绑定到一个真实 Git 对象的缩写、大小写错误或非十六进制 commit。 */
  it('rejects a bootstrap approval without an exact lowercase commit', async () => {
    const storage = createBootstrapStorage()
    await expect(prepareBootstrapStableCandidate({
      approvedTag: 'v2.1.0', approvedVersion: '2.1.0', approvedCommit: '01234567',
      approvedLegacyVersion: LEGACY_VERSION,
      approvedLegacyManifestSha256: LEGACY_SHA256, prefix: 'dsh-desktop'
    }, storage, { prepareCandidate: async () => candidateFixture() }))
      .rejects.toThrow('approved commit must be a full lowercase Git commit SHA')
  })

  /** 固定批准的 legacy manifest digest 必须逐字绑定当前 OSS Stable，而不只检查版本号。 */
  it('rejects a different legacy manifest than the approved digest', async () => {
    const storage = createBootstrapStorage()
    await expect(prepareBootstrapStableCandidate({
      approvedTag: 'v2.1.0', approvedVersion: '2.1.0', approvedCommit: COMMIT,
      approvedLegacyVersion: LEGACY_VERSION,
      approvedLegacyManifestSha256: 'f'.repeat(64), prefix: 'dsh-desktop'
    }, storage, { prepareCandidate: async () => candidateFixture() }))
      .rejects.toThrow('approved legacy Stable manifest digest')
  })

  /** finalization 复核 evidence/candidate/Stable/receipt，再写并复读不可变 receipt，最后才写 Stable。 */
  it('writes and byte-verifies a content-digested receipt before writing Stable last', async () => {
    const storage = createBootstrapStorage()
    const candidate = candidateFixture()
    const evidence = await seedFinalizationInputs(storage, candidate)
    try {
      const result = await finalizeBootstrapStableCandidate(candidate, storage, {
        prefix: 'dsh-desktop',
        evidenceDirectory: evidence,
        maxAgeHours: 24,
        lockOwner: `test-run:1:${COMMIT}`
      }, {
        verifyEvidence: async (_directory: string, expectations: Readonly<Record<string, unknown>>) => {
          expect(expectations).toMatchObject({
            tag: 'v2.1.0', version: '2.1.0', commit: COMMIT,
            manifest_sha256: candidate.manifest_sha256,
            requireRealBootstrap: true
          })
          return { schemaVersion: 1, targets: ['windows-x86_64', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64'] }
        }
      })

      expect(result.receipt_key).toMatch(/^dsh-desktop\/bootstrap\/receipts\/[0-9a-f]{64}-first-updater-stable\.json$/)
      expect(result.receipt_sha256).toMatch(/^[0-9a-f]{64}$/)
      const receiptEnsure = storage.events.findIndex(event => event === `ensure:${result.receipt_key}`)
      const receiptRead = storage.events.findIndex(event => event === `read:${result.receipt_key}`)
      const stableWrite = storage.events.findIndex(event => event === 'replace:dsh-desktop/channels/stable/latest.json')
      const lock = storage.events.findIndex(event => event === 'lock:dsh-desktop/channels/stable/promotion.lock')
      const unlock = storage.events.findIndex(event => event === 'unlock:dsh-desktop/channels/stable/promotion.lock')
      expect(lock).toBeGreaterThan(-1)
      expect(receiptEnsure).toBeGreaterThan(-1)
      expect(receiptRead).toBeGreaterThan(receiptEnsure)
      expect(stableWrite).toBeGreaterThan(receiptRead)
      expect(unlock).toBeGreaterThan(stableWrite)
      expect(storage.objects.get('dsh-desktop/channels/stable/latest.json'))
        .toEqual(storage.objects.get(new URL(candidate.manifest_url).pathname.slice(1)))
    } finally {
      await rm(evidence, { recursive: true, force: true })
    }
  })

  /** OSS AppendObject position=0 的 409 竞争失败必须映射为 fail-closed lock 冲突。 */
  it.each([409, 412])('maps OSS append-lock conflict status %s to a rejected promotion', async status => {
    const storage = createOssutilStorage({
      bucket: 'release-bucket',
      region: 'cn-shenzhen',
      prefix: 'dsh-desktop',
      credentials: { accessKeyId: 'temporary-id', accessKeySecret: 'temporary-secret', securityToken: 'temporary-token' },
      fetch: async () => new Response('<Error><Code>PositionNotEqualToLength</Code></Error>', { status })
    })
    await expect(storage.acquirePromotionLock!(
      'dsh-desktop/channels/stable/promotion.lock',
      Buffer.from('{"owner":"run-1"}\n')
    )).rejects.toThrow('promotion lock acquisition conflict')
  })

  /** lock adapter 使用服务端 position=0 条件请求，并只由 byte-identical owner 删除。 */
  it('acquires and releases the global lock through signed OSS requests', async () => {
    const owner = Buffer.from('{"owner":"run-1"}\n')
    const requests: Array<{ url: string; init: RequestInit }> = []
    const storage = createOssutilStorage({
      bucket: 'release-bucket',
      region: 'cn-shenzhen',
      prefix: 'dsh-desktop',
      credentials: { accessKeyId: 'temporary-id', accessKeySecret: 'temporary-secret', securityToken: 'temporary-token' },
      now: () => new Date('2026-08-29T07:00:00Z'),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init! })
        return new Response(init?.method === 'DELETE' ? null : '', { status: init?.method === 'DELETE' ? 204 : 200 })
      },
      runOssutil: async args => {
        expect(args[0]).toBe('cp')
        expect(args[1]).toContain('oss://release-bucket/')
        await writeFile(args[2], owner)
        return { stdout: Buffer.from('0.123(s) elapsed\n'), stderr: '' }
      }
    })
    const key = 'dsh-desktop/channels/stable/promotion.lock'

    await storage.acquirePromotionLock!(key, owner)
    await storage.releasePromotionLock!(key, owner)

    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      url: 'https://release-bucket.oss-cn-shenzhen.aliyuncs.com/dsh-desktop/channels/stable/promotion.lock?append&position=0',
      init: { method: 'POST', body: owner }
    })
    expect(new Headers(requests[0].init.headers).get('authorization')).toMatch(/^OSS temporary-id:/)
    expect(new Headers(requests[0].init.headers).get('x-oss-security-token')).toBe('temporary-token')
    expect(requests[1]).toMatchObject({
      url: 'https://release-bucket.oss-cn-shenzhen.aliyuncs.com/dsh-desktop/channels/stable/promotion.lock',
      init: { method: 'DELETE' }
    })
  })

  /** 任一前置状态漂移或 evidence 缺失都会在 receipt/Stable 写入前失败。 */
  it('fails closed on changed Stable, existing receipt, or missing evidence', async () => {
    for (const mutation of ['stable', 'receipt', 'evidence'] as const) {
      const storage = createBootstrapStorage()
      const candidate = candidateFixture()
      const evidence = await seedFinalizationInputs(storage, candidate)
      if (mutation === 'stable') storage.objects.set('dsh-desktop/channels/stable/latest.json', Buffer.from('{"version":"2.0.16"}\n'))
      if (mutation === 'receipt') storage.objects.set('dsh-desktop/bootstrap/receipts/partial.json', Buffer.from('partial'))
      try {
        await expect(finalizeBootstrapStableCandidate(candidate, storage, {
          prefix: 'dsh-desktop', evidenceDirectory: evidence, maxAgeHours: 24, lockOwner: `test-run:1:${COMMIT}`
        }, {
          verifyEvidence: async () => {
            if (mutation === 'evidence') throw new Error('missing bootstrap target evidence')
            return { schemaVersion: 1, targets: [] }
          }
        })).rejects.toThrow()
        expect(storage.events.some(event => event.startsWith('ensure:dsh-desktop/bootstrap/receipts/'))).toBe(false)
        expect(storage.events.some(event => event.startsWith('replace:'))).toBe(false)
      } finally {
        await rm(evidence, { recursive: true, force: true })
      }
    }
  })

  /** candidate 不可变对象的任何字节变化都会在 receipt 创建前阻止 finalization。 */
  it('rejects a changed immutable candidate before recording a receipt', async () => {
    const storage = createBootstrapStorage()
    const candidate = candidateFixture()
    const evidence = await seedFinalizationInputs(storage, candidate)
    storage.objects.set(new URL(candidate.manifest_url).pathname.slice(1), Buffer.from('{"tampered":true}\n'))
    try {
      await expect(finalizeBootstrapStableCandidate(candidate, storage, {
        prefix: 'dsh-desktop', evidenceDirectory: evidence, maxAgeHours: 24, lockOwner: `test-run:1:${COMMIT}`
      }, { verifyEvidence: async () => ({ schemaVersion: 1, targets: [] }) }))
        .rejects.toThrow('bootstrap candidate manifest digest mismatch')
      expect(storage.events.some(event => event.startsWith('ensure:dsh-desktop/bootstrap/receipts/'))).toBe(false)
      expect(storage.events.some(event => event.startsWith('replace:'))).toBe(false)
    } finally {
      await rm(evidence, { recursive: true, force: true })
    }
  })

  /** receipt 回读后若发现同前缀新增任何部分记录，必须保留旧 Stable 并阻断。 */
  it('rejects an extra partial receipt discovered after the expected receipt write', async () => {
    const storage = createBootstrapStorage()
    const candidate = candidateFixture()
    const evidence = await seedFinalizationInputs(storage, candidate)
    const originalRead = storage.readObject.bind(storage)
    storage.readObject = async key => {
      const body = await originalRead(key)
      if (key.includes('/bootstrap/receipts/')) {
        storage.objects.set('dsh-desktop/bootstrap/receipts/unexpected-partial.json', Buffer.from('partial'))
      }
      return body
    }
    try {
      await expect(finalizeBootstrapStableCandidate(candidate, storage, {
        prefix: 'dsh-desktop', evidenceDirectory: evidence, maxAgeHours: 24, lockOwner: `test-run:1:${COMMIT}`
      }, { verifyEvidence: async () => ({ schemaVersion: 1, targets: [] }) }))
        .rejects.toThrow('bootstrap receipt set changed')
      expect(storage.events.some(event => event.startsWith('replace:'))).toBe(false)
    } finally {
      await rm(evidence, { recursive: true, force: true })
    }
  })

  /** finalization CLI 重新绑定四个 protected approval 值，拒绝篡改的 candidate artifact。 */
  it('rebinds finalization to the configured approved identity and legacy digest', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dsh-bootstrap-candidate-'))
    const candidatePath = path.join(directory, 'candidate.json')
    await writeFile(candidatePath, `${JSON.stringify(candidateFixture())}\n`)
    let finalized = false
    try {
      await expect(runBootstrapFinalizationCli({
        ALIBABA_CLOUD_ACCESS_KEY_ID: 'temporary-id',
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'temporary-secret',
        ALIBABA_CLOUD_SECURITY_TOKEN: 'temporary-token',
        OSS_BUCKET: 'release-bucket',
        OSS_REGION: 'cn-shenzhen',
        UPDATE_BASE_URL: 'https://updates.cyunlab.com'
      }, {
        createStorage: () => createBootstrapStorage(),
        finalizeBootstrap: async () => { finalized = true; return { manifest: candidateFixture().manifest } }
      }, [
        '--candidate', candidatePath, '--evidence', directory, '--max-age-hours', '24',
        '--approved-tag', 'v2.1.0', '--approved-version', '2.1.0',
        '--approved-commit', 'f'.repeat(40),
        '--approved-legacy-version', LEGACY_VERSION,
        '--approved-legacy-manifest-sha256', LEGACY_SHA256,
        '--prefix', 'dsh-desktop'
      ])).rejects.toThrow('bootstrap candidate does not match the approved identity')
      expect(finalized).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
