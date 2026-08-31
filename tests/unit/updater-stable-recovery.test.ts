import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  finalizeUpdaterStableRecovery,
  prepareUpdaterStableRecovery,
  type PromotionStorage,
  type UpdaterStableRecoveryCandidate,
} from '../../scripts/promote-stable-release.mjs'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const BROKEN_VERSION = '2.1.5'
const STABLE_BODY = Buffer.from(`{"version":"${BROKEN_VERSION}","platforms":{}}\n`)
const STABLE_SHA256 = createHash('sha256').update(STABLE_BODY).digest('hex')
const FIRST_RECEIPT_BODY = Buffer.from(`${JSON.stringify({
  schema_version: 1,
  kind: 'first-updater-stable-bootstrap',
  candidate_version: BROKEN_VERSION,
  candidate_manifest_sha256: STABLE_SHA256,
}, null, 2)}\n`)
const FIRST_RECEIPT_SHA256 = createHash('sha256').update(FIRST_RECEIPT_BODY).digest('hex')
const FIRST_RECEIPT_KEY = `dsh-desktop/bootstrap/receipts/${FIRST_RECEIPT_SHA256}-first-updater-stable.json`

/** 创建能观察 recovery receipt 与 Stable 写入顺序的内存 OSS。 */
function createStorage(): PromotionStorage & { objects: Map<string, Buffer>; events: string[] } {
  const objects = new Map<string, Buffer>([
    ['dsh-desktop/channels/stable/latest.json', STABLE_BODY],
    [FIRST_RECEIPT_KEY, FIRST_RECEIPT_BODY],
  ])
  const events: string[] = []
  return {
    objects,
    events,
    async ensureObject(key, body) {
      events.push(`ensure:${key}`)
      const current = objects.get(key)
      if (current && !current.equals(body)) throw new Error('immutable object changed')
      objects.set(key, Buffer.from(body))
      return current ? 'reused' : 'uploaded'
    },
    async replaceObject(key, body) { events.push(`replace:${key}`); objects.set(key, Buffer.from(body)) },
    async readObject(key) {
      events.push(`read:${key}`)
      const body = objects.get(key)
      if (!body) throw new Error(`NoSuchKey: ${key}`)
      return Buffer.from(body)
    },
    async listObjects(prefix) { events.push(`list:${prefix}`); return [...objects.keys()].filter(key => key.startsWith(prefix)).sort() },
    async acquirePromotionLock(key, body) { events.push(`lock:${key}`); objects.set(key, Buffer.from(body)) },
    async releasePromotionLock(key) { events.push(`unlock:${key}`); objects.delete(key) },
  }
}

/** 创建绑定损坏 Stable 与首次 bootstrap receipt 的 recovery candidate。 */
function candidateFixture(): UpdaterStableRecoveryCandidate {
  const manifest = {
    version: '2.1.10', notes: 'Recovery updater.', pub_date: '2026-08-31T05:00:00Z',
    platforms: Object.fromEntries(['windows-x86_64', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64']
      .map(target => [target, { url: `https://updates.cyunlab.com/dsh-desktop/releases/2.1.10/${target}/package`, signature: `signature-${target}` }])),
  }
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const digest = createHash('sha256').update(body).digest('hex')
  return {
    schema_version: 1,
    bootstrap_kind: 'broken-updater-stable-recovery',
    candidate_tag: 'v2.1.10', candidate_version: '2.1.10', candidate_commit: COMMIT,
    broken_stable_version: BROKEN_VERSION, broken_stable_manifest_sha256: STABLE_SHA256,
    prior_bootstrap_receipt_key: FIRST_RECEIPT_KEY, prior_bootstrap_receipt_sha256: FIRST_RECEIPT_SHA256,
    failed_promotion_run_id: '33359884959', manifest_url: `https://updates.cyunlab.com/dsh-desktop/candidates/2.1.10/${COMMIT}/${digest}-latest.json`,
    manifest_sha256: digest, manifest,
  }
}

/** 创建严格命名的四平台 fresh-install evidence fixture。 */
async function createEvidence() {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-recovery-evidence-'))
  for (const target of ['windows-x86_64', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64']) {
    const body = Buffer.from(`${JSON.stringify({ target })}\n`)
    await writeFile(path.join(directory, `${target}.json`), body)
    await writeFile(path.join(directory, `${target}.json.sha256`), `${createHash('sha256').update(body).digest('hex')}  ${target}.json\n`)
  }
  return directory
}

describe('broken updater Stable recovery', () => {
  /** recovery 准备必须逐字绑定当前 Stable、原始 receipt 和唯一失败 run。 */
  it('prepares only against the exact broken Stable and original receipt', async () => {
    const storage = createStorage()
    const expected = candidateFixture()
    const prepared = await prepareUpdaterStableRecovery({
      approvedTag: expected.candidate_tag, approvedVersion: expected.candidate_version, approvedCommit: COMMIT,
      approvedCandidateManifestSha256: expected.manifest_sha256,
      approvedBrokenStableVersion: BROKEN_VERSION, approvedBrokenStableManifestSha256: STABLE_SHA256,
      approvedPriorReceiptKey: FIRST_RECEIPT_KEY, approvedPriorReceiptSha256: FIRST_RECEIPT_SHA256,
      approvedFailedPromotionRunId: '33359884959', prefix: 'dsh-desktop',
    }, storage, { prepareCandidate: async () => ({
      ...expected,
      previous_stable_version: BROKEN_VERSION,
      previous_stable_manifest_sha256: STABLE_SHA256,
    }) })
    expect(prepared).toEqual(expected)

    await expect(prepareUpdaterStableRecovery({
      approvedTag: expected.candidate_tag, approvedVersion: expected.candidate_version, approvedCommit: COMMIT,
      approvedCandidateManifestSha256: expected.manifest_sha256,
      approvedBrokenStableVersion: BROKEN_VERSION, approvedBrokenStableManifestSha256: STABLE_SHA256,
      approvedPriorReceiptKey: FIRST_RECEIPT_KEY, approvedPriorReceiptSha256: 'f'.repeat(64),
      approvedFailedPromotionRunId: '33359884959', prefix: 'dsh-desktop',
    }, storage, { prepareCandidate: async () => expected })).rejects.toThrow('receipt key digest')
  })

  /** recovery 必须先写不可变 receipt，再把候选 manifest 作为最后一次 release-content mutation 写入 Stable。 */
  it('writes a recovery receipt before Stable last', async () => {
    const storage = createStorage()
    const candidate = candidateFixture()
    storage.objects.set(new URL(candidate.manifest_url).pathname.slice(1), Buffer.from(`${JSON.stringify(candidate.manifest, null, 2)}\n`))
    const evidence = await createEvidence()
    try {
      const result = await finalizeUpdaterStableRecovery(candidate, storage, {
        prefix: 'dsh-desktop', evidenceDirectory: evidence, maxAgeHours: 24, lockOwner: `test:1:${COMMIT}`,
      }, { verifyEvidence: async (_directory: string, expectations: Record<string, unknown>) => {
        expect(expectations).toMatchObject({ requireRealBootstrap: true, requireMacosSigning: true })
        return { targets: ['windows-x86_64', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64'] }
      } })
      expect(result.receipt_key).toMatch(/^dsh-desktop\/recovery\/receipts\/[0-9a-f]{64}-broken-updater-stable\.json$/)
      const receiptWrite = storage.events.indexOf(`ensure:${result.receipt_key}`)
      const stableWrite = storage.events.indexOf('replace:dsh-desktop/channels/stable/latest.json')
      expect(receiptWrite).toBeGreaterThan(-1)
      expect(stableWrite).toBeGreaterThan(receiptWrite)
      expect(storage.objects.get('dsh-desktop/channels/stable/latest.json'))
        .toEqual(storage.objects.get(new URL(candidate.manifest_url).pathname.slice(1)))
    } finally {
      await rm(evidence, { recursive: true, force: true })
    }
  })

  /** receipt 写入后若首次 bootstrap receipt 漂移，Stable 仍必须保持旧值。 */
  it('rereads the prior bootstrap receipt after writing the recovery receipt', async () => {
    const storage = createStorage()
    const candidate = candidateFixture()
    storage.objects.set(new URL(candidate.manifest_url).pathname.slice(1), Buffer.from(`${JSON.stringify(candidate.manifest, null, 2)}\n`))
    const originalEnsure = storage.ensureObject.bind(storage)
    storage.ensureObject = async (key, body, metadata) => {
      const result = await originalEnsure(key, body, metadata)
      if (key.includes('/recovery/receipts/')) storage.objects.set(FIRST_RECEIPT_KEY, Buffer.from('changed'))
      return result
    }
    const evidence = await createEvidence()
    try {
      await expect(finalizeUpdaterStableRecovery(candidate, storage, {
        prefix: 'dsh-desktop', evidenceDirectory: evidence, maxAgeHours: 24, lockOwner: `test:2:${COMMIT}`,
      }, { verifyEvidence: async () => ({ targets: [] }) })).rejects.toThrow('prior bootstrap receipt')
      expect(storage.objects.get('dsh-desktop/channels/stable/latest.json')).toEqual(STABLE_BODY)
    } finally {
      await rm(evidence, { recursive: true, force: true })
    }
  })

  /** 任意既有 recovery receipt 都永久关闭第二次恢复尝试。 */
  it('rejects any existing recovery receipt', async () => {
    const storage = createStorage()
    storage.objects.set('dsh-desktop/recovery/receipts/partial.json', Buffer.from('partial'))
    const candidate = candidateFixture()
    await expect(prepareUpdaterStableRecovery({
      approvedTag: candidate.candidate_tag, approvedVersion: candidate.candidate_version, approvedCommit: COMMIT,
      approvedCandidateManifestSha256: candidate.manifest_sha256,
      approvedBrokenStableVersion: BROKEN_VERSION, approvedBrokenStableManifestSha256: STABLE_SHA256,
      approvedPriorReceiptKey: FIRST_RECEIPT_KEY, approvedPriorReceiptSha256: FIRST_RECEIPT_SHA256,
      approvedFailedPromotionRunId: '33359884959', prefix: 'dsh-desktop',
    }, storage, { prepareCandidate: async () => candidate })).rejects.toThrow('recovery receipt already exists')
  })
})
