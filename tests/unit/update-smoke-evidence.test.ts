import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  REQUIRED_SMOKE_CHECKPOINTS,
  REQUIRED_SMOKE_TARGETS,
  verifyUpdateSmokeEvidenceDirectory,
  verifyUpdateSmokeEvidenceSet
} from '../../scripts/verify-update-smoke-evidence.mjs'

const roots: string[] = []
const candidate = {
  tag: 'v2.1.0',
  version: '2.1.0',
  commit: '1234567890abcdef1234567890abcdef12345678',
  manifest_sha256: 'a'.repeat(64)
}
const baselineExpectation = {
  baselineTag: 'v2.0.15',
  baseline_manifest_sha256: 'f'.repeat(64)
}

/** 根据目标生成一份完整且与候选版本绑定的原生证据。 */
function validEvidence(target: string, evidenceKind = 'real-native') {
  const platform = {
    'windows-x86_64': { package_kind: 'nsis-exe', install_scope: 'current-user', authenticode: 'not-required', code_signing: 'not-applicable', notarization: 'not-applicable', install_registry_root: 'HKCU', install_location_class: 'user-profile', msi_present: false },
    'linux-x86_64': { package_kind: 'appimage', install_scope: 'user', authenticode: 'not-applicable', code_signing: 'not-applicable', notarization: 'not-applicable', replacement_path_same: true, executable_bit: true, digest_changed: true },
    'darwin-aarch64': { package_kind: 'app-tar-gz', install_scope: 'user', authenticode: 'not-applicable', signing_credentials_configured: true, code_signing: 'verified', notarization: 'verified' },
    'darwin-x86_64': { package_kind: 'app-tar-gz', install_scope: 'user', authenticode: 'not-applicable', signing_credentials_configured: true, code_signing: 'verified', notarization: 'verified' }
  }[target]!
  const runner = {
    'windows-x86_64': { os: 'windows', arch: 'x86_64' },
    'linux-x86_64': { os: 'linux', arch: 'x86_64' },
    'darwin-aarch64': { os: 'macos', arch: 'aarch64' },
    'darwin-x86_64': { os: 'macos', arch: 'x86_64' }
  }[target]!
  return {
    schema_version: 1,
    evidence_kind: evidenceKind,
    target,
    runner,
    candidate: { ...candidate, package_sha256: target === 'windows-x86_64' ? 'b'.repeat(64) : createHash('sha256').update(target).digest('hex'), signature_sha256: 'd'.repeat(64) },
    baseline: {
      tag: 'v2.0.15',
      version: '2.0.15',
      commit: '9'.repeat(40),
      provenance: evidenceKind === 'real-native' ? 'published-release' : 'local-fixture',
      artifact_sha256: 'c'.repeat(64),
      signature_sha256: 'e'.repeat(64),
      stable_manifest_sha256: 'f'.repeat(64),
      artifact_url: `https://updates.cyunlab.com/dsh-desktop/releases/2.0.15/${target}/baseline`
    },
    previous_version: '2.0.15',
    started_at: '2026-08-28T08:00:00.000Z',
    completed_at: '2026-08-28T08:10:00.000Z',
    platform,
    observations: {
      official_node: true,
      cli_runtime_closure: true,
      desktop_capabilities_package: true,
      desktop_update_client_package: true,
      composition_patch: true,
      trusted_updater_configuration: true
    },
    checkpoints: REQUIRED_SMOKE_CHECKPOINTS.map(id => ({ id, status: 'passed', details: `${id} observed` }))
  }
}

/** 生成完整四目标证据集。 */
function validSet(evidenceKind = 'real-native') {
  return REQUIRED_SMOKE_TARGETS.map(target => validEvidence(target, evidenceKind))
}

/** 将证据与逐字节 SHA-256 companion 写入目录。 */
async function writeEvidenceDirectory(documents: ReturnType<typeof validSet>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-update-smoke-test-'))
  roots.push(directory)
  for (const document of documents) {
    const body = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
    const file = path.join(directory, `${document.target}.json`)
    await writeFile(file, body)
    await writeFile(`${file}.sha256`, `${createHash('sha256').update(body).digest('hex')}  ${path.basename(file)}\n`)
  }
  return directory
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('update smoke evidence verifier public seam', () => {
  /** 发布的 JSON Schema 与 verifier 共享同一版本、目标和 checkpoint 集合。 */
  it('keeps the published JSON Schema aligned with the verifier contract', async () => {
    const schema = JSON.parse(await readFile(new URL('../../docs/update-smoke-evidence-v1.schema.json', import.meta.url), 'utf8'))
    expect(schema.properties.schema_version.const).toBe(1)
    expect(schema.properties.target.enum).toEqual(REQUIRED_SMOKE_TARGETS)
    expect(schema.$defs.checkpointId.enum).toEqual(REQUIRED_SMOKE_CHECKPOINTS)
    expect(schema.properties.checkpoints.minItems).toBe(REQUIRED_SMOKE_CHECKPOINTS.length)
    expect(schema.properties.checkpoints.maxItems).toBe(REQUIRED_SMOKE_CHECKPOINTS.length)
    expect(REQUIRED_SMOKE_CHECKPOINTS).not.toContain('install.restart_requested')
    expect(REQUIRED_SMOKE_CHECKPOINTS.some(id => id.startsWith('negative.'))).toBe(false)
    expect(REQUIRED_SMOKE_CHECKPOINTS.some(id => id.startsWith('setting.'))).toBe(false)
  })

  /** 完整真实原生证据应满足 Stable promotion 的候选绑定。 */
  it('accepts one complete real-native document for every supported target', () => {
    const result = verifyUpdateSmokeEvidenceSet(validSet(), { ...candidate, ...baselineExpectation, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24, requireRealNative: true })
    expect(result).toEqual({ schemaVersion: 1, targets: REQUIRED_SMOKE_TARGETS, candidate })
  })

  /** previous Stable 身份必须与 candidate preparation 读取的权威 pointer 完全一致。 */
  it('rejects a baseline tag or manifest digest that differs from candidate preparation', () => {
    expect(() => verifyUpdateSmokeEvidenceSet(validSet(), {
      ...candidate,
      ...baselineExpectation,
      baselineTag: 'v2.0.14',
      now: new Date('2026-08-28T09:00:00.000Z'),
      maxAgeHours: 24
    })).toThrow('baseline tag does not match candidate preparation')
    expect(() => verifyUpdateSmokeEvidenceSet(validSet(), {
      ...candidate,
      ...baselineExpectation,
      baseline_manifest_sha256: '0'.repeat(64),
      now: new Date('2026-08-28T09:00:00.000Z'),
      maxAgeHours: 24
    })).toThrow('baseline Stable manifest does not match candidate preparation')
  })

  /** fixture 只能验证合约，不能成为 Stable promotion 证据。 */
  it('rejects local fixtures when real native evidence is required', () => {
    expect(() => verifyUpdateSmokeEvidenceSet(validSet('local-fixture'), { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24, requireRealNative: true }))
      .toThrow('real-native evidence is required')
  })

  /** source rebuild 可辅助开发，但不能冒充已发布 previous Stable。 */
  it('rejects a source-rebuilt baseline for Stable promotion', () => {
    const documents = validSet()
    documents[0].baseline.provenance = 'source-rebuild'
    expect(() => verifyUpdateSmokeEvidenceSet(documents, { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24, requireRealNative: true }))
      .toThrow('published-release baseline is required')
  })

  /** 缺失、重复或额外目标都必须 fail closed。 */
  it('rejects an incomplete or duplicate four-target set', () => {
    expect(() => verifyUpdateSmokeEvidenceSet(validSet().slice(1), { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('evidence targets do not exactly match')
    expect(() => verifyUpdateSmokeEvidenceSet([...validSet(), validEvidence('linux-x86_64')], { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('duplicate evidence target')
  })

  /** 候选 tag、commit、manifest 与 package digest 必须完整且精确绑定。 */
  it('rejects candidate mismatch and malformed digests', () => {
    const mismatch = validSet()
    mismatch[0].candidate.commit = 'f'.repeat(40)
    expect(() => verifyUpdateSmokeEvidenceSet(mismatch, { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('candidate commit does not match')
    const malformed = validSet()
    malformed[0].candidate.package_sha256 = 'not-a-digest'
    expect(() => verifyUpdateSmokeEvidenceSet(malformed, { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('package_sha256 must be lowercase SHA-256')
  })

  /** evidence 不接受同版本、降级或与 baseline tag 不一致的路径。 */
  it('requires a strictly newer candidate than the tagged baseline', () => {
    const sameVersion = validSet()
    for (const document of sameVersion) {
      document.baseline.tag = 'v2.1.0'
      document.baseline.version = '2.1.0'
      document.previous_version = '2.1.0'
    }
    expect(() => verifyUpdateSmokeEvidenceSet(sameVersion, { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('candidate version must be newer')
  })

  /** 每个生命周期、阻断路径与用户设置 checkpoint 都必须唯一且通过。 */
  it('rejects a missing, duplicate, unknown, or failed checkpoint', () => {
    const missing = validSet()
    missing[0]!.checkpoints.pop()
    expect(() => verifyUpdateSmokeEvidenceSet(missing, { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('checkpoint set does not exactly match')
    const failed = validSet()
    failed[0]!.checkpoints[0]!.status = 'failed'
    expect(() => verifyUpdateSmokeEvidenceSet(failed, { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('checkpoint did not pass')
  })

  /** 过期、未来时间或持续过久的 evidence 不能用于当前候选。 */
  it('rejects stale and implausible evidence timestamps', () => {
    expect(() => verifyUpdateSmokeEvidenceSet(validSet(), { ...candidate, now: new Date('2026-08-30T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('evidence is stale')
    const long = validSet()
    long[0].completed_at = '2026-08-28T12:30:00.000Z'
    expect(() => verifyUpdateSmokeEvidenceSet(long, { ...candidate, now: new Date('2026-08-28T13:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('evidence duration exceeds')
  })

  /** 平台证据必须使用既定原生架构与安装格式。 */
  it('rejects MSI, non-AppImage Linux, and mismatched native runners', () => {
    const windows = validSet()
    windows[0]!.platform.package_kind = 'msi'
    expect(() => verifyUpdateSmokeEvidenceSet(windows, { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('platform contract mismatch')
    const mac = validSet()
    mac[2]!.runner.arch = 'x86_64'
    expect(() => verifyUpdateSmokeEvidenceSet(mac, { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('runner contract mismatch')
  })

  /** packaged Runtime closure 的五项强制观察缺一不可。 */
  it('rejects missing packaged runtime observations', () => {
    const documents = validSet()
    documents[1].observations.desktop_update_client_package = false
    expect(() => verifyUpdateSmokeEvidenceSet(documents, { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('required observation did not pass')
  })

  /** 文件入口验证 companion checksum，并拒绝夹带多余文件或被篡改字节。 */
  it('verifies checksummed evidence files and rejects tampering', async () => {
    const directory = await writeEvidenceDirectory(validSet())
    await expect(verifyUpdateSmokeEvidenceDirectory(directory, { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24, requireRealNative: true }))
      .resolves.toMatchObject({ targets: REQUIRED_SMOKE_TARGETS })
    await writeFile(path.join(directory, 'linux-x86_64.json'), '{}\n')
    await expect(verifyUpdateSmokeEvidenceDirectory(directory, { ...candidate, now: new Date('2026-08-28T09:00:00.000Z'), maxAgeHours: 24, requireRealNative: true }))
      .rejects.toThrow('checksum mismatch')
    await mkdir(path.join(directory, 'unexpected'))
  })
})
